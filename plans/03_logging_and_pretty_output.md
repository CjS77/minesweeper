# 03 — Logging & pretty output
## Status: done

## Context
The daemon needs to be **glanceable**: an operator should be able to look
at the terminal for two seconds and know whether anything is stuck or has
failed. We need both a human-friendly stdout layer and a structured
machine-parseable log file.

## Scope (in)
- `src/logging.ts` exporting:
  - `createLogger(opts)` — returns a `pino` logger that writes structured
    JSON to a file (`.minesweeper/logs/daemon.log` by default) and a
    pretty-formatted line to stdout via a custom transport.
  - `event(role, level, issueNumber, message, meta?)` — convenience for
    the one-line-per-event format defined in the master plan.
  - `spinner(role, issueNumber, message)` — `ora` wrapper that returns a
    handle with `.succeed()` / `.fail()` / `.warn()` / `.info()`.
- Per-role colour map and per-level emoji map, exported as constants so
  every callsite uses the same vocabulary.
- A `--quiet` flag honoured globally (suppresses INFO on stdout, never
  affects file logs).
- Unit tests for the formatter (snapshot-style: given inputs, expected
  ANSI-stripped output).

## Output contract
```
{HH:MM:SS} {emoji} {ROLE_COLOURED} #{issueNumber} — {message}
```

Roles: `daemon` (white), `planner` (cyan), `critic` (cyan-dim),
`assessor` (yellow), `refiner` (yellow), `executor` (blue),
`reviewer` (magenta).

Levels: `INFO` (no emoji or `🔍`), `OK` (`✅`), `WARN` (`⚠️`),
`ERROR` (`❌`). Plus role-specific status: `🚧` (working), `🚀` (success
artifact created).

When no `issueNumber` (e.g. daemon-level events), elide the `#N` segment.

## Scope (out)
- Live updating dashboards / panels — defer.
- Log rotation (pino-roll) — defer; daily rotation can come when logs
  start hurting.

## Critical files
- `src/logging.ts`
- `src/__tests__/logging.test.ts`

## Dependencies to add
- `chalk` (v5)
- `log-symbols`
- `ora`
- `pino`
- `pino-pretty` (used as a transport, not invoked directly)

## Acceptance criteria
- A trivial `cli.ts` change that calls `event("daemon", "INFO", null,
  "hello")` prints a coloured single line to stdout *and* appends a JSON
  object to the log file.
- ANSI codes disappear when stdout is not a TTY (chalk handles this; verify
  by piping to `cat`).
- `--quiet` removes INFO lines from stdout but keeps WARN/ERROR.
- The log file path is created if missing (so first run on a fresh worktree
  works).

## Verification
1. `pnpm test`
2. Manual: `node dist/cli.js run` — see at least one daemon line printed in
   colour with the right format. Pipe to `cat` and confirm no ANSI.
3. `cat .minesweeper/logs/daemon.log | jq` shows structured JSON.
