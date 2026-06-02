/**
 * Addressing-CI-failure mode: re-runs the executor against the
 * already-approved plan plus a rendered list of failing CI check runs,
 * then pushes incremental commits to the existing PR branch. No
 * squash, no force-push, no re-planning.
 *
 * The mode is entered by the daemon's CI-feedback poller
 * (`src/daemon/ci_feedback.ts`), which:
 *
 *   1. Detects completed failing check runs on the worktree's PR branch,
 *   2. Renders the failures to `.minesweeper/ci_check_failures.md`,
 *   3. Flips the worktree's state to `mode = "AddressingCIFailure"`,
 *      `status = "InProgress"`,
 *   4. Re-spawns the child via `supervisor.resume`.
 *
 * Per-iteration timeline (one round, no loop):
 *
 *   1. Read `.minesweeper/final_plan.md` (errors if missing).
 *   2. Read `.minesweeper/ci_check_failures.md` (errors if missing —
 *      the poller is the only legitimate writer and must have written
 *      it before flipping the mode).
 *   3. Run the `executor` subagent with the plan under `# Execution Plan`
 *      and the failures under `# CI Failures`. The agent commits.
 *   4. Verify HEAD moved; WARN if not.
 *   5. `git push` (incremental — no `-u`, no `--force`).
 *   6. Write `state.status = "Complete"`. The mode stays
 *      `AddressingCIFailure` so the supervisor's status check leaves
 *      the worktree on disk and the next poll tick can re-evaluate.
 *
 * The mode does not call the reviewer subagent — CI is the judge here,
 * and its verdict arrives on the next poll tick via the GitHub API.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../config.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { State } from "../state.js";
import { defaultGit, FINAL_PLAN_FILE, type GitOps, type RunSubagentFn } from "./execution.js";

/** Path (worktree-relative) the daemon writes failing check details to. */
export const CI_CHECK_FAILURES_FILE = join(".minesweeper", "ci_check_failures.md");

export interface CIFeedbackDeps {
  /** Loaded config — model lookup, base branch. */
  config: Config;
  /** Worktree root (== this child's cwd in production). */
  cwd: string;
  /** State as just read from disk by the handler. */
  state: State;
  /** Override the subagent runner (tests). */
  runSubagent?: RunSubagentFn;
  /** Override the state writer (tests). */
  writeState?: typeof defaultState.writeState;
  /** Override the git wrapper (tests). */
  git?: GitOps;
  /** Override the logger event sink (tests, or to suppress logging). */
  emit?: Logger["event"];
}

/**
 * Run one CI-failure iteration. On the success path the returned state
 * has `mode = "AddressingCIFailure"` and `status = "Complete"`; the
 * supervisor's exit-code-0 path leaves the worktree on disk so the
 * next poll tick can re-evaluate CI.
 *
 * Throws if `.minesweeper/final_plan.md` or
 * `.minesweeper/ci_check_failures.md` is missing, or if `git push`
 * fails.
 */
export async function runAddressingCIFailure(deps: CIFeedbackDeps): Promise<State> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const writeState = deps.writeState ?? defaultState.writeState;
  const git = deps.git ?? defaultGit;

  const state = deps.state;
  const issueNumber = state.issueNumber;
  const branch = state.branchName;

  emit("executor", "WORK", issueNumber, `addressing CI failures on ${branch}`);

  const finalPlan = await readRequired(join(cwd, FINAL_PLAN_FILE), "final_plan.md");
  const ciFailures = await readRequired(join(cwd, CI_CHECK_FAILURES_FILE), "ci_check_failures.md");

  const headBefore = await git.headSha(cwd);
  await runSubagent({
    role: "executor",
    config,
    userPrompt: ciFailurePromptFor(finalPlan, ciFailures),
    issueNumber,
    iteration: state.iterations + 1,
    cwd,
  });
  const headAfter = await git.headSha(cwd);
  if (headBefore === headAfter) {
    emit("executor", "WARN", issueNumber, "executor finished without producing a new commit while addressing CI failures");
  } else {
    await git.pushBranch(cwd, branch);
  }

  return writeState(cwd, { ...state, status: "Complete" });
}

async function readRequired(path: string, label: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`ci-failure mode: ${label} not found at ${path}`);
    }
    throw err;
  }
}

function ciFailurePromptFor(plan: string, failures: string): string {
  return [
    "# Execution Plan",
    "",
    plan.trimEnd(),
    "",
    "# CI Failures",
    "",
    failures.trimEnd(),
    "",
    "Fix every failing CI check listed above while keeping the rest of the plan intact. End with a `git commit`.",
  ].join("\n");
}
