# Minesweeper Implementation Plan — Index

This directory holds the implementation plans for Minesweeper, derived from
the high-level architecture plan at
`~/.claude/plans/i-need-an-application-snazzy-axolotl.md`.

The plans are sequenced. Each one is a single PR's worth of work and is
designed to be reviewed and merged before the next is started.

## Milestones

- **M0** — manual scaffold: 01–03
- **M1** — minimum self-hosting cut: 04–10. After 10 lands, Minesweeper can
  fix its own labelled issues. We start dogfooding here.
- **M2** — safety + assess/refine: 11–12.
- **M3** — concurrency, retries, MCP/TUI: deferred, no plan files yet.

## Plans

| # | File | Deliverable | Depends on | Milestone |
|---|------|-------------|------------|-----------|
| 01 | [01_repo_scaffold.md](./01_repo_scaffold.md) | Project skeleton, lint/format/test/CI, CLI stubs. | — | M0 |
| 02 | [02_config_and_state_schemas.md](./02_config_and_state_schemas.md) | Env config + `state.json` zod schemas. | 01 | M0 |
| 03 | [03_logging_and_pretty_output.md](./03_logging_and_pretty_output.md) | Structured logger + pretty stdout layer. | 01 | M0 |
| 04 | [04_github_wrapper.md](./04_github_wrapper.md) | `src/github/` — orchestrator-owned `gh` wrapper. | 02, 03 | M1 |
| 05 | [05_claude_sdk_wrapper.md](./05_claude_sdk_wrapper.md) | `src/claude/` — Agent SDK wrapper, role registry, transcripts. | 02, 03 | M1 |
| 06 | [06_worktree_lifecycle.md](./06_worktree_lifecycle.md) | `git worktree` add/archive/remove helpers. | 02 | M1 |
| 07 | [07_daemon_supervisor.md](./07_daemon_supervisor.md) | Parent daemon: poller + supervisor + child spawn. | 04, 05, 06 | M1 |
| 08 | [08_child_planning_mode.md](./08_child_planning_mode.md) | Child handler + planning mode (planner ↔ critic loop). | 05, 02 | M1 |
| 09 | [09_child_execution_mode.md](./09_child_execution_mode.md) | Execution mode (executor ↔ reviewer + commit + PR). | 04, 05, 08 | M1 |
| 10 | [10_eligibility_label_only_and_readme.md](./10_eligibility_label_only_and_readme.md) | Label-only eligibility filter + README spec deltas. **End of M1.** | 04, 07 | M1 |
| 11 | [11_eligibility_prompt_injection.md](./11_eligibility_prompt_injection.md) | Haiku-backed prompt-injection screen. | 10 | M2 |
| 12 | [12_assess_and_refine_modes.md](./12_assess_and_refine_modes.md) | Assess + refine modes; sub-issue creation. **End of M2.** | 09, 10 | M2 |

## Cross-cutting decisions (already locked)

- TypeScript on Node.js (no Rust SDK from Anthropic; subprocess would still
  be the path even if there was).
- Claude Code via `@anthropic-ai/claude-agent-sdk` `query()` (in-process,
  typed events).
- GitHub via `gh` subprocess, **orchestrator-owned**, with one carve-out:
  the executor subagent runs `git commit` itself inside the worktree.
- Repo inferred from cwd (Claude-Code-style). Single repo per Minesweeper
  instance.
- Long-running daemon (`minesweeper run`) + per-issue child processes
  (`minesweeper handle <issue#>`) running with cwd = worktree.
- Worktree lifecycle owned by the parent: parent creates it, child works
  in it, parent archives `.minesweeper/` and removes it on success.
- State machine on disk in `.minesweeper/state.json`; all modes idempotent
  enough to resume after crash.
- Pretty stdout via `chalk` + `log-symbols` + `ora`; structured logs via
  `pino`.
- v0 is Claude-only; codex/other-backend support deferred.
- Prompt-injection (not MCP) for handing state context to subagents.
