# 07 — Daemon: poller + supervisor
## Status: Not started

## Context
The parent daemon is the long-running process the operator launches. It
polls GitHub on an interval, decides which issues to dispatch (eligibility
logic is stubbed in this plan and replaced in plan 10), and supervises
per-issue child processes whose cwd is the issue's worktree.

## Scope (in)
- `src/daemon/eligibility.ts` (placeholder for now): exports
  `isEligible(issue, config): boolean` that returns `true` only if the issue
  has the `MINESWEEPER_ALWAYS_FIX_LABEL` label. We'll layer the proper
  filter in plan 10. Intentionally narrow so we have something testable.
- `src/daemon/poller.ts`:
  - `pollOnce(deps): Promise<Issue[]>` — calls `github.listIssues`,
    filters with `isEligible`, returns the list (no side effects).
  - `runPollLoop(deps, intervalMs)` — `setInterval`-style loop using
    `setTimeout` so we can cleanly cancel; emits each eligible issue to
    the supervisor.
- `src/daemon/supervisor.ts`:
  - Maintains a `Map<issueNumber, Child>` of in-flight children.
  - `dispatch(issue)`:
    1. If already in-flight or worktree exists, skip.
    2. Compute `branchName = sanitiseBranchName(issue.title) +
       "-" + issue.number` (issue number always appended for uniqueness).
    3. `addWorktree(...)` and `initState(...)`.
    4. `execa.node("dist/cli.js", ["handle", String(issue.number)], {
       cwd: worktreePath, stdio: "inherit", detached: false })`.
    5. Add to in-flight map; on `exit`:
       - exit code 0 → `archiveAndRemove`, log success.
       - non-zero → `addLabel(issue.number, FAILED_LABEL)`, leave the
         worktree, log error with the worktree path.
    6. Enforce `MINESWEEPER_MAX_CONCURRENCY` (a queue with a configurable
       parallelism cap; v0 default 1 means strictly serial).
- `src/cli.ts` — `run` subcommand wires up `loadConfig()`, `createLogger()`,
  builds deps, starts the poll loop, registers a `SIGINT/SIGTERM` handler
  that stops accepting new work and waits for in-flight children to exit
  cleanly.
- Startup recovery: call `worktree.listOrphans()` on boot. For any worktree
  whose `state.status === "Failed"`, leave it alone. For any other state,
  re-dispatch (`execa.node` again with the same args) — the child knows how
  to resume from disk.
- Tests:
  - Unit tests for `pollOnce` with mocked `github` deps.
  - Supervisor tests with mocked `execa` and `worktree` to verify
    spawn/exit lifecycle and label-on-failure.

## Scope (out)
- The actual `handle` child code — that's plans 08–09.
- Prompt-injection eligibility — plan 11.
- Concurrency >1 in production use — works in code but default stays at 1
  until we trust the system.

## Critical files
- `src/daemon/poller.ts`
- `src/daemon/supervisor.ts`
- `src/daemon/eligibility.ts`
- Modifications to `src/cli.ts` (`run` subcommand)
- `src/daemon/__tests__/*.test.ts`

## Acceptance criteria
- `node dist/cli.js run` starts, polls once, logs a daemon line about how
  many eligible issues were found, then keeps running.
- Ctrl-C exits cleanly within 1 polling interval.
- With `MINESWEEPER_E2E=1` and a scratch repo with one labelled issue:
  daemon spawns a child that exits 0 (using a stub `handle` that just
  exits 0); supervisor archives + removes the worktree.
- Label-on-failure path verified by stubbing `handle` to exit 1.

## Verification
1. `pnpm test`
2. E2E: scratch repo + one labelled issue → start daemon → confirm child
   was spawned → confirm worktree was created → confirm cleanup.
3. Crash recovery: kill the daemon mid-flight, restart, confirm orphan is
   re-dispatched.
