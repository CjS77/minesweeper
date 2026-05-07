# 04 — GitHub wrapper (`src/github/`)
## Status: done

## Context
Per the architecture plan, the orchestrator owns all GitHub interactions
(except the executor's `git commit` carve-out). We wrap the `gh` CLI as a
subprocess, validate every JSON response with zod, and expose a small,
typed surface to the rest of the codebase.

## Scope (in)
- `src/github/process.ts` — `runGh(args, opts?)` using `execa`. Returns
  parsed JSON or stdout string. Captures stderr for error messages. Honours
  a `cwd` (so callers can target either the main checkout or a worktree).
- `src/github/models.ts` — zod schemas for `Issue`, `Label`, `User`,
  `PullRequest`. Types inferred via `z.infer`.
- `src/github/index.ts` — public API:
  - `listIssues(opts?: { state?: "open" | "closed" | "all"; limit?: number })`
  - `getIssue(number)`
  - `addLabel(number, label)`
  - `removeLabel(number, label)`
  - `createIssue({ title, body, labels })` → returns `{ number, url }`
  - `comment(number, body)`
  - `createPr({ base, head, title, body, draft? })` → returns `{ number, url }`
- Unit tests for `models.ts` against captured fixtures stored in
  `src/github/__fixtures__/`. Include intentionally noisy/extra fields to
  prove zod's `passthrough` / `strict` choice is right.
- A small integration test gated behind `MINESWEEPER_E2E=1` that hits a
  scratch repo with `gh issue list` — skipped by default.

## Scope (out)
- The eligibility logic (filtering by labels, prompt-injection check) —
  that's plan 10 and 11.
- Anything that calls the wrapper — wired up later.
- Pagination beyond what `gh ... --limit N` provides; v0 polls top-N issues.

## Concrete `gh` invocations

| API method | `gh` command |
|------------|--------------|
| `listIssues` | `gh issue list --state {state} --limit {N} --json number,title,body,labels,author,state,url,createdAt,updatedAt` |
| `getIssue` | `gh issue view {N} --json number,title,body,labels,author,state,url,comments` |
| `addLabel` | `gh issue edit {N} --add-label "{label}"` |
| `removeLabel` | `gh issue edit {N} --remove-label "{label}"` |
| `createIssue` | `gh issue create --title "{t}" --body "{b}" --label "{l1},{l2}"` (returns issue URL on stdout; parse to extract number) |
| `comment` | `gh issue comment {N} --body "{b}"` |
| `createPr` | `gh pr create --base {base} --head {head} --title "{t}" --body "{b}" [--draft]` (returns PR URL on stdout) |

## Critical files
- `src/github/process.ts`
- `src/github/models.ts`
- `src/github/index.ts`
- `src/github/__fixtures__/*.json`
- `src/github/__tests__/*.test.ts`

## Dependencies to add
- `execa`

## Acceptance criteria
- All public API methods are typed with zod-inferred return types.
- Calling any method when `gh` is not installed produces a clear error
  ("`gh` CLI not found — install from https://cli.github.com").
- Calling any method when not in a git repo produces a clear error.
- Fixture-based tests pass with ≥ 90% line coverage of `models.ts`.

## Verification
1. `pnpm test` — fixture tests pass.
2. With `MINESWEEPER_E2E=1` and `gh auth status` valid: integration test
   hits a real scratch repo and lists issues without crashing.
3. Type-level: import any function in `cli.ts` and confirm autocomplete
   shows the right shape.
