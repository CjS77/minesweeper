/**
 * Assess mode: a single subagent call that decides whether the approved
 * plan should be executed as one PR or first broken up into sub-issues.
 *
 * Inputs (read from disk):
 *
 *   - `.minesweeper/final_plan.md` — the plan that just came out of
 *     planning mode.
 *   - The GitHub issue (fetched fresh through the orchestrator-owned
 *     `gh` wrapper for context + labels).
 *
 * The mode invokes the `assessor` role exactly once, parses the
 * mandatory `Verdict: <Execute|Refine>` line out of its response, and
 * persists both the verdict and the full response (as
 * `assessmentReason`) to state for audit. There is no retry loop — if
 * the assessor returns no parseable verdict, we log a WARN and treat
 * the response as `Refine` (the conservative default: split rather
 * than silently merging a possibly-too-large change).
 *
 * On exit:
 *
 *   - `Execute` → state transitions to `mode = "Execution"`,
 *     `status = "Writing"`, `iterations = 0`,
 *     `maxIterations = config.maxReviewRounds`. The handler's mode loop
 *     dispatches execution next, in this same process.
 *   - `Refine` → state transitions to `mode = "Refine"`,
 *     `status = "InProgress"`, `iterations = 0`, `maxIterations = 1`.
 *     The handler's mode loop dispatches refine next.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../config.js";
import * as defaultGithub from "../../github/index.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import type { RunSubagentOptions, SubagentResult } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { Assessment, State } from "../state.js";
import {
  asCodeScanningWorkItem,
  asIssueWorkItem,
  asSecretScanningWorkItem,
  formatWorkItem,
  type WorkItem,
} from "../../workitem.js";

/** Path (worktree-relative) the planning mode wrote the approved plan to. */
export const FINAL_PLAN_FILE = join(".minesweeper", "final_plan.md");

/**
 * Matches the assessor's mandatory final line. Case-insensitive,
 * anchored to a line, tolerates surrounding tabs/spaces. The longer
 * alternatives are listed first defensively even though both tokens
 * have the same length — pattern stays consistent with planner/critic
 * verdict regexes.
 */
const ASSESS_VERDICT_RE = /^[ \t]*verdict[ \t]*:[ \t]*(execute|refine)[ \t]*$/gim;

/**
 * Parse an assessor response and return the **last** verdict line
 * found, or `null` if none match. Callers treat `null` as `Refine`
 * (and log a warning).
 */
export function parseAssessVerdict(text: string): Assessment | null {
  const matches = [...text.matchAll(ASSESS_VERDICT_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const value = (last[1] ?? "").toLowerCase();
  if (value === "execute") return "Execute";
  return "Refine";
}

/** Subagent runner shape — kept narrow so tests can inject a fake easily. */
export type RunSubagentFn = (opts: RunSubagentOptions) => Promise<SubagentResult>;

export interface AssessDeps {
  /** Loaded config — model lookup, max review rounds for the next mode. */
  config: Config;
  /** Worktree root (== this child's cwd in production). */
  cwd: string;
  /** State as just read from disk by the handler. */
  state: State;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<typeof defaultGithub, "getIssue" | "getCodeScanningAlert" | "getSecretScanningAlert">;
  /** Override the subagent runner (tests). */
  runSubagent?: RunSubagentFn;
  /** Override the state writer (tests can wrap to assert call sequence). */
  writeState?: typeof defaultState.writeState;
  /** Override the logger event sink (tests, or to suppress logging). */
  emit?: Logger["event"];
}

/**
 * Run the assess state machine to completion. Returns the post-mode-
 * transition state (`Execution` on Execute, `Refine` on Refine).
 *
 * Throws on unrecoverable errors (subagent throws, missing
 * `final_plan.md`). The caller is expected to translate uncaught
 * exceptions to a non-zero exit so the supervisor can label the issue
 * `failedLabel`.
 */
export async function runAssess(deps: AssessDeps): Promise<State> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const gh = deps.github ?? defaultGithub;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const writeState = deps.writeState ?? defaultState.writeState;

  let state = deps.state;
  const issueNumber = state.issueNumber;

  emit("assessor", "WORK", issueNumber, "assessing approved plan");

  const finalPlan = await readFinalPlan(join(cwd, FINAL_PLAN_FILE));
  const item = await fetchWorkItem(gh, state, cwd);

  const result = await runSubagent({
    role: "assessor",
    config,
    userPrompt: assessorPromptFor(item, finalPlan),
    issueNumber,
    iteration: 1,
    cwd,
  });

  const parsed = parseAssessVerdict(result.finalText);
  const verdict: Assessment = parsed ?? "Refine";
  if (parsed === null) {
    emit("assessor", "WARN", issueNumber, "assessor did not emit a parseable Verdict line; defaulting to Refine");
  } else {
    emit("assessor", "INFO", issueNumber, `verdict: ${verdict}`);
  }

  const reason = result.finalText.trim();
  state = await writeState(cwd, {
    ...state,
    assessment: verdict,
    assessmentReason: reason.length > 0 ? reason : null,
  });

  if (verdict === "Execute") {
    return writeState(cwd, {
      ...state,
      mode: "Execution",
      status: "Writing",
      iterations: 0,
      maxIterations: config.maxReviewRounds,
    });
  }

  return writeState(cwd, {
    ...state,
    mode: "Refine",
    status: "InProgress",
    iterations: 0,
    maxIterations: 1,
  });
}

async function readFinalPlan(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`assess: ${path} not found — planning mode must run first`);
    }
    throw err;
  }
}

function assessorPromptFor(item: WorkItem, plan: string): string {
  return [
    formatWorkItem(item),
    "",
    "# Approved plan",
    "",
    plan.trimEnd(),
    "",
    "Decide whether this plan should be executed as one PR or refined into sub-issues. End your response with a single `Verdict: Execute` or `Verdict: Refine` line.",
  ].join("\n");
}

/**
 * Resolve the on-disk `state.kind` to a fresh GitHub fetch of the
 * underlying work item. Mirrors the helper in `planning.ts` so the
 * assessor sees the same canonical block as the planner.
 */
async function fetchWorkItem(gh: NonNullable<AssessDeps["github"]>, state: State, cwd: string): Promise<WorkItem> {
  switch (state.kind) {
    case "issue": {
      const issue = await gh.getIssue(state.issueNumber, { cwd });
      return asIssueWorkItem(issue);
    }
    case "codeScanningAlert": {
      const alert = await gh.getCodeScanningAlert(state.issueNumber, { cwd });
      return asCodeScanningWorkItem(alert);
    }
    case "secretScanningAlert": {
      const alert = await gh.getSecretScanningAlert(state.issueNumber, { cwd });
      return asSecretScanningWorkItem(alert);
    }
  }
}
