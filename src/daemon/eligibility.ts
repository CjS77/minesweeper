/**
 * Eligibility filter — label hierarchy + prompt-injection screen.
 *
 * Two functions live here:
 *
 *   - `isEligible(issue, config)`  — synchronous, label-only, pure.
 *     Encodes the label hierarchy from the spec. Used as the cheap
 *     pre-check; safe to call anywhere.
 *   - `decideEligibility(issue, deps)` — asynchronous; runs the same
 *     label hierarchy and, when the catch-all branch is reached *and*
 *     `defaultEligible=true`, calls the screener (`src/daemon/screen.ts`)
 *     and applies side effects on `dangerous` / `uncertain`. The poller
 *     calls this one.
 *
 * The label hierarchy. Earlier rules take precedence over later ones:
 *
 *   1. `neverFixLabel`         → ineligible (hard opt-out wins over everything).
 *   2. `manuallyApprovedLabel` → eligible (a human signed off — skip screen).
 *   3. `failedLabel`           → ineligible (don't reattempt past failures).
 *   4. `possiblyDangerousLabel`→ ineligible (already screened, awaits human).
 *   5. `alwaysFixLabel`        → eligible (human opt-in — skip screen).
 *   6. `tryFixLabel`           → run the screener; route on the verdict
 *                                (per-issue opt-in *with* a safety gate, even
 *                                when `defaultEligible=false`).
 *   7. otherwise               → screen if `defaultEligible`; else ineligible.
 *
 * Closed issues are always ineligible (checked first).
 *
 * Side effects on screener verdict (steps 6 and 7):
 *
 *   - `safe`      → eligible.
 *   - `dangerous` → addLabel(possiblyDangerousLabel) + comment + ineligible.
 *   - `uncertain` → addLabel(possiblyDangerousLabel) + ineligible.
 *
 * Once labelled `possiblyDangerous`, the issue short-circuits at step 4
 * on subsequent polls — the screener will not be re-invoked, and no
 * second comment will be posted.
 *
 * TODO(plan 10 follow-up): also skip issues with an open PR that references
 * `Fixes #N`. The cheapest signal is `gh issue view N
 * --json closedByPullRequestsReferences` but that lives in the supervisor /
 * poller, not here.
 */

import type { Config } from "../config.js";
import * as defaultGithub from "../github/index.js";
import type { Issue } from "../github/index.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { screenIssue as defaultScreenIssue, type ScreenResult } from "./screen.js";

export function isEligible(issue: Issue, config: Config): boolean {
  if (issue.state === "CLOSED") return false;

  const labels = new Set(issue.labels.map((l) => l.name));
  const has = (name: string): boolean => labels.has(name);

  if (has(config.neverFixLabel)) return false;
  if (has(config.manuallyApprovedLabel)) return true;
  if (has(config.failedLabel)) return false;
  if (has(config.possiblyDangerousLabel)) return false;
  if (has(config.alwaysFixLabel)) return true;
  // `tryFix` and the `defaultEligible` catch-all are both *potentially*
  // eligible — `decideEligibility` resolves them via the screener.
  if (has(config.tryFixLabel)) return true;
  return config.defaultEligible;
}

/** Return type for {@link decideEligibility}. The reason is for log lines. */
export interface EligibilityDecision {
  eligible: boolean;
  /** Short, human-readable reason — for the daemon log. */
  reason: string;
  /** Set when the screener was actually invoked. */
  screen?: ScreenResult;
}

/** Screen function injected into {@link decideEligibility} (tests). */
export type ScreenIssueFn = typeof defaultScreenIssue;

export interface DecideEligibilityDeps {
  /** Loaded config — label names, screener model, defaultEligible flag. */
  config: Config;
  /** Daemon cwd — propagated to gh side effects and the screener cache. */
  cwd: string;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<typeof defaultGithub, "addLabel" | "comment">;
  /** Override the screener (tests). */
  screenIssue?: ScreenIssueFn;
  /** Override the logger event sink. */
  emit?: Logger["event"];
}

/**
 * Decide whether an issue should be processed. Runs the label hierarchy
 * via {@link isEligible} for the cheap branches, then defers to the
 * screener for the catch-all `defaultEligible=true` case. On
 * `dangerous` / `uncertain` verdicts the issue is labelled
 * `possiblyDangerous`; on `dangerous` we also leave a polite comment
 * pointing at the override label.
 */
export async function decideEligibility(issue: Issue, deps: DecideEligibilityDeps): Promise<EligibilityDecision> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const gh = deps.github ?? defaultGithub;
  const screen = deps.screenIssue ?? defaultScreenIssue;

  if (issue.state === "CLOSED") {
    return { eligible: false, reason: "issue is closed" };
  }

  const labels = new Set(issue.labels.map((l) => l.name));
  if (labels.has(config.neverFixLabel)) {
    return { eligible: false, reason: `has ${config.neverFixLabel}` };
  }
  if (labels.has(config.manuallyApprovedLabel)) {
    return { eligible: true, reason: `has ${config.manuallyApprovedLabel}` };
  }
  if (labels.has(config.failedLabel)) {
    return { eligible: false, reason: `has ${config.failedLabel}` };
  }
  if (labels.has(config.possiblyDangerousLabel)) {
    return { eligible: false, reason: `has ${config.possiblyDangerousLabel}` };
  }
  if (labels.has(config.alwaysFixLabel)) {
    return { eligible: true, reason: `has ${config.alwaysFixLabel}` };
  }

  const viaTryFix = labels.has(config.tryFixLabel);
  if (!viaTryFix && !config.defaultEligible) {
    return { eligible: false, reason: "no opt-in label and defaultEligible=false" };
  }

  // Either the issue carries `tryFix` (per-issue opt-in with screen) or
  // `defaultEligible=true` is letting it through. Both routes use the same
  // screener and the same side effects on the verdict; they only differ in
  // how they got here, which is reflected in the `reason` string.
  const route = viaTryFix ? `screener (${config.tryFixLabel})` : "screener";
  const screened = await screen(issue, { config, cwd, emit });

  if (screened.verdict === "safe") {
    return { eligible: true, reason: `${route}: safe`, screen: screened };
  }

  if (screened.verdict === "dangerous") {
    await applyDangerousLabel(gh, issue.number, config, cwd, emit);
    await postScreenerComment(gh, issue.number, screened.verdict, config, cwd, emit);
    return { eligible: false, reason: `${route}: dangerous`, screen: screened };
  }

  // uncertain
  await applyDangerousLabel(gh, issue.number, config, cwd, emit);
  return { eligible: false, reason: `${route}: uncertain`, screen: screened };
}

async function applyDangerousLabel(
  gh: Pick<typeof defaultGithub, "addLabel">,
  issueNumber: number,
  config: Config,
  cwd: string,
  emit: Logger["event"],
): Promise<void> {
  try {
    await gh.addLabel(issueNumber, config.possiblyDangerousLabel, { cwd });
  } catch (err) {
    emit(
      "screener",
      "WARN",
      issueNumber,
      `failed to apply ${config.possiblyDangerousLabel} label: ${(err as Error).message}`,
    );
  }
}

async function postScreenerComment(
  gh: Pick<typeof defaultGithub, "comment">,
  issueNumber: number,
  verdict: "dangerous",
  config: Config,
  cwd: string,
  emit: Logger["event"],
): Promise<void> {
  try {
    await gh.comment(issueNumber, screenerCommentBody(verdict, config), { cwd });
  } catch (err) {
    emit("screener", "WARN", issueNumber, `failed to post screener comment: ${(err as Error).message}`);
  }
}

/**
 * Build the comment body left on `dangerous` issues. Deliberately does
 * not echo the screener's reason — quoting injection text back into a
 * comment would launder it for any other tool that scrapes the issue.
 */
function screenerCommentBody(verdict: "dangerous", config: Config): string {
  return [
    "Hi — I am Minesweeper, an automated bot. Before processing an issue I",
    "screen it for prompt-injection and out-of-scope requests.",
    "",
    `This issue was flagged as **${verdict}**, so I have applied the`,
    `\`${config.possiblyDangerousLabel}\` label and will not act on it.`,
    "",
    "If you are a maintainer and you have decided this is a legitimate",
    `request, replace the \`${config.possiblyDangerousLabel}\` label with`,
    `\`${config.manuallyApprovedLabel}\` to override the screener.`,
  ].join("\n");
}
