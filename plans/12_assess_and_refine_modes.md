# 12 — Assess + refine modes
## Status: Not started

## Context
The final M2 deliverable. Up to this point we've been treating every plan
as `Execute` (the M1 shortcut from plan 08). Now we add the assess decision
and the refine path: the assessor decides whether a plan is "small enough
to execute" or "should be split", and the refiner does the splitting by
creating sub-issues.

## Scope (in)

### Assess mode
- `src/child/modes/assess.ts`:
  - Inputs: `final_plan.md`, the issue.
  - Invokes `runSubagent("assessor", { userPrompt: assessorPromptFor(plan,
    issue), issueNumber })` with `model =
    config.MINESWEEPER_PLANNING_AGENT` (uses the planning agent — same
    cognitive scope).
  - Assessor returns a structured verdict ending with `Verdict:
    <Execute|Refine>` plus a reason.
  - Persist `state.assessment = verdict`, save reason to state for audit.
  - On `Execute` → set `state.mode = "Execution"`, exit (supervisor
    re-dispatches; execution mode picks up).
  - On `Refine` → set `state.mode = "Delegated"` (per spec), exit
    (supervisor calls refine mode? or refine runs in this same process?).
    Decision: refine mode runs in the **same process** because it's all
    GitHub-API plumbing — no subagent loop to checkpoint between.
- Update `src/child/handler.ts` to dispatch `Planning` →
  (post-planning transitions) → `Assess` → either `Execution` or
  `Refine`, replacing the M1 shortcut.

### Refine mode
- `src/child/modes/refine.ts`:
  - Invokes `runSubagent("refiner", { userPrompt: refinerPromptFor(plan,
    issue), issueNumber })` with the same model as assessor.
  - Refiner is asked to break the plan into N independent sub-tasks; it
    must return a structured list (markdown — each sub-task is `## Task
    {n}: {title}` with body fields `### Description`, `### Recommended
    plan`).
  - Orchestrator parses that list, then for each sub-task:
    1. `github.createIssue({ title, body, labels })` where:
       - body includes a link to the parent issue and the recommended plan
       - labels include `MINESWEEPER_SUBTASK_LABEL`
       - if parent has `MINESWEEPER_ALWAYS_FIX_LABEL`, also apply that
    2. Collect the new issue numbers.
  - After all sub-issues are created, comment on the parent with a
    checklist:
    ```
    Refined into the following sub-tasks:
    - [ ] #123 — {title}
    - [ ] #124 — {title}
    ```
  - Set `state.mode = "Delegated"`, `state.status = "Complete"`. Exit 0
    (supervisor archives + removes worktree).

### State schema extension
- Add `state.assessmentReason: string | null`.
- Bump `state.version` to `2`. Add a tiny migration function in
  `state.ts` that handles `version === 1` → `version === 2` by setting
  `assessmentReason` to `null`.

### Prompts
- `prompts/assessor.md` — replaces the stub from plan 05.
- `prompts/refiner.md` — replaces the stub from plan 05. The refiner
  prompt must specify the exact markdown structure the parser expects.

### Tests
- Unit tests for assess parsing and dispatch.
- Unit tests for refine: mocked `github.createIssue` and `comment`,
  verifying labels are propagated, parent comment formatted correctly,
  state transitions to Delegated.

## Scope (out)
- Recursive refinement (a sub-task is itself refined further) — let the
  daemon's normal eligibility process pick the sub-issues up; recursion
  is implicit.
- Cycle detection — sub-issues will get the `subtask` label and a parent
  link; if the human creates loops, that's on them.

## Critical files
- `src/child/modes/assess.ts`
- `src/child/modes/refine.ts`
- Modifications to `src/child/handler.ts` (replace M1 shortcut)
- Modifications to `src/child/state.ts` (schema bump + migration)
- `prompts/assessor.md`
- `prompts/refiner.md`
- `src/child/__tests__/assess.test.ts`
- `src/child/__tests__/refine.test.ts`

## Acceptance criteria
- Mocked tests pass.
- Live test: file a deliberately too-large issue ("rewrite the entire
  daemon in Rust"), confirm assess returns `Refine`, confirm refiner
  produces multiple sub-issues with proper labels and a parent comment
  with a checklist.
- Live test: file a small issue, confirm assess returns `Execute` and
  the existing execution path runs unchanged.

## Verification
1. `pnpm test`
2. Both live tests above.
3. Confirm parent issue's checklist links resolve and sub-issues carry
   the autofix label when the parent did.
