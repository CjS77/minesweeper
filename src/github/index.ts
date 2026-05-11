import {
  IssueListSchema,
  IssueSchema,
  LabelSchema,
  PullRequestSchema,
  type Issue,
  type Label,
  type PullRequest,
} from "./models.js";
import { z } from "zod";
import { runGh, type RunGhOptions } from "./process.js";

const RepoLabelListSchema = z.array(LabelSchema);
const PullRequestListSchema = z.array(PullRequestSchema);
const RepoOwnerResponseSchema = z.object({ owner: z.object({ login: z.string() }) });

export { GhError, GhMissingError, GhNotARepoError, runGh, type RunGhOptions } from "./process.js";
export {
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
  UserSchema,
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
  type User,
} from "./models.js";

const ISSUE_LIST_FIELDS = "number,title,body,labels,author,state,url,createdAt,updatedAt";
const ISSUE_VIEW_FIELDS = `${ISSUE_LIST_FIELDS},comments`;
const PR_LIST_FIELDS = "number,headRefName,baseRefName,state,author,url";
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},title,body,reviews,reviewDecision,reviewThreads,comments`;

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

export async function createIssue(opts: CreateIssueOptions): Promise<{ number: number; url: string }> {
  const args = ["issue", "create", "--title", opts.title, "--body", opts.body];
  if (opts.labels && opts.labels.length > 0) {
    args.push("--label", opts.labels.join(","));
  }
  const stdout = await runGh<string>(args, ghOpts(opts));
  const url = lastUrl(stdout);
  return { number: parseIssueNumber(url), url };
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
 * `gh pr view --json` with the full set of fields the PR-feedback
 * poller relies on, including `reviews`, `reviewDecision`,
 * `reviewThreads`, and `comments`.
 */
export async function getPullRequest(number: number, opts: GhOverridable = {}): Promise<PullRequest> {
  const raw = await runGh(["pr", "view", String(number), "--json", PR_VIEW_FIELDS], {
    ...ghOpts(opts),
    json: true,
  });
  return PullRequestSchema.parse(raw);
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
