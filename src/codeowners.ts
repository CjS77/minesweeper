/**
 * Minimal `CODEOWNERS` parser.
 *
 * The PR-feedback poller (`src/daemon/pr_feedback.ts`) trusts a small
 * allowlist of GitHub logins when deciding whether a "changes
 * requested" review or a thread comment should trigger a fresh
 * executor round. That allowlist is the repo owner plus every bare
 * `@username` mentioned in `CODEOWNERS`. This module is the parser.
 *
 * Scope intentionally narrow:
 *
 * - We accept the first existing of `.github/CODEOWNERS`,
 *   `CODEOWNERS`, and `docs/CODEOWNERS` — the three locations GitHub
 *   itself searches.
 * - We extract every `@user` token from non-comment lines, ignore the
 *   leading path glob, and skip anything containing a `/` (team handles
 *   like `@org/team`). Resolving teams to member logins is deferred.
 * - Missing file → empty set. Reading errors other than ENOENT bubble.
 *
 * Returns lowercased logins so callers can compare without re-casing.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

const CANDIDATE_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/**
 * Load the set of bare `@username` logins from the repo's CODEOWNERS
 * file. The result is lowercased and deduped.
 */
export async function loadCodeownerLogins(repoRoot: string): Promise<Set<string>> {
  const raw = await readFirstExisting(repoRoot);
  if (raw === null) return new Set<string>();
  return parseCodeowners(raw);
}

/**
 * Pure parser, exposed for tests. Strips comments, tokenises on
 * whitespace, keeps tokens starting with `@`, and rejects ones that
 * contain a `/` (team handles).
 */
export function parseCodeowners(content: string): Set<string> {
  const logins = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const withoutComment = line.replace(/#.*$/, "").trim();
    if (withoutComment.length === 0) continue;
    const tokens = withoutComment.split(/\s+/);
    // First token is the path glob; the rest are owners.
    for (const token of tokens.slice(1)) {
      if (!token.startsWith("@")) continue;
      const handle = token.slice(1);
      if (handle.length === 0) continue;
      if (handle.includes("/")) continue;
      logins.add(handle.toLowerCase());
    }
  }
  return logins;
}

async function readFirstExisting(repoRoot: string): Promise<string | null> {
  for (const candidate of CANDIDATE_PATHS) {
    try {
      return await fs.readFile(join(repoRoot, candidate), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}
