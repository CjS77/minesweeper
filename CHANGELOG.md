# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-05-11

### Added
- `minesweeper issue new` (alias `issue create`) command. Accepts free
  text on the CLI, via `-f <path>`, or piped on stdin; a Sonnet-backed
  `issuewriter` subagent shapes it into the autofix issue template,
  optionally opens it in `$EDITOR` for review (skip with `-y`), and
  files the issue through `gh` with the `autofix` label applied (use
  `-n` to suppress). New `MINESWEEPER_ISSUE_WRITER_AGENT` config slot,
  defaulting to `claude-sonnet-4-6`.
- `tryFix` label tier in the eligibility filter. The label opts an
  issue in but always routes it through the Haiku screener (unlike
  `alwaysFix` / `manuallyApproved`, which bypass screening).
  Configurable via `MINESWEEPER_TRY_FIX_LABEL` (default `tryFix`). The
  label is propagated to refined sub-issues, which are themselves
  re-screened.
- Cron-aware poll scheduling. Operators can set one or more cron
  expressions in `~/.minesweeper/config.json` (`schedule` field) to
  drive the daemon's poll loop; the existing fixed-interval driver
  remains as the fallback when nothing is configured. New
  `pollCooldownSeconds` gate (default 120 s; env
  `MINESWEEPER_POLL_COOLDOWN`) prevents overlapping schedules from
  double-polling within the cooldown window. New
  `MINESWEEPER_CONFIG_FILE` env var to pick a non-default config path.
- `log view --issue <n>` resolver that locates transcripts under
  `MINESWEEPER_WORKTREE_PATH` from both active worktrees (matched via
  `state.json.issueNumber`) and the archive (matched via the
  `{issueNumber}-` prefix). The positional argument now becomes an
  optional basename regex filter.

### Changed
- The eligibility screener prompt now catches the
  "wholesale destruction disguised as cleanup" attack class — deletion
  framed as optimisation, simplification, or minification when the
  request would leave only a trivial program behind.
- `log view` rendering: multi-file output gets dim banner separators
  with a fresh render context per file, `tool_result` blocks are
  collapsed to a header plus line count, `tool_use` blocks pretty-print
  their input bodies (Write/Edit content is now visible), empty or
  signature-only thinking blocks are skipped, and `🤖` / `👤`
  single-codepoint emojis replace the previous wider-glyph icons for
  better terminal/font compatibility.

### Fixed
- The Claude Agent SDK's native-binary resolver tries the musl tarball
  ahead of glibc with no actual libc detection, which caused
  `ENOENT /lib/ld-musl-x86_64.so.1` ("Claude Code native binary not
  found") on glibc systems once the optional musl dep was installed.
  npm `overrides` now alias the musl packages to the glibc tarballs
  for both x64 and arm64.

## [0.1.0] — 2026-05-08

Initial usable cut: a self-hosting agentic bughunter that polls
labelled GitHub issues, plans and executes fixes inside a per-issue
git worktree, and opens a pull request.

### Added
- TypeScript / Node 20 project scaffold with ESLint, Prettier, Vitest,
  and a GitHub Actions CI pipeline (typecheck, lint, format check,
  test, build).
- Zod-validated environment config loader and on-disk
  `.minesweeper/state.json` schema.
- Structured `pino` logger with a pretty stdout layer and a
  role-aware `event(role, level, issueNumber, ...)` helper.
- `gh` subprocess wrapper with typed response models and dedicated
  error classes (`GhError`, `GhMissingError`, `GhNotARepoError`).
- Claude Agent SDK wrapper: role registry that loads the markdown
  prompts in `prompts/`, plus per-run transcript capture.
- `git worktree` lifecycle helpers — add, archive `.minesweeper/`, and
  remove on success.
- Long-running `minesweeper run` daemon with poller and child-process
  supervisor.
- Per-issue `minesweeper handle <issue#>` child process with planning
  mode (planner ↔ critic loop) and execution mode (executor ↔ reviewer
  loop, commit, and PR creation via the `prwriter` role).
- Label-only eligibility filter and the `labels` CLI command for
  managing repo labels.
- Haiku-backed prompt-injection eligibility screener.
- Assess and refine modes, including sub-issue creation for refined
  follow-up tasks.
- `models` CLI command (with abbreviation key in `--verbose` output)
  and an `issues` CLI command for listing current issues.
- `log view` CLI for browsing per-run transcripts.

### Changed
- Worktree cleanup is deferred until the issue is closed, so failed
  runs leave their working state on disk for inspection.

### Fixed
- The child state machine is driven to a terminal status within a
  single process invocation rather than relying on re-entry.
- Several CI configuration issues from the initial workflow rollout.

[Unreleased]: https://github.com/CjS77/minesweeper/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CjS77/minesweeper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CjS77/minesweeper/releases/tag/v0.1.0
