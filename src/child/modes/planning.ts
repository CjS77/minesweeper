/**
 * Planning mode: drives the planner ↔ critic loop until the critic
 * approves the plan or `state.maxIterations` is reached.
 *
 * The loop is structured as alternating subagent calls. Each call counts
 * as one iteration, so the parity of `state.iterations` decides whose
 * turn it is:
 *
 *   - even (0, 2, 4, …) → planner's turn (initial plan or re-plan after
 *     a `Request changes` critique).
 *   - odd  (1, 3, 5, …) → critic's turn (review the latest plan).
 *
 * The current plan lives at `.minesweeper/current_plan.md`. After each
 * iteration the file is rewritten:
 *
 *   - planner output → replaces the file entirely.
 *   - critic `Request changes` → appends a `## Execution Plan review`
 *     section so the next planner round sees the feedback.
 *   - critic `Approved with comments` → appends a `## Points to consider`
 *     section so the executor sees the nits, then the loop exits.
 *   - critic `Approved` → loop exits without modifying the plan.
 *
 * On exit the plan is copied verbatim to `.minesweeper/final_plan.md`,
 * the state is transitioned to `mode=Execution`, `status=Writing`,
 * `iterations=0`, `maxIterations=config.maxReviewRounds`, and the
 * function returns. The child handler's mode loop sees the new mode
 * on disk and dispatches execution next, inside the same process —
 * no second `minesweeper handle` invocation is involved.
 *
 * Resumption: the loop reads `state.iterations` from disk on entry, so
 * a crashed child that left state at iteration N resumes at iteration
 * N+1. Mid-iteration resume (i.e. a crash *during* a subagent call) is
 * out of scope: the iteration is replayed in full.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type { Config } from "../../config.js";
import * as defaultGithub from "../../github/index.js";
import type { Issue } from "../../github/index.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import type { RunSubagentOptions, SubagentResult } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { State } from "../state.js";

/** Path (worktree-relative) where the in-progress plan is persisted. */
export const CURRENT_PLAN_FILE = join(".minesweeper", "current_plan.md");

/** Path (worktree-relative) where the approved plan is persisted on success. */
export const FINAL_PLAN_FILE = join(".minesweeper", "final_plan.md");

/** The three possible critic verdicts. */
export type Verdict = "Approved" | "Approved with comments" | "Request changes";

/**
 * Matches the critic's mandatory final line. Case-insensitive, anchored
 * to a line. Spaces and tabs around the keyword are tolerated; newlines
 * are not (we use `[ \t]*` instead of `\s*` so the match cannot span
 * lines). The longer alternative is listed first so alternation prefers
 * "approved with comments" over "approved".
 */
const VERDICT_RE =
  /^[ \t]*verdict[ \t]*:[ \t]*(approved with comments|approved|request changes)[ \t]*$/gim;

/**
 * Parse a critic response and return the **last** verdict line found,
 * or `null` if none match. The orchestrator treats `null` as
 * `Request changes` and logs a warning — see the planning loop.
 */
export function parseVerdict(text: string): Verdict | null {
  const matches = [...text.matchAll(VERDICT_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const value = (last[1] ?? "").toLowerCase();
  if (value === "approved with comments") return "Approved with comments";
  if (value === "approved") return "Approved";
  return "Request changes";
}

/** Subagent runner shape — kept narrow so tests can inject a fake easily. */
export type RunSubagentFn = (opts: RunSubagentOptions) => Promise<SubagentResult>;

export interface PlanningDeps {
  /** Loaded config — model lookup + `maxReviewRounds` for the next mode. */
  config: Config;
  /** Worktree root (== this child's cwd in production). */
  cwd: string;
  /** State as just read from disk by the handler. */
  state: State;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<typeof defaultGithub, "getIssue">;
  /** Override the subagent runner (tests). */
  runSubagent?: RunSubagentFn;
  /** Override the state writer (tests can wrap to assert call sequence). */
  writeState?: typeof defaultState.writeState;
  /** Override the logger event sink (tests, or to suppress logging). */
  emit?: Logger["event"];
}

/**
 * Run the planning state machine to completion. Returns the post-mode-
 * transition state (mode=Execution, status=Writing) on success.
 *
 * Throws on unrecoverable errors (subagent throws, filesystem failures).
 * The caller is expected to translate uncaught exceptions to a non-zero
 * exit so the supervisor can label the issue `failedLabel`.
 */
export async function runPlanning(deps: PlanningDeps): Promise<State> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const gh = deps.github ?? defaultGithub;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const writeState = deps.writeState ?? defaultState.writeState;

  let state = deps.state;
  const issueNumber = state.issueNumber;

  emit(
    "planner",
    "WORK",
    issueNumber,
    `planning starting at iteration ${state.iterations + 1}/${state.maxIterations}`,
  );

  const issue = await gh.getIssue(issueNumber, { cwd });
  let currentPlan = await readFileIfExists(join(cwd, CURRENT_PLAN_FILE));
  let approved = false;

  while (state.iterations < state.maxIterations) {
    const iteration = state.iterations + 1;
    const plannerTurn = state.iterations % 2 === 0;

    if (plannerTurn) {
      const result = await runSubagent({
        role: "planner",
        config,
        userPrompt: plannerPromptFor(issue, currentPlan),
        issueNumber,
        iteration,
        cwd,
      });
      currentPlan = result.finalText;
      await writePlanFile(join(cwd, CURRENT_PLAN_FILE), currentPlan);
      state = await writeState(cwd, { ...state, iterations: iteration });
      continue;
    }

    if (currentPlan === null) {
      throw new Error("planning: critic invoked but no current plan exists on disk");
    }

    const result = await runSubagent({
      role: "critic",
      config,
      userPrompt: criticPromptFor(issue, currentPlan),
      issueNumber,
      iteration,
      cwd,
    });

    const parsed = parseVerdict(result.finalText);
    const verdict: Verdict = parsed ?? "Request changes";
    if (parsed === null) {
      emit(
        "critic",
        "WARN",
        issueNumber,
        "critic did not emit a parseable Verdict line; treating as Request changes",
      );
    } else {
      emit("critic", "INFO", issueNumber, `verdict: ${verdict}`);
    }

    if (verdict === "Approved") {
      state = await writeState(cwd, { ...state, iterations: iteration });
      approved = true;
      break;
    }

    if (verdict === "Approved with comments") {
      currentPlan = appendSection(currentPlan, "Points to consider", result.finalText);
      await writePlanFile(join(cwd, CURRENT_PLAN_FILE), currentPlan);
      state = await writeState(cwd, { ...state, iterations: iteration });
      approved = true;
      break;
    }

    currentPlan = appendSection(currentPlan, "Execution Plan review", result.finalText);
    await writePlanFile(join(cwd, CURRENT_PLAN_FILE), currentPlan);
    state = await writeState(cwd, { ...state, iterations: iteration });
  }

  if (!approved) {
    emit(
      "critic",
      "WARN",
      issueNumber,
      `planning hit maxIterations (${state.maxIterations}); treating last plan as Approved`,
    );
  }

  if (currentPlan === null) {
    throw new Error("planning: completed without ever producing a plan");
  }

  await writePlanFile(join(cwd, FINAL_PLAN_FILE), currentPlan);

  const next = await writeState(cwd, {
    ...state,
    mode: "Execution",
    status: "Writing",
    iterations: 0,
    maxIterations: config.maxReviewRounds,
  });

  emit("planner", "OK", issueNumber, "planning complete; transitioning to Execution");
  return next;
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writePlanFile(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const payload = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(path, payload, "utf8");
}

function appendSection(plan: string, heading: string, body: string): string {
  const trimmedPlan = plan.replace(/\s+$/, "");
  const trimmedBody = body.replace(/\s+$/, "");
  return `${trimmedPlan}\n\n## ${heading}\n\n${trimmedBody}\n`;
}

function plannerPromptFor(issue: Issue, annotatedPlan: string | null): string {
  const issueBlock = formatIssue(issue);
  if (annotatedPlan === null) {
    return [
      issueBlock,
      "",
      "Produce an execution plan for this issue. Follow the output format described in your system prompt.",
    ].join("\n");
  }
  return [
    issueBlock,
    "",
    'Below is the prior execution plan with the critic\'s review appended under "## Execution Plan review".',
    "Produce a revised plan that addresses every bullet under that heading.",
    "",
    annotatedPlan,
  ].join("\n");
}

function criticPromptFor(issue: Issue, currentPlan: string): string {
  return [
    formatIssue(issue),
    "",
    "Review the following execution plan.",
    "",
    currentPlan,
  ].join("\n");
}

function formatIssue(issue: Issue): string {
  const labels = issue.labels.map((l) => l.name).join(", ") || "(none)";
  const lines = [
    `# GitHub issue #${issue.number}`,
    `Title: ${issue.title}`,
    `Author: ${issue.author.login}`,
    `Labels: ${labels}`,
    `URL: ${issue.url}`,
    "",
    "## Body",
    "",
    issue.body.length > 0 ? issue.body : "(empty body)",
  ];
  if (issue.comments && issue.comments.length > 0) {
    lines.push("", "## Comments");
    for (const c of issue.comments) {
      lines.push("", `### ${c.author.login} — ${c.createdAt}`, "", c.body);
    }
  }
  return lines.join("\n");
}
