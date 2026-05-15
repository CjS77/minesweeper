/**
 * Worktree lifecycle helpers.
 *
 * Each issue Minesweeper handles runs inside its own `git worktree`. The parent daemon owns
 * the lifecycle (create on dispatch, archive + remove on completion) and the child works
 * exclusively inside the worktree. These helpers wrap the operations the daemon needs:
 * `addWorktree`, `archiveWorktreeState` + `removeWorktree` (the two halves of teardown), and
 * `listOrphans` (used at startup to recover from crashes).
 *
 * `sanitiseBranchName` is exported for reuse — plan 07 derives the per-issue branch name from
 * the issue title and feeds it through the same sanitiser.
 */

import { promises as fs, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import { STATE_DIR, STATE_FILE, StateSchema, migrateIfNeeded, type State, type WorkItemKind } from "./child/state.js";

export interface AddWorktreeOptions {
  /** Absolute path to the main repo (the one that owns the worktrees). */
  repoRoot: string;
  /** Directory under which the new worktree directory will be created. Created if missing. */
  worktreesRoot: string;
  /** Free-form branch name; will be passed through {@link sanitiseBranchName}. */
  branchName: string;
}

export interface AddedWorktree {
  /** Absolute path of the new worktree, equal to `worktreesRoot/branch`. */
  path: string;
  /** Sanitised branch name actually checked out in the worktree. */
  branch: string;
}

export interface ArchiveWorktreeStateOptions {
  /** Absolute path of the worktree whose `.minesweeper/` directory will be archived. */
  worktreePath: string;
  /** Directory under which `${kind}${issueNumber}-${ISO}` archive subdirs are created. */
  archiveRoot: string;
  /** Issue / alert number used to namespace the archive subdir. */
  issueNumber: number;
  /**
   * Work-item kind. Defaults to `"issue"` for back-compat. Non-issue kinds
   * are prefixed onto the archive directory name so issue #N and alert #N
   * never collide on disk.
   */
  kind?: WorkItemKind;
}

export interface OrphanedWorktree {
  /** Absolute path of the worktree directory. */
  path: string;
  /**
   * Parsed `state.json` from the worktree's `.minesweeper/`. Always present in results
   * returned by {@link listOrphans} — entries without a valid state are filtered out.
   */
  state?: State;
}

/**
 * Normalise an arbitrary string into a valid git branch / directory name.
 *
 * - Lowercases, replaces any character outside `[a-z0-9/_.-]` with `-`, then collapses
 *   runs of `-` and `.` and trims leading/trailing `-`, `.`, `/`.
 * - Slashes are preserved so namespaced refs (e.g. `feature/foo`) survive.
 * - Throws if the result is empty, or if it would produce a `.lock` ref — git uses
 *   `<ref>.lock` files as lock sentinels and rejects refs ending in `.lock`.
 */
export function sanitiseBranchName(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("sanitiseBranchName requires a string");
  }
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9/_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[-./]+|[-./]+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(`Branch name "${input}" sanitises to an empty string`);
  }
  if (cleaned.endsWith(".lock") || cleaned.includes(".lock/")) {
    throw new Error(`Branch name "${input}" sanitises to a forbidden ".lock" ref: "${cleaned}"`);
  }
  return cleaned;
}

/**
 * Create a new worktree at `worktreesRoot/<sanitised-branch>` with a freshly created
 * branch checked out (`git worktree add -b`).
 *
 * Self-heals from a stale branch left behind by a previous run whose worktree directory
 * was removed but whose `git branch -D` step never ran (e.g. the daemon was killed during
 * teardown, or `removeWorktree` failed after deleting the dir). If the per-issue branch
 * already exists *and* no live worktree is using it, the branch is force-deleted and the
 * worktree creation is retried — otherwise the original git error is propagated so two
 * concurrent dispatches cannot fight over a checked-out branch.
 */
export async function addWorktree(opts: AddWorktreeOptions): Promise<AddedWorktree> {
  const branch = sanitiseBranchName(opts.branchName);
  const path = join(opts.worktreesRoot, branch);
  await fs.mkdir(opts.worktreesRoot, { recursive: true });

  const first = await execa("git", ["worktree", "add", "-b", branch, path], {
    cwd: opts.repoRoot,
    reject: false,
  });
  if (first.exitCode === 0) return { path, branch };

  if (isBranchAlreadyExistsError(first.stderr, branch) && !(await isBranchCheckedOut(opts.repoRoot, branch))) {
    await execa("git", ["branch", "-D", branch], { cwd: opts.repoRoot });
    await execa("git", ["worktree", "add", "-b", branch, path], { cwd: opts.repoRoot });
    return { path, branch };
  }

  throw new Error(
    `git worktree add -b ${branch} ${path} failed (exit ${first.exitCode ?? "?"}): ${first.stderr.trim()}`,
  );
}

function isBranchAlreadyExistsError(stderr: string, branch: string): boolean {
  // git: "fatal: a branch named 'foo' already exists"
  return new RegExp(`a branch named '${escapeRegExp(branch)}' already exists`, "i").test(stderr);
}

/**
 * True iff the branch is currently checked out in any worktree of `repoRoot`. Uses
 * `git worktree list --porcelain`, whose per-worktree blocks include a line
 * `branch refs/heads/<name>` for non-detached worktrees.
 */
async function isBranchCheckedOut(repoRoot: string, branch: string): Promise<boolean> {
  const { stdout } = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const needle = `branch refs/heads/${branch}`;
  return stdout.split(/\r?\n/).some((line) => line.trim() === needle);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Copy the worktree's `.minesweeper/` directory (state, transcripts, traces) to
 * `archiveRoot/{issueNumber}-{ISO8601 timestamp}/`. Returns the absolute path of the created
 * archive directory.
 *
 * If `.minesweeper/` is absent (e.g. the child crashed before `initState`) an empty archive
 * directory is still created so the issue has a record.
 *
 * Pair with {@link removeWorktree} to fully tear down a finished issue: archive first, then
 * remove — the inverse order would delete the source the archive copies from.
 */
export async function archiveWorktreeState(opts: ArchiveWorktreeStateOptions): Promise<string> {
  const kind = opts.kind ?? "issue";
  const prefix = kind === "issue" ? "" : `${kind}-`;
  const archiveDir = join(opts.archiveRoot, `${prefix}${opts.issueNumber}-${new Date().toISOString()}`);
  await fs.mkdir(opts.archiveRoot, { recursive: true });

  const sourceDir = join(opts.worktreePath, STATE_DIR);
  if (await pathExists(sourceDir)) {
    await fs.cp(sourceDir, archiveDir, { recursive: true });
  } else {
    await fs.mkdir(archiveDir, { recursive: true });
  }
  return archiveDir;
}

/**
 * Remove a git worktree and the local branch that was checked out in it.
 *
 * Always called by the parent daemon — never the child — so the child's process holds no
 * handles on the directory by the time we run.
 *
 * The owning repo is discovered from the worktree itself via `git rev-parse --git-common-dir`,
 * so callers don't need to plumb `repoRoot` through. `--force` is used because the worktree
 * may legitimately contain uncommitted files (e.g. in-flight state writes) at teardown time.
 *
 * After the worktree is deregistered the function also runs `git branch -D <branch>` in the
 * main repo to delete the per-issue branch that `addWorktree` created — otherwise every issue
 * Minesweeper handles leaves a stale branch behind. A `not found` failure from `branch -D` is
 * treated as success (the branch was already gone). Detached-HEAD worktrees skip the delete
 * step entirely because there is no branch ref to remove.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  const mainRepo = await findMainRepoFromWorktree(worktreePath);
  const branch = await resolveWorktreeBranch(worktreePath);
  await execa("git", ["worktree", "remove", "--force", worktreePath], { cwd: mainRepo });
  if (branch !== null) {
    await deleteBranchIfPresent(mainRepo, branch);
  }
}

/**
 * Read the currently-checked-out branch of `worktreePath`. Returns `null` for a detached HEAD
 * (where `git rev-parse --abbrev-ref HEAD` prints the literal string `HEAD`) — in that case
 * there is no branch ref to delete after the worktree is removed.
 */
async function resolveWorktreeBranch(worktreePath: string): Promise<string | null> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
  const branch = stdout.trim();
  return branch === "" || branch === "HEAD" ? null : branch;
}

/**
 * Run `git branch -D <branch>` in `mainRepo`. Swallow the failure if git reports the branch
 * does not exist (`error: branch '<name>' not found.`) — the goal is idempotent cleanup. Any
 * other failure is propagated so the caller can log it.
 *
 * `-D` (force) rather than `-d` because the per-issue branch is local-only and may legitimately
 * carry unmerged commits at teardown time (e.g. assessment ran but the PR was never opened).
 */
async function deleteBranchIfPresent(mainRepo: string, branch: string): Promise<void> {
  const result = await execa("git", ["branch", "-D", branch], { cwd: mainRepo, reject: false });
  if (result.exitCode === 0) return;
  if (/not found/i.test(result.stderr)) return;
  throw new Error(`git branch -D ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

/**
 * Enumerate worktree directories that look like they belonged to a previous, possibly crashed,
 * run. Used by the daemon at startup to decide whether to resume or archive each one.
 *
 * Returns one entry per immediate subdirectory of `worktreesRoot` whose
 * `.minesweeper/state.json` exists, parses as JSON, and validates against {@link StateSchema}.
 * Anything else (no state file, malformed JSON, schema mismatch) is silently filtered — those
 * directories are not Minesweeper-managed (or are too corrupt to recover) and the caller should
 * not act on them. A missing `worktreesRoot` returns `[]` rather than throwing.
 */
export async function listOrphans(worktreesRoot: string): Promise<OrphanedWorktree[]> {
  const entries = await readDirOrEmpty(worktreesRoot);
  const orphans = await Promise.all(
    entries
      .filter((ent) => ent.isDirectory())
      .map(async (ent): Promise<OrphanedWorktree | null> => {
        const path = join(worktreesRoot, ent.name);
        const stateFile = join(path, STATE_DIR, STATE_FILE);
        const state = await readStateOrNull(stateFile);
        if (state === null) return null;
        return { path, state };
      }),
  );
  return orphans.filter((o): o is OrphanedWorktree => o !== null);
}

async function readDirOrEmpty(path: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readStateOrNull(path: string): Promise<State | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return StateSchema.parse(migrateIfNeeded(JSON.parse(raw)));
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function findMainRepoFromWorktree(worktreePath: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--git-common-dir"], { cwd: worktreePath });
  const raw = stdout.trim();
  const commonDir = isAbsolute(raw) ? raw : resolve(worktreePath, raw);
  return dirname(commonDir);
}
