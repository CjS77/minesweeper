/**
 * Shared helpers for publishing local git changes to GitHub via the API.
 *
 * `computeFileChanges` converts `git diff --name-status` output into the
 * `FileChanges` shape the GraphQL `createCommitOnBranch` mutation expects.
 * `publishIncrementalCommit` wraps the full publish cycle for PR-feedback and
 * CI-failure rounds where the branch already exists on the remote.
 */

import { type CommitPublisher, type FileChanges } from "../../github/commit.js";
import { type GitOps } from "./execution.js";

/**
 * Build a {@link FileChanges} object from `git diff --name-status --find-renames`
 * output between `from` and `to`. Added/modified/type-changed files become
 * additions (blob read from `to`); deleted files become deletions; renames
 * become a delete of the old path plus an addition of the new path; copies
 * become an addition of the new path.
 */
export async function computeFileChanges(git: GitOps, cwd: string, from: string, to: string): Promise<FileChanges> {
  const raw = await git.diffNameStatus(cwd, from, to);
  if (!raw.trim()) return { additions: [], deletions: [] };

  const additions: FileChanges["additions"] = [];
  const deletions: FileChanges["deletions"] = [];

  for (const line of raw.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    const code = status[0];

    if (code === "A" || code === "M" || code === "T") {
      const filePath = parts[1];
      if (!filePath) continue;
      const contents = await git.readBlob(cwd, to, filePath);
      additions.push({ path: filePath, contents });
    } else if (code === "D") {
      const filePath = parts[1];
      if (!filePath) continue;
      deletions.push({ path: filePath });
    } else if (code === "R") {
      // Rename: <status>\t<old-path>\t<new-path>
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath) deletions.push({ path: oldPath });
      if (newPath) {
        const contents = await git.readBlob(cwd, to, newPath);
        additions.push({ path: newPath, contents });
      }
    } else if (code === "C") {
      // Copy: <status>\t<source-path>\t<dest-path>
      const newPath = parts[2];
      if (newPath) {
        const contents = await git.readBlob(cwd, to, newPath);
        additions.push({ path: newPath, contents });
      }
    }
  }

  return { additions, deletions };
}

export interface PublishIncrementalCommitOptions {
  publisher: CommitPublisher;
  git: GitOps;
  cwd: string;
  branch: string;
  /** Local ref for the start of the diff (typically `headBefore`). */
  from: string;
  /** Local ref for the end of the diff (typically `headAfter` or `"HEAD"`). */
  to: string;
  headline: string;
}

/**
 * Publish the local `from..to` diff as a single signed API commit on top of
 * the branch's current remote HEAD.
 *
 * The remote HEAD is read fresh via `getRef` each call so a concurrent push is
 * detected immediately. The `from..to` delta applied on the remote HEAD yields
 * the same tree as local `to` because the remote is in lockstep with local
 * `from` (no out-of-band pushes between `headBefore` and now).
 */
export async function publishIncrementalCommit(opts: PublishIncrementalCommitOptions): Promise<void> {
  const { publisher, git, cwd, branch, from, to, headline } = opts;
  const remoteHead = await publisher.getRef(branch);
  const fileChanges = await computeFileChanges(git, cwd, from, to);
  const body = await git.subjects(cwd, from);
  await publisher.createCommitOnBranch({
    branchName: branch,
    expectedHeadOid: remoteHead,
    headline,
    body,
    fileChanges,
  });
}
