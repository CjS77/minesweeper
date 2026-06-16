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
import type { Config } from "../config.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { decideEligibility as defaultDecideEligibility, type EligibilityDecision } from "./eligibility.js";
import type { ScreenIssueFn } from "./eligibility.js";
import {
  asCodeScanningWorkItem,
  asIssueWorkItem,
  asSecretScanningWorkItem,
  workItemKey,
  workItemNumber,
  type WorkItem,
} from "../workitem.js";
import cronParser from "cron-parser";

/**
 * Predicate the poller uses to filter work items. Async because the
 * default implementation may call out to the screener subagent. Tests
 * can inject a sync function — both `boolean` and `Promise<boolean>`
 * are accepted.
 */
export type EligibilityFn = (item: WorkItem, config: Config) => boolean | Promise<boolean>;

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
  /**
   * Override the `gh` carve-out used by the poller. Issues are always
   * fetched; alert endpoints are fetched only when `config.alertsEligible`
   * is true (so disabled-GHAS repos do not log a 403 every tick).
   */
  github?: Pick<
    typeof defaultGithub,
    "listIssues" | "listCodeScanningAlerts" | "listSecretScanningAlerts" | "addLabel" | "comment"
  >;
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
 * Result of one {@link pollOnce}.
 *
 * `eligible` is the dispatch candidate list (post eligibility filter).
 * `openKeys` is the {@link workItemKey} of *every* open work item seen this
 * tick, **before** the eligibility filter — the supervisor diffs it against
 * its in-flight set to detect work items that were closed externally while a
 * child was running. It is built from lists `pollOnce` already fetched, so
 * exposing it costs no extra `gh` calls.
 */
export interface PollResult {
  /** Work items that passed the eligibility filter — dispatch candidates. */
  eligible: WorkItem[];
  /** `${kind}:${number}` for every open work item this tick, pre-eligibility. */
  openKeys: ReadonlySet<string>;
}

/**
 * Run a single poll: list open issues + (optionally) open code-scanning
 * and secret-scanning alerts, then return the eligible ones plus the key
 * set of every open work item as a {@link PollResult}.
 *
 * The default predicate is {@link defaultDecideEligibility}, which may
 * apply the `possiblyDangerous` label or post a comment when the
 * screener flags an issue. Those side effects happen *during* the
 * `pollOnce` call — they are intentional, not an accident of polling.
 *
 * Each network source is wrapped in {@link safeList} so a 403/404 from
 * one endpoint (e.g. `code-scanning/alerts` on a repo without GHAS)
 * does not drop work items from the others — the offending source
 * yields `[]` and emits a `WARN` log instead.
 */
export async function pollOnce(deps: PollerDeps): Promise<PollResult> {
  const gh = deps.github ?? defaultGithub;
  const emit = deps.emit ?? defaultEvent;
  const filter: EligibilityFn =
    deps.isEligible ??
    (async (item: WorkItem): Promise<boolean> => {
      const decision: EligibilityDecision = await defaultDecideEligibility(item, {
        config: deps.config,
        cwd: deps.cwd,
        github: gh,
        screenIssue: deps.screenIssue,
        emit,
      });
      emit(
        "daemon",
        "INFO",
        workItemNumber(item),
        `eligibility: ${decision.eligible ? "yes" : "no"} (${decision.reason})`,
        { kind: item.kind },
      );
      return decision.eligible;
    });

  const issuesP = safeList("issues", () => gh.listIssues({ cwd: deps.cwd, state: "open" }), emit);
  const csaP = deps.config.alertsEligible
    ? safeList("code-scanning alerts", () => gh.listCodeScanningAlerts({ cwd: deps.cwd, state: "open" }), emit)
    : Promise.resolve([]);
  const ssaP = deps.config.alertsEligible
    ? safeList("secret-scanning alerts", () => gh.listSecretScanningAlerts({ cwd: deps.cwd, state: "open" }), emit)
    : Promise.resolve([]);

  const [issues, csa, ssa] = await Promise.all([issuesP, csaP, ssaP]);
  const items: WorkItem[] = [
    ...issues.map(asIssueWorkItem),
    ...csa.map(asCodeScanningWorkItem),
    ...ssa.map(asSecretScanningWorkItem),
  ];
  const openKeys = new Set(items.map((item) => workItemKey(item.kind, workItemNumber(item))));
  const verdicts = await Promise.all(items.map((item) => Promise.resolve(filter(item, deps.config))));
  return { eligible: items.filter((_, i) => verdicts[i]), openKeys };
}

/**
 * Run a `gh` list call and convert any failure to an empty result + a
 * single WARN log line. The poller composes the three sources via this
 * helper so an outage in one endpoint does not stall the daemon.
 */
async function safeList<T>(label: string, fn: () => Promise<T[]>, emit: Logger["event"]): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    const message = stripGhScopeHint((err as Error).message);
    emit("daemon", "WARN", null, `poll: ${label} fetch failed (${message}); continuing without`);
    return [];
  }
}

/**
 * `gh` tacks a misleading advisory onto some 404s, e.g. `gh: This API
 * operation needs the "admin:repo_hook" scope. To request it, run: gh auth
 * refresh -h github.com -s admin:repo_hook`. That scope is unrelated to the
 * alert endpoints — the real cause is "no analysis found" / the feature being
 * disabled on the repo — so we drop the advisory line to avoid sending
 * operators down a dead end. The substantive error line is kept.
 */
export function stripGhScopeHint(message: string): string {
  return message
    .split("\n")
    .filter((line) => !/needs the ".*?" scope|gh auth refresh/i.test(line))
    .join("\n")
    .trimEnd();
}

export interface PollLoopOptions {
  /**
   * Called once per eligible {@link WorkItem} per poll tick. The
   * supervisor's `dispatch` is the canonical implementation.
   */
  onWorkItem: (item: WorkItem) => void | Promise<void>;
  /**
   * Called once at the end of every tick, after all `onWorkItem`
   * callbacks have settled. Receives the {@link workItemKey} of every
   * open work item seen this tick — the supervisor diffs it against its
   * in-flight set to terminate children whose work item closed
   * externally, then sweeps closed-issue worktrees.
   */
  onTickEnd?: (openKeys: ReadonlySet<string>) => void | Promise<void>;
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
      const { eligible, openKeys } = await pollOnce(deps);
      emit("daemon", "INFO", null, `polled (${eligible.length} eligible)`);
      for (const item of eligible) {
        await opts.onWorkItem(item);
      }
      if (opts.onTickEnd) {
        await opts.onTickEnd(openKeys);
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
