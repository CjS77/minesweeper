/**
 * GitHub API commit publisher.
 *
 * Creates commits through the GitHub REST and GraphQL APIs when authenticated
 * with a GitHub App installation token. Server-side commit signing means
 * commits show as Verified and are attributed to the App's bot identity —
 * independent of the host operator's git signing config, and accepted by repos
 * with a "Require signed commits" ruleset.
 *
 * The local worktree is still used by the executor subagent for editing and
 * local commits; this module only handles the *publish* step (pushing to
 * remote and opening the PR via the API instead of via git push + gh pr create).
 *
 * Secrets discipline: the installation token is never logged or embedded in
 * thrown error messages. `CommitPublisherError` captures only the HTTP status.
 */

import { z } from "zod";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

// ── Domain types ──────────────────────────────────────────────────────────────

/** A file to add or modify in a commit; `contents` is base64-encoded raw bytes. */
export interface FileAddition {
  path: string;
  /** Base64-encoded file content. */
  contents: string;
}

/** A file to delete in a commit. */
export interface FileDeletion {
  path: string;
}

/** The complete set of file changes carried by one API commit. */
export interface FileChanges {
  additions: FileAddition[];
  deletions: FileDeletion[];
}

/** Input to {@link CommitPublisher.createCommitOnBranch}. */
export interface CreateCommitInput {
  branchName: string;
  expectedHeadOid: string;
  headline: string;
  body: string;
  fileChanges: FileChanges;
}

/** Input to {@link CommitPublisher.createPullRequest}. */
export interface CreatePullRequestInput {
  base: string;
  head: string;
  title: string;
  body: string;
}

/** A created pull request's essential fields. */
export interface PullRequest {
  number: number;
  url: string;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const RefSchema = z.object({ object: z.object({ sha: z.string() }).loose() }).loose();

const CommitResultSchema = z
  .object({
    data: z
      .object({
        createCommitOnBranch: z.object({ commit: z.object({ oid: z.string() }).loose() }).loose(),
      })
      .loose()
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).loose()).optional(),
  })
  .loose();

const PullRequestResultSchema = z.object({ number: z.number(), html_url: z.string() }).loose();

// ── Error class ───────────────────────────────────────────────────────────────

export class CommitPublisherError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(status !== undefined ? `${message} (HTTP ${status})` : message);
    this.name = "CommitPublisherError";
    this.status = status;
  }
}

// ── Publisher interface ───────────────────────────────────────────────────────

export interface CommitPublisher {
  /** Resolve the SHA of the branch's current remote HEAD. */
  getRef(branch: string): Promise<string>;
  /** Create (or idempotently confirm) a branch ref pointing at `sha`. */
  createBranchRef(branch: string, sha: string): Promise<void>;
  /** Create a signed commit on the branch via GraphQL; returns the new commit oid. */
  createCommitOnBranch(input: CreateCommitInput): Promise<string>;
  /** Open a pull request from `head` into `base`; returns PR number and URL. */
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
}

export interface CreateCommitPublisherOptions {
  owner: string;
  name: string;
  /** A current installation access token, refreshed per-call. */
  getToken: () => Promise<string>;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Build a {@link CommitPublisher} that authenticates every call with a fresh
 * token from `getToken`. The token is fetched per-call so a mid-session token
 * refresh is always picked up without the caller needing to coordinate.
 */
export function createCommitPublisher(opts: CreateCommitPublisherOptions): CommitPublisher {
  const doFetch = opts.fetch ?? fetch;
  const { owner, name } = opts;

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await opts.getToken();
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * GitHub's own error text for a failed response, as ` — <message>`, or
   * `""` if the body has none. Only the API's `message`/`errors` fields are
   * surfaced; the request (which carries the token) is never echoed.
   */
  async function failureDetail(res: Response): Promise<string> {
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== "object" || body === null) return "";
    const message = "message" in body && typeof body.message === "string" ? body.message : "";
    const errors =
      "errors" in body && Array.isArray(body.errors)
        ? body.errors
            .map((e: unknown) =>
              typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? e.message : "",
            )
            .filter((m) => m.length > 0)
            .join("; ")
        : "";
    const detail = [message, errors].filter((part) => part.length > 0).join(": ");
    return detail.length > 0 ? ` — ${detail}` : "";
  }

  async function githubJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${GITHUB_API}${path}`, {
        ...init,
        headers: { ...(await authHeaders()), ...init?.headers },
      });
    } catch (err) {
      throw new CommitPublisherError(`request to ${path} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new CommitPublisherError(`GitHub request to ${path} was rejected${await failureDetail(res)}`, res.status);
    }
    const body: unknown = await res.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new CommitPublisherError(`GitHub response for ${path} did not match expected shape`);
    }
    return parsed.data;
  }

  async function getRef(branch: string): Promise<string> {
    const result = await githubJson(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`, RefSchema);
    return result.object.sha;
  }

  async function createBranchRef(branch: string, sha: string): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(`${GITHUB_API}/repos/${owner}/${name}/git/refs`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      });
    } catch (err) {
      throw new CommitPublisherError(`createBranchRef network error: ${(err as Error).message}`);
    }
    if (res.ok) return;
    // Only swallow the "Reference already exists" 422 — other 422 bodies (e.g. "Object does not exist", meaning the
    // anchor sha was never pushed) must surface, and must carry GitHub's message: the status alone cannot tell those
    // two apart, and the caller would otherwise fail confusingly later at createCommitOnBranch.
    const detail = await failureDetail(res);
    if (res.status === 422 && detail === " — Reference already exists") return;
    throw new CommitPublisherError(`createBranchRef was rejected${detail}`, res.status);
  }

  async function createCommitOnBranch(input: CreateCommitInput): Promise<string> {
    const mutation = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
  }
}`;
    const variables = {
      input: {
        branch: { repositoryNameWithOwner: `${owner}/${name}`, branchName: input.branchName },
        message: { headline: input.headline, body: input.body },
        expectedHeadOid: input.expectedHeadOid,
        fileChanges: input.fileChanges,
      },
    };

    let res: Response;
    try {
      res = await doFetch(GITHUB_GRAPHQL, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ query: mutation, variables }),
      });
    } catch (err) {
      throw new CommitPublisherError(`GraphQL createCommitOnBranch network error: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new CommitPublisherError(`GraphQL request rejected`, res.status);
    }
    const body: unknown = await res.json();
    const parsed = CommitResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new CommitPublisherError("GraphQL response did not match expected shape");
    }
    const result = parsed.data;
    if (result.errors && result.errors.length > 0) {
      throw new CommitPublisherError(`GraphQL errors: ${result.errors.map((e) => e.message).join("; ")}`);
    }
    const oid = result.data?.createCommitOnBranch?.commit?.oid;
    if (!oid) {
      throw new CommitPublisherError("GraphQL response missing commit oid");
    }
    return oid;
  }

  async function createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const result = await githubJson(`/repos/${owner}/${name}/pulls`, PullRequestResultSchema, {
      method: "POST",
      body: JSON.stringify({ base: input.base, head: input.head, title: input.title, body: input.body }),
    });
    return { number: result.number, url: result.html_url };
  }

  return { getRef, createBranchRef, createCommitOnBranch, createPullRequest };
}
