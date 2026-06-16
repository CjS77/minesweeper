# Minesweeper

An agentic bughunter. It uses Claude Code as a harness in order to automatically identify, screen, evaluate, and fix
issues in a repository's GitHub repo.

Minesweeper periodically:

* Pulls a list of issues from GitHub.
* If the issue is eligible, then Minesweeper enters planning mode.
* Once planning mode is complete, Minesweeper enters assess mode.
* If assess mode decides to execute, Minesweeper enters execution mode.
* If assess mode decides the plan is too complex, it enters refine mode.
* Once execution mode is complete, a new pull request is opened on GitHub.
* Once refine mode is complete, the issue is updated with a checklist of all the sub-issues that were created.

# Requirements

* [Claude Code](https://claude.com/claude-code) (the CLI) — drives the agent loop via `@anthropic-ai/claude-agent-sdk`.
* [GitHub CLI](https://cli.github.com/) (`gh`) authenticated against the repo (`gh auth login` or `GH_TOKEN`, or a
  GitHub App — see [Authoring PRs as a bot](#authoring-prs-as-a-bot-github-app)).
* Node.js 20 or later.
* `git` 2.20+ (for `git worktree`).

# Installation

Minesweeper is published on npm as `cc-minesweeper` and installs the `minesweeper` binary on your PATH:

```sh
npm install -g cc-minesweeper
minesweeper --version
```

Once installed, `minesweeper` is the single command for everything — daemon, one-shot helpers, label management, and
log inspection (see `minesweeper --help`). The Requirements above are runtime prerequisites: `gh` must already be
authenticated (`gh auth login`) and the Claude Agent SDK must be able to find credentials (either via an existing
Claude Code login on the machine, or `ANTHROPIC_API_KEY` in the environment).

If you'd rather run from a checkout (for development or to pin a specific commit), `git clone` this repo, run
`npm install && npm run build`, and either `npm link` to expose `minesweeper` globally or invoke `node dist/cli.js`
directly.

# Working directory

Minesweeper acts on the GitHub repo of whatever directory you launch it from. Concretely:

* `gh` (and therefore the issue poller, label commands, and PR creation) resolves the target repo from the current
  working directory's git remotes -- `cd` into a checkout of the repo you want serviced, then run `minesweeper run`.
* Daemon logs are written under `<cwd>/.minesweeper/logs/`. Per-issue worktrees and their archives live under
  `$MINESWEEPER_WORKTREE_PATH` (default `/tmp/minesweeper`), not inside the repo checkout.
* Branches are namespaced per-project, so for example `/tmp/minesweeper/projectA-issue0001` and  `/tmp/minesweeper/projectB-issue0015` 
  represent worktrees for issue #1 of Project A and #15 of Project B respectively.
* The **per-repo config file** is read from `<cwd>/.minesweeper/config.json` (see *Configuration* below).

The typical operator workflow is therefore:

```sh
cd ~/code/my-repo                 # the repo whose issues you want Minesweeper to triage
minesweeper labels --force        # one-off: seed the labels Minesweeper relies on
minesweeper run                   # start the daemon
```

# Configuration

Minesweeper merges configuration from four layers. Higher layers override lower layers on a per-key basis:

1. **Environment variables** (`MINESWEEPER_*`) — set in your shell or a `.env` file you source.
2. **Per-repo JSON file** at `<cwd>/.minesweeper/config.json` (override the path with `MINESWEEPER_REPO_CONFIG_FILE`).
3. **Global JSON file** at `~/.minesweeper/config.json` (override the path with `MINESWEEPER_CONFIG_FILE`).
4. **Hard-coded defaults** baked into `src/config.ts`.

Both JSON files use the same schema and any subset of keys is fine. For example:

```jsonc
// ~/.minesweeper/config.json -- cross-repo defaults
{
  "planningAgent": "claude-opus-4-7",
  "reviewAgent": "claude-sonnet-4-6",
  "pollIntervalSeconds": 600
}
```

```jsonc
// <repo>/.minesweeper/config.json -- overrides for this one repo
{
  "alwaysFixLabel": "ready-to-ship",
  "prBaseBranch": "develop",
  "schedule": ["0 9 * * 1-5", "0 17 * * 1-5"]
}
```

A `minesweeper run` (or any command that emits structured logs) writes one `config loaded` record at startup whose
`sources` map records where each value was resolved from (`envar` / `repo-config` / `config-file` / `default`). That
record is the source of truth when debugging "why is field X set to Y?".

**Gitignore note.** `.minesweeper/` is conventionally gitignored (it holds logs, transcripts, and per-issue state),
so `<repo>/.minesweeper/config.json` is by default a per-checkout override that lives only on your machine. To share
repo-level settings with a team, either:

* add `!.minesweeper/config.json` after `.minesweeper/` in your `.gitignore`, then commit the file; or
* keep the file outside `.minesweeper/` (e.g. `minesweeper.config.json` at the repo root) and point
  `MINESWEEPER_REPO_CONFIG_FILE` at it.

The full list of settable fields is documented in the table under [Environment variables](#environment-variables)
below — every `MINESWEEPER_*` env var in that table maps to a camelCase JSON key (drop the prefix, lowercase the
first letter, e.g. `MINESWEEPER_ALWAYS_FIX_LABEL` → `alwaysFixLabel`). `schedule` (cron expressions) is the one
exception: it is **JSON-only** because cron lists contain commas that can't round-trip through an env var.

# Architecture

The detailed architecture and decision log live in `~/.claude/plans/i-need-an-application-snazzy-axolotl.md`. The
implementation is sequenced as numbered plans in [`plans/`](./plans/00_index.md).

In brief, Minesweeper is structured as **one long-running daemon plus one short-lived child process per in-flight
issue**:

* **Daemon (`minesweeper run`)** — polls GitHub, runs the eligibility filter, owns worktree lifecycle, and supervises
  one child per issue. The daemon is the only process that ever talks to `gh` (with one carve-out: the executor
  subagent runs `git commit` itself inside the worktree).
* **Child (`minesweeper handle <issue#>`)** — spawned by the supervisor with `cwd` set to a freshly created
  `git worktree`. The child drives the role agents (planner ↔ critic, then executor ↔ reviewer) via the Claude Agent
  SDK. State is persisted to `.minesweeper/state.json` inside the worktree so a crashed child can be resumed.
* **Worktree lifecycle** — the daemon creates the worktree under `$MINESWEEPER_WORKTREE_PATH/<branch>`. The worktree
  stays on disk for the entire life of the issue: on a clean exit (`code === 0`) the daemon leaves it alone so the
  reviewer of the open PR can inspect `.minesweeper/`; on a non-zero exit it labels the issue with
  `$MINESWEEPER_FAILED_LABEL` and again leaves the worktree in place for post-mortem. Each poll tick the daemon then
  runs a closed-issue sweep — for every worktree whose issue is now `CLOSED` (PR merged, manually closed, or "not
  planned"), it archives `.minesweeper/` under `archive/<issue>-<timestamp>/` and removes the worktree.

## Issue eligibility

You can control whether an issue is autonomously handled via repository labels and environment variables. When the
daemon polls, every open issue is run through the filter in this order — the first rule that matches wins:

1. `MINESWEEPER_NEVER_FIX_LABEL` → ineligible (hard opt-out).
2. `MINESWEEPER_MANUALLY_APPROVED_LABEL` → eligible (human signed off).
3. `MINESWEEPER_FAILED_LABEL` → ineligible (don't reattempt past failures automatically).
4. `MINESWEEPER_POSSIBLY_DANGEROUS_LABEL` → ineligible (flagged by the screen, awaiting review).
5. `MINESWEEPER_ALWAYS_FIX_LABEL` → eligible (the standard opt-in; **skips the screener**).
6. `MINESWEEPER_TRY_FIX_LABEL` → eligible **after the prompt-injection screener clears it**. Use this for issues you want
   processed but want screened first — it runs the screener regardless of `MINESWEEPER_DEFAULT_ELIGIBLE`. A `dangerous`
   verdict swaps the label for `MINESWEEPER_POSSIBLY_DANGEROUS_LABEL` and posts an explanatory comment; an `uncertain`
   verdict applies the same label silently. Either way, a human can override by replacing the label with
   `MINESWEEPER_MANUALLY_APPROVED_LABEL`.
7. Otherwise → fall back to `MINESWEEPER_DEFAULT_ELIGIBLE` (default `false`); when `true`, the issue is screened.

Closed issues are always ineligible.

When reading an issue, Minesweeper will (in M2) decide whether it's a legitimate issue or an attempt to inject
malicious code via issue-hijacking or prompt injection. If the latter, it marks the issue with
`MINESWEEPER_POSSIBLY_DANGEROUS_LABEL` and skips it. Until that screen lands, keep `MINESWEEPER_DEFAULT_ELIGIBLE=false`
and rely on the always-fix label.

### Alerts (code-scanning, secret-scanning)

In addition to issues, the daemon polls **GitHub Advanced Security** alerts via the REST API:

- `GET /repos/{o}/{r}/code-scanning/alerts` — CodeQL & SARIF findings.
- `GET /repos/{o}/{r}/secret-scanning/alerts` — leaked credentials.

Alerts cannot carry GitHub labels, so the per-label opt-in / opt-out controls do not apply. Eligibility is gated by a
single boolean: `MINESWEEPER_ALERTS_ELIGIBLE` (default `true`). When true, every open alert is treated as if it
carried the always-fix label — eligible without a screen. When false, alerts are hard-ineligible and the daemon
stops calling the alert APIs (so disabled-GHAS repos do not log a 403 every poll).

Alerts share the rest of the pipeline with issues — worktree creation, planning, execution, PR opening — with two
differences: branches are namespaced by kind (`{slug}-codeScanningAlert{NNNN}` / `{slug}-secretScanningAlert{NNNN}`),
and the PR body trailer is a `## Closes alert` section linking to the alert URL instead of `Fixes #N` (alerts do not
auto-close from PR-body keywords; code-scanning alerts close when the vulnerable code is removed, secret-scanning
alerts must be manually dismissed). Dependabot alerts are out of scope today.

The poller fetches issues, code-scanning alerts, and secret-scanning alerts in parallel; an outage in any single
endpoint emits a `WARN` and continues with the rest, so a token without `security_events` scope does not stall issue
polling.

### Planning mode

In planning mode, the per-issue child process:

* Loads the issue in context.
* Sets `mode` to `Planning`, `status` to `InProgress`, `iterations` to 0.
* Reads its working directory — the worktree under `${MINESWEEPER_WORKTREE_PATH}/{branchname}` — which the **parent
  daemon** has already created. All further work for the issue happens inside this worktree; the main checkout is
  never touched.
* Persists `.minesweeper/state.json` recording the state of the issue.
* Starts a subagent in planning mode to deliver a plan to resolve the issue.

* Then until `state.status` is `Complete` or `state.iterations` >= `state.max_iterations`:
    * Starts another sub-agent — preferably using a different LLM model — to critique the current plan. The LLM is
      told to take particular note of any comments under the heading "Execution Plan review" and to be sure to address
      all points brought up there.
    * The sub-agent only sees the current plan, the issue, and the source code. It does not see the full iteration
      history.
    * The sub-agent responds with its critique and a summary, one of:
        * Approved
        * Approved, with comments
        * Request changes
    * If the status is `Approved`, then `state.status` is set to `Complete`.
    * If the status is `Approved, with comments`, then `state.status` is set to `Complete`, and the comments are
      appended to the plan under the heading "Points to consider".
    * If the status is `Request changes`, `state.status` stays in `InProgress`. The critique is appended under the
      heading "Execution Plan review".
    * Increment `state.iterations` and repeat.
* Once `state.status` is `Complete`, re-initialise `state` for assess mode.

Notes:

* The full history of conversations, back-and-forths, and planning iterations must be stored in a convenient format
  for a supervisor to review. This lives in `.minesweeper/planning_history/`.
* A copy of the final plan is stored in `.minesweeper/final_plan.md`.

`.minesweeper/state.json` is of the following form:

```json5
{
  "mode": "Planning",   // Planning, Assess, Refine, or Execution
  "status": "InProgress",
  "iterations": 0,      // planning iterations completed
  "max_iterations": 5,  // copied from $MINESWEEPER_MAX_PLANNING_ITERATIONS
  "assessment": null,
}
```

### Assess mode

A sub-agent decides whether the plan should be executed all at once or broken up into smaller subtasks.

This mode does not change any code or the plan. It only saves the assessment in `state.assessment`. The result is
either `Execute` or `Refine`.

### Refine mode

In refine mode, no code is changed. Instead, the _plan_ is sent to an LLM subagent with the request to break it into
smaller, independent sub-tasks.

For each sub-task, a new GitHub issue is created with the full description of the sub-task, a link to the parent task,
and a recommended plan of action. The issue is labelled with `$MINESWEEPER_SUBTASK_LABEL`. If the parent task is
labelled `$MINESWEEPER_ALWAYS_FIX_LABEL`, the same label is added to the subtask.

After all subtasks are posted, `state.mode` is set to `Delegated`.

### Execution mode

When `state` enters execution mode, it looks like:

```json5
{
  "mode": "Execution",
  "status": "Writing",
  "iterations": 0,
  "max_iterations": 3, // copied from $MINESWEEPER_MAX_REVIEW_ROUNDS
}
```

A sub-agent executes the plan in `.minesweeper/final_plan.md`. The agent picks up all context from `CLAUDE.md` and the
local `.claude/` settings, including default permissions.

* Once execution is complete, increment `state.iterations`.
* Commit changes with a detailed git message describing what was done.
* Then, until `state.status` is `Complete` or `state.iterations` >= `state.max_iterations`:
    * Set `state.status` to `Reviewing`.
    * Start a review sub-agent — preferably with a different model — to conduct a thorough review of every change in
      the branch (not just the last commit). The review compares the changes against the plan for completeness and
      checks the code for cleanliness, readability, correctness, and especially security.
    * The review concludes with one of `Approved`, `Approved with minor concerns`, `Changes requested`.
    * If the status is `Approved` or `Approved with minor concerns`, set `state.status` to `Complete`.
    * Save all review comments to `.minesweeper/review_comments.md`, overwriting any old comments.
    * If `state.status` is not `Complete`, start a new execution agent:
        * Set `state.status` to `Fixing review comments`.
        * The plan is background; the review comments are the focus.
        * Once execution is complete, increment `state.iterations`.
        * Commit changes with a detailed git message of what was done.
* Run final checks (formatting, tests). If tests fail at this point we **do not** loop back — CI will pick this up
  and the code owner decides what to do.
* Squash commits into a single commit message.
* Push a new PR to GitHub against `$MINESWEEPER_PR_BASE_BRANCH`, referencing this issue.

### Addressing PR review feedback

Once a Minesweeper PR is open, the daemon keeps watching it. On every poll tick, for every worktree whose state is
`mode = Execution, status = Complete` and has a recorded `prNumber`, the daemon checks the PR via `gh pr view`:

* If the PR has a fresh `CHANGES_REQUESTED` review, or a fresh unresolved review-thread comment, from an **authorised
  reviewer**, the daemon renders the new items to `.minesweeper/pr_review_comments.md`, flips the state to
  `mode = AddressingPRFeedback, status = InProgress`, and re-runs the executor against the original plan plus the
  rendered feedback.
* Authorised reviewers are the **repo owner** (`gh repo view --json owner`) plus every bare `@username` listed in the
  repo's `CODEOWNERS` file (one of `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`). `@org/team` entries are
  ignored in v0 — resolving teams to member logins is deferred.
* **Curating a bot reviewer's comments with a 👍.** Comments from a third-party reviewer such as CodeRabbit are not
  authored by an authorised reviewer, so they are not actioned automatically. Add the bot's login to an extra-reviewer
  allowlist with `minesweeper reviewers add 'coderabbitai[bot]'` (stored in `.minesweeper/reviewers.json`); then a
  comment from that login becomes actionable **only** once an authorised reviewer adds a `+1` reaction to it. The `+1`
  is the trigger — the code owner curates exactly which of the bot's suggestions to apply. A directly authored comment
  from an authorised reviewer still needs no reaction. Manage the allowlist with `minesweeper reviewers add|remove|list`.
* The executor's new commits are pushed with an **incremental `git push`** (no force, no re-squash) so the PR history
  stays readable and never overwrites a reviewer's own pushed commits. GitHub's squash-merge button still produces a
  single commit at merge time.
* Two watermarks on `state.json` prevent reprocessing: `prFeedbackProcessedAt` tracks the newest review/authored-comment
  timestamp acted on, and `prReactionsProcessedAt` separately tracks the newest authorising `+1` — reactions live on
  their own clock because a thumbs-up can land long after the comment it approves.
* If a reviewer force-pushes to the PR branch, the incremental push will fail and Minesweeper bails out — the issue is
  labelled with `$MINESWEEPER_FAILED_LABEL` and the worktree is preserved for a human to inspect.
* The feedback loop ends naturally when the issue is closed (e.g. PR merged); the closed-issue sweep then archives and
  removes the worktree as usual.

### Responding to failing CI checks

Once a Minesweeper PR is open, the daemon also watches its check runs. On every poll tick, for every worktree whose state is `mode ∈ {Execution, AddressingPRFeedback, AddressingCIFailure}, status = Complete` and has a recorded `prNumber`, the daemon calls `GET /repos/{o}/{r}/commits/{branch}/check-runs`:

* If any check is still `queued` or `in_progress`, the daemon skips the tick — it waits for all checks to settle so the executor receives the complete failure picture.
* If all checks are terminal and at least one has `conclusion ∈ {failure, timed_out, action_required}`, the daemon renders the failing check names, conclusions, and output summaries to `.minesweeper/ci_check_failures.md`, flips state to `mode = AddressingCIFailure, status = InProgress`, and re-runs the executor.
* A SHA watermark (`ciChecksProcessedAt` on `state.json`) records the HEAD commit the daemon has acted on, so the same failing commit is never processed twice.
* A lifetime counter (`ciFixIterations`) caps total CI-fix dispatches at `MINESWEEPER_MAX_REVIEW_ROUNDS`. When the cap is reached the daemon emits a WARN and stops dispatching; the PR stays open for a human to inspect.
* The executor pushes incremental commits (no squash, no force-push). CI re-runs on the new commit; if it passes, no further dispatch occurs.

CI checks respond to the same `MINESWEEPER_CI_CHECKS_ELIGIBLE` flag (default `true`). Set it to `false` to disable CI-failure response entirely — useful on repos where CI is slow or flaky and you prefer to handle failures manually.

### Environment variables

The defaults below are the canonical values; `src/config.ts` is the source of truth. See `.env.sample` for a
copy-pasteable template.

| Environment Variable                   | Meaning                                                              | Default               |
|----------------------------------------|----------------------------------------------------------------------|-----------------------|
| `MINESWEEPER_DEFAULT_ELIGIBLE`         | Issues are eligible by default                                       | `false`               |
| `MINESWEEPER_ALERTS_ELIGIBLE`          | Code-scanning & secret-scanning alerts are eligible (no labels)      | `true`                |
| `MINESWEEPER_CI_CHECKS_ELIGIBLE`       | Re-run executor when GitHub check runs fail on an open PR            | `true`                |
| `MINESWEEPER_ALWAYS_FIX_LABEL`         | Issues labelled with this value are _always_ eligible                | `"autofix"`           |
| `MINESWEEPER_TRY_FIX_LABEL`            | Issues labelled with this value are eligible _after_ the screener clears them | `"tryFix"`   |
| `MINESWEEPER_NEVER_FIX_LABEL`          | Issues labelled with this value are _never_ eligible                 | `"manual"`            |
| `MINESWEEPER_POSSIBLY_DANGEROUS_LABEL` | Issue might be malicious. Needs manual review                        | `"possiblyDangerous"` |
| `MINESWEEPER_MANUALLY_APPROVED_LABEL`  | Issue has been manually reviewed and is ok                           | `"manuallyReviewed"`  |
| `MINESWEEPER_FAILED_LABEL`             | Applied when Minesweeper gives up on an issue                        | `"minesweeperFailed"` |
| `MINESWEEPER_SUBTASK_LABEL`            | Issues created by Minesweeper are labelled with this                 | `"subtask"`           |
| `MINESWEEPER_MAX_PLANNING_ITERATIONS`  | Maximum number of planning iterations                                | `5`                   |
| `MINESWEEPER_MAX_REVIEW_ROUNDS`        | Maximum number of review rounds during execution                     | `3`                   |
| `MINESWEEPER_ELIGIBILITY_AGENT`        | Model used to assess issue eligibility                               | `"haiku"`             |
| `MINESWEEPER_PLANNING_AGENT`           | Model used to run in planning mode                                   | `"claude-opus-4-7"`   |
| `MINESWEEPER_REVIEW_AGENT`             | Model used to run in review mode (codex / other backends are future) | `"claude-sonnet-4-6"` |
| `MINESWEEPER_EXECUTION_AGENT`          | Model used to run in execute mode                                    | `"claude-opus-4-7"`   |
| `MINESWEEPER_WORKTREE_PATH`            | Where per-issue worktrees are materialised                           | `"/tmp/minesweeper"`  |
| `MINESWEEPER_PR_BASE_BRANCH`           | Base branch for pull requests opened by Minesweeper                  | `"main"`              |
| `MINESWEEPER_POLL_INTERVAL_SECONDS`    | How often the daemon polls GitHub for new issues                     | `300`                 |
| `MINESWEEPER_POLL_COOLDOWN`            | Minimum seconds between successive ticks; `0` disables the gate      | `120`                 |
| `MINESWEEPER_CONFIG_FILE`              | Path to the **global** JSON config file (cross-repo defaults)        | `~/.minesweeper/config.json` |
| `MINESWEEPER_REPO_CONFIG_FILE`         | Path to the **per-repo** JSON config file (overrides the global one) | `<cwd>/.minesweeper/config.json` |
| `MINESWEEPER_MAX_CONCURRENCY`          | Maximum issue children running in parallel (v0 is single-threaded)   | `1`                   |

# Operating Minesweeper

## Prerequisites

1. Install Node.js 20+ and Minesweeper itself: `npm install -g cc-minesweeper` (see [Installation](#installation)).
2. Install `gh` and authenticate it against the target repo (`gh auth login`, or set `GH_TOKEN` / `GITHUB_TOKEN`).
3. Authenticate the Claude Agent SDK. The simplest path is to log in once with the Claude Code CLI; alternatively
   set `ANTHROPIC_API_KEY` in the environment.
4. Optional: copy `.env.sample` into a shell-sourced `.env`, or write a `~/.minesweeper/config.json` / per-repo
   `.minesweeper/config.json` (see [Configuration](#configuration)). Every setting is optional and defaults sensibly.

## Authoring PRs as a bot (GitHub App)

By default Minesweeper acts as whoever `gh` is authenticated as, so PRs and commits are attributed to the operator. To
have PRs **opened by** a dedicated bot and commits **authored by** it, register a GitHub App and point Minesweeper at it.
When configured, Minesweeper mints a short-lived **installation access token** and uses it for every `gh` call (issue
comments, labels, reactions, PR creation), the branch push, and sets the worktree's git identity — so the whole flow is
attributed to the App's bot user (`<app-slug>[bot]`). Leaving the App unset keeps the ambient `gh`/git identity.

Setup:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps) and generate a private key (`.pem`).
2. Install the App on the target repo(s), granting:

   | Permission | Why |
   | --- | --- |
   | Issues: Read & write | issue comments and labels |
   | Pull requests: Read & write | PR creation, review comments and reactions |
   | Contents: Read & write | branch push |
   | Metadata: Read | mandatory |
   | Checks: Read | the CI-feedback loop |
   | Code scanning alerts: Read | only if `MINESWEEPER_ALERTS_ELIGIBLE` is true |
   | Secret scanning alerts: Read | only if `MINESWEEPER_ALERTS_ELIGIBLE` is true |

3. Set `MINESWEEPER_GITHUB_APP_ID` and one of `MINESWEEPER_GITHUB_APP_PRIVATE_KEY_PATH` /
   `MINESWEEPER_GITHUB_APP_PRIVATE_KEY` (see [`.env.sample`](.env.sample)). The installation id is resolved from the repo
   automatically; set `MINESWEEPER_GITHUB_APP_INSTALLATION_ID` to pin it. The installation token takes precedence over
   `GH_TOKEN` / `gh auth login`.

The token is refreshed automatically before it expires and is never written to disk or logged. One caveat: commits made
via the git CLI show as **"Unverified"** — GitHub only auto-verifies App commits created through its Contents API.

## Labelling issues for autofix

The simplest workflow is to apply the always-fix label to issues you want Minesweeper to pick up:

```sh
# One-off:
gh issue edit <N> --add-label autofix

# Or seed the labels on a fresh repo first:
minesweeper labels --force
```

The `labels` subcommand creates / updates every label Minesweeper relies on (`autofix`, `tryFix`, `manual`,
`possiblyDangerous`, `manuallyReviewed`, `minesweeperFailed`, `subtask`) with sensible colours and descriptions.

For issues filed by people whose intent you trust less than your own — community contributors, or your past self in a
hurry — apply `tryFix` instead of `autofix`. The issue still gets picked up automatically, but only after the
prompt-injection screener (`prompts/screener.md`) clears it. The screener is a Haiku call costing ~$0.001 per issue.

When filing issues you want Minesweeper to handle, use the **Autofix** issue template
(`.github/ISSUE_TEMPLATE/autofix.md`) — it pre-applies the label and provides a body shaped for the planner prompt.

## Running the daemon

```sh
minesweeper run
```

The daemon prints a pretty stream of events: `polled (N eligible) → dispatching → planning → executing → reviewing
→ PR opened`. Stop it with `Ctrl+C`; it drains in-flight children before exiting.

## Cron schedules and the JSON config file

The daemon's poll cadence is configurable in two ways. By default it polls every
`MINESWEEPER_POLL_INTERVAL_SECONDS` seconds (the legacy fixed interval). For
operators who want polling concentrated into known windows — say, every fifteen
minutes during business hours plus one nightly sweep — either of the two JSON
config files (global `~/.minesweeper/config.json` or per-repo
`<cwd>/.minesweeper/config.json`) accepts a list of cron expressions:

```json
{
  "schedule": ["*/15 * * * *", "0 2 * * *"],
  "pollCooldownSeconds": 120
}
```

Notes:

- Configuration precedence is `env > repo file > global file > defaults` (see
  the [Configuration](#configuration) section above for the full picture).
  Anything in either JSON file is overridable from the environment.
- `schedule` is **JSON-file-only** — cron list fields contain commas, which
  can't round-trip through a comma-delimited env var. A `schedule` array in
  the per-repo file replaces (rather than appends to) the global one.
- Schedules are interpreted in the daemon process's local timezone.
- A single global `pollCooldownSeconds` (default 120) gates every tick. Two
  schedules that align cannot both fire inside the cooldown window — the second
  is logged as `skipped poll: within cooldown (Ns since last)` and dropped.
  Set `pollCooldownSeconds: 0` to disable the gate.
- **Cron-only configurations do not fire an immediate poll at startup.** The
  first poll happens at the first cron match. Interval mode (no `schedule`
  configured) keeps the legacy "fire one tick immediately on startup" behaviour
  so operators see `polled (N eligible)` without waiting out the interval.

## Inspecting transcripts

`minesweeper log view <name>` pretty-prints a JSONL transcript captured by the planner / critic / executor / reviewer
under `<worktree>/.minesweeper/planning_history/`. Pass a bare name (`planner-01`) and the command resolves it
relative to the current worktree; pass an explicit path (or one ending in `.jsonl`) to view archived runs.

```sh
# Inside an active worktree, page through the first planning round:
minesweeper log view planner-01 | less -R
# Strip colour for grep / sed pipelines:
minesweeper log view planner-01 --no-color | grep tool_result
# Show full bodies (default caps each message body at 40 lines):
minesweeper log view executor-01 --max-lines 0
```

## Logs and post-mortem

* **Structured logs** — JSON, one line per event, in `.minesweeper/logs/daemon.log` (rotated by Minesweeper). Useful
  with `jq`. Per-issue children write their own logs into `<worktree>/.minesweeper/logs/`.
* **Pretty stdout** — `chalk`-coloured summaries; this is the human-readable view.
* **Successful runs** — when a child exits 0 the daemon leaves the worktree on disk and only logs `child exited 0;
  worktree at … kept until issue is closed`. The PR reviewer can poke at `<worktree>/.minesweeper/` while the PR is
  open. Once the issue is closed (typically by the PR being merged), the next poll tick's sweep archives
  `.minesweeper/` under `$MINESWEEPER_WORKTREE_PATH/archive/<issue>-<timestamp>/` and removes the worktree.
* **Failed runs** — the worktree is **left in place** at `$MINESWEEPER_WORKTREE_PATH/<branch>` and the issue is
  tagged with `$MINESWEEPER_FAILED_LABEL`. Inspect the run with:

  ```sh
  cat $MINESWEEPER_WORKTREE_PATH/<branch>/.minesweeper/state.json
  ls $MINESWEEPER_WORKTREE_PATH/<branch>/.minesweeper/
  ```

  When you're done, close the issue (e.g. as "not planned") — the next sweep tick will archive and remove the
  worktree for you. If you want to clean up sooner, `git worktree remove` works too.

# Bootstrap mode — using Minesweeper to develop Minesweeper

Minesweeper was built to dogfood itself. During the run-up to **v0.2.0** we filed `autofix`-labelled issues against
this very repo and let the daemon raise the PRs. While exciting, that was also where things could go sideways fastest,
so the following safety rules applied throughout bootstrap:

* **Run only against issues you filed yourself.** Bootstrap-mode Minesweeper was not pointed at issues filed by external
  contributors until the prompt-injection screen landed.
* **Keep `MINESWEEPER_DEFAULT_ELIGIBLE=false`.** The always-fix label was the only opt-in path during bootstrap.
* **The main checkout is never touched.** The daemon only ever operates inside generated worktrees, so uncommitted
  work in the main checkout was safe by construction.
* **Review every PR.** Bootstrap-mode Minesweeper opened PRs the same way a human contributor would — they went through
  the normal CI + review path. Nothing was auto-merged.
* **Stop on red.** If two consecutive runs produced broken PRs, the daemon was stopped and the worktrees inspected
  rather than letting it churn.

With v0.2.0 shipped, these rules have relaxed: the prompt-injection screen now makes external issues safer to accept,
and assess/refine modes let Minesweeper decompose its own work.
