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
 *   - The PR has fresh actionable feedback. Three shapes qualify:
 *       1. An actionable review from a *trusted* reviewer, newer than
 *          `state.prFeedbackProcessedAt`. A review is actionable when its
 *          state is `CHANGES_REQUESTED`, or `COMMENTED` *with* a non-empty
 *          body (an empty-bodied `COMMENTED` review is just the GitHub
 *          container for inline comments, picked up separately).
 *       2. An inline comment authored by a *trusted* reviewer, fresh by
 *          the same watermark.
 *       3. An inline comment authored by an *authorised commenter* (e.g.
 *          CodeRabbit, added via `minesweeper reviewers add`) that a
 *          trusted reviewer has thumbed-up — the `+1` is the curation
 *          signal. Freshness here keys off the *reaction's* timestamp
 *          against `state.prReactionsProcessedAt`, a watermark separate
 *          from `prFeedbackProcessedAt` because a `+1` can land long after
 *          the comment it approves.
 *     Reviews come from `gh pr view`; inline comments come from REST
 *     (`getReviewThreads`); per-comment reactions come from REST
 *     (`getReviewCommentReactions`), fetched only when the comment's `+1`
 *     summary count is non-zero. The REST comments endpoint has no
 *     thread-resolution state, so resolution is approximated as
 *     "unresolved" and the watermarks prevent replay.
 *
 * Two reviewer tiers, computed once per tick (see {@link Allowlist}):
 * `trusted` = repo owner (`gh repo view --json owner`) + every bare
 * `@username` in `CODEOWNERS`; `commentAuthors` = `trusted` plus the
 * CLI-managed extra reviewers (`.minesweeper/reviewers.json`). Only
 * `trusted` logins can author directly-actionable feedback or cast an
 * authorising `+1`. All sets are lowercased; `@org/team` entries are
 * deferred — see `src/codeowners.ts`.
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
import type {
  PrReview,
  PrReviewThread,
  PrReviewThreadComment,
  PullRequest,
  ReviewCommentReaction,
} from "../github/index.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import * as defaultWorktree from "../worktree.js";
import { loadCodeownerLogins as defaultLoadCodeownerLogins } from "../codeowners.js";
import { loadExtraReviewers as defaultLoadExtraReviewers } from "../reviewers.js";
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
  github?: Pick<
    typeof defaultGithub,
    "getPullRequest" | "getReviewThreads" | "getRepoOwner" | "getReviewCommentReactions"
  >;
  /** Override worktree helpers (tests). */
  worktree?: Pick<typeof defaultWorktree, "listOrphans">;
  /** Override the codeowners loader (tests). */
  loadCodeownerLogins?: typeof defaultLoadCodeownerLogins;
  /** Override the extra-reviewers loader (tests). */
  loadExtraReviewers?: typeof defaultLoadExtraReviewers;
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
  const loadExtraReviewers = deps.loadExtraReviewers ?? defaultLoadExtraReviewers;
  const writeState = deps.writeState ?? defaultState.writeState;

  const orphans = await wt.listOrphans(deps.worktreesRoot);
  const candidates = orphans.filter(
    (o): o is { path: string; state: State } =>
      o.state !== undefined &&
      o.state.prNumber !== null &&
      o.state.status === "Complete" &&
      (o.state.mode === "Execution" ||
        o.state.mode === "AddressingPRFeedback" ||
        o.state.mode === "AddressingCIFailure") &&
      !deps.isInFlight(o.state.issueNumber),
  );
  if (candidates.length === 0) return;

  const allowlist = await buildAllowlist(deps.repoRoot, gh, loadCodeownerLogins, loadExtraReviewers, emit);

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

/**
 * The two tiers the poller distinguishes:
 *
 *   - `trusted` — repo owner + `CODEOWNERS`. Their *authored* comments
 *     and reviews are actionable on their own, and they are the only
 *     logins whose `+1` can promote someone else's comment.
 *   - `commentAuthors` — `trusted` plus the CLI-managed extra reviewers
 *     (e.g. CodeRabbit). A comment authored by one of these is actionable
 *     *only* once a `trusted` reviewer has thumbed it up.
 */
interface Allowlist {
  trusted: Set<string>;
  commentAuthors: Set<string>;
}

async function buildAllowlist(
  repoRoot: string,
  gh: Pick<typeof defaultGithub, "getRepoOwner">,
  loadCodeownerLogins: typeof defaultLoadCodeownerLogins,
  loadExtraReviewers: typeof defaultLoadExtraReviewers,
  emit: Logger["event"],
): Promise<Allowlist> {
  const trusted = new Set<string>();
  try {
    const owner = await gh.getRepoOwner({ cwd: repoRoot });
    trusted.add(owner.toLowerCase());
  } catch (err) {
    emit("daemon", "WARN", null, `pr-feedback: gh repo view failed (${(err as Error).message})`);
  }
  const codeowners = await loadCodeownerLogins(repoRoot);
  for (const login of codeowners) trusted.add(login.toLowerCase());

  const commentAuthors = new Set(trusted);
  const extra = await loadExtraReviewers(repoRoot);
  for (const login of extra) commentAuthors.add(login.toLowerCase());

  return { trusted, commentAuthors };
}

interface ProcessCandidateArgs {
  candidate: { path: string; state: State };
  allowlist: Allowlist;
  gh: Pick<typeof defaultGithub, "getPullRequest" | "getReviewThreads" | "getReviewCommentReactions">;
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

  const fresh = await collectFreshFeedback({
    pr,
    threads,
    since: state.prFeedbackProcessedAt,
    reactionsSince: state.prReactionsProcessedAt,
    allowlist,
    gh,
    cwd: candidate.path,
    emit,
    issueNumber: state.issueNumber,
  });
  if (fresh.reviews.length === 0 && fresh.threadComments.length === 0) return;

  const rendered = renderFeedback(fresh);
  await writeFeedbackFile(candidate.path, rendered);
  await writePrReviewCommentAcks(candidate.path, ackIdsFor(fresh));

  // Advance each watermark only on its own axis: a tick that fired purely
  // on a +1 must not push prFeedbackProcessedAt past reviews/comments it
  // never looked at (and vice-versa), and must not bury an as-yet-unhandled
  // +1 on the reaction axis. An axis that contributed nothing this tick
  // keeps its existing watermark unchanged. `now` is only a fallback for
  // an axis that *did* contribute but whose item carried no timestamp.
  const now = new Date().toISOString();
  const feedbackTs = newestFeedbackTimestamp(fresh);
  const reactionTs = newestReactionTimestamp(fresh);
  const newState = await writeState(candidate.path, {
    ...state,
    mode: "AddressingPRFeedback",
    status: "InProgress",
    iterations: 0,
    maxIterations: config.maxReviewRounds,
    prFeedbackProcessedAt: hasFeedbackAxisItems(fresh) ? (feedbackTs ?? now) : state.prFeedbackProcessedAt,
    prReactionsProcessedAt: hasReactionAxisItems(fresh) ? (reactionTs ?? now) : state.prReactionsProcessedAt,
  });

  emit(
    "daemon",
    "WORK",
    state.issueNumber,
    `pr-feedback: dispatching #${state.issueNumber} (PR #${prNumber}, ${fresh.reviews.length} reviews, ${fresh.threadComments.length} thread comments)`,
  );
  await resume({ path: candidate.path, state: newState });
}

/**
 * A selected inline comment plus how it qualified. `triggerReactionAt`
 * is set only for the `+1`-curated path (path 4) and carries the
 * reaction's timestamp — the freshness/watermark key for that axis.
 * Comments selected because a trusted reviewer authored them (path 3)
 * leave it `undefined`.
 */
interface SelectedThreadComment {
  thread: PrReviewThread;
  comment: PrReviewThreadComment;
  triggerReactionAt?: string;
}

interface FreshFeedback {
  reviews: PrReview[];
  threadComments: SelectedThreadComment[];
}

interface CollectFreshFeedbackArgs {
  pr: PullRequest;
  threads: PrReviewThread[];
  /** Watermark for reviews + trusted-authored comments. */
  since: string | null;
  /** Watermark for `+1` reactions (their own clock). */
  reactionsSince: string | null;
  allowlist: Allowlist;
  gh: Pick<typeof defaultGithub, "getReviewCommentReactions">;
  cwd: string;
  emit: Logger["event"];
  issueNumber: number;
}

async function collectFreshFeedback(args: CollectFreshFeedbackArgs): Promise<FreshFeedback> {
  const { pr, threads, since, reactionsSince, allowlist, gh, cwd, emit, issueNumber } = args;

  const isFresh = freshnessPredicate(since);
  const isReactionFresh = freshnessPredicate(reactionsSince);
  const isTrusted = (login: string | undefined): boolean =>
    login !== undefined && allowlist.trusted.has(login.toLowerCase());
  const isAllowedAuthor = (login: string | undefined): boolean =>
    login !== undefined && allowlist.commentAuthors.has(login.toLowerCase());

  const reviews = (pr.reviews ?? []).filter(
    (review) => isActionableReview(review) && isFresh(review.submittedAt ?? null) && isTrusted(review.author.login),
  );

  const threadComments: SelectedThreadComment[] = [];
  const selected = new Set<string>();
  for (const thread of threads) {
    if (thread.isResolved) continue;
    for (const comment of thread.comments) {
      const key = comment.id ?? `${thread.id ?? "?"}:${comment.createdAt}`;
      if (selected.has(key)) continue;

      // Path 3 — a trusted reviewer (owner/CODEOWNERS) authored the comment:
      // always actionable, no reaction required.
      if (isTrusted(comment.author.login) && isFresh(comment.createdAt)) {
        threadComments.push({ thread, comment });
        selected.add(key);
        continue;
      }

      // Path 4 — an authorised commenter (e.g. CodeRabbit) whose comment a
      // trusted reviewer approved with a fresh +1. The author gate
      // short-circuits before any reactions fetch.
      if (!isAllowedAuthor(comment.author.login)) continue;
      if ((comment.plusOneCount ?? 0) === 0) continue;
      if (comment.id === undefined) continue;
      const commentId = Number(comment.id);
      if (!Number.isInteger(commentId) || commentId <= 0) continue;
      const reactions = await fetchReactionsSafe(gh, commentId, cwd, emit, issueNumber);
      const trigger = reactions.find(
        (r) => r.content === "+1" && isTrusted(r.user.login) && isReactionFresh(r.createdAt),
      );
      if (trigger) {
        threadComments.push({ thread, comment, triggerReactionAt: trigger.createdAt });
        selected.add(key);
      }
    }
  }

  return { reviews, threadComments };
}

/** Build a `> cutoff` freshness predicate; `null` cutoff treats all as fresh. */
function freshnessPredicate(since: string | null): (iso: string | null | undefined) => boolean {
  const cutoff = since === null ? null : Date.parse(since);
  return (iso) => {
    if (iso === null || iso === undefined) return false;
    if (cutoff === null) return true;
    return Date.parse(iso) > cutoff;
  };
}

/**
 * Fetch a comment's reactions, swallowing any `gh` error to an empty
 * list: a deleted comment (404) or a transient API hiccup must skip the
 * comment, not crash the whole poll tick.
 */
async function fetchReactionsSafe(
  gh: Pick<typeof defaultGithub, "getReviewCommentReactions">,
  commentId: number,
  cwd: string,
  emit: Logger["event"],
  issueNumber: number,
): Promise<ReviewCommentReaction[]> {
  try {
    return await gh.getReviewCommentReactions(commentId, { cwd });
  } catch (err) {
    emit(
      "daemon",
      "WARN",
      issueNumber,
      `pr-feedback: gh api pulls/comments/${commentId}/reactions failed (${(err as Error).message})`,
    );
    return [];
  }
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

/** Thread comments selected on the +1 axis carry a `triggerReactionAt`. */
function isReactionSelected(tc: SelectedThreadComment): boolean {
  return tc.triggerReactionAt !== undefined;
}

/** Did anything qualify on the feedback axis (reviews + authored comments)? */
function hasFeedbackAxisItems(fresh: FreshFeedback): boolean {
  return fresh.reviews.length > 0 || fresh.threadComments.some((tc) => !isReactionSelected(tc));
}

/** Did anything qualify on the reaction axis (+1-curated comments)? */
function hasReactionAxisItems(fresh: FreshFeedback): boolean {
  return fresh.threadComments.some(isReactionSelected);
}

/** Newest review/authored-comment timestamp, or null if none qualified. */
function newestFeedbackTimestamp(fresh: FreshFeedback): string | null {
  const timestamps: number[] = [];
  for (const review of fresh.reviews) {
    if (review.submittedAt) timestamps.push(Date.parse(review.submittedAt));
  }
  for (const tc of fresh.threadComments) {
    if (!isReactionSelected(tc)) timestamps.push(Date.parse(tc.comment.createdAt));
  }
  return maxIso(timestamps);
}

/** Newest triggering-`+1` timestamp, or null if no reaction qualified. */
function newestReactionTimestamp(fresh: FreshFeedback): string | null {
  const timestamps = fresh.threadComments
    .filter(isReactionSelected)
    .map((tc) => Date.parse(tc.triggerReactionAt as string));
  return maxIso(timestamps);
}

function maxIso(timestamps: number[]): string | null {
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
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

  for (const { thread, comment, triggerReactionAt } of fresh.threadComments) {
    const where = formatThreadAnchor(thread, comment);
    const curated = triggerReactionAt !== undefined ? " (selected via 👍)" : "";
    lines.push(`## Thread comment by @${comment.author.login}${where ? ` — ${where}` : ""}${curated}`);
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
