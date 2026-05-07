# 02 — Config + state schemas
## Status: Not started

## Context
Minesweeper is configured entirely via `MINESWEEPER_*` env vars (per the
spec) and persists per-issue state to `.minesweeper/state.json` inside the
worktree. Both surfaces need typed, validated schemas before any feature
code can rely on them. We use **zod** as the single source of truth — types
flow from schemas, defaults live alongside.

## Scope (in)
- `src/config.ts`:
  - One zod schema covering every `MINESWEEPER_*` env var listed in the
    README plus the new ones we identified (worktree path, poll interval,
    PR base, max concurrency, failed label).
  - `loadConfig()` reads `process.env`, applies defaults, validates,
    returns a `Config` object with sensible types (numbers as numbers,
    durations parsed to milliseconds, etc.).
  - Useful error messages on validation failure (point at which env var
    is wrong).
- `src/child/state.ts`:
  - Zod schemas for `State` (the union of planning + execution shapes
    described in the README).
  - `readState(cwd)` / `writeState(cwd, state)` / `initState(cwd, mode)` —
    all operate on `${cwd}/.minesweeper/state.json`.
  - Atomic writes (write to temp file, rename) so a crash mid-write can't
    corrupt state.
- Unit tests for both modules.

## Scope (out)
- Anything that *uses* config or state — that lives in later plans.
- Migrations between state schema versions (we'll add a `version` field
  and bump it lazily when needed).

## Env vars and defaults (canonical list)

| Var | Type | Default |
|-----|------|---------|
| `MINESWEEPER_DEFAULT_ELIGIBLE` | bool | `false` |
| `MINESWEEPER_ALWAYS_FIX_LABEL` | string | `"autofix"` |
| `MINESWEEPER_NEVER_FIX_LABEL` | string | `"manual"` |
| `MINESWEEPER_POSSIBLY_DANGEROUS_LABEL` | string | `"possiblyDangerous"` |
| `MINESWEEPER_MANUALLY_APPROVED_LABEL` | string | `"manuallyReviewed"` |
| `MINESWEEPER_FAILED_LABEL` | string | `"minesweeperFailed"` |
| `MINESWEEPER_SUBTASK_LABEL` | string | `"subtask"` |
| `MINESWEEPER_MAX_PLANNING_ITERATIONS` | int ≥ 1 | `5` |
| `MINESWEEPER_MAX_REVIEW_ROUNDS` | int ≥ 1 | `3` |
| `MINESWEEPER_ELIGIBILITY_AGENT` | string | `"haiku"` |
| `MINESWEEPER_PLANNING_AGENT` | string | `"opus"` |
| `MINESWEEPER_REVIEW_AGENT` | string | `"sonnet"` (was `"codex"`) |
| `MINESWEEPER_EXECUTION_AGENT` | string | `"opus"` |
| `MINESWEEPER_WORKTREE_PATH` | path | `"/tmp/minesweeper"` |
| `MINESWEEPER_PR_BASE_BRANCH` | string | `"main"` |
| `MINESWEEPER_POLL_INTERVAL_SECONDS` | int ≥ 30 | `300` |
| `MINESWEEPER_MAX_CONCURRENCY` | int ≥ 1 | `1` |

## State schema sketch

```ts
const State = z.object({
  version: z.literal(1),
  issueNumber: z.number().int(),
  branchName: z.string(),
  mode: z.enum(["Planning", "Execution", "Delegated"]),
  status: z.enum([
    "InProgress",
    "Writing", "Reviewing", "FixingReviewComments",
    "Complete",
    "Failed",
  ]),
  iterations: z.number().int().min(0),
  maxIterations: z.number().int().min(1),
  assessment: z.enum(["Execute", "Refine"]).nullable(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

## Critical files
- `src/config.ts`
- `src/child/state.ts`
- `src/__tests__/config.test.ts`
- `src/__tests__/state.test.ts`

## Acceptance criteria
- `loadConfig()` returns the right shape with all defaults when no env
  vars are set.
- Invalid env values (e.g. `MINESWEEPER_MAX_PLANNING_ITERATIONS=foo`)
  raise an error pointing at the offending variable.
- `initState(tmpDir, "Planning")` creates a valid state.json.
- `writeState` is atomic (no truncated files visible mid-write — verified
  by writing a large state in a loop and concurrently reading).

## Verification
1. `pnpm test` passes new tests.
2. `pnpm typecheck` passes.
3. Manually: in a tmp dir, `node -e "require('./dist/config.js').loadConfig()"`
   succeeds with no env vars; fails clearly with bad values.
