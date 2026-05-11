/**
 * PR-feedback poller: detects fresh reviewer activity on open
 * Minesweeper PRs and re-dispatches the worktree into
 * `AddressingPRFeedback` mode.
 *
 * Trigger conditions, evaluated once per worktree per tick:
 *
 *   - The worktree's `state.json` carries a `prNumber`, has
 *     `status = "Complete"`, and is in `Execution` or
 *     `AddressingPRFeedback` mode (i.e. it has produced a PR and is
 *     not actively in some other phase of the state machine).
 *   - The issue is not currently in-flight on the supervisor.
 *   - The PR has either an actionable review or an inline review
 *     comment from an authorised reviewer whose timestamp is strictly
 *     newer than `state.prFeedbackProcessedAt`. A review is actionable
 *     when its state is `CHANGES_REQUESTED`, or `COMMENTED` *with* a
 *     non-empty body (a `COMMENTED` review with an empty body is just
 *     the GitHub container for inline comments, which we pick up
 *     separately and would otherwise double-dispatch on). Reviews come
 *     from `gh pr view`; inline review comments come from REST
 *     (`getReviewThreads`) because `gh pr view --json` does not expose
 *     `reviewThreads`. The REST endpoint has no thread-resolution
 *     state, so resolution status is approximated as "unresolved" and
 *     the watermark prevents replay.
 *
 * Authorised reviewers are computed once per tick: the repo owner
 * (`gh repo view --json owner`) plus every bare `@username` listed in
 * the repo's `CODEOWNERS` file. Both sets are lowercased for the
 * compare. `@org/team` entries are deferred — see
 * `src/codeowners.ts`.
 *
 * Side effects on a dispatch:
 *
 *   1. Render the fresh items to
 *      `<worktree>/.minesweeper/pr_review_comments.md` (overwriting any
 *      prior round; the feedback mode only acts on the latest).
 *   2. Update `state` with `mode = "AddressingPRFeedback"`,
 *      `status = "InProgress"`, `iterations = 0`,
 *      `maxIterations = config.maxReviewRounds`, and
 *      `prFeedbackProcessedAt = max(timestamps in fresh set)` so the
 *      next tick can't reprocess the same items.
 *   3. Hand the worktree to `supervisor.resume`, which re-spawns the
 *      child.
 *
 * Errors talking to `gh` are logged WARN and the worktree is skipped
 * for the tick — a transient API hiccup must not block the daemon.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config.js";
import * as defaultGithub from "../github/index.js";
import type { PrReview, PrReviewThread, PrReviewThreadComment, PullRequest } from "../github/index.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import * as defaultWorktree from "../worktree.js";
import { loadCodeownerLogins as defaultLoadCodeownerLogins } from "../codeowners.js";
import type { State } from "../child/state.js";
import * as defaultState from "../child/state.js";
import { PR_REVIEW_COMMENTS_FILE, writePrReviewCommentAcks } from "../child/modes/feedback.js";

/** Worktree-shaped argument the supervisor accepts in `resume`. */
export interface ResumeArg {
  path: string;
  state: State;
}

/** What the poller asks of the supervisor — strictly a `resume` hook. */
export type ResumeFn = (orphan: ResumeArg) => Promise<boolean>;

export interface PrFeedbackDeps {
  config: Config;
  /** Absolute path of the parent repo (used for `gh` cwd and CODEOWNERS). */
  repoRoot: string;
  /** Where new worktrees live; one subdir per branch. */
  worktreesRoot: string;
  /** Predicate the supervisor exposes for "this issue has a running child". */
  isInFlight: (issueNumber: number) => boolean;
  /** Supervisor's `resume` — the dispatch path for re-running on a worktree. */
  resume: ResumeFn;
  /** Override the github wrapper (tests). */
  github?: Pick<typeof defaultGithub, "getPullRequest" | "getReviewThreads" | "getRepoOwner">;
  /** Override worktree helpers (tests). */
  worktree?: Pick<typeof defaultWorktree, "listOrphans">;
  /** Override the codeowners loader (tests). */
  loadCodeownerLogins?: typeof defaultLoadCodeownerLogins;
  /** Override the state writer (tests). */
  writeState?: typeof defaultState.writeState;
  /** Override the logger event sink (tests). */
  emit?: Logger["event"];
}

/** Iterate every orphan with a PR and check for fresh authorised feedback. */
export async function pollPrFeedback(deps: PrFeedbackDeps): Promise<void> {
  const gh = deps.github ?? defaultGithub;
  const wt = deps.worktree ?? defaultWorktree;
  const emit = deps.emit ?? defaultEvent;
  const loadCodeownerLogins = deps.loadCodeownerLogins ?? defaultLoadCodeownerLogins;
  const writeState = deps.writeState ?? defaultState.writeState;

  const orphans = await wt.listOrphans(deps.worktreesRoot);
  const candidates = orphans.filter(
    (o): o is { path: string; state: State } =>
      o.state !== undefined &&
      o.state.prNumber !== null &&
      o.state.status === "Complete" &&
      (o.state.mode === "Execution" || o.state.mode === "AddressingPRFeedback") &&
      !deps.isInFlight(o.state.issueNumber),
  );
  if (candidates.length === 0) return;

  const allowlist = await buildAllowlist(deps.repoRoot, gh, loadCodeownerLogins, emit);

  for (const candidate of candidates) {
    await processCandidate({
      candidate,
      allowlist,
      gh,
      writeState,
      resume: deps.resume,
      config: deps.config,
      emit,
    });
  }
}

async function buildAllowlist(
  repoRoot: string,
  gh: Pick<typeof defaultGithub, "getRepoOwner">,
  loadCodeownerLogins: typeof defaultLoadCodeownerLogins,
  emit: Logger["event"],
): Promise<Set<string>> {
  const allowlist = new Set<string>();
  try {
    const owner = await gh.getRepoOwner({ cwd: repoRoot });
    allowlist.add(owner.toLowerCase());
  } catch (err) {
    emit("daemon", "WARN", null, `pr-feedback: gh repo view failed (${(err as Error).message})`);
  }
  const codeowners = await loadCodeownerLogins(repoRoot);
  for (const login of codeowners) allowlist.add(login.toLowerCase());
  return allowlist;
}

interface ProcessCandidateArgs {
  candidate: { path: string; state: State };
  allowlist: Set<string>;
  gh: Pick<typeof defaultGithub, "getPullRequest" | "getReviewThreads">;
  writeState: typeof defaultState.writeState;
  resume: ResumeFn;
  config: Config;
  emit: Logger["event"];
}

async function processCandidate(args: ProcessCandidateArgs): Promise<void> {
  const { candidate, allowlist, gh, writeState, resume, config, emit } = args;
  const { state } = candidate;
  // Narrowed by the filter above; assert for the type system.
  const prNumber = state.prNumber as number;

  let pr: PullRequest;
  let threads: PrReviewThread[];
  try {
    pr = await gh.getPullRequest(prNumber, { cwd: candidate.path });
  } catch (err) {
    emit(
      "daemon",
      "WARN",
      state.issueNumber,
      `pr-feedback: gh pr view #${prNumber} failed (${(err as Error).message})`,
    );
    return;
  }
  try {
    threads = await gh.getReviewThreads(prNumber, { cwd: candidate.path });
  } catch (err) {
    emit(
      "daemon",
      "WARN",
      state.issueNumber,
      `pr-feedback: gh api pulls/${prNumber}/comments failed (${(err as Error).message})`,
    );
    return;
  }

  const fresh = collectFreshFeedback(pr, threads, state.prFeedbackProcessedAt, allowlist);
  if (fresh.reviews.length === 0 && fresh.threadComments.length === 0) return;

  const rendered = renderFeedback(fresh);
  await writeFeedbackFile(candidate.path, rendered);
  await writePrReviewCommentAcks(candidate.path, ackIdsFor(fresh));

  const watermark = newestTimestamp(fresh) ?? new Date().toISOString();
  const newState = await writeState(candidate.path, {
    ...state,
    mode: "AddressingPRFeedback",
    status: "InProgress",
    iterations: 0,
    maxIterations: config.maxReviewRounds,
    prFeedbackProcessedAt: watermark,
  });

  emit(
    "daemon",
    "WORK",
    state.issueNumber,
    `pr-feedback: dispatching #${state.issueNumber} (PR #${prNumber}, ${fresh.reviews.length} reviews, ${fresh.threadComments.length} thread comments)`,
  );
  await resume({ path: candidate.path, state: newState });
}

interface FreshFeedback {
  reviews: PrReview[];
  threadComments: Array<{ thread: PrReviewThread; comment: PrReviewThreadComment }>;
}

function collectFreshFeedback(
  pr: PullRequest,
  threads: PrReviewThread[],
  since: string | null,
  allowlist: Set<string>,
): FreshFeedback {
  const cutoff = since === null ? null : Date.parse(since);
  const isFresh = (iso: string | null | undefined): boolean => {
    if (iso === null || iso === undefined) return false;
    if (cutoff === null) return true;
    return Date.parse(iso) > cutoff;
  };
  const isAuthorised = (login: string | undefined): boolean =>
    login !== undefined && allowlist.has(login.toLowerCase());

  const reviews = (pr.reviews ?? []).filter(
    (review) => isActionableReview(review) && isFresh(review.submittedAt ?? null) && isAuthorised(review.author.login),
  );

  const threadComments: FreshFeedback["threadComments"] = [];
  for (const thread of threads) {
    if (thread.isResolved) continue;
    for (const comment of thread.comments) {
      if (!isFresh(comment.createdAt)) continue;
      if (!isAuthorised(comment.author.login)) continue;
      threadComments.push({ thread, comment });
    }
  }

  return { reviews, threadComments };
}

/**
 * A review is actionable when it carries enough information for the
 * executor to do something with it. `CHANGES_REQUESTED` is always
 * actionable. `COMMENTED` is actionable only when it has a non-empty
 * body — an empty-bodied `COMMENTED` review is GitHub's container for
 * a batch of inline comments, which we already collect via
 * `getReviewThreads`; accepting it here would re-dispatch the same
 * feedback twice.
 */
function isActionableReview(review: PrReview): boolean {
  if (review.state === "CHANGES_REQUESTED") return true;
  if (review.state === "COMMENTED") return review.body.trim().length > 0;
  return false;
}

function newestTimestamp(fresh: FreshFeedback): string | null {
  const timestamps: number[] = [];
  for (const review of fresh.reviews) {
    if (review.submittedAt) timestamps.push(Date.parse(review.submittedAt));
  }
  for (const { comment } of fresh.threadComments) {
    timestamps.push(Date.parse(comment.createdAt));
  }
  if (timestamps.length === 0) return null;
  const max = Math.max(...timestamps);
  return new Date(max).toISOString();
}

function renderFeedback(fresh: FreshFeedback): string {
  const lines: string[] = ["# PR review feedback", ""];

  for (const review of fresh.reviews) {
    lines.push(`## Review by @${review.author.login}`);
    if (review.submittedAt) lines.push(`Submitted: ${review.submittedAt}`);
    lines.push("");
    const body = review.body.trim();
    lines.push(body.length > 0 ? body : "(review left no top-level body)");
    lines.push("");
  }

  for (const { thread, comment } of fresh.threadComments) {
    const where = formatThreadAnchor(thread, comment);
    lines.push(`## Thread comment by @${comment.author.login}${where ? ` — ${where}` : ""}`);
    lines.push(`Posted: ${comment.createdAt}`);
    lines.push("");
    lines.push(comment.body.trim());
    lines.push("");
  }

  return lines.join("\n");
}

function formatThreadAnchor(thread: PrReviewThread, comment: PrReviewThreadComment): string {
  const path = thread.path ?? comment.path ?? null;
  const line = thread.line ?? comment.line ?? null;
  if (path === null) return "";
  return line === null ? path : `${path}:${line}`;
}

/**
 * Extract the numeric REST IDs of fresh inline review comments so
 * the feedback mode can post a `+1` reaction on each one after the
 * executor commits its fix. `getReviewThreads` populates `comment.id`
 * with `String(restId)`, so the integer round-trip is lossless; any
 * comment without a parseable integer id is silently dropped (it
 * shouldn't happen, but we'd rather skip an ack than crash the
 * dispatch).
 */
function ackIdsFor(fresh: FreshFeedback): number[] {
  const ids: number[] = [];
  for (const { comment } of fresh.threadComments) {
    if (comment.id === undefined) continue;
    const parsed = Number(comment.id);
    if (Number.isInteger(parsed) && parsed > 0) ids.push(parsed);
  }
  return ids;
}

async function writeFeedbackFile(worktreePath: string, content: string): Promise<void> {
  const path = join(worktreePath, PR_REVIEW_COMMENTS_FILE);
  await fs.mkdir(join(worktreePath, ".minesweeper"), { recursive: true });
  const payload = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(path, payload, "utf8");
}
