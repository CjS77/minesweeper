# 10 — Label-only eligibility + README spec deltas
## Status: done

## Context
This is the M1 capstone. Before we dogfood Minesweeper, we need 
(a) a proper eligibility filter — still label-based, prompt-injection screening comes in plan 11 — and 
(b) a README that matches the actual behaviour and introduces the new env vars.

## Scope (in)

### Eligibility filter
Replace the placeholder `isEligible` from plan 07 with the real label-based
logic that honours the spec's hierarchy:

1. If issue has `MINESWEEPER_NEVER_FIX_LABEL` → ineligible.
2. If issue has `MINESWEEPER_MANUALLY_APPROVED_LABEL` → eligible.
3. If issue has `MINESWEEPER_FAILED_LABEL` → ineligible (don't reattempt
   failed issues automatically).
4. If issue has `MINESWEEPER_POSSIBLY_DANGEROUS_LABEL` → ineligible.
6. If issue has `MINESWEEPER_ALWAYS_FIX_LABEL` → eligible.
6. Otherwise → fall back to `MINESWEEPER_DEFAULT_ELIGIBLE` (default
   `false`).

Plus: skip issues that are already in-flight (worktree exists), already
have an open PR linked, or are closed. The "open PR linked" check uses
`gh issue view N --json closedByPullRequestsReferences,timelineItems`
or similar — the cheapest signal is "look for any PR that references
`Fixes #N`". We can defer that to a follow-up if it makes plan 10 too big;
at minimum, skip issues whose state is `closed`.

Unit tests covering each branch.

### README updates
Apply the spec deltas identified in the master plan:

1. Change `MINESWEEPER_REVIEW_AGENT` default from `"codex"` to whatever is in .env.sample,
   note codex/other-backend support is on the roadmap.
2. Add to the env-var table (in order) - use the value in .env.sample if it conflicts with below:
   - `MINESWEEPER_WORKTREE_PATH` — `"/tmp/minesweeper"`
   - `MINESWEEPER_PR_BASE_BRANCH` — `"main"`
   - `MINESWEEPER_POLL_INTERVAL_SECONDS` — `300`
   - `MINESWEEPER_MAX_CONCURRENCY` — `1`
   - `MINESWEEPER_FAILED_LABEL` — `"minesweeperFailed"`
3. Add an "Architecture" section pointing at the architecture plan and
   summarising the daemon + child-process model.
4. Add an "Operating Minesweeper" section with:
   - Prerequisites (`gh`, Node 20+, `ANTHROPIC_API_KEY` or however the
     SDK authenticates).
   - How to label issues for autofix.
   - Where logs live (`.minesweeper/logs/daemon.log`).
   - How to inspect a failed issue (worktree retained at
     `$MINESWEEPER_WORKTREE_PATH/<branch>`; `cat
     $worktree/.minesweeper/state.json`).
5. Make the worktree → child-process model explicit in the planning
   section (per spec delta #7 in the master plan).

### Bootstrap docs
- Create `.github/ISSUE_TEMPLATE/autofix.md` — a template that
  pre-populates the `autofix` label and a body that's structured the way
  the planner prompt expects.
- Add a section in the README: "Bootstrap mode — using Minesweeper to
  develop Minesweeper" describing the safety rules from the master plan.

## Scope (out)
- Prompt-injection screen — plan 11.
- Skipping issues that already have a linked PR — note as a TODO in code,
  defer if it complicates the plan.

## Critical files
- `src/daemon/eligibility.ts` (replaces plan 07's stub)
- `README.md`
- `.github/ISSUE_TEMPLATE/autofix.md`
- `src/daemon/__tests__/eligibility.test.ts`

## Acceptance criteria
- Eligibility tests cover the full label hierarchy.
- README env-var table matches `src/config.ts` exactly (consider adding a
  CI check that asserts the README has every var the schema does).
- A real labelled issue against this repo is processed end-to-end.

## Verification — **end-to-end self-hosting test**

This is the gate for declaring M1 done.

1. On the dogfood checkout:
   - Check if the necessary labels have been created. Run `labels -f` if not.
   - File a real issue: e.g. "Add a `--version` flag to the CLI" with the
     `autofix` label.
   - Start the daemon: `node dist/cli.js run`.
   - Watch the pretty stdout: poll → eligible → planning → executing →
     reviewing → PR opened.
   - Open the PR on GitHub, review it manually, merge it.
2. Repeat with a slightly bigger issue (e.g. "add a `gc` subcommand that
   removes worktrees whose state is Failed").
3. After two successful self-hosted PRs, M1 is done — proceed to plan 11.
