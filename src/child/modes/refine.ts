/**
 * Refine mode: turn the approved plan into N independent sub-issues
 * filed against the parent's repository, then comment on the parent
 * with a checklist linking to each child.
 *
 * The mode runs in this child process — there is no inner subagent
 * loop to checkpoint between, just one `refiner` call followed by
 * `gh issue create` / `gh issue comment` plumbing. On success the
 * state transitions to `mode = "Delegated"`, `status = "Complete"`
 * and the supervisor archives + removes the worktree per the standard
 * lifecycle.
 *
 * Inputs (read at runtime):
 *
 *   - `.minesweeper/final_plan.md` — the plan that was assessed as
 *     `Refine` in the prior mode.
 *   - The parent GitHub issue (used for the prompt context, the
 *     parent-link in each sub-issue body, and the
 *     `alwaysFixLabel` / `tryFixLabel` propagation rules).
 *
 * Output side-effects (in order):
 *
 *   1. One `gh issue create` per parsed sub-task. Labels: the
 *      configured subtask label, plus the `alwaysFixLabel` iff the
 *      parent carries it, plus the `tryFixLabel` iff the parent carries
 *      *that* one (each child is still re-screened on its own merits).
 *   2. One `gh issue comment` on the parent containing a checklist
 *      that links each new sub-issue.
 *   3. State transitions to `Delegated/Complete`.
 *
 * Idempotency / resume: if the process crashes mid-way through
 * step 1, a re-run will create duplicate sub-issues. v0 accepts that —
 * the human operator can close duplicates. There is no plan-side
 * dedup key on the new issues yet.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../config.js";
import * as defaultGithub from "../../github/index.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import type { RunSubagentOptions, SubagentResult } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { State } from "../state.js";
import {
  asCodeScanningWorkItem,
  asIssueWorkItem,
  asSecretScanningWorkItem,
  formatWorkItem,
  workItemNumber,
  type WorkItem,
} from "../../workitem.js";

/** Path (worktree-relative) the planning mode wrote the approved plan to. */
export const FINAL_PLAN_FILE = join(".minesweeper", "final_plan.md");

/** Subagent runner shape — kept narrow so tests can inject a fake easily. */
export type RunSubagentFn = (opts: RunSubagentOptions) => Promise<SubagentResult>;

export interface SubTask {
  /** Title from the `## Task <N>: <title>` heading. */
  title: string;
  /** Body of the `### Description` subsection (trimmed). */
  description: string;
  /** Body of the `### Recommended plan` subsection (trimmed). */
  recommendedPlan: string;
}

/** Minimal shape of a created sub-issue, returned by `gh.createIssue`. */
export interface CreatedSubIssue {
  number: number;
  url: string;
  title: string;
}

export interface RefineDeps {
  /** Loaded config — model lookup, label names. */
  config: Config;
  /** Worktree root (== this child's cwd in production). */
  cwd: string;
  /** State as just read from disk by the handler. */
  state: State;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<
    typeof defaultGithub,
    "getIssue" | "getCodeScanningAlert" | "getSecretScanningAlert" | "createIssue" | "comment"
  >;
  /** Override the subagent runner (tests). */
  runSubagent?: RunSubagentFn;
  /** Override the state writer (tests can wrap to assert call sequence). */
  writeState?: typeof defaultState.writeState;
  /** Override the logger event sink (tests, or to suppress logging). */
  emit?: Logger["event"];
}

/**
 * Run the refine state machine to completion. Returns the terminal
 * state (`mode = "Delegated"`, `status = "Complete"`).
 *
 * Throws on unrecoverable errors (subagent throws, parser produces no
 * sub-tasks, GitHub failures). Partial sub-issue creation followed by
 * a failure is left as-is — see the file header.
 */
export async function runRefine(deps: RefineDeps): Promise<State> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const gh = deps.github ?? defaultGithub;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const writeState = deps.writeState ?? defaultState.writeState;

  const state = deps.state;
  const issueNumber = state.issueNumber;

  emit("refiner", "WORK", issueNumber, "refining plan into sub-issues");

  const finalPlan = await readFinalPlan(join(cwd, FINAL_PLAN_FILE));
  const item = await fetchWorkItem(gh, state, cwd);

  const result = await runSubagent({
    role: "refiner",
    config,
    userPrompt: refinerPromptFor(item, finalPlan),
    issueNumber,
    iteration: 1,
    cwd,
  });

  const subTasks = parseSubTasks(result.finalText);
  if (subTasks.length === 0) {
    throw new Error(
      "refine: refiner produced no parseable sub-tasks (expected one or more `## Task <N>: ...` sections)",
    );
  }

  emit("refiner", "DEBUG", issueNumber, `parsed ${subTasks.length} sub-task(s) from refiner output`);

  const inheritedLabels = inheritedLabelsFor(item, config);
  const created: CreatedSubIssue[] = [];
  for (const task of subTasks) {
    const body = subIssueBody(item, task);
    const subIssue = await gh.createIssue({
      title: task.title,
      body,
      labels: inheritedLabels,
      cwd,
    });
    emit("refiner", "OK", issueNumber, `created sub-issue #${subIssue.number}: ${task.title}`);
    created.push({ ...subIssue, title: task.title });
  }

  // `gh issue comment` only works on issues. Alert parents are linked back via each
  // sub-issue body line instead, so skip the parent-checklist comment for them.
  if (item.kind === "issue") {
    await gh.comment(issueNumber, parentChecklistComment(created), { cwd });
    emit("refiner", "OK", issueNumber, `commented parent issue with ${created.length}-item checklist`);
  } else {
    emit(
      "refiner",
      "DEBUG",
      issueNumber,
      `parent is a ${parentKindLabel(item)}; skipped parent-checklist comment (sub-issues link back via body)`,
    );
  }

  return writeState(cwd, {
    ...state,
    mode: "Delegated",
    status: "Complete",
  });
}

async function readFinalPlan(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`refine: ${path} not found — planning mode must run first`);
    }
    throw err;
  }
}

/** Labels to apply to each new sub-issue. */
function inheritedLabelsFor(parent: WorkItem, config: Config): string[] {
  const labels = new Set<string>();
  labels.add(config.subtaskLabel);
  if (parent.kind !== "issue") {
    // Alerts carry no GitHub-issue labels, so there is nothing extra to inherit.
    return [...labels];
  }
  const parentLabelNames = new Set(parent.labels.map((l) => l.name));
  if (parentLabelNames.has(config.alwaysFixLabel)) {
    labels.add(config.alwaysFixLabel);
  }
  if (parentLabelNames.has(config.tryFixLabel)) {
    labels.add(config.tryFixLabel);
  }
  return [...labels];
}

function subIssueBody(parent: WorkItem, task: SubTask): string {
  return [
    `Refined from parent ${parentKindLabel(parent)} #${workItemNumber(parent)}.`,
    "",
    "## Description",
    "",
    task.description.length > 0 ? task.description : "(no description provided)",
    "",
    "## Recommended plan",
    "",
    task.recommendedPlan.length > 0 ? task.recommendedPlan : "(no recommended plan provided)",
    "",
  ].join("\n");
}

function parentKindLabel(item: WorkItem): string {
  switch (item.kind) {
    case "issue":
      return "issue";
    case "codeScanningAlert":
      return "code-scanning alert";
    case "secretScanningAlert":
      return "secret-scanning alert";
  }
}

function parentChecklistComment(created: readonly CreatedSubIssue[]): string {
  const items = created.map((c) => `- [ ] #${c.number} — ${c.title}`).join("\n");
  return `Refined into the following sub-tasks:\n\n${items}\n`;
}

/**
 * Match each `## Task <N>: <title>` heading. The captured group is the
 * title (rest of the heading line, trimmed by the consumer).
 */
const TASK_HEADING_RE = /^[ \t]*##[ \t]+task[ \t]+\d+[ \t]*:[ \t]*(.+?)[ \t]*$/gim;

/**
 * Parse the refiner's structured Markdown output into a list of
 * sub-tasks. Tolerates extra preamble before the first `## Task 1:`
 * heading; rejects nothing — sub-tasks missing one of the required
 * subsections come through with empty strings and the orchestrator
 * surfaces them as "(no … provided)" in the new issue body.
 */
export function parseSubTasks(text: string): SubTask[] {
  const headings = [...text.matchAll(TASK_HEADING_RE)];
  if (headings.length === 0) return [];

  return headings.map((heading, index) => {
    const title = (heading[1] ?? "").trim();
    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = index + 1 < headings.length ? (headings[index + 1]!.index ?? text.length) : text.length;
    const body = text.slice(sectionStart, sectionEnd);
    return {
      title,
      description: extractSubsection(body, "description"),
      recommendedPlan: extractSubsection(body, "recommended plan"),
    };
  });
}

/**
 * Extract a `### <name>` subsection's body. Returns the trimmed text
 * between that heading and the next `### ` heading (or end of string).
 * Returns "" if the heading is not present.
 */
function extractSubsection(body: string, name: string): string {
  const escaped = name.replace(/[ \t]+/g, "[ \\t]+");
  const startRe = new RegExp(`^[ \\t]*###[ \\t]+${escaped}\\b[ \\t]*$`, "im");
  const startMatch = startRe.exec(body);
  if (!startMatch) return "";
  const afterHeading = body.slice(startMatch.index + startMatch[0].length);
  const nextHeadingRe = /^[ \t]*###[ \t]+/m;
  const nextMatch = nextHeadingRe.exec(afterHeading);
  const section = nextMatch ? afterHeading.slice(0, nextMatch.index) : afterHeading;
  return section.trim();
}

function refinerPromptFor(item: WorkItem, plan: string): string {
  return [
    formatWorkItem(item),
    "",
    "# Approved plan",
    "",
    plan.trimEnd(),
    "",
    "Refine this plan into independent sub-tasks following the structure described in your system prompt.",
  ].join("\n");
}

/**
 * Resolve the on-disk `state.kind` to a fresh GitHub fetch of the
 * underlying work item. Mirrors the helper in `planning.ts` and
 * `assess.ts` so refine sees the same canonical block as the planner.
 */
async function fetchWorkItem(gh: NonNullable<RefineDeps["github"]>, state: State, cwd: string): Promise<WorkItem> {
  switch (state.kind) {
    case "issue": {
      const issue = await gh.getIssue(state.issueNumber, { cwd });
      return asIssueWorkItem(issue);
    }
    case "codeScanningAlert": {
      const alert = await gh.getCodeScanningAlert(state.issueNumber, { cwd });
      return asCodeScanningWorkItem(alert);
    }
    case "secretScanningAlert": {
      const alert = await gh.getSecretScanningAlert(state.issueNumber, { cwd });
      return asSecretScanningWorkItem(alert);
    }
  }
}
