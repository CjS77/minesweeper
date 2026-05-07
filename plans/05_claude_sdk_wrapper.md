# 05 — Claude Agent SDK wrapper (`src/claude/`)
## Status: done

## Context
Every "subagent" in the README spec (planner, critic, assessor, refiner,
executor, reviewer) becomes a call to `query()` from
`@anthropic-ai/claude-agent-sdk`. We wrap the SDK in a single module so
mode code never imports the SDK directly — this gives us one seam to swap
in alternative agent backends later (e.g. codex) and one place to log
transcripts.

## Scope (in)
- `src/claude/roles.ts` — registry of role definitions:
  ```ts
  type Role = {
    name: "planner" | "critic" | "assessor" | "refiner" | "executor" | "reviewer";
    modelEnvVar: keyof Config;        // which Config field holds the model
    systemPromptPath: string;         // path to prompts/{role}.md (relative to repo root)
    allowedTools: string[];           // tighter for planning, looser for exec
    permissionMode: "default" | "plan" | "acceptEdits"; // SDK option
  };
  export const ROLES: Record<Role["name"], Role>;
  ```
- `src/claude/transcript.ts` — append-only JSONL writer for SDK events,
  keyed by `(role, iteration)`. Writes to
  `${cwd}/.minesweeper/planning_history/{role}-{NN}.jsonl`.
- `src/claude/index.ts` — `runSubagent(role, opts)`:
  - Builds the prompt (caller supplies the user message; system prompt is
    loaded from the role's markdown file).
  - Calls `query()` from `@anthropic-ai/claude-agent-sdk`.
  - Streams events to the transcript writer **and** to the logger
    (`event(role, "INFO", issue, "...")` for high-level milestones like
    "tool call: Edit", "assistant text: ..." truncated, etc.).
  - Returns a `Result` summary: `{ finalText: string; events: number;
    durationMs: number; stopReason: string }`.
- `prompts/planner.md`, `prompts/critic.md`, `prompts/executor.md`,
  `prompts/reviewer.md` — initial drafts. (Assessor + refiner can be
  stubbed and fleshed out in plan 12.)
- Unit tests with the SDK mocked (`vi.mock("@anthropic-ai/claude-agent-sdk")`)
  — verify role lookup, allowed tools wiring, transcript writes.

## Scope (out)
- Calling `runSubagent` from mode code — wired in plans 08, 09.
- MCP server — not in v0.
- A second backend (codex) — note in code where the seam goes, but no impl.

## Role/tool sketch

| Role | Allowed tools | Permission mode |
|------|---------------|-----------------|
| planner | `Read`, `Grep`, `Glob`, `Bash` (read-only commands), `WebFetch` | `plan` |
| critic | `Read`, `Grep`, `Glob` | `plan` |
| assessor | `Read`, `Grep` | `plan` |
| refiner | `Read`, `Grep` | `plan` |
| executor | `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob` | `acceptEdits` |
| reviewer | `Read`, `Grep`, `Glob`, `Bash` (read-only) | `plan` |

(Adjust as we discover what each role actually needs.)

## Critical files
- `src/claude/index.ts`
- `src/claude/roles.ts`
- `src/claude/transcript.ts`
- `prompts/planner.md`
- `prompts/critic.md`
- `prompts/executor.md`
- `prompts/reviewer.md`
- `prompts/assessor.md` (stub)
- `prompts/refiner.md` (stub)
- `src/claude/__tests__/*.test.ts`

## Dependencies to add
- `@anthropic-ai/claude-agent-sdk`

## Acceptance criteria
- `runSubagent({ role: "planner", issueNumber: 1, userPrompt: "..." })`
  returns a `Result` and writes a JSONL transcript.
- The SDK call receives the right model from config, the right
  `appendSystemPrompt`, the right `allowedTools`, and `cwd = process.cwd()`.
- Transcript file lines are valid JSON, one per SDK event.
- Mocked tests pass.

## Verification
1. `pnpm test`
2. Manual smoke (requires a valid `ANTHROPIC_API_KEY` or whatever the SDK
   needs): write a one-off script that calls `runSubagent` against the
   planner role with a trivial prompt and confirm it produces a transcript
   and a final-text summary.
