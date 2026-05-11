/**
 * Addressing-PR-feedback mode: re-runs the executor against the
 * already-approved plan plus a rendered set of PR review comments, then
 * pushes incremental commits to the existing PR branch. No
 * squash, no force-push, no re-planning.
 *
 * The mode is entered by the daemon's PR-feedback poller
 * (`src/daemon/pr_feedback.ts`), which:
 *
 *   1. Detects fresh `CHANGES_REQUESTED` reviews or unresolved thread
 *      comments from authorised reviewers on a worktree's PR,
 *   2. Renders the fresh items to `.minesweeper/pr_review_comments.md`,
 *   3. Flips the worktree's state to `mode = "AddressingPRFeedback"`,
 *      `status = "InProgress"`,
 *   4. Re-spawns the child via `supervisor.resume`.
 *
 * Per-iteration timeline (one round, no loop):
 *
 *   1. Read `.minesweeper/final_plan.md` (errors if missing — the
 *      worktree must have produced a plan to have a PR in the first
 *      place).
 *   2. Read `.minesweeper/pr_review_comments.md` (errors if missing —
 *      the poller is the only legitimate writer and must have written
 *      it before flipping the mode).
 *   3. Run the `executor` subagent with the plan and the feedback under
 *      the heading `# Review Comments`. The agent commits.
 *   4. Verify HEAD moved; WARN if not.
 *   5. `git push` (incremental — no `-u`, no `--force`).
 *   6. Write `state.status = "Complete"`. The mode stays
 *      `AddressingPRFeedback` so the supervisor's status check leaves
 *      the worktree on disk and the next poll tick can re-evaluate.
 *
 * The mode does not call the reviewer subagent. The "reviewer" here is
 * the human on the PR, whose verdict arrives via the GitHub API and is
 * processed by the poller, not by this code.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../config.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { State } from "../state.js";
import { defaultGit, FINAL_PLAN_FILE, type GitOps, type RunSubagentFn } from "./execution.js";

/** Path (worktree-relative) the daemon writes fresh PR review comments to. */
export const PR_REVIEW_COMMENTS_FILE = join(".minesweeper", "pr_review_comments.md");

export interface FeedbackDeps {
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
 * Run one PR-feedback iteration. On the success path the returned
 * state has `mode = "AddressingPRFeedback"` and
 * `status = "Complete"`; the supervisor's exit-code-0 path leaves the
 * worktree on disk so the next poll tick can re-evaluate it.
 *
 * Throws if `.minesweeper/final_plan.md` or
 * `.minesweeper/pr_review_comments.md` is missing, or if `git push`
 * fails. A push failure typically means someone has force-pushed to
 * the PR branch — the right call is to bail out and let a human
 * inspect, which is what the unhandled throw produces (supervisor
 * applies `failedLabel` and the worktree is preserved).
 */
export async function runAddressingPrFeedback(deps: FeedbackDeps): Promise<State> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const writeState = deps.writeState ?? defaultState.writeState;
  const git = deps.git ?? defaultGit;

  const state = deps.state;
  const issueNumber = state.issueNumber;
  const branch = state.branchName;

  emit("executor", "WORK", issueNumber, `addressing PR feedback on ${branch}`);

  const finalPlan = await readRequired(join(cwd, FINAL_PLAN_FILE), "final_plan.md");
  const reviewComments = await readRequired(join(cwd, PR_REVIEW_COMMENTS_FILE), "pr_review_comments.md");

  const headBefore = await git.headSha(cwd);
  await runSubagent({
    role: "executor",
    config,
    userPrompt: feedbackPromptFor(finalPlan, reviewComments),
    issueNumber,
    iteration: state.iterations + 1,
    cwd,
  });
  const headAfter = await git.headSha(cwd);
  if (headBefore === headAfter) {
    emit(
      "executor",
      "WARN",
      issueNumber,
      "executor finished without producing a new commit while addressing PR feedback",
    );
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
      throw new Error(`feedback mode: ${label} not found at ${path}`);
    }
    throw err;
  }
}

function feedbackPromptFor(plan: string, reviewComments: string): string {
  return [
    "# Execution Plan",
    "",
    plan.trimEnd(),
    "",
    "# Review Comments",
    "",
    reviewComments.trimEnd(),
    "",
    "Address each bullet under `# Review Comments` while keeping the rest of the plan intact. End with a `git commit`.",
  ].join("\n");
}
