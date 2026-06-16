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
 *   6. Post a `+1` reaction on every inline review comment listed in
 *      `.minesweeper/pr_review_comment_acks.json` (best-effort — a
 *      reaction failure is logged WARN, never thrown — and the
 *      sidecar is deleted afterwards). Top-level PR reviews are not
 *      acked because the GitHub API has no reactions endpoint for
 *      them.
 *   7. Write `state.status = "Complete"`. The mode stays
 *      `AddressingPRFeedback` so the supervisor's status check leaves
 *      the worktree on disk and the next poll tick can re-evaluate.
 *
 * The mode does not call the reviewer subagent. The "reviewer" here is
 * the human on the PR, whose verdict arrives via the GitHub API and is
 * processed by the poller, not by this code.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { Config } from "../../config.js";
import * as defaultGithub from "../../github/index.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { State } from "../state.js";
import { createGit, FINAL_PLAN_FILE, type GitOps, type RunSubagentFn } from "./execution.js";
import { type PushAuth } from "../../botAuth.js";

/** Path (worktree-relative) the daemon writes fresh PR review comments to. */
export const PR_REVIEW_COMMENTS_FILE = join(".minesweeper", "pr_review_comments.md");

/**
 * Sidecar JSON written by the PR-feedback poller next to
 * `pr_review_comments.md`. Records the numeric REST IDs of the inline
 * review comments that triggered the dispatch. After a successful push,
 * the feedback mode posts a `+1` reaction to each ID and deletes the
 * file. Missing or empty is fine — only inline review comments live
 * here (top-level PR reviews have no reactions endpoint on the GitHub
 * API).
 */
export const PR_REVIEW_COMMENT_ACKS_FILE = join(".minesweeper", "pr_review_comment_acks.json");

export const PrReviewCommentAcksSchema = z.object({
  commentIds: z.array(z.number().int().positive()),
});
export type PrReviewCommentAcks = z.infer<typeof PrReviewCommentAcksSchema>;

/** Write the acks sidecar. Used by the daemon's PR-feedback poller. */
export async function writePrReviewCommentAcks(cwd: string, commentIds: number[]): Promise<void> {
  const payload = PrReviewCommentAcksSchema.parse({ commentIds });
  await fs.mkdir(join(cwd, ".minesweeper"), { recursive: true });
  await fs.writeFile(join(cwd, PR_REVIEW_COMMENT_ACKS_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Read the acks sidecar. Returns `null` if the file is missing —
 * which is the steady state when there were no inline comments in
 * the last dispatch (or a previous round already consumed them).
 */
export async function readPrReviewCommentAcks(cwd: string): Promise<PrReviewCommentAcks | null> {
  try {
    const raw = await fs.readFile(join(cwd, PR_REVIEW_COMMENT_ACKS_FILE), "utf8");
    return PrReviewCommentAcksSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

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
  /** When set (app mode), the branch push authenticates as the GitHub App bot. */
  pushAuth?: PushAuth;
  /** Override the github wrapper (tests). Used to post the post-fix `+1` reaction on inline review comments. */
  github?: Pick<typeof defaultGithub, "addReactionToReviewComment">;
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
  const git = deps.git ?? createGit(deps.pushAuth);
  const gh = deps.github ?? defaultGithub;

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
    await ackReviewComments(cwd, gh, emit, issueNumber);
  }

  return writeState(cwd, { ...state, status: "Complete" });
}

/**
 * Post a `+1` reaction to every inline review comment recorded in
 * `pr_review_comment_acks.json`, then delete the file. A best-effort
 * step: any individual reaction failure is logged WARN and we move
 * on — the executor has already committed and pushed the fix, so
 * losing a reaction must not poison the success path. The file is
 * deleted only after the loop runs (whether or not every call
 * succeeded) so a transient outage on this poll cycle doesn't cause
 * us to react to the same comments again next time.
 */
async function ackReviewComments(
  cwd: string,
  gh: Pick<typeof defaultGithub, "addReactionToReviewComment">,
  emit: Logger["event"],
  issueNumber: number,
): Promise<void> {
  const acks = await readPrReviewCommentAcks(cwd);
  if (acks === null || acks.commentIds.length === 0) return;
  for (const id of acks.commentIds) {
    try {
      await gh.addReactionToReviewComment(id, "+1", { cwd });
    } catch (err) {
      emit("executor", "WARN", issueNumber, `failed to react +1 on review comment ${id}: ${(err as Error).message}`);
    }
  }
  await fs.rm(join(cwd, PR_REVIEW_COMMENT_ACKS_FILE), { force: true });
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
