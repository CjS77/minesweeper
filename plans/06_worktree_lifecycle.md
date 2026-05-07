# 06 — Worktree lifecycle helpers
## Status: done

## Context
Each issue gets its own `git worktree` under `MINESWEEPER_WORKTREE_PATH`.
The parent daemon creates worktrees and is the *only* process that
removes them; the child runs entirely inside one. We need a small,
well-tested helper module for the three operations we'll do.

## Scope (in)
- `src/worktree.ts` — pure-function helpers built on `execa`:
  - `addWorktree({ repoRoot, worktreesRoot, branchName }): Promise<{ path: string; branch: string }>`
    Runs `git worktree add -b {branch} {worktreesRoot}/{branch}` from
    `repoRoot`. Branch name should be sanitised (no slashes that would
    create nested dirs unexpectedly — actually slashes are fine, but
    spaces, `~`, `^`, `:`, `?`, `*`, `[`, control chars must be stripped).
  - `archiveAndRemove({ worktreePath, archiveRoot, issueNumber }): Promise<void>`
    Copies `${worktreePath}/.minesweeper` to
    `${archiveRoot}/{issueNumber}-{ISO8601}/`, then runs
    `git worktree remove --force {worktreePath}` from the worktree's
    parent repo.
  - `listOrphans(worktreesRoot): Promise<{ path: string; state?: State }[]>`
    Scans the worktrees root, reads `.minesweeper/state.json` from each,
    returns a list. Used at daemon startup to detect crashes.
  - `sanitiseBranchName(input): string` — exported helper, used here and
    re-used in plan 07 for picking the branch name from the issue title. Check that the name matches the pattern `{repo slug}-issue{\d+}`
- Unit tests using a temp git repo created in `beforeEach` (real `git init`,
  not mocks — `execa` against a real temp dir).

## Scope (out)
- Picking the branch name from issue content — handled in plan 07.
- Cleanup of stale archives — manual for now; can add a `gc` subcommand
  later.

## Critical files
- `src/worktree.ts`
- `src/__tests__/worktree.test.ts`

## Acceptance criteria
- `addWorktree` creates a real worktree at the expected path, with the
  branch checked out, and the parent repo's `git worktree list` includes it.
- `archiveAndRemove` removes the worktree and leaves an archive directory
  with the `.minesweeper/` contents.
- `listOrphans` correctly enumerates worktrees with valid state.json and
  ignores ones without it.
- `sanitiseBranchName("Fix: bug in foo (issue!)")` returns something like
  `"fix-bug-in-foo-issue"`.

## Verification
1. `pnpm test`
2. Manual: in a scratch git repo, run a small script that calls
   `addWorktree` then `archiveAndRemove` and verify everything ends up where
   expected.
