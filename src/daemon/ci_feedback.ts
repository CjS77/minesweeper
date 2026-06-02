/**
 * CI-feedback poller: detects failing GitHub check runs on open
 * Minesweeper PR branches and re-dispatches the worktree into
 * `AddressingCIFailure` mode so the executor can push a fix.
 *
 * Trigger conditions, evaluated once per worktree per tick:
 *
 *   - `config.ciChecksEligible` is true.
 *   - The worktree's `state.json` carries a `prNumber`, has
 *     `status = "Complete"`, and is in `Execution`,
 *     `AddressingPRFeedback`, or `AddressingCIFailure` mode (i.e. a
 *     PR is open and the worktree is not mid-flight in another phase).
 *   - The issue is not currently in-flight on the supervisor.
 *   - At least one check run on the branch HEAD is `completed` with a
 *     failing conclusion (`failure | timed_out | action_required`).
 *   - No check is still `queued` or `in_progress` — we wait for all
 *     checks to settle so the executor gets the complete failure picture.
 *   - The HEAD SHA of the failing checks differs from
 *     `state.ciChecksProcessedAt` — prevents re-dispatching against
 *     the same commit's already-processed failures.
 *   - `state.ciFixIterations` is below `config.maxReviewRounds` — the
 *     lifetime CI-fix dispatch count for this worktree. When the cap is
 *     reached the poller emits a WARN and silently watermarks the SHA
 *     rather than applying `failedLabel`, so the PR stays open for a
 *     human to close.
 *
 * Side effects on a dispatch:
 *
 *   1. Render the failing check runs to
 *      `<worktree>/.minesweeper/ci_check_failures.md` (overwriting any
 *      prior round — the CI-failure mode only acts on the latest).
 *   2. Update state with `mode = "AddressingCIFailure"`,
 *      `status = "InProgress"`, `iterations = 0`,
 *      `maxIterations = config.maxReviewRounds`,
 *      `ciChecksProcessedAt = headSha`, and
 *      `ciFixIterations = (state.ciFixIterations ?? 0) + 1`.
 *   3. Hand the worktree to `supervisor.resume`, which re-spawns the
 *      child.
 *
 * Errors talking to `gh` are logged WARN and the worktree is skipped
 * for the tick — a transient API hiccup must not block the daemon.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config.js";
import * as defaultGithub from "../github/index.js";
import type { CheckRun } from "../github/index.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import * as defaultWorktree from "../worktree.js";
import type { State } from "../child/state.js";
import * as defaultState from "../child/state.js";

/** Path (worktree-relative) the daemon writes failing check details to. */
export const CI_CHECK_FAILURES_FILE = join(".minesweeper", "ci_check_failures.md");

/** Worktree-shaped argument the supervisor accepts in `resume`. */
export interface ResumeArg {
  path: string;
  state: State;
}

export type ResumeFn = (orphan: ResumeArg) => Promise<boolean>;

export interface CIFeedbackDeps {
  config: Config;
  /** Absolute path of the parent repo (used for `gh` cwd). */
  repoRoot: string;
  /** Where new worktrees live; one subdir per branch. */
  worktreesRoot: string;
  /** Predicate the supervisor exposes for "this issue has a running child". */
  isInFlight: (issueNumber: number) => boolean;
  /** Supervisor's `resume` — the dispatch path for re-running on a worktree. */
  resume: ResumeFn;
  /** Override the github wrapper (tests). */
  github?: Pick<typeof defaultGithub, "getCheckRuns">;
  /** Override worktree helpers (tests). */
  worktree?: Pick<typeof defaultWorktree, "listOrphans">;
  /** Override the state writer (tests). */
  writeState?: typeof defaultState.writeState;
  /** Override the logger event sink (tests). */
  emit?: Logger["event"];
}

/** Iterate every orphan with a PR and check for fresh failing CI runs. */
export async function pollCIFeedback(deps: CIFeedbackDeps): Promise<void> {
  if (!deps.config.ciChecksEligible) return;

  const gh = deps.github ?? defaultGithub;
  const wt = deps.worktree ?? defaultWorktree;
  const emit = deps.emit ?? defaultEvent;
  const writeState = deps.writeState ?? defaultState.writeState;

  const orphans = await wt.listOrphans(deps.worktreesRoot);
  const candidates = orphans.filter(
    (o): o is { path: string; state: State } =>
      o.state !== undefined &&
      o.state.prNumber !== null &&
      o.state.status === "Complete" &&
      (o.state.mode === "Execution" ||
        o.state.mode === "AddressingPRFeedback" ||
        o.state.mode === "AddressingCIFailure") &&
      !deps.isInFlight(o.state.issueNumber),
  );
  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    await processCandidate({ candidate, gh, writeState, resume: deps.resume, config: deps.config, emit });
  }
}

interface ProcessCandidateArgs {
  candidate: { path: string; state: State };
  gh: Pick<typeof defaultGithub, "getCheckRuns">;
  writeState: typeof defaultState.writeState;
  resume: ResumeFn;
  config: Config;
  emit: Logger["event"];
}

async function processCandidate(args: ProcessCandidateArgs): Promise<void> {
  const { candidate, gh, writeState, resume, config, emit } = args;
  const { state } = candidate;

  let runs: CheckRun[];
  try {
    runs = await gh.getCheckRuns(state.branchName, { cwd: candidate.path });
  } catch (err) {
    emit(
      "daemon",
      "WARN",
      state.issueNumber,
      `ci-feedback: getCheckRuns for ${state.branchName} failed (${(err as Error).message})`,
    );
    return;
  }

  if (runs.length === 0) return;

  // Wait for all checks to settle — acting while some are still running
  // would give the executor an incomplete picture.
  const anyPending = runs.some((r) => r.status === "queued" || r.status === "in_progress");
  if (anyPending) return;

  const failing = runs.filter(
    (r) => r.status === "completed" && isFailing(r.conclusion ?? null),
  );
  if (failing.length === 0) return;

  // All check runs in a batch share the same head_sha; use the first.
  const headSha = runs[0]?.head_sha;
  if (!headSha) return;

  if (headSha === state.ciChecksProcessedAt) return;

  const currentIterations = state.ciFixIterations ?? 0;
  if (currentIterations >= config.maxReviewRounds) {
    emit(
      "daemon",
      "WARN",
      state.issueNumber,
      `ci-feedback: CI fix iteration cap (${config.maxReviewRounds}) reached for #${state.issueNumber}; stopping`,
    );
    // Watermark the SHA so we don't re-log every tick.
    await writeState(candidate.path, { ...state, ciChecksProcessedAt: headSha });
    return;
  }

  const rendered = renderFailures(failing, headSha);
  await writeCIFailuresFile(candidate.path, rendered);

  const newState = await writeState(candidate.path, {
    ...state,
    mode: "AddressingCIFailure",
    status: "InProgress",
    iterations: 0,
    maxIterations: config.maxReviewRounds,
    ciChecksProcessedAt: headSha,
    ciFixIterations: currentIterations + 1,
  });

  emit(
    "daemon",
    "WORK",
    state.issueNumber,
    `ci-feedback: dispatching #${state.issueNumber} (${failing.length} failing check(s) on ${headSha.slice(0, 7)})`,
  );
  await resume({ path: candidate.path, state: newState });
}

function isFailing(conclusion: string | null): boolean {
  return conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required";
}

function renderFailures(failing: CheckRun[], headSha: string): string {
  const lines: string[] = [
    "# CI check failures",
    "",
    `Commit: ${headSha}`,
    "",
  ];

  for (const run of failing) {
    const app = run.app?.name ? ` (${run.app.name})` : "";
    lines.push(`## ${run.name}${app}`);
    lines.push(`Conclusion: ${run.conclusion ?? "unknown"}`);
    if (run.completed_at) lines.push(`Completed: ${run.completed_at}`);
    lines.push(`URL: ${run.html_url}`);
    lines.push("");

    const title = run.output?.title?.trim();
    const summary = run.output?.summary?.trim();
    if (title) {
      lines.push(`### ${title}`);
      lines.push("");
    }
    if (summary) {
      lines.push(summary);
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function writeCIFailuresFile(worktreePath: string, content: string): Promise<void> {
  const path = join(worktreePath, CI_CHECK_FAILURES_FILE);
  await fs.mkdir(join(worktreePath, ".minesweeper"), { recursive: true });
  const payload = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(path, payload, "utf8");
}
