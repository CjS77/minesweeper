/**
 * CLI-managed extra authorised-reviewer allowlist.
 *
 * The PR-feedback poller (`src/daemon/pr_feedback.ts`) trusts a small
 * allowlist of GitHub logins: the repo owner plus every bare `@username`
 * in `CODEOWNERS` (see `src/codeowners.ts`). That set is fine for human
 * reviewers but can't authorise a bot like CodeRabbit, whose comments the
 * code owner curates with a `+1`. Rather than make the user wrangle env
 * vars or config JSON, this module persists an extra-logins list at
 * `<repoRoot>/.minesweeper/reviewers.json`, managed by the `minesweeper
 * reviewers` command, and unioned into the poller's allowlist at runtime.
 *
 * Invariants:
 *
 * - Logins are stored and returned lowercased, so callers compare without
 *   re-casing (matching `loadCodeownerLogins`).
 * - A login must look like a GitHub user or app login — `coderabbitai[bot]`
 *   is explicitly allowed (bot logins carry a `[bot]` suffix).
 * - A missing file is the empty allowlist, never an error.
 * - Writes are atomic (temp file + rename) so a crashed write can't leave
 *   a half-written file the daemon would fail to parse.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/** Worktree-relative path of the extra-reviewers file. */
export const REVIEWERS_FILE = join(".minesweeper", "reviewers.json");

export const ReviewersFileSchema = z.object({
  reviewers: z.array(z.string().min(1)).default([]),
});
export type ReviewersFile = z.infer<typeof ReviewersFileSchema>;

/**
 * A GitHub login: alphanumerics and hyphens, optionally suffixed with the
 * `[bot]` marker GitHub appends to app logins (e.g. `coderabbitai[bot]`).
 */
const LOGIN_PATTERN = /^[A-Za-z0-9-]+(\[bot\])?$/;

/** Throw on anything that doesn't look like a GitHub login. */
export function assertValidLogin(login: string): void {
  if (!LOGIN_PATTERN.test(login)) {
    throw new Error(`invalid GitHub login: ${JSON.stringify(login)} (expected e.g. "octocat" or "coderabbitai[bot]")`);
  }
}

function reviewersPath(repoRoot: string): string {
  return join(repoRoot, REVIEWERS_FILE);
}

/** Read and parse the file, returning `null` when it doesn't exist. */
async function readFileOrNull(repoRoot: string): Promise<ReviewersFile | null> {
  try {
    const raw = await fs.readFile(reviewersPath(repoRoot), "utf8");
    return ReviewersFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Load the extra reviewers as a lowercased set. Missing file → empty set.
 * Used by the poller to extend its allowlist.
 */
export async function loadExtraReviewers(repoRoot: string): Promise<Set<string>> {
  const file = await readFileOrNull(repoRoot);
  if (file === null) return new Set<string>();
  return new Set(file.reviewers.map((login) => login.toLowerCase()));
}

/** Return the persisted reviewers as a sorted, lowercased array. */
export async function listReviewers(repoRoot: string): Promise<string[]> {
  const set = await loadExtraReviewers(repoRoot);
  return [...set].sort();
}

/**
 * Add a login (validated, lowercased, deduped). Returns the full sorted
 * list afterwards. Idempotent — adding an existing login is a no-op write.
 */
export async function addReviewer(repoRoot: string, login: string): Promise<string[]> {
  assertValidLogin(login);
  const set = await loadExtraReviewers(repoRoot);
  set.add(login.toLowerCase());
  return persist(repoRoot, set);
}

/**
 * Remove a login (case-insensitive). Returns the full sorted list
 * afterwards. Removing an absent login is a no-op.
 */
export async function removeReviewer(repoRoot: string, login: string): Promise<string[]> {
  const set = await loadExtraReviewers(repoRoot);
  set.delete(login.toLowerCase());
  return persist(repoRoot, set);
}

async function persist(repoRoot: string, set: Set<string>): Promise<string[]> {
  const reviewers = [...set].sort();
  const dir = dirname(reviewersPath(repoRoot));
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJson(reviewersPath(repoRoot), ReviewersFileSchema.parse({ reviewers }));
  return reviewers;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const tmp = join(dir, `.${basename(path)}.tmp.${suffix}`);
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
