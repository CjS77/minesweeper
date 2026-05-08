/**
 * Label-only eligibility filter (plan 10).
 *
 * Encodes the spec's label hierarchy. Earlier rules take precedence over later
 * ones, so callers can reason about a single issue + config without consulting
 * external state. The hierarchy:
 *
 *   1. `neverFixLabel`         → ineligible (hard opt-out wins over everything).
 *   2. `manuallyApprovedLabel` → eligible (a human signed off).
 *   3. `failedLabel`           → ineligible (don't reattempt past failures).
 *   4. `possiblyDangerousLabel`→ ineligible (awaits human review).
 *   5. `alwaysFixLabel`        → eligible (the standard opt-in).
 *   6. otherwise               → `config.defaultEligible`.
 *
 * Closed issues are always ineligible. Plan 11 adds a Haiku-backed
 * prompt-injection screen on top of this filter.
 *
 * TODO(plan 10 follow-up): also skip issues with an open PR that references
 * `Fixes #N`. The cheapest signal is `gh issue view N
 * --json closedByPullRequestsReferences` but that lives in the supervisor /
 * poller, not here.
 */

import type { Config } from "../config.js";
import type { Issue } from "../github/index.js";

export function isEligible(issue: Issue, config: Config): boolean {
  if (issue.state === "CLOSED") return false;

  const labels = new Set(issue.labels.map((l) => l.name));
  const has = (name: string): boolean => labels.has(name);

  if (has(config.neverFixLabel)) return false;
  if (has(config.manuallyApprovedLabel)) return true;
  if (has(config.failedLabel)) return false;
  if (has(config.possiblyDangerousLabel)) return false;
  if (has(config.alwaysFixLabel)) return true;
  return config.defaultEligible;
}
