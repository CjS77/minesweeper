import { z } from "zod";

export const UserSchema = z
  .object({
    login: z.string(),
    id: z.string().optional(),
    name: z.string().nullable().optional(),
    is_bot: z.boolean().optional(),
  })
  .loose();
export type User = z.infer<typeof UserSchema>;

export const LabelSchema = z
  .object({
    name: z.string(),
    id: z.string().optional(),
    description: z.string().nullable().optional(),
    color: z.string().optional(),
  })
  .loose();
export type Label = z.infer<typeof LabelSchema>;

export const IssueStateSchema = z.enum(["OPEN", "CLOSED"]);
export type IssueState = z.infer<typeof IssueStateSchema>;

export const PrStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);
export type PrState = z.infer<typeof PrStateSchema>;

export const CommentSchema = z
  .object({
    id: z.string(),
    author: UserSchema,
    body: z.string(),
    createdAt: z.iso.datetime(),
  })
  .loose();
export type Comment = z.infer<typeof CommentSchema>;

export const IssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    labels: z.array(LabelSchema),
    author: UserSchema,
    state: IssueStateSchema,
    url: z.url(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    comments: z.array(CommentSchema).optional(),
  })
  .loose();
export type Issue = z.infer<typeof IssueSchema>;

export const IssueListSchema = z.array(IssueSchema);

/**
 * State of a single PR review. `gh pr view --json reviews` returns
 * the GraphQL review state, which we model as the subset Minesweeper
 * actually keys on. `.loose()` lets unknown future values pass through
 * the broader `PrReviewSchema` because we filter in code by the
 * canonical strings (`"CHANGES_REQUESTED"` etc.).
 */
export const PrReviewStateSchema = z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
export type PrReviewState = z.infer<typeof PrReviewStateSchema>;

/**
 * `gh pr view --json reviewDecision` returns one of the GraphQL values
 * or the empty string when no decision is recorded yet. We normalise
 * the empty string to `null` so callers can rely on a clean
 * "undecided" sentinel.
 */
export const PrReviewDecisionSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
);
export type PrReviewDecision = z.infer<typeof PrReviewDecisionSchema>;

export const PrReviewSchema = z
  .object({
    id: z.string().optional(),
    author: UserSchema,
    body: z.string().optional().default(""),
    state: PrReviewStateSchema,
    submittedAt: z.iso.datetime().nullable().optional(),
  })
  .loose();
export type PrReview = z.infer<typeof PrReviewSchema>;

/**
 * Inline review-comment shape used by the PR-feedback poller. Each
 * entry is a synthetic single-comment "thread" derived from the REST
 * `/repos/{o}/{r}/pulls/{n}/comments` endpoint — see
 * {@link getReviewThreads}. `isResolved` is approximated as `false`
 * because REST does not expose thread resolution state; the
 * `prFeedbackProcessedAt` watermark on `state.json` deduplicates
 * already-handled comments across polls.
 */
export const PrReviewThreadCommentSchema = z
  .object({
    id: z.string().optional(),
    author: UserSchema,
    body: z.string(),
    createdAt: z.iso.datetime(),
    path: z.string().nullable().optional(),
    line: z.number().int().nullable().optional(),
  })
  .loose();
export type PrReviewThreadComment = z.infer<typeof PrReviewThreadCommentSchema>;

export const PrReviewThreadSchema = z
  .object({
    id: z.string().optional(),
    isResolved: z.boolean().optional().default(false),
    path: z.string().nullable().optional(),
    line: z.number().int().nullable().optional(),
    comments: z.array(PrReviewThreadCommentSchema).default([]),
  })
  .loose();
export type PrReviewThread = z.infer<typeof PrReviewThreadSchema>;

/**
 * REST user shape. The REST API returns `user.id` as a number whereas
 * `UserSchema` (modelled on the GraphQL projection that `gh pr view`
 * uses) expects a string, so we keep the REST variant separate rather
 * than relaxing the shared `UserSchema`.
 */
const RestUserSchema = z
  .object({
    login: z.string(),
    id: z.number().int().optional(),
  })
  .loose();

/**
 * Raw REST shape of a single PR review comment as returned by
 * `GET /repos/{o}/{r}/pulls/{n}/comments`. Normalised into a
 * {@link PrReviewThread} by `getReviewThreads`. Fields outside the set
 * Minesweeper keys on are passed through via `.loose()`.
 */
export const RestReviewCommentSchema = z
  .object({
    id: z.number().int(),
    user: RestUserSchema.nullable(),
    body: z.string(),
    created_at: z.iso.datetime(),
    path: z.string().nullable().optional(),
    line: z.number().int().nullable().optional(),
    original_line: z.number().int().nullable().optional(),
  })
  .loose();
export type RestReviewComment = z.infer<typeof RestReviewCommentSchema>;

export const PullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().optional(),
    url: z.url(),
    state: PrStateSchema.optional(),
    author: UserSchema.optional(),
    headRefName: z.string().optional(),
    baseRefName: z.string().optional(),
    isDraft: z.boolean().optional(),
    reviews: z.array(PrReviewSchema).optional(),
    reviewDecision: PrReviewDecisionSchema.optional(),
    comments: z.array(CommentSchema).optional(),
  })
  .loose();
export type PullRequest = z.infer<typeof PullRequestSchema>;
