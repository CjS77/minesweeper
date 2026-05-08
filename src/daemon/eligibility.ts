/**
 * Plan-07 placeholder eligibility filter.
 *
 * Returns `true` only when the issue carries `config.alwaysFixLabel`. Plan 10
 * layers in the full label-only filter (default eligibility, never-fix opt-out,
 * possibly-dangerous gating) and plan 11 adds the prompt-injection screen.
 *
 * Kept intentionally narrow so the supervisor has something deterministic to
 * exercise in unit tests and the dogfooding cut-over is a single import swap.
 */

import type { Config } from "../config.js";
import type { Issue } from "../github/index.js";

export function isEligible(issue: Issue, config: Config): boolean {
  return issue.labels.some((label) => label.name === config.alwaysFixLabel);
}
