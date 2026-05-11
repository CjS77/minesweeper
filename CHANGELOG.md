# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] — 2026-05-11

### Added
- Code-scanning and secret-scanning alerts are now polled as first-class work items and pushed through the same
  dispatch → worktree → planning → execution → PR pipeline as issues. A new `WorkItem` discriminated union
  (`src/workitem.ts`) threads the kind through eligibility, poller, supervisor, planning, and execution. Because alerts
  cannot carry labels, a new `MINESWEEPER_ALERTS_ELIGIBLE` flag (default `true`) gates them at the same precedence as
  the always-fix label. The poller fetches all three sources in parallel via `safeList` so an outage in one endpoint
  emits a WARN and continues with the rest. Branches and worktree archive paths are kind-prefixed
  (`{slug}-codeScanningAlert{NNNN}`) and the supervisor inflight map keys on `(kind, number)` so issue #N and alert #N
  never collide. `minesweeper handle` keeps the bare-number form and adds `codeScanningAlert/N` / `secretScanningAlert/N`.
  PR body trailer for alerts is `## Closes alert <url>` since `Fixes #N` keywords do not auto-close alerts. State
  schema bumped v3 → v4 with a `kind` field; v3 → v4 migration defaults legacy state to `kind: "issue"`.
- Layered config with a per-repo override at `<cwd>/.minesweeper/config.json`. Precedence is now
  env > repo file > global file > defaults, merged per-key. `ConfigSource` gains `"repo-config"`; resolvers tag each
  field's provenance accordingly. `loadConfig` takes a `{ repoConfigFile, cwd }` option pair and the CLI passes `cwd`
  explicitly at every call site. Overridable via `MINESWEEPER_REPO_CONFIG_FILE`. README gains Installation, Working
  directory, and Configuration sections plus a gitignore note on sharing repo-level config.
- `.github/dependabot.yml` for automated dependency updates.

### Changed
- `log view --issue <n> <name>` now treats `<name>` as a case-sensitive substring match against transcript basenames
  rather than compiling it as a regex. Closes #35 (untrusted regex compilation was a ReDoS surface). Migration: drop
  regex anchors and meta-characters — e.g. `^critic` becomes `critic`.
- CI Node version bumped from 20 to 24 so `npm ci` uses npm 11, which handles the optional/wasm transitive deps that
  Vitest v4 pulls in (`@rolldown/binding-wasm32-wasi`, `@emnapi/core`, `@emnapi/runtime`) without tripping
  "Missing: ... from lock file".

### Dependency updates
- vitest: ^2.1.0 => ^4.1.6 (resolves GHSA-67mh-4wv8-2f99)
- @vitest/coverage-v8: ^2.1.9 => ^4.1.6
- typescript: 5.9.3 => 6.0.3
- commander: 12.1.0 => 14.0.3
- @types/node: 22.19.18 => 25.6.2

## [0.4.0] — 2026-05-11

### Changed
- `removeWorktree` now deletes the local branch that was checked out in the worktree after the `git worktree remove
  --force` step, preventing stale branches from accumulating in the main repository over time. New internal helpers
  `resolveWorktreeBranch` (reads `git rev-parse --abbrev-ref HEAD`, returns `null` for detached HEAD) and
  `deleteBranchIfPresent` (runs `git branch -D` and swallows already-deleted branches via a `/not found/i` match on
  stderr). Public signature is unchanged.

## [0.3.0] — 2026-05-11

### Added
- Autonomous PR-review feedback loop. After Minesweeper opens a PR, the daemon keeps watching it: for every worktree
  whose state is `mode = Execution, status = Complete` with a recorded `prNumber`, the poll tick fetches the PR via
  `gh pr view` plus the REST `pulls/{n}/comments` endpoint. A fresh `CHANGES_REQUESTED` review, an inline review-thread
  comment, or a `COMMENTED` review with a non-empty body from an **authorised reviewer** (repo owner plus the bare
  `@username` entries in `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`; `@org/team` entries are deferred)
  renders the new items to `.minesweeper/pr_review_comments.md`, flips the state to
  `mode = AddressingPRFeedback, status = InProgress`, and re-runs the executor against the original plan plus the
  rendered feedback. New commits are pushed with an **incremental `git push`** — no force, no re-squash — so reviewer
  pushes are never overwritten. A `prFeedbackProcessedAt` watermark records the newest acted-on timestamp so the same
  feedback is never replayed. The loop ends when the issue is closed; the closed-issue sweep then archives the
  worktree as usual. Inline review comments that triggered a dispatch get a `+1` reaction after the fix is pushed,
  written via `POST repos/{owner}/{repo}/pulls/comments/{id}/reactions`.
- `config loaded` startup log line. Every command that runs with an active logger now emits a single structured `info`
  entry listing each non-derived config field alongside the source that provided it — `envar`, `config-file`, or
  `default`. Fields whose names match `key|secret|token` are replaced with `<redacted>`. Provenance is captured at the
  point of resolution and stored on `config.sources`; the logging boundary just redacts and emits.

### Changed
- Package renamed from `@cjs77/minesweeper` to `cc-minesweeper` on npm to avoid registry clashes. The binary is still
  `minesweeper`.
- On-disk state schema bumped v2 → v3 with the new `prNumber`, `prFeedbackProcessedAt`, and `AddressingPRFeedback`
  mode. `migrateIfNeeded` is now exported and chains v1 → v2 → v3, and `readStateOrNull` runs it so `listOrphans` does
  not silently drop pre-v3 worktrees.

### Fixed
- `gh pr view --json reviewThreads` is not a valid `gh` field — that data is GraphQL-only. PR-feedback polling now
  fetches inline review comments via REST (`repos/{owner}/{repo}/pulls/{n}/comments`, paginated), so feedback runs no
  longer fail wholesale with `Unknown JSON field: "reviewThreads"`.
- The actionable-review filter now also matches `COMMENTED` reviews whose body is non-empty. Empty-bodied `COMMENTED`
  reviews are the GitHub container that wraps inline comments and were causing double-dispatch.

## [0.2.0] — 2026-05-11

### Added
- `minesweeper issue new` (alias `issue create`) command. Accepts free text on the CLI, via `-f <path>`, or piped on
  stdin; a Sonnet-backed `issuewriter` subagent shapes it into the autofix issue template, optionally opens it in
  `$EDITOR` for review (skip with `-y`), and files the issue through `gh` with the `autofix` label applied (use `-n` to
  suppress). New `MINESWEEPER_ISSUE_WRITER_AGENT` config slot, defaulting to `claude-sonnet-4-6`.
- `tryFix` label tier in the eligibility filter. The label opts an issue in but always routes it through the Haiku
  screener (unlike `alwaysFix` / `manuallyApproved`, which bypass screening). Configurable via
  `MINESWEEPER_TRY_FIX_LABEL` (default `tryFix`). The label is propagated to refined sub-issues, which are themselves
  re-screened.
- Cron-aware poll scheduling. Operators can set one or more cron expressions in `~/.minesweeper/config.json`
  (`schedule` field) to drive the daemon's poll loop; the existing fixed-interval driver remains as the fallback when
  nothing is configured. New `pollCooldownSeconds` gate (default 120 s; env `MINESWEEPER_POLL_COOLDOWN`) prevents
  overlapping schedules from double-polling within the cooldown window. New `MINESWEEPER_CONFIG_FILE` env var to pick a
  non-default config path.
- `log view --issue <n>` resolver that locates transcripts under `MINESWEEPER_WORKTREE_PATH` from both active worktrees
  (matched via `state.json.issueNumber`) and the archive (matched via the `{issueNumber}-` prefix). The positional
  argument now becomes an optional basename regex filter.

### Changed
- The eligibility screener prompt now catches the "wholesale destruction disguised as cleanup" attack class — deletion
  framed as optimisation, simplification, or minification when the request would leave only a trivial program behind.
- `log view` rendering: multi-file output gets dim banner separators with a fresh render context per file,
  `tool_result` blocks are collapsed to a header plus line count, `tool_use` blocks pretty-print their input bodies
  (Write/Edit content is now visible), empty or signature-only thinking blocks are skipped, and `🤖` / `👤`
  single-codepoint emojis replace the previous wider-glyph icons for better terminal/font compatibility.

### Fixed
- The Claude Agent SDK's native-binary resolver tries the musl tarball ahead of glibc with no actual libc detection,
  which caused `ENOENT /lib/ld-musl-x86_64.so.1` ("Claude Code native binary not found") on glibc systems once the
  optional musl dep was installed. npm `overrides` now alias the musl packages to the glibc tarballs for both x64 and
  arm64.

## [0.1.0] — 2026-05-08

Initial usable cut: a self-hosting agentic bughunter that polls labelled GitHub issues, plans and executes fixes inside
a per-issue git worktree, and opens a pull request.

### Added
- TypeScript / Node 20 project scaffold with ESLint, Prettier, Vitest, and a GitHub Actions CI pipeline (typecheck,
  lint, format check, test, build).
- Zod-validated environment config loader and on-disk `.minesweeper/state.json` schema.
- Structured `pino` logger with a pretty stdout layer and a role-aware `event(role, level, issueNumber, ...)` helper.
- `gh` subprocess wrapper with typed response models and dedicated error classes (`GhError`, `GhMissingError`,
  `GhNotARepoError`).
- Claude Agent SDK wrapper: role registry that loads the markdown prompts in `prompts/`, plus per-run transcript
  capture.
- `git worktree` lifecycle helpers — add, archive `.minesweeper/`, and remove on success.
- Long-running `minesweeper run` daemon with poller and child-process supervisor.
- Per-issue `minesweeper handle <issue#>` child process with planning mode (planner ↔ critic loop) and execution mode
  (executor ↔ reviewer loop, commit, and PR creation via the `prwriter` role).
- Label-only eligibility filter and the `labels` CLI command for managing repo labels.
- Haiku-backed prompt-injection eligibility screener.
- Assess and refine modes, including sub-issue creation for refined follow-up tasks.
- `models` CLI command (with abbreviation key in `--verbose` output) and an `issues` CLI command for listing current
  issues.
- `log view` CLI for browsing per-run transcripts.

### Changed
- Worktree cleanup is deferred until the issue is closed, so failed runs leave their working state on disk for
  inspection.

### Fixed
- The child state machine is driven to a terminal status within a single process invocation rather than relying on
  re-entry.
- Several CI configuration issues from the initial workflow rollout.

[Unreleased]: https://github.com/CjS77/minesweeper/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/CjS77/minesweeper/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CjS77/minesweeper/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CjS77/minesweeper/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CjS77/minesweeper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CjS77/minesweeper/releases/tag/v0.1.0
