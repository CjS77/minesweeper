/**
 * GitHub poller for the daemon.
 *
 * `pollOnce` is a one-shot: it lists open issues via `gh`, runs each through
 * the eligibility filter, and returns the survivors. It has no side effects
 * — the caller decides what to do with the list.
 *
 * `runPollLoop` schedules one `setInterval` per spec (each spec is a poll
 * interval in milliseconds, parsed from config by the CLI). On every tick it
 * calls `pollOnce` and forwards each eligible issue to the supplied
 * `onIssue` callback (typically `supervisor.dispatch`), then invokes the
 * optional `onTickEnd` hook (typically `supervisor.sweepClosedIssues`). The
 * first tick fires immediately so operators see "polled (N eligible)"
 * without waiting out the interval; subsequent ticks fire every `intervalMs`.
 *
 * Errors in a tick are logged and swallowed — a transient `gh` failure
 * should not take down the daemon.
 */

import * as defaultGithub from "../github/index.js";
import type { Issue } from "../github/index.js";
import type { Config } from "../config.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { decideEligibility as defaultDecideEligibility, type EligibilityDecision } from "./eligibility.js";
import type { ScreenIssueFn } from "./eligibility.js";

/**
 * Predicate the poller uses to filter issues. Async because the
 * default implementation may call out to the screener subagent. Tests
 * can inject a sync function — both `boolean` and `Promise<boolean>`
 * are accepted.
 */
export type EligibilityFn = (issue: Issue, config: Config) => boolean | Promise<boolean>;

export interface PollerDeps {
  /** Loaded config; passed to the eligibility predicate. */
  config: Config;
  /** Working directory for `gh` invocations (the parent repo root). */
  cwd: string;
  /** Override `github.listIssues` / `addLabel` / `comment` (tests). */
  github?: Pick<typeof defaultGithub, "listIssues" | "addLabel" | "comment">;
  /** Override the eligibility predicate (tests). */
  isEligible?: EligibilityFn;
  /** Override the screener (passed through to {@link decideEligibility}). */
  screenIssue?: ScreenIssueFn;
  /** Override the logger event sink. */
  emit?: Logger["event"];
}

/**
 * Run a single poll: list open issues, return the eligible ones.
 *
 * The default predicate is {@link defaultDecideEligibility}, which may
 * apply the `possiblyDangerous` label or post a comment when the
 * screener flags an issue. Those side effects happen *during* the
 * `pollOnce` call — they are intentional, not an accident of polling.
 */
export async function pollOnce(deps: PollerDeps): Promise<Issue[]> {
  const gh = deps.github ?? defaultGithub;
  const emit = deps.emit ?? defaultEvent;
  const filter: EligibilityFn =
    deps.isEligible ??
    (async (issue: Issue): Promise<boolean> => {
      const decision: EligibilityDecision = await defaultDecideEligibility(issue, {
        config: deps.config,
        cwd: deps.cwd,
        github: gh,
        screenIssue: deps.screenIssue,
        emit,
      });
      emit(
        "daemon",
        decision.eligible ? "INFO" : "INFO",
        issue.number,
        `eligibility: ${decision.eligible ? "yes" : "no"} (${decision.reason})`,
      );
      return decision.eligible;
    });
  const issues = await gh.listIssues({ cwd: deps.cwd, state: "open" });
  const verdicts = await Promise.all(issues.map((issue) => Promise.resolve(filter(issue, deps.config))));
  return issues.filter((_, i) => verdicts[i]);
}

export interface PollLoopOptions {
  /**
   * Called once per eligible issue per poll tick. The supervisor's
   * `dispatch` is the canonical implementation.
   */
  onIssue: (issue: Issue) => void | Promise<void>;
  /**
   * Called once at the end of every tick, after all `onIssue` callbacks
   * have settled. The supervisor's `sweepClosedIssues` is the canonical
   * implementation: it reaps worktrees whose issue has been closed.
   */
  onTickEnd?: () => void | Promise<void>;
}

export interface PollLoopHandle {
  /** Clear all timers. Safe to call multiple times. */
  stop(): void;
}

/**
 * Schedule polling. Each `intervalMs` in `specs` gets its own
 * `setInterval` timer. The loop fires once immediately on startup so the
 * daemon's first poll happens before the interval elapses (plan 07
 * acceptance criterion).
 */
export function runPollLoop(deps: PollerDeps, specs: readonly number[], opts: PollLoopOptions): PollLoopHandle {
  const emit = deps.emit ?? defaultEvent;
  const tick = async (): Promise<void> => {
    try {
      const eligible = await pollOnce(deps);
      emit("daemon", "INFO", null, `polled (${eligible.length} eligible)`);
      for (const issue of eligible) {
        await opts.onIssue(issue);
      }
      if (opts.onTickEnd) {
        await opts.onTickEnd();
      }
    } catch (err) {
      emit("daemon", "ERROR", null, `poll failed: ${(err as Error).message}`);
    }
  };

  void tick();
  const timers = specs.map((intervalMs) =>
    setInterval(() => {
      void tick();
    }, intervalMs),
  );

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.forEach((t) => clearInterval(t));
    },
  };
}
