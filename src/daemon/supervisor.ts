/**
 * Per-issue child supervisor.
 *
 * Owns the lifecycle around `minesweeper handle <issue#>`:
 *
 *   1. Compute the per-issue branch name (`{repo-slug}-issue{NNNN}`),
 *   2. Create the worktree and seed `state.json`,
 *   3. Spawn the child with `cwd` set to the worktree,
 *   4. On exit:
 *        exit 0 → log success and leave the worktree on disk so the operator
 *                 (or a reviewer of the open PR) can inspect it; cleanup is
 *                 deferred to the closed-issue sweep,
 *        exit ≠ 0 → label the issue with `failedLabel`, leave the worktree
 *                   alone for post-mortem; cleanup also deferred to the
 *                   closed-issue sweep.
 *
 * Closed-issue sweep: `sweepClosedIssues` enumerates worktree dirs on disk,
 * skips ones whose issue is in-flight, asks `gh` for each remaining issue's
 * state, and archives `.minesweeper/` + removes the worktree once the issue
 * is `CLOSED`. This applies to both successful (PR merged or manually closed)
 * and failed (operator triaged + closed) lifecycles. The sweep is wired to
 * fire once per poll tick from `cli.ts`.
 *
 * In-flight reaper: the sweep deliberately skips in-flight worktrees, so a
 * work item closed *while its child is running* would otherwise keep burning
 * tokens through review/refine. `reapClosedInFlight` covers that gap — given
 * the set of open work-item keys the poll tick already fetched, it `SIGTERM`s
 * any in-flight child whose key is absent (closed externally). The killed
 * child exits non-zero but is flagged so `handleChildExit` reaps its worktree
 * instead of mislabelling it as a failure.
 *
 * Concurrency is bounded by `config.maxConcurrency` (v0 default 1, i.e.
 * strictly serial). Extra work goes onto an in-memory queue and starts as
 * slots free up. Re-entrancy is prevented two ways:
 *   - the inflight `Map<issueNumber, …>` short-circuits dispatches for
 *     issues that already have a child running, and
 *   - the worktree-existence check short-circuits dispatches whose worktree
 *     dir is already on disk (e.g. a previous run was killed mid-flight, or
 *     an exited child whose issue is still open — orphan recovery handles
 *     in-progress orphans via `resume`, the sweep handles closed-issue ones).
 *
 * `drain` is the shutdown handle: it stops accepting new work, drops the
 * queue, and resolves once every in-flight child has exited.
 */

import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { execaNode } from "execa";

import type { Config } from "../config.js";
import * as defaultGithub from "../github/index.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import * as defaultWorktree from "../worktree.js";
import * as defaultState from "../child/state.js";
import type { State, WorkItemKind } from "../child/state.js";
import { loadCodeownerLogins as defaultLoadCodeownerLogins } from "../codeowners.js";
import { pollPrFeedback as defaultPollPrFeedback } from "./pr_feedback.js";
import { pollCIFeedback as defaultPollCIFeedback } from "./ci_feedback.js";
import { branchSegmentForKind, workItemKey, workItemNumber, type WorkItem } from "../workitem.js";

const ISSUE_NUMBER_PAD = 4;
const FAILED_EXIT_CODE = -1;

/** Lifecycle handle returned by the spawn function. */
export interface ChildHandle {
  /** Resolves with the child's exit code (or {@link FAILED_EXIT_CODE} if spawn failed). */
  exit: Promise<number>;
  /** Best-effort signal delivery. Used during shutdown. */
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnChildOptions {
  issueNumber: number;
  worktreePath: string;
  /**
   * Work-item kind. Defaults to `"issue"` for back-compat with existing
   * tests. The CLI argument the child receives is the namespaced
   * `parseHandleArg` form for non-issue kinds.
   */
  kind?: WorkItemKind;
}

export type SpawnChild = (opts: SpawnChildOptions) => ChildHandle;

export interface OrphanedWorktree {
  path: string;
  state: State;
}

export interface SupervisorDeps {
  config: Config;
  /** Absolute path of the parent repo. Used as the slug source and worktree owner. */
  repoRoot: string;
  /** Where new worktrees are created (one subdir per branch). */
  worktreesRoot: string;
  /** Where archived `.minesweeper/` directories land when an issue is closed. */
  archiveRoot: string;
  /** Test/dev seam: how to spawn the per-issue child. Defaults to {@link defaultSpawnChild}. */
  spawnChild?: SpawnChild;
  /** Override the github carve-out (tests). */
  github?: Pick<
    typeof defaultGithub,
    | "addLabel"
    | "getIssue"
    | "getCodeScanningAlert"
    | "getSecretScanningAlert"
    | "getPullRequest"
    | "getReviewThreads"
    | "getReviewCommentReactions"
    | "getRepoOwner"
    | "getCheckRuns"
  >;
  /** Override worktree helpers (tests). */
  worktree?: Pick<typeof defaultWorktree, "addWorktree" | "archiveWorktreeState" | "removeWorktree" | "listOrphans">;
  /** Override `child/state.initState` (tests). */
  initState?: typeof defaultState.initState;
  /** Override the codeowners loader (tests). */
  loadCodeownerLogins?: typeof defaultLoadCodeownerLogins;
  /** Override the state writer (tests). */
  writeState?: typeof defaultState.writeState;
  /** Override the PR-feedback poller (tests). */
  pollPrFeedback?: typeof defaultPollPrFeedback;
  /** Override the CI-feedback poller (tests). */
  pollCIFeedback?: typeof defaultPollCIFeedback;
  /** Override the logger event sink. */
  emit?: Logger["event"];
  /** Test seam for the worktree-exists pre-flight check. */
  pathExists?: (path: string) => Promise<boolean>;
}

export interface Supervisor {
  /**
   * Take ownership of a {@link WorkItem}: queue (or start immediately) a
   * fresh dispatch. Returns `false` if already in flight, already queued,
   * the worktree exists, or the supervisor has been drained.
   */
  dispatch(item: WorkItem): Promise<boolean>;
  /**
   * Re-spawn a child against an existing worktree (used at startup for
   * orphan recovery). Skips orphans whose state is `Failed` or already
   * `Complete` — those wait for the closed-issue sweep, not a child re-run.
   */
  resume(orphan: OrphanedWorktree): Promise<boolean>;
  /**
   * Enumerate worktree dirs on disk, query `gh` for each issue's state,
   * and archive + remove the worktrees whose issue is `CLOSED`. Skips
   * in-flight issues. Errors talking to `gh` are logged and swallowed so
   * a transient GitHub failure does not take down the daemon.
   */
  sweepClosedIssues(): Promise<void>;
  /**
   * Terminate in-flight children whose work item was closed externally.
   * `openKeys` is the {@link workItemKey} set the poll tick already
   * fetched; any in-flight key absent from it has been closed on GitHub.
   * The child is `SIGTERM`'d and flagged so its non-zero exit reaps the
   * worktree rather than applying `failedLabel`. Idempotent across ticks —
   * a child already being reaped is not signalled again.
   */
  reapClosedInFlight(openKeys: ReadonlySet<string>): Promise<void>;
  /**
   * Inspect each Minesweeper-owned PR for fresh reviewer activity and,
   * if any authorised reviewer requested changes since the worktree's
   * watermark, re-dispatch the worktree into `AddressingPRFeedback`
   * mode. Errors talking to `gh` are logged and swallowed.
   */
  pollPrFeedback(): Promise<void>;
  /**
   * Inspect each Minesweeper-owned PR branch for failing CI check runs
   * and, when all checks have settled with at least one failure, re-
   * dispatch the worktree into `AddressingCIFailure` mode. Errors
   * talking to `gh` are logged and swallowed.
   */
  pollCIFeedback(): Promise<void>;
  /**
   * Per-poll-cycle sweep — re-queues `Paused` orphans whose `canResumeAt`
   * has elapsed (or is `null`, meaning retry next cycle). Skips orphans
   * already in-flight. Runs after `sweepClosedIssues` so a paused worktree
   * whose issue was closed gets reaped rather than resumed.
   */
  resumePausedWorktrees(): Promise<void>;
  /**
   * Identifiers of currently in-flight children. Strings of the form
   * `${kind}:${number}` so issue #N and alert #N are distinguishable.
   */
  inFlight(): readonly string[];
  /** Number of items waiting for a free slot. */
  queueLength(): number;
  /** Stop accepting new work; drop the queue; await every running child. */
  drain(): Promise<void>;
}

export interface DefaultSpawnChildOptions {
  /** Absolute path to the compiled CLI script the child runs. */
  childScript: string;
  /**
   * Absolute path of the daemon's repo root. Used to point the child at the
   * same per-repo config file the daemon resolved — without this, the child
   * (whose cwd is a worktree under `MINESWEEPER_WORKTREE_PATH`) would look
   * for `.minesweeper/config.json` in the worktree and miss every per-repo
   * override the operator set. Forwarded as `MINESWEEPER_REPO_CONFIG_FILE`,
   * but only as a default — an explicit env var on the parent wins.
   */
  repoRoot: string;
}

/**
 * Production spawner: `execa.node(childScript, ["handle", arg], { cwd: worktreePath, stdio: "inherit" })`.
 * For issue work items the CLI arg is just the bare number (legacy form).
 * For alert kinds it is the namespaced form `kind/N` consumed by
 * `parseHandleArg` in `cli.ts`.
 *
 * Tests pass a stub via {@link SupervisorDeps.spawnChild}.
 *
 * `reject: false` is set so a non-zero exit returns a result object rather
 * than rejecting — the supervisor needs to inspect `exitCode` to decide
 * between the success and failure paths.
 */
export function defaultSpawnChild(opts: DefaultSpawnChildOptions): SpawnChild {
  // Default repo-config pointer: spread `process.env` *after* it so a value
  // already set on the parent (e.g. operator `MINESWEEPER_REPO_CONFIG_FILE=…`)
  // wins; the daemon-derived path is only the fallback.
  const childEnv: NodeJS.ProcessEnv = {
    MINESWEEPER_REPO_CONFIG_FILE: join(opts.repoRoot, ".minesweeper", "config.json"),
    ...process.env,
  };
  return ({ issueNumber, worktreePath, kind = "issue" }: SpawnChildOptions): ChildHandle => {
    const arg = kind === "issue" ? String(issueNumber) : `${kind}/${issueNumber}`;
    const sub = execaNode(opts.childScript, ["handle", arg], {
      cwd: worktreePath,
      stdio: "inherit",
      detached: false,
      reject: false,
      env: childEnv,
    });
    const exit = sub.then(
      (r) => r.exitCode ?? FAILED_EXIT_CODE,
      () => FAILED_EXIT_CODE,
    );
    return {
      exit,
      kill(signal: NodeJS.Signals = "SIGTERM") {
        sub.kill(signal);
      },
    };
  };
}

/**
 * Format the canonical per-work-item branch name. Uses the kind as a
 * namespace prefix so issue #N and alert #N (which share the same numeric
 * keyspace inside their respective sources) cannot collide on disk:
 *
 *   - issue:               `{slug}-issue{NNNN}`
 *   - codeScanningAlert:   `{slug}-codeScanningAlert{NNNN}`
 *   - secretScanningAlert: `{slug}-secretScanningAlert{NNNN}`
 *
 * Slug is the basename of the repo root; numbers are zero-padded to four
 * digits (1 → "0001", 99 → "0099", 12345 → "12345" — pad does not truncate).
 */
export function branchNameFor(repoRoot: string, issueNumber: number, kind: WorkItemKind = "issue"): string {
  const slug = basename(repoRoot);
  return `${slug}-${branchSegmentForKind(kind)}${String(issueNumber).padStart(ISSUE_NUMBER_PAD, "0")}`;
}

interface QueueEntry {
  kind: WorkItemKind;
  issueNumber: number;
  branchName: string;
  /** Set for resume entries; absent for fresh dispatches. */
  worktreePath?: string;
  resume: boolean;
}

interface InFlight {
  kind: WorkItemKind;
  issueNumber: number;
  worktreePath: string;
  /** Signal delivery into the running child. Used by the in-flight reaper. */
  kill: ChildHandle["kill"];
  /** Resolves when the child has exited AND post-exit cleanup has run. */
  done: Promise<void>;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const emit = deps.emit ?? defaultEvent;
  const gh = deps.github ?? defaultGithub;
  const wt = deps.worktree ?? defaultWorktree;
  const initState = deps.initState ?? defaultState.initState;
  const writeState = deps.writeState ?? defaultState.writeState;
  const loadCodeownerLogins = deps.loadCodeownerLogins ?? defaultLoadCodeownerLogins;
  const pollPrFeedbackFn = deps.pollPrFeedback ?? defaultPollPrFeedback;
  const pollCIFeedbackFn = deps.pollCIFeedback ?? defaultPollCIFeedback;
  const exists = deps.pathExists ?? pathExistsImpl;
  const spawn = deps.spawnChild ?? defaultSpawnChild({ childScript: requiredChildScript(), repoRoot: deps.repoRoot });

  const queue: QueueEntry[] = [];
  const inflight = new Map<string, InFlight>();
  /** Keys of in-flight children that have been `SIGTERM`'d because their work
   *  item closed externally. Read by `handleChildExit` to route the exit to
   *  worktree reaping instead of the `failedLabel` path. */
  const closedExternally = new Set<string>();
  let accepting = true;

  /** Already known to the supervisor (running or queued)? Keyed by `(kind, number)`. */
  const isKnown = (kind: WorkItemKind, issueNumber: number): boolean => {
    const key = workItemKey(kind, issueNumber);
    return inflight.has(key) || queue.some((q) => workItemKey(q.kind, q.issueNumber) === key);
  };

  const dispatch = async (item: WorkItem): Promise<boolean> => {
    if (!accepting) return false;
    const number = workItemNumber(item);
    if (isKnown(item.kind, number)) return false;

    const branchName = branchNameFor(deps.repoRoot, number, item.kind);
    const worktreePath = join(deps.worktreesRoot, branchName);
    if (await exists(worktreePath)) {
      emit("daemon", "WARN", number, `worktree already exists at ${worktreePath}; skipping dispatch`, {
        kind: item.kind,
      });
      return false;
    }

    queue.push({ kind: item.kind, issueNumber: number, branchName, resume: false });
    void drain();
    return true;
  };

  const resume = async (orphan: OrphanedWorktree): Promise<boolean> => {
    if (!accepting) return false;
    if (orphan.state.status === "Failed") return false;
    // Complete orphans don't need a child re-run — the work is already done
    // and the worktree is just waiting for the closed-issue sweep.
    if (orphan.state.status === "Complete") return false;
    if (isKnown(orphan.state.kind, orphan.state.issueNumber)) return false;

    queue.push({
      kind: orphan.state.kind,
      issueNumber: orphan.state.issueNumber,
      branchName: orphan.state.branchName,
      worktreePath: orphan.path,
      resume: true,
    });
    emit(
      "daemon",
      "INFO",
      orphan.state.issueNumber,
      `recovering orphan worktree ${orphan.path} (mode=${orphan.state.mode}, status=${orphan.state.status})`,
      { kind: orphan.state.kind },
    );
    void drain();
    return true;
  };

  /**
   * Archive the worktree's `.minesweeper/` directory, then remove the worktree
   * and its branch. Shared by the closed-issue sweep and the in-flight reaper.
   * `reason` is interpolated into the success log ("closed", "closed
   * externally"). Failures are logged, never thrown — a transient git/fs error
   * should not take down the daemon.
   */
  const reapWorktree = async (
    kind: WorkItemKind,
    issueNumber: number,
    worktreePath: string,
    reason: string,
  ): Promise<void> => {
    try {
      const archiveDir = await wt.archiveWorktreeState({
        worktreePath,
        archiveRoot: deps.archiveRoot,
        issueNumber,
        kind,
      });
      await wt.removeWorktree(worktreePath);
      emit("daemon", "OK", issueNumber, `${kind} ${reason}; archived to ${archiveDir} and removed worktree`, { kind });
    } catch (err) {
      emit("daemon", "ERROR", issueNumber, `cleanup failed for ${worktreePath}: ${(err as Error).message}`, { kind });
    }
  };

  const sweepClosedIssues = async (): Promise<void> => {
    const orphans = await wt.listOrphans(deps.worktreesRoot);
    for (const orphan of orphans) {
      if (!orphan.state) continue;
      const { issueNumber, kind } = orphan.state;
      if (inflight.has(workItemKey(kind, issueNumber))) continue;

      let isClosed: boolean;
      try {
        isClosed = await isWorkItemClosed(gh, kind, issueNumber, deps.repoRoot);
      } catch (err) {
        emit(
          "daemon",
          "WARN",
          issueNumber,
          `sweep: gh fetch failed (${(err as Error).message}); leaving worktree at ${orphan.path}`,
          { kind },
        );
        continue;
      }
      if (!isClosed) continue;

      await reapWorktree(kind, issueNumber, orphan.path, "closed");
    }
  };

  const reapClosedInFlight = async (openKeys: ReadonlySet<string>): Promise<void> => {
    for (const [key, item] of inflight) {
      if (openKeys.has(key) || closedExternally.has(key)) continue;
      closedExternally.add(key);
      emit(
        "daemon",
        "WARN",
        item.issueNumber,
        `${item.kind} closed externally while in-flight; terminating child to reap the worktree`,
        { kind: item.kind },
      );
      item.kill("SIGTERM");
    }
  };

  const resumePausedWorktrees = async (): Promise<void> => {
    const orphans = await wt.listOrphans(deps.worktreesRoot);
    const now = Date.now();
    for (const orphan of orphans) {
      const st = orphan.state;
      if (!st || st.status !== "Paused") continue;
      if (inflight.has(workItemKey(st.kind, st.issueNumber))) continue;
      if (st.canResumeAt && Date.parse(st.canResumeAt) > now) {
        emit(
          "daemon",
          "INFO",
          st.issueNumber,
          `paused worktree not yet resumable (canResumeAt=${st.canResumeAt}); skipping`,
          {
            kind: st.kind,
          },
        );
        continue;
      }
      await resume({ path: orphan.path, state: st });
    }
  };

  const pollPrFeedback = async (): Promise<void> => {
    await pollPrFeedbackFn({
      config: deps.config,
      repoRoot: deps.repoRoot,
      worktreesRoot: deps.worktreesRoot,
      // pr_feedback today only re-dispatches issue-backed worktrees (state.prNumber
      // is only ever set by the executor for kind="issue"). Check the issue key
      // explicitly so the type stays narrow.
      isInFlight: (n) => inflight.has(workItemKey("issue", n)),
      resume,
      github: gh,
      worktree: wt,
      loadCodeownerLogins,
      writeState,
      emit,
    });
  };

  const pollCIFeedback = async (): Promise<void> => {
    await pollCIFeedbackFn({
      config: deps.config,
      repoRoot: deps.repoRoot,
      worktreesRoot: deps.worktreesRoot,
      isInFlight: (n) => inflight.has(workItemKey("issue", n)),
      resume,
      github: gh,
      worktree: wt,
      writeState,
      emit,
    });
  };

  /** Move queue entries into the inflight map until at capacity. */
  const drain = async (): Promise<void> => {
    while (inflight.size < deps.config.maxConcurrency && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      await start(next);
    }
  };

  const start = async (entry: QueueEntry): Promise<void> => {
    let worktreePath: string;
    try {
      if (entry.resume && entry.worktreePath) {
        worktreePath = entry.worktreePath;
      } else {
        const added = await wt.addWorktree({
          repoRoot: deps.repoRoot,
          worktreesRoot: deps.worktreesRoot,
          branchName: entry.branchName,
        });
        worktreePath = added.path;
        await initState(worktreePath, "Planning", {
          kind: entry.kind,
          issueNumber: entry.issueNumber,
          branchName: added.branch,
          maxIterations: deps.config.maxPlanningIterations,
        });
        emit("daemon", "WORK", entry.issueNumber, `dispatching → ${worktreePath}`, { kind: entry.kind });
      }
    } catch (err) {
      emit("daemon", "ERROR", entry.issueNumber, `failed to set up worktree: ${(err as Error).message}`, {
        kind: entry.kind,
      });
      return;
    }

    const child = spawn({ kind: entry.kind, issueNumber: entry.issueNumber, worktreePath });
    const key = workItemKey(entry.kind, entry.issueNumber);
    const done = handleChildExit(entry.kind, entry.issueNumber, worktreePath, child).finally(() => {
      inflight.delete(key);
      void drain();
    });
    inflight.set(key, { kind: entry.kind, issueNumber: entry.issueNumber, worktreePath, kill: child.kill, done });
  };

  const handleChildExit = async (
    kind: WorkItemKind,
    issueNumber: number,
    worktreePath: string,
    child: ChildHandle,
  ): Promise<void> => {
    const code = await child.exit;

    // A child the in-flight reaper terminated exits non-zero, but its work
    // item is closed — reap the worktree rather than treating it as a failure.
    const key = workItemKey(kind, issueNumber);
    if (closedExternally.has(key)) {
      closedExternally.delete(key);
      emit("daemon", "INFO", issueNumber, `child exited ${code} after external close; reaping worktree`, { kind });
      await reapWorktree(kind, issueNumber, worktreePath, "closed externally");
      return;
    }

    if (code === 0) {
      emit("daemon", "OK", issueNumber, `child exited 0; worktree at ${worktreePath} kept until issue is closed`, {
        kind,
      });
      return;
    }

    if (kind === "issue") {
      try {
        await gh.addLabel(issueNumber, deps.config.failedLabel, { cwd: deps.repoRoot });
      } catch (err) {
        emit(
          "daemon",
          "ERROR",
          issueNumber,
          `child exited ${code}; could not apply ${deps.config.failedLabel}: ${(err as Error).message}`,
        );
        // fall through and still log the worktree path below
      }
    } else {
      // Alerts cannot carry GitHub labels, so the failedLabel post-mortem is
      // skipped — the worktree is left in place for an operator to inspect.
      emit("daemon", "WARN", issueNumber, `${kind} cannot be labelled ${deps.config.failedLabel}; skipping`, { kind });
    }
    emit("daemon", "ERROR", issueNumber, `child exited ${code}; left worktree at ${worktreePath} for post-mortem`, {
      kind,
    });
  };

  return {
    dispatch,
    resume,
    sweepClosedIssues,
    reapClosedInFlight,
    resumePausedWorktrees,
    pollPrFeedback,
    pollCIFeedback,
    inFlight: () => [...inflight.keys()],
    queueLength: () => queue.length,
    async drain(): Promise<void> {
      accepting = false;
      queue.length = 0;
      if (inflight.size === 0) return;
      await Promise.all([...inflight.values()].map((i) => i.done));
    },
  };
}

async function pathExistsImpl(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function requiredChildScript(): string {
  // The CLI is responsible for plumbing an absolute childScript path; the
  // default supervisor never reaches this branch in tests because tests
  // always inject `spawnChild`. If someone constructs a supervisor without
  // a spawn function in production, fail loudly rather than running the
  // wrong binary.
  throw new Error(
    "createSupervisor: pass deps.spawnChild (e.g. defaultSpawnChild({ childScript })) — no default child script available",
  );
}

/**
 * Per-kind "is this work item still actionable?" check used by the
 * closed-work-item sweep. Issues are closed when GitHub's `state` is
 * `"CLOSED"`. Code-scanning alerts use `state ∈ {open, dismissed, fixed,
 * auto_dismissed}`; secret-scanning alerts use `{open, resolved}`. In
 * both cases anything other than `"open"` means "reap the worktree."
 */
async function isWorkItemClosed(
  gh: NonNullable<SupervisorDeps["github"]>,
  kind: WorkItemKind,
  number: number,
  cwd: string,
): Promise<boolean> {
  switch (kind) {
    case "issue": {
      const issue = await gh.getIssue(number, { cwd });
      return issue.state === "CLOSED";
    }
    case "codeScanningAlert": {
      const alert = await gh.getCodeScanningAlert(number, { cwd });
      return alert.state !== "open";
    }
    case "secretScanningAlert": {
      const alert = await gh.getSecretScanningAlert(number, { cwd });
      return alert.state !== "open";
    }
  }
}
