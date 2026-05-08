The specification for the project is given is @README.md.

If you want the overall implementation plan, read `~/.claude/plans/i-need-an-application-snazzy-axolotl.md` first.

This plan is broken into smaller chunks, and saved in @plans/*.md.
Read @plans/00_index.md first to get a view of the plan structure.

When you start a new plan, change status to "In Progress".
If it's already marked as "Done", then tell the user and stop.

Once plans are complete, mark them as "## Status: done".

## Repo layout

Top-level:

- `src/` — TypeScript source. Entry points: `index.ts` (library exports) and `cli.ts` (the `minesweeper` binary).
- `prompts/` — Markdown prompt files for each Claude role (`planner.md`, `critic.md`, `executor.md`, `reviewer.md`,
  `assessor.md`, `refiner.md`). Loaded by `src/claude/roles.ts`.
- `plans/` — Sequenced implementation plans (`00_index.md` first, then `01..12_*.md`). See `CLAUDE.md` for status
  conventions.
- `.minesweeper/` — Runtime state for the daemon (`state.json`, `logs/`). Created at runtime; not for hand-editing.
- `README.md` — Product/architecture spec. Source of truth for behaviour.
- `.env.sample` — Template for the env vars consumed by `src/config.ts`.
- Tooling: `eslint.config.js`, `.prettierrc`, `tsconfig.json`, `vitest.config.ts`, `.github/` (CI).

Inside `src/`:

- `config.ts` — Env-driven config loader (zod-validated).
- `logging.ts` — `pino` structured logger + pretty stdout layer.
- `worktree.ts` — `git worktree` add/archive/remove helpers.
- `cli.ts` / `index.ts` — CLI entry and public exports.
- `github/` — Orchestrator-owned `gh` subprocess wrapper.
    - `process.ts` runs `gh`; `models.ts` holds typed responses; `index.ts` is the public surface;
      `__fixtures__/` for tests.
- `claude/` — Agent SDK wrapper.
    - `roles.ts` (role registry, loads `prompts/*.md`), `transcript.ts` (per-run transcript capture),
      `index.ts` (public `query()`-style API).
- `daemon/` — Long-running parent process (`minesweeper run`).
    - `index.ts` (entry), `poller.ts` (GitHub poll loop), `supervisor.ts` (spawns/tracks children),
      `eligibility.ts` (label-only filter; prompt-injection screen later).
- `child/` — Per-issue child process (`minesweeper handle <issue#>`).
    - `handler.ts` (top-level driver), `state.ts` (`.minesweeper/state.json` read/write), `modes/` (one file per mode —
      currently `planning.ts`, with `execution`, `assess`, `refine` to come).
- `__tests__/` (top-level and per-subdir) — Vitest tests colocated next to the modules they cover.

## Development conventions

In-code patterns this project uses. Apply them when writing new code so we don't re-derive them every session.

- **Line width: 120 characters** for source code and prose. Prettier (`.prettierrc`) is configured to match.

### TypeScript & modules

- ESM throughout (`"type": "module"`). Relative imports include `.js` extensions even though sources are `.ts` (NodeNext
  idiom): `import { loadConfig } from "./config.js"`.
- Use the `node:` prefix for Node stdlib (`node:fs`, `node:path`).
- `verbatimModuleSyntax` is on — use inline type-only imports: `import { type Config, loadConfig } from "./config.js"`.
- `interface` for option/dep shapes; `type` for unions, aliases, and zod-derived types.
- File names are camelCase (`handler.ts`). Constants are `SCREAMING_SNAKE_CASE`. Env vars are `MINESWEEPER_*`.

### Schemas as the source of truth

Anything parsed at a system boundary (env, on-disk JSON, GitHub responses) is a zod schema, and the TS type is
`z.infer<typeof Schema>` — don't hand-write a parallel `interface`. See `ConfigSchema`/`Config` in `src/config.ts`,
`StateSchema`/`State` in `src/child/state.ts`, response shapes in `src/github/models.ts`.

### Dependency injection

- Config, logger, and side-effecting deps are passed in as a `*Deps` / `*Options` object — not imported as module
  singletons. Examples: `PollerDeps` (`src/daemon/poller.ts`), `PlanningDeps` (`src/child/modes/planning.ts`),
  `HandleChildOptions` (`src/child/handler.ts`).
- `loadConfig()` is called once at the CLI entry (`src/cli.ts`) and threaded down. Don't call it from inside library
  functions.

### Errors & subprocesses

- Subprocesses use `execa`, not raw `child_process`. Pass `reject: false` and inspect `exitCode` / `stderr` so failures
  can be wrapped in our own error classes. See `src/github/process.ts`.
- Custom error classes extend `Error`, set `this.name`, and capture context (`stdout`, `stderr`, `exitCode`, `args`).
  Examples: `GhError`, `GhMissingError`, `GhNotARepoError`, `ConfigError`. Throw these — no Result types.

### Logging

- One `pino` logger per process, created at startup via `createLogger()` in `src/logging.ts`. JSON to file
  (`.minesweeper/logs/`), pretty layer to stdout.
- Prefer the structured helper `event(role, level, issueNumber, message, meta?)` over raw `logger.info(...)`. Roles are
  the const tuple in `src/logging.ts`.

### CLI shape

- `commander` with chained `.command(...).action(async () => { ... })`. New commands live in `src/commands/<name>.ts`
  and are registered in `src/cli.ts`.
- The `preAction` hook in `src/cli.ts` initialises the logger — don't re-initialise inside command actions.

### Function shape & comments

- Short, single-purpose functions. Functional style: `map` / `filter` / `reduce` chains over imperative `for` loops.
- Every module starts with a `/** ... */` block describing purpose, invariants, and lifecycle. Exported types and
  functions get JSDoc; small private helpers don't.
- Inline comments are reserved for non-obvious *why* (constraints, ordering hazards, regex caveats), not *what*.

### Testing (Vitest)

- Tests live in `__tests__/` colocated next to the module under test, named `<module>.test.ts`, one test file per source
  file.
- **Mock at the subprocess / SDK boundary, not at our own wrapper.** Use `vi.mock("execa")` for github tests and
  `vi.mock("@anthropic-ai/claude-agent-sdk")` for claude tests.
- For state-on-disk and worktree code, use real fs with `mkdtemp(join(tmpdir(), "minesweeper-..."))` per test and
  `rm(tmp, { recursive: true, force: true })` in `afterEach`. Don't mock fs.
- Fixtures (snapshots of external command output) live in `src/<area>/__fixtures__/` as JSON, loaded via
  `fileURLToPath(import.meta.url)` + `readFileSync`.
- Define small per-file helpers (`ok()`, `fail()`, `lastCall()`) at the top of the test file rather than sharing them
  across files.
- E2E suites that hit real `gh` / Claude live in `e2e.test.ts`, gated on `MINESWEEPER_E2E=1`, default-skipped via
  `describe.skip`.
- `it.each` for truth tables; `toMatchObject` for partial object matches; regex assertions for error messages.
