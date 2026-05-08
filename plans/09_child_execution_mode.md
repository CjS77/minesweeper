# 09 — Child execution mode
## Status: done

## Context
With planning landed, we now implement the executor ↔ reviewer loop and the
PR-pushing endpoint. The executor subagent makes code changes inside the
worktree and commits via the Bash carve-out (`git commit` from inside the
agent). The reviewer subagent reviews the diff and emits a verdict the
orchestrator parses. After approval, the orchestrator squashes commits and
opens the PR.

## Scope (in)
- `src/child/modes/execution.ts`:
  1. Read `.minesweeper/final_plan.md`.
  2. **Writing**: invoke `runSubagent("executor", { userPrompt:
     executorPromptFor(plan), issueNumber })`. The prompt instructs the
     agent to implement the plan and finish with a `git commit -m "..."`
     of its work.
  3. After exit, verify a new commit exists on HEAD vs. the branch's first
     commit. If not, log a warning and treat as a no-op iteration (still
     increment counter; failure path will catch a stuck loop).
  4. Set `state.status = "Reviewing"`, persist.
  5. **Reviewing**: invoke `runSubagent("reviewer", { userPrompt:
     reviewerPromptFor(plan, gitDiff), issueNumber })`. Reviewer is given:
     - the plan,
     - the cumulative diff from base branch to HEAD,
     - the list of commit messages on the branch.
     Reviewer ends with a `Verdict:` line, same parsing rule as the critic
     in plan 08, with `Approved with minor concerns` accepted as approval.
  6. Save reviewer comments to `.minesweeper/review_comments.md`
     (overwrites prior round's comments, per spec).
  7. On approval → finalize (see step 9). On request changes →
     `state.status = "FixingReviewComments"`, increment iterations, then
     re-invoke executor with a prompt that includes the plan plus the
     review comments as the focus. Loop until approved or
     `iterations >= max_iterations`.
  8. If we exit the loop without approval, proceed anyway (per spec:
     "If tests fail at this point, we do not go back. CI will pick this up
     and the code owner will decide what to do."). Log a clear WARN.
  9. **Finalize**:
     - Run formatting / tests if hooks exist (`npm run check` if defined,
       else skip — best-effort, do not fail the run).
     - Squash all commits on the branch into one with a message derived
       from the issue title and a body summarising the plan
       (`git reset --soft <baseCommit> && git commit -m "..."`).
     - Push: `git push -u origin <branch>` (using `execa` from the
       worktree).
     - `github.createPr({ base: config.MINESWEEPER_PR_BASE_BRANCH, head:
       branchName, title, body })`. Body references the issue with
       `Fixes #N`.
     - Set `state.status = "Complete"`. Persist. Exit 0.
- `prompts/executor.md` and `prompts/reviewer.md` finalised.
- Unit tests covering: clean approval first round; one round of changes
  then approval; max rounds without approval (proceeds with WARN); commit
  carve-out validation (executor must produce a commit).

## Scope (out)
- Assess + refine modes — plan 12.
- Retry on transient `gh` failures — deferred.
- Auto-creating release notes / changelog — out.

## Squash strategy

Use `git reset --soft <base>` where `<base>` is the merge-base of the
worktree branch and `MINESWEEPER_PR_BASE_BRANCH`. Then a single
`git commit` with a message constructed by the orchestrator from the issue
title + a digest of the plan. This sidesteps interactive rebase entirely.

## Critical files
- `src/child/modes/execution.ts`
- `prompts/executor.md`
- `prompts/reviewer.md`
- `src/child/__tests__/execution.test.ts`

## Acceptance criteria
- Mocked tests pass for all branches.
- After execution completes against a real scratch issue: a PR exists on
  GitHub targeting `main`, with `Fixes #N` in its body, and a single
  squashed commit on its branch.
- `state.status` is `"Complete"` and the child exited 0; supervisor
  archived and removed the worktree.

## Verification
1. `pnpm test`
2. E2E: file a labelled issue ("add a function `greet(name)` to
   `src/util.ts`"), let Minesweeper run end-to-end, confirm a PR appears
   on GitHub with the implementation. Merge it; the loop has closed.
