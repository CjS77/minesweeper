import {
  CheckRunsResponseSchema,
  CodeScanningAlertListSchema,
  CodeScanningAlertSchema,
  IssueListSchema,
  IssueSchema,
  LabelSchema,
  PullRequestSchema,
  RestReviewCommentSchema,
  SecretScanningAlertListSchema,
  SecretScanningAlertSchema,
  type CheckRun,
  type CodeScanningAlert,
  type Issue,
  type Label,
  type PrReviewThread,
  type PullRequest,
  type RestReviewComment,
  type SecretScanningAlert,
} from "./models.js";
import { z } from "zod";
import { runGh, type RunGhOptions } from "./process.js";

const RepoLabelListSchema = z.array(LabelSchema);
const PullRequestListSchema = z.array(PullRequestSchema);
const RestReviewCommentListSchema = z.array(RestReviewCommentSchema);
const RepoOwnerResponseSchema = z.object({ owner: z.object({ login: z.string() }) });

export { GhError, GhMissingError, GhNotARepoError, runGh, type RunGhOptions } from "./process.js";
export {
  AlertStateSchema,
  CheckRunSchema,
  CheckRunsResponseSchema,
  CodeScanningAlertListSchema,
  CodeScanningAlertSchema,
  CommentSchema,
  IssueListSchema,
  IssueSchema,
  IssueStateSchema,
  LabelSchema,
  PrReviewDecisionSchema,
  PrReviewSchema,
  PrReviewStateSchema,
  PrReviewThreadCommentSchema,
  PrReviewThreadSchema,
  PrStateSchema,
  PullRequestSchema,
  SecretScanningAlertListSchema,
  SecretScanningAlertSchema,
  UserSchema,
  type AlertState,
  type CheckRun,
  type CodeScanningAlert,
  type Comment,
  type Issue,
  type IssueState,
  type Label,
  type PrReview,
  type PrReviewDecision,
  type PrReviewState,
  type PrReviewThread,
  type PrReviewThreadComment,
  type PrState,
  type PullRequest,
  type SecretScanningAlert,
  type User,
} from "./models.js";

const ISSUE_LIST_FIELDS = "number,title,body,labels,author,state,url,createdAt,updatedAt";
const ISSUE_VIEW_FIELDS = `${ISSUE_LIST_FIELDS},comments`;
const PR_LIST_FIELDS = "number,headRefName,baseRefName,state,author,url";
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},title,body,reviews,reviewDecision,comments`;

interface CwdOnly {
  cwd?: string;
}

interface GhOverridable extends CwdOnly {
  /** Override the gh binary (tests). */
  bin?: string;
}

function ghOpts(opts: GhOverridable): RunGhOptions {
  return { cwd: opts.cwd, bin: opts.bin };
}

export interface ListIssuesOptions extends GhOverridable {
  state?: "open" | "closed" | "all";
  /** Hard cap on rows returned by `gh issue list --limit`. Default 30. */
  limit?: number;
}

export async function listIssues(opts: ListIssuesOptions = {}): Promise<Issue[]> {
  const args = [
    "issue",
    "list",
    "--state",
    opts.state ?? "open",
    "--limit",
    String(opts.limit ?? 30),
    "--json",
    ISSUE_LIST_FIELDS,
  ];
  const raw = await runGh(args, { ...ghOpts(opts), json: true });
  return IssueListSchema.parse(raw);
}

export async function getIssue(number: number, opts: GhOverridable = {}): Promise<Issue> {
  const raw = await runGh(["issue", "view", String(number), "--json", ISSUE_VIEW_FIELDS], {
    ...ghOpts(opts),
    json: true,
  });
  return IssueSchema.parse(raw);
}

export async function addLabel(number: number, label: string, opts: GhOverridable = {}): Promise<void> {
  await runGh(["issue", "edit", String(number), "--add-label", label], ghOpts(opts));
}

export async function removeLabel(number: number, label: string, opts: GhOverridable = {}): Promise<void> {
  await runGh(["issue", "edit", String(number), "--remove-label", label], ghOpts(opts));
}

export interface CreateIssueOptions extends GhOverridable {
  title: string;
  body: string;
  labels?: readonly string[];
}

/** A label requested via `createIssue` that could not be applied. */
export interface LabelApplicationFailure {
  label: string;
  /** Human-readable reason taken from the failing `gh` call. */
  reason: string;
}

export interface CreateIssueResult {
  number: number;
  url: string;
  /**
   * Labels from `opts.labels` that could not be applied after the issue
   * was created (e.g. the label does not exist on the repo). Omitted when
   * every requested label applied cleanly or none were requested.
   */
  failedLabels?: LabelApplicationFailure[];
}

/**
 * Create an issue, then apply any requested labels one at a time. Labels are
 * applied *after* creation (not via `--label` on `gh issue create`) so an
 * unknown label — which makes `gh` exit non-zero — cannot block the issue
 * from being filed. Labels that fail are returned in `failedLabels` for the
 * caller to surface non-fatally.
 */
export async function createIssue(opts: CreateIssueOptions): Promise<CreateIssueResult> {
  const args = ["issue", "create", "--title", opts.title, "--body", opts.body];
  const stdout = await runGh<string>(args, ghOpts(opts));
  const url = lastUrl(stdout);
  const number = parseIssueNumber(url);

  const failedLabels = await applyLabels(number, opts.labels ?? [], opts);
  return failedLabels.length > 0 ? { number, url, failedLabels } : { number, url };
}

/**
 * Apply each label to a freshly-created issue one at a time, so a single
 * unknown label (which makes `gh` exit non-zero) cannot block the rest.
 * Returns the labels that failed, paired with the `gh` error text.
 */
async function applyLabels(
  number: number,
  labels: readonly string[],
  opts: GhOverridable,
): Promise<LabelApplicationFailure[]> {
  const failures: LabelApplicationFailure[] = [];
  for (const label of labels) {
    try {
      await addLabel(number, label, opts);
    } catch (err) {
      failures.push({ label, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return failures;
}

export async function comment(number: number, body: string, opts: GhOverridable = {}): Promise<void> {
  await runGh(["issue", "comment", String(number), "--body", body], ghOpts(opts));
}

export interface ListLabelsOptions extends GhOverridable {
  /** Hard cap on rows returned by `gh label list --limit`. Default 200. */
  limit?: number;
}

/**
 * Return every label currently defined on the repository (name, colour and
 * description). Used by `minesweeper labels` to show the operator what is
 * already on the repo before mutating it.
 */
export async function listLabels(opts: ListLabelsOptions = {}): Promise<Label[]> {
  const args = ["label", "list", "--limit", String(opts.limit ?? 200), "--json", "name,color,description"];
  const raw = await runGh(args, { ...ghOpts(opts), json: true });
  return RepoLabelListSchema.parse(raw);
}

export interface UpsertLabelOptions extends GhOverridable {
  name: string;
  /** 6-char hex without leading `#`. */
  color: string;
  description: string;
}

/**
 * Create a repository label, or update its colour and description if it
 * already exists. Uses `gh label create --force`, which is idempotent.
 */
export async function upsertLabel(opts: UpsertLabelOptions): Promise<void> {
  await runGh(
    ["label", "create", opts.name, "--color", opts.color, "--description", opts.description, "--force"],
    ghOpts(opts),
  );
}

export interface CreatePrOptions extends GhOverridable {
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}

export async function createPr(opts: CreatePrOptions): Promise<{ number: number; url: string }> {
  const args = ["pr", "create", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body];
  if (opts.draft) args.push("--draft");
  const stdout = await runGh<string>(args, ghOpts(opts));
  const url = lastUrl(stdout);
  return { number: parsePrNumber(url), url };
}

export interface ListPullRequestsOptions extends GhOverridable {
  state?: "open" | "closed" | "merged" | "all";
  /** Filter on `headRefName` (branch name). */
  head?: string;
  /** Filter on author login (use `"@me"` for the authenticated user). */
  author?: string;
  /** Hard cap on rows returned by `gh pr list --limit`. Default 30. */
  limit?: number;
}

/**
 * `gh pr list` with the JSON projection Minesweeper needs to find its
 * own open PRs. Returns the parsed list — review fields are not
 * included here (use {@link getPullRequest} for those).
 */
export async function listPullRequests(opts: ListPullRequestsOptions = {}): Promise<PullRequest[]> {
  const args = ["pr", "list", "--state", opts.state ?? "open", "--limit", String(opts.limit ?? 30)];
  if (opts.head !== undefined) args.push("--head", opts.head);
  if (opts.author !== undefined) args.push("--author", opts.author);
  args.push("--json", PR_LIST_FIELDS);
  const raw = await runGh(args, { ...ghOpts(opts), json: true });
  return PullRequestListSchema.parse(raw);
}

/**
 * `gh pr view --json` with the field set the PR-feedback poller needs:
 * `reviews`, `reviewDecision`, and the PR-level `comments` (the
 * issue-comment thread on the conversation tab). Inline review-thread
 * comments are *not* fetched here — `gh pr view` does not expose them.
 * Use {@link getReviewThreads} for those.
 */
export async function getPullRequest(number: number, opts: GhOverridable = {}): Promise<PullRequest> {
  const raw = await runGh(["pr", "view", String(number), "--json", PR_VIEW_FIELDS], {
    ...ghOpts(opts),
    json: true,
  });
  return PullRequestSchema.parse(raw);
}

/**
 * Fetch inline review-comment threads for a PR via the REST endpoint
 * `GET /repos/{owner}/{repo}/pulls/{number}/comments`, paginated.
 *
 * `gh pr view --json` does not expose `reviewThreads` (that field only
 * lives in the GraphQL API), so we fall back to REST. The REST shape
 * is flat — one comment per row, no thread grouping or resolution
 * state — so each comment becomes a synthetic single-comment thread
 * with `isResolved: false`. The PR-feedback poller already dedupes via
 * `prFeedbackProcessedAt`, so the loss of `isResolved` precision is
 * accepted: every fresh authorised review comment triggers a dispatch,
 * and the watermark prevents replay.
 *
 * `{owner}` / `{repo}` are auto-templated by `gh api` from the current
 * working directory's git remote, so the caller only supplies the PR
 * number.
 */
export async function getReviewThreads(number: number, opts: GhOverridable = {}): Promise<PrReviewThread[]> {
  const raw = await runGh(["api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/comments`], {
    ...ghOpts(opts),
    json: true,
  });
  const comments = RestReviewCommentListSchema.parse(raw);
  return comments.map(toSyntheticThread);
}

/**
 * Convert one REST review comment into a single-comment
 * `PrReviewThread`. We synthesise per-comment threads (rather than
 * grouping by `pull_request_review_id`) so the existing
 * thread-oriented filter in `pr_feedback.ts` keeps working unchanged.
 */
function toSyntheticThread(c: RestReviewComment): PrReviewThread {
  const line = c.line ?? c.original_line ?? null;
  // REST `user.id` is numeric; drop it so the canonical (string-id) UserSchema is happy.
  const author = c.user === null ? { login: "ghost" } : { login: c.user.login };
  return {
    id: String(c.id),
    isResolved: false,
    path: c.path ?? null,
    line,
    comments: [
      {
        id: String(c.id),
        author,
        body: c.body,
        createdAt: c.created_at,
        path: c.path ?? null,
        line,
      },
    ],
  };
}

/**
 * Reactions content values accepted by GitHub's reactions API. See
 * <https://docs.github.com/en/rest/reactions/reactions>.
 */
export type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

/**
 * Post a reaction (e.g. `+1`) to an inline PR review comment via
 * `POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions`.
 *
 * Used by the AddressingPRFeedback mode to ack each reviewer comment
 * the executor has just addressed and pushed. The endpoint is
 * specifically for *review* comments (i.e. inline comments attached to
 * a line of code in a PR); top-level PR reviews themselves are not
 * reactable through the GitHub API.
 *
 * The call is idempotent on the GitHub side — re-running with the
 * same `(comment, content)` simply returns the existing reaction
 * rather than creating a duplicate.
 */
export async function addReactionToReviewComment(
  commentId: number,
  content: ReactionContent,
  opts: GhOverridable = {},
): Promise<void> {
  await runGh(
    ["api", "-X", "POST", `repos/{owner}/{repo}/pulls/comments/${commentId}/reactions`, "-f", `content=${content}`],
    ghOpts(opts),
  );
}

/**
 * Return the login of the repository owner (`gh repo view --json owner`).
 * Used to seed the authorised-reviewer allowlist alongside
 * `CODEOWNERS` entries.
 */
export async function getRepoOwner(opts: GhOverridable = {}): Promise<string> {
  const raw = await runGh(["repo", "view", "--json", "owner"], { ...ghOpts(opts), json: true });
  return RepoOwnerResponseSchema.parse(raw).owner.login;
}

export interface ListAlertsOptions extends GhOverridable {
  /**
   * GitHub's REST `state` filter. Defaults to `"open"` so the daemon never
   * pulls already-resolved alerts. Pass `"all"` for diagnostics.
   */
  state?: "open" | "dismissed" | "fixed" | "resolved" | "all";
  /**
   * Per-page hint passed to `gh api --paginate`. The CLI still paginates
   * through all pages; the per-page size only affects the number of
   * round trips. Default 30.
   */
  perPage?: number;
}

function alertListArgs(endpoint: string, opts: ListAlertsOptions): string[] {
  const state = opts.state ?? "open";
  const params: string[] = [];
  if (state !== "all") params.push(`state=${state}`);
  params.push(`per_page=${opts.perPage ?? 30}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return ["api", "--paginate", `repos/{owner}/{repo}/${endpoint}${query}`];
}

/**
 * `GET /repos/{owner}/{repo}/code-scanning/alerts`. Returns the parsed
 * list. The endpoint requires the `security_events` token scope and that
 * GitHub Advanced Security (or a public-repo CodeQL setup) is enabled —
 * callers should treat 403/404 as "alerts not available on this repo,"
 * not as a daemon-level fault.
 */
export async function listCodeScanningAlerts(opts: ListAlertsOptions = {}): Promise<CodeScanningAlert[]> {
  const raw = await runGh(alertListArgs("code-scanning/alerts", opts), { ...ghOpts(opts), json: true });
  return CodeScanningAlertListSchema.parse(raw);
}

export async function getCodeScanningAlert(number: number, opts: GhOverridable = {}): Promise<CodeScanningAlert> {
  const raw = await runGh(["api", `repos/{owner}/{repo}/code-scanning/alerts/${number}`], {
    ...ghOpts(opts),
    json: true,
  });
  return CodeScanningAlertSchema.parse(raw);
}

/**
 * `GET /repos/{owner}/{repo}/secret-scanning/alerts`. Same scope and
 * fail-soft caveats as {@link listCodeScanningAlerts}.
 */
export async function listSecretScanningAlerts(opts: ListAlertsOptions = {}): Promise<SecretScanningAlert[]> {
  const raw = await runGh(alertListArgs("secret-scanning/alerts", opts), { ...ghOpts(opts), json: true });
  return SecretScanningAlertListSchema.parse(raw);
}

export async function getSecretScanningAlert(number: number, opts: GhOverridable = {}): Promise<SecretScanningAlert> {
  const raw = await runGh(["api", `repos/{owner}/{repo}/secret-scanning/alerts/${number}`], {
    ...ghOpts(opts),
    json: true,
  });
  return SecretScanningAlertSchema.parse(raw);
}

/**
 * Fetch check runs for a ref (branch name or commit SHA) via the REST API
 * `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`. Returns up to 100
 * runs — sufficient for any real CI setup. Does not paginate: callers treat
 * this as a best-effort snapshot, not an exhaustive list.
 *
 * A 403/404 (no Actions access, or repo without checks) should be treated by
 * the caller as "no checks" — same fail-soft pattern as the alert endpoints.
 */
export async function getCheckRuns(ref: string, opts: GhOverridable = {}): Promise<CheckRun[]> {
  const raw = await runGh(["api", `repos/{owner}/{repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`], {
    ...ghOpts(opts),
    json: true,
  });
  return CheckRunsResponseSchema.parse(raw).check_runs;
}

const URL_RE = /https?:\/\/\S+/g;

function lastUrl(stdout: string): string {
  const matches = stdout.match(URL_RE);
  if (!matches || matches.length === 0) {
    throw new Error(`gh did not return a URL on stdout:\n${stdout}`);
  }
  // Trim trailing punctuation that some shells/output may include.
  return (matches[matches.length - 1] ?? "").replace(/[.,)\]]+$/, "");
}

function parseIssueNumber(url: string): number {
  const m = url.match(/\/issues\/(\d+)/);
  if (!m) throw new Error(`could not parse issue number from URL: ${url}`);
  return Number(m[1]);
}

function parsePrNumber(url: string): number {
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`could not parse pull-request number from URL: ${url}`);
  return Number(m[1]);
}
