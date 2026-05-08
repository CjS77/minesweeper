/**
 * GitHub poller for the daemon.
 *
 * `pollOnce` is a one-shot: it lists open issues via `gh`, runs each through
 * the eligibility filter, and returns the survivors. It has no side effects
 * — the caller decides what to do with the list.
 *
 * `runPollLoop` accepts a list of {@link Schedule}s and arranges for `tick()`
 * to fire on each. Two flavours are supported:
 *
 * - `{ kind: "interval", intervalMs }` — the legacy fixed-interval driver.
 *   On startup an interval-bearing schedule list also fires one immediate
 *   tick so operators see "polled (N eligible)" without waiting out the
 *   interval (preserved from the original poller).
 * - `{ kind: "cron", expression }` — parsed via `cron-parser`. The next
 *   match is computed once and re-computed after each fire (no
 *   `setInterval`). Cron-only configurations do **not** fire an immediate
 *   tick on startup; the first poll happens at the first cron match.
 *
 * A single global cooldown (`pollCooldownMs`) gates every tick: when two
 * schedules align, the second is dropped with a "skipped poll: within
 * cooldown" log line. Errors in a tick are logged and swallowed — a
 * transient `gh` failure should not take down the daemon.
 */

import * as defaultGithub from "../github/index.js";
import type { Issue } from "../github/index.js";
import type { Config } from "../config.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { decideEligibility as defaultDecideEligibility, type EligibilityDecision } from "./eligibility.js";
import type { ScreenIssueFn } from "./eligibility.js";
import cronParser from "cron-parser";

/**
 * Predicate the poller uses to filter issues. Async because the
 * default implementation may call out to the screener subagent. Tests
 * can inject a sync function — both `boolean` and `Promise<boolean>`
 * are accepted.
 */
export type EligibilityFn = (issue: Issue, config: Config) => boolean | Promise<boolean>;

/**
 * One entry in the poll-loop schedule list.
 *
 * `interval` reproduces the legacy `setInterval(intervalMs)` driver;
 * `cron` is a 5-field cron expression evaluated in the daemon's local
 * timezone.
 */
export type Schedule = { kind: "interval"; intervalMs: number } | { kind: "cron"; expression: string };

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
  /** Override the cooldown window (defaults to `config.pollCooldownMs`). */
  cooldownMs?: number;
  /** Inject a clock (defaults to `Date.now`). Used for both cooldown maths and as the cron anchor. */
  now?: () => number;
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
 * Schedule polling against `schedules`. Every schedule shares one cooldown
 * window — when a tick is currently within `cooldownMs` of the previous one,
 * it is skipped and an `INFO` event is emitted.
 *
 * Interval-mode schedules fire an extra immediate tick on startup; cron-mode
 * schedules wait for the first match.
 */
export function runPollLoop(deps: PollerDeps, schedules: readonly Schedule[], opts: PollLoopOptions): PollLoopHandle {
  const emit = deps.emit ?? defaultEvent;
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? deps.config.pollCooldownMs;

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

  let lastTickStartedAt: number | null = null;
  let cancelled = false;
  const timers: NodeJS.Timeout[] = [];

  const gatedTick = async (): Promise<void> => {
    if (cancelled) return;
    if (cooldownMs > 0 && lastTickStartedAt !== null) {
      const elapsed = now() - lastTickStartedAt;
      if (elapsed < cooldownMs) {
        const elapsedSeconds = Math.round(elapsed / 1000);
        emit("daemon", "INFO", null, `skipped poll: within cooldown (${elapsedSeconds}s since last)`);
        return;
      }
    }
    // Stamp before awaiting so concurrent callers see the latest start time.
    lastTickStartedAt = now();
    await tick();
  };

  const scheduleCron = (expression: string): void => {
    if (cancelled) return;
    let nextAt: number;
    try {
      nextAt = cronParser
        .parseExpression(expression, { currentDate: new Date(now()) })
        .next()
        .getTime();
    } catch (err) {
      emit("daemon", "ERROR", null, `cron schedule ${JSON.stringify(expression)} failed: ${(err as Error).message}`);
      return;
    }
    const delay = Math.max(0, nextAt - now());
    const timer = setTimeout(() => {
      void (async () => {
        await gatedTick();
        scheduleCron(expression);
      })();
    }, delay);
    timers.push(timer);
  };

  const hasInterval = schedules.some((s) => s.kind === "interval");

  for (const schedule of schedules) {
    if (schedule.kind === "interval") {
      timers.push(
        setInterval(() => {
          void gatedTick();
        }, schedule.intervalMs),
      );
    } else {
      scheduleCron(schedule.expression);
    }
  }

  // Preserve the legacy "first tick fires immediately" behaviour for any
  // interval-bearing schedule list. Cron-only configurations wait for the
  // first match instead.
  if (hasInterval) {
    void gatedTick();
  }

  return {
    stop() {
      if (cancelled) return;
      cancelled = true;
      timers.forEach((t) => {
        clearTimeout(t);
        clearInterval(t);
      });
    },
  };
}
