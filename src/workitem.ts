/**
 * `WorkItem` is the unified shape the daemon dispatches against. Originally
 * the daemon only handled GitHub *issues*, so much of the codebase still
 * speaks `Issue`. This module introduces a discriminated union so
 * code-scanning and secret-scanning alerts can ride the same pipeline.
 *
 * The discriminant `kind` matches the same string used in the `branchName`
 * prefix (`{slug}-issue{NNNN}`, `{slug}-codeScanningAlert{NNNN}`, …) and as
 * the CLI namespace (`minesweeper handle codeScanningAlert/42`). Keeping
 * one canonical spelling everywhere means callers do not have to translate
 * between three different name styles.
 *
 * The `Issue` variant inlines its `Issue` fields — existing code that
 * narrows to `kind: "issue"` then reads `item.number` keeps working without
 * an extra `.issue.` hop. Alert variants wrap their alert payload because
 * the alert shapes are richer and would muddy the flat namespace.
 */

import type { CodeScanningAlert, Issue, SecretScanningAlert } from "./github/index.js";
import type { WorkItemKind } from "./child/state.js";

export type { WorkItemKind } from "./child/state.js";

/** Issue variant — `Issue` fields are inlined alongside the discriminant. */
export type IssueWorkItem = Issue & { kind: "issue" };

/** Code-scanning alert variant — wraps the parsed alert payload. */
export interface CodeScanningWorkItem {
  kind: "codeScanningAlert";
  alert: CodeScanningAlert;
}

/** Secret-scanning alert variant — wraps the parsed alert payload. */
export interface SecretScanningWorkItem {
  kind: "secretScanningAlert";
  alert: SecretScanningAlert;
}

export type WorkItem = IssueWorkItem | CodeScanningWorkItem | SecretScanningWorkItem;

/**
 * Wrap an `Issue` into the `WorkItem` union. Used by the poller and tests
 * that previously constructed `Issue` objects directly.
 */
export function asIssueWorkItem(issue: Issue): IssueWorkItem {
  return { ...issue, kind: "issue" };
}

export function asCodeScanningWorkItem(alert: CodeScanningAlert): CodeScanningWorkItem {
  return { kind: "codeScanningAlert", alert };
}

export function asSecretScanningWorkItem(alert: SecretScanningAlert): SecretScanningWorkItem {
  return { kind: "secretScanningAlert", alert };
}

/** Per-kind work-item number. Each kind has its own per-repo number space. */
export function workItemNumber(item: WorkItem): number {
  switch (item.kind) {
    case "issue":
      return item.number;
    case "codeScanningAlert":
    case "secretScanningAlert":
      return item.alert.number;
  }
}

/** Per-kind URL pointing at the work item on github.com. */
export function workItemUrl(item: WorkItem): string {
  switch (item.kind) {
    case "issue":
      return item.url;
    case "codeScanningAlert":
    case "secretScanningAlert":
      return item.alert.html_url;
  }
}

/** Whether this work item is still actionable. Issues use OPEN; alerts use `state === "open"`. */
export function workItemIsOpen(item: WorkItem): boolean {
  switch (item.kind) {
    case "issue":
      return item.state === "OPEN";
    case "codeScanningAlert":
    case "secretScanningAlert":
      return item.alert.state === "open";
  }
}

/** Title used in logs, branch names, and prompts. */
export function workItemTitle(item: WorkItem): string {
  switch (item.kind) {
    case "issue":
      return item.title;
    case "codeScanningAlert":
      return `${item.alert.rule.name ?? item.alert.rule.id ?? "code-scanning alert"} (${item.alert.rule.severity ?? "?"})`;
    case "secretScanningAlert":
      return item.alert.secret_type_display_name ?? item.alert.secret_type ?? "secret-scanning alert";
  }
}

/**
 * Format a work item as the markdown block the planner / critic / executor
 * subagents see. Supersedes the old `formatIssue` helper. Issues keep the
 * pre-existing layout; alerts get a kind-specific layout that surfaces the
 * fields a fixer-agent actually needs (rule id, file location, severity).
 */
export function formatWorkItem(item: WorkItem): string {
  switch (item.kind) {
    case "issue":
      return formatIssue(item);
    case "codeScanningAlert":
      return formatCodeScanningAlert(item.alert);
    case "secretScanningAlert":
      return formatSecretScanningAlert(item.alert);
  }
}

function formatIssue(issue: IssueWorkItem): string {
  const labels = issue.labels.map((l) => l.name).join(", ") || "(none)";
  const lines = [
    `# GitHub issue #${issue.number}`,
    `Title: ${issue.title}`,
    `Author: ${issue.author.login}`,
    `Labels: ${labels}`,
    `URL: ${issue.url}`,
    "",
    "## Body",
    "",
    issue.body.length > 0 ? issue.body : "(empty body)",
  ];
  if (issue.comments && issue.comments.length > 0) {
    lines.push("", "## Comments");
    for (const c of issue.comments) {
      lines.push("", `### ${c.author.login} — ${c.createdAt}`, "", c.body);
    }
  }
  return lines.join("\n");
}

function formatCodeScanningAlert(alert: CodeScanningAlert): string {
  const ruleId = alert.rule.id ?? alert.rule.name ?? "(unknown rule)";
  const severity = alert.rule.security_severity_level ?? alert.rule.severity ?? "(unknown severity)";
  const location = alert.most_recent_instance?.location;
  const locationLine = location?.path
    ? `${location.path}${location.start_line ? `:${location.start_line}` : ""}`
    : "(unknown location)";
  const lines = [
    `# Code-scanning alert #${alert.number}`,
    `Rule: ${ruleId}`,
    `Severity: ${severity}`,
    `Location: ${locationLine}`,
    `URL: ${alert.html_url}`,
    "",
    "## Description",
    "",
    alert.rule.full_description ?? alert.rule.description ?? "(no description provided)",
  ];
  const message = alert.most_recent_instance?.message?.text;
  if (message) {
    lines.push("", "## Latest tool message", "", message);
  }
  return lines.join("\n");
}

function formatSecretScanningAlert(alert: SecretScanningAlert): string {
  const kindName = alert.secret_type_display_name ?? alert.secret_type ?? "(unknown secret kind)";
  const lines = [
    `# Secret-scanning alert #${alert.number}`,
    `Secret type: ${kindName}`,
    `URL: ${alert.html_url}`,
    "",
    "## Guidance",
    "",
    "Treat the leaked secret as compromised: revoke and rotate the credential at the",
    "issuing service before patching the codebase. The fix is to remove the secret",
    "from source control and replace any lookup with an environment variable or",
    "secret-manager reference. Do **not** include the secret value in any commit",
    "message, comment, or PR description.",
  ];
  return lines.join("\n");
}

/**
 * Map a `WorkItemKind` to its branch-name segment. Identity for now, but
 * routed through one helper so any future renaming can change the on-disk
 * spelling in a single place.
 */
export function branchSegmentForKind(kind: WorkItemKind): string {
  return kind;
}
