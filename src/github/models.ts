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
  })
  .loose();
export type PullRequest = z.infer<typeof PullRequestSchema>;
