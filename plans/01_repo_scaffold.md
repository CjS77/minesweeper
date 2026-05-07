# 01 — Repo scaffold & CLI stubs
## Status: done

## Context
Greenfield TypeScript project. We need the skeleton in place before any
feature work: package manifests, build/lint/test config, CI, and a CLI entry
point that prints sensible help for the three subcommands. This is pure
plumbing — no business logic.

## Scope (in)
- `package.json` — `type: "module"`, Node 20+ engine, `bin: "minesweeper"
  → dist/cli.js`, scripts: `build`, `dev`, `test`, `lint`, `format`,
  `typecheck`.
- `tsconfig.json` — strict, ESM, `moduleResolution: "bundler"` (or
  `"NodeNext"` if simpler), output to `dist/`.
- `.gitignore` — `node_modules`, `dist`, `.minesweeper/`,
  `coverage/`, `.env`, `*.log`.
- `eslint.config.js` (flat config) + `.prettierrc`.
- `vitest.config.ts` with one passing smoke test.
- `.github/workflows/ci.yml` — `pnpm install` (or npm — pick one and
  document), `pnpm typecheck && pnpm lint && pnpm test`. Runs on every PR
  and on push to `main`.
- `src/cli.ts` — uses `commander`, declares three subcommands:
  - `run` (long-running daemon — currently prints "TODO: not yet
    implemented" and exits 0)
  - `handle <issue>` (child worker — same)
  - `once <issue>` (debug one-shot — same)
- `src/index.ts` re-exporting nothing yet (placeholder for future programmatic
  API).

## Scope (out)
- Any actual daemon, child, claude, or github logic — only stubs.
- README updates beyond a one-line "WIP" note (deferred to plan 10).

## Critical files to create
- `package.json`
- `tsconfig.json`
- `.gitignore`
- `eslint.config.js`
- `.prettierrc`
- `vitest.config.ts`
- `.github/workflows/ci.yml`
- `src/cli.ts`
- `src/index.ts`
- `src/__tests__/smoke.test.ts`

## Dependencies to add
- Runtime: `commander`
- Dev: `typescript`, `tsx`, `vitest`, `@types/node`, `eslint`,
  `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`,
  `prettier`, `eslint-config-prettier`

## Acceptance criteria
- `pnpm install` (or chosen package manager) succeeds clean.
- `pnpm build` produces `dist/cli.js`.
- `node dist/cli.js --help` lists `run`, `handle`, `once`.
- `node dist/cli.js run` prints a TODO line and exits 0.
- `pnpm typecheck` passes.
- `pnpm lint` passes.
- `pnpm test` passes (smoke test asserts `1 + 1 === 2`).
- CI workflow file is valid (validated by GitHub on push, but locally check
  with `act` or just visual review).

## Verification
1. `pnpm install`
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
3. `node dist/cli.js --help` — confirm three subcommands shown
4. `node dist/cli.js run` — confirm TODO message
5. Commit and open PR — confirm CI is green
