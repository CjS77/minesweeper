# 08 — Child handler + planning mode
## Status: Not started

## Context
This plan implements the child-side entry point and the first state-machine
mode: planning. The child reads `.minesweeper/state.json` from cwd (the
worktree), drives a planner ↔ critic loop until the critic Approves or we
hit `max_iterations`, then writes the final plan to
`.minesweeper/final_plan.md` and transitions state to assess (which we'll
fast-forward to "Execute" in plan 10 since assess+refine are M2).

## Scope (in)
- `src/child/handler.ts` (cli `handle <issue#>` entry):
  - Reads state from cwd.
  - Branches on `state.mode` and dispatches to the appropriate mode
    function. For now: only `Planning` is implemented; other modes throw
    `not implemented` and exit non-zero (which the supervisor will treat
    as failure — fine while planning is the only mode landed).
- `src/child/modes/planning.ts`:
  - Inputs: the issue body (fetched via `github.getIssue` once at the
    start) and the current state.
  - First iteration: invokes `runSubagent("planner", { userPrompt:
    plannerPromptFor(issue), issueNumber })`. Saves the planner's final
    text to `.minesweeper/current_plan.md`.
  - Subsequent iterations: invokes `runSubagent("critic", { userPrompt:
    criticPromptFor(issue, currentPlan), issueNumber })`. Parses the
    critic's structured verdict (look for the line `Verdict: Approved`,
    `Verdict: Approved with comments`, or `Verdict: Request changes`).
  - On `Approved` → write `current_plan.md` to `final_plan.md` and finish.
  - On `Approved with comments` → append "## Points to consider" with the
    comments to `current_plan.md`, copy to `final_plan.md`, finish.
  - On `Request changes` → append "## Execution Plan review" with the
    critique to `current_plan.md`; re-invoke planner with the annotated
    plan; loop.
  - Increment `state.iterations` after every iteration; persist state at
    every step (atomic write).
  - When complete: set `state.mode = "Execution"` (skipping assess for
    M1 — see plan 10) and `state.status = "Writing"`, reset
    `iterations` to 0 and `maxIterations` to
    `config.MINESWEEPER_MAX_REVIEW_ROUNDS`. Save and exit 0 *without*
    starting execution — the next supervisor cycle will re-dispatch and
    plan 09's execution mode will pick up.
  - Or: keep going in the same process. Decide based on how plan 09
    structures things; either is fine. Recommended: **exit between modes**
    so each mode is a process boundary and the state-on-disk discipline
    is enforced.
- `prompts/planner.md` and `prompts/critic.md` finalised:
  - Planner: must produce a plan in markdown with a clear "Plan" section,
    referencing files by path.
  - Critic: must end with the literal line `Verdict: <one of the three>`
    so the parser is unambiguous.
- Unit tests (mocked `runSubagent` and `github`) covering all three
  verdict branches and max-iteration termination.

## Scope (out)
- Execution mode — plan 09.
- Assess mode — plan 12.
- Resumption from arbitrary mid-loop state (we resume to whichever
  iteration is recorded; we don't try to mid-iteration resume).

## Verdict parsing rule

The critic's response is searched (case-insensitive) for the **last**
match of `^\s*verdict\s*:\s*(approved with comments|approved|request
changes)\s*$`. If no match, treat as `Request changes` and log a warning
(model didn't follow the format).

## Critical files
- `src/child/handler.ts`
- `src/child/modes/planning.ts`
- `prompts/planner.md`
- `prompts/critic.md`
- `src/child/__tests__/planning.test.ts`

## Acceptance criteria
- Mocked tests cover: planner-only, planner→critic-approved,
  planner→critic-comments, planner→critic-changes→planner→critic-approved,
  hitting `maxIterations` (treated as Approved with a warning logged).
- After planning completes: `final_plan.md` exists, state.mode is
  `"Execution"`, state.status is `"Writing"`, iterations reset.
- Process exits 0 on success.

## Verification
1. `pnpm test`
2. E2E: in a scratch repo, file an issue, label it, start the daemon,
   watch the child run planning to completion, confirm `final_plan.md`
   exists in the worktree's `.minesweeper/` directory, confirm state
   transitions are visible in the state.json file.
