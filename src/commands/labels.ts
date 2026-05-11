/**
 * `minesweeper labels` — create or update the repository labels Minesweeper
 * uses to gate issue eligibility and tag bot-authored work.
 *
 * The set of labels is derived from `Config` so it stays in sync with whatever
 * names the operator has configured via `MINESWEEPER_*_LABEL` env vars. Each
 * label is upserted via `gh label create --force`, so the command is safe to
 * run repeatedly.
 *
 * Modes:
 * - `list: true` queries `gh label list` and prints the labels currently
 *   registered on the repository (in their actual colours) — no mutation.
 * - default: shows the proposed labels, lists only the existing labels that
 *   clash with the planned writes, and prompts the operator to (A)bort,
 *   (O)verwrite, or only create the new ones. Pass `force: true` (CLI: `-f`)
 *   to skip the prompt and overwrite everything.
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";

import { type Config } from "../config.js";
import { listLabels, upsertLabel, type Label } from "../github/index.js";
import { event } from "../logging.js";

/** Specification for a single Minesweeper label. */
export interface LabelSpec {
  /** Stable handle used in logs and tests; not the GitHub label name. */
  key: "alwaysFix" | "tryFix" | "neverFix" | "possiblyDangerous" | "manuallyApproved" | "failed" | "subtask";
  /** The actual label name shown on GitHub, sourced from config. */
  name: string;
  /** GitHub label colour — 6-char hex, no leading `#`. */
  color: string;
  /** Human-readable description shown in the GitHub UI. */
  description: string;
}

/**
 * Build the canonical Minesweeper label set from the current config. Colours
 * are picked from GitHub's standard palette to telegraph intent at a glance:
 * green for "go", red for "stop", orange for caution, blue/purple/grey for
 * informational tags.
 */
export function buildLabelSpecs(config: Config): LabelSpec[] {
  return [
    {
      key: "alwaysFix",
      name: config.alwaysFixLabel,
      color: "0e8a16",
      description: "Minesweeper will always pick up issues with this label.",
    },
    {
      key: "tryFix",
      name: config.tryFixLabel,
      color: "fbca04",
      description: "Minesweeper will pick up this issue, but only after the prompt-injection screener clears it.",
    },
    {
      key: "neverFix",
      name: config.neverFixLabel,
      color: "b60205",
      description: "Minesweeper will never touch issues with this label — humans only.",
    },
    {
      key: "possiblyDangerous",
      name: config.possiblyDangerousLabel,
      color: "d93f0b",
      description: "Possibly malicious or prompt-injected — needs manual review before Minesweeper acts.",
    },
    {
      key: "manuallyApproved",
      name: config.manuallyApprovedLabel,
      color: "8d5f15",
      description: "Issue has been manually reviewed and cleared for Minesweeper to handle.",
    },
    {
      key: "failed",
      name: config.failedLabel,
      color: "8a2c92",
      description: "Minesweeper attempted to handle this issue but bailed out — needs human triage.",
    },
    {
      key: "subtask",
      name: config.subtaskLabel,
      color: "2e9d00",
      description: "Issue was created by Minesweeper as a sub-task of a larger plan.",
    },
  ];
}

/** Outcome of the three-way confirmation prompt. */
export type LabelsPromptChoice = "abort" | "overwrite" | "new-only";

export interface RunLabelsCommandOptions {
  config: Config;
  cwd?: string;
  /** Override the gh binary (tests). */
  bin?: string;
  /** When true, print the repo's current labels and exit without mutating GitHub. */
  list?: boolean;
  /** When true, skip the confirmation prompt and overwrite everything. */
  force?: boolean;
  /** Stream for human-readable output. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /**
   * Confirmation prompt. Returns one of `"abort"`, `"overwrite"`, or
   * `"new-only"`. Default uses `node:readline/promises` and reads from
   * `process.stdin`; case-insensitive.
   */
  prompt?: (question: string) => Promise<LabelsPromptChoice>;
}

export interface RunLabelsCommandResult {
  /** Specs that were successfully (or attempted to be) upserted. Empty when listed/cancelled. */
  upserted: LabelSpec[];
  /** Labels that were printed in `list: true` mode (the repo's current labels). */
  listed?: Label[];
  /** True when the user declined the confirmation prompt. */
  cancelled?: boolean;
  /** True when only labels missing from the repo were created. */
  newOnly?: boolean;
}

/** Apply the operator's intent — either show, or upsert with confirmation. */
export async function runLabelsCommand(opts: RunLabelsCommandOptions): Promise<RunLabelsCommandResult> {
  const stdout = opts.stdout ?? process.stdout;
  const specs = buildLabelSpecs(opts.config);

  if (opts.list) {
    const existing = await listLabels({ cwd: opts.cwd, bin: opts.bin });
    renderRepoLabels(stdout, existing);
    return { upserted: [], listed: existing };
  }

  stdout.write(`${chalk.bold("Proposed Minesweeper labels:")}\n`);
  stdout.write(`${renderSpecsTable(specs)}\n\n`);

  const wantedNames = new Set(specs.map((s) => s.name));
  const existing = await listLabels({ cwd: opts.cwd, bin: opts.bin });
  const clashes = existing.filter((l) => wantedNames.has(l.name));
  renderClashes(stdout, clashes);

  const newCount = specs.length - clashes.length;

  let choice: LabelsPromptChoice = "overwrite";
  if (!opts.force) {
    const promptFn = opts.prompt ?? defaultPrompt;
    choice = await promptFn(
      `Apply changes? ${clashes.length} clash, ${newCount} new — (A)bort / (O)verwrite / new onl(Y) [A/O/Y]: `,
    );
  }

  if (choice === "abort") {
    stdout.write(`${chalk.yellow("Aborted — no labels changed.")}\n`);
    return { upserted: [], cancelled: true };
  }

  if (choice === "new-only") {
    const existingNames = new Set(existing.map((l) => l.name));
    const toCreate = specs.filter((s) => !existingNames.has(s.name));
    if (toCreate.length === 0) {
      stdout.write(`${chalk.dim("Nothing to create — every proposed label already exists.")}\n`);
      return { upserted: [], newOnly: true };
    }
    const result = await upsertAll(toCreate, opts);
    return { ...result, newOnly: true };
  }

  return await upsertAll(specs, opts);
}

async function upsertAll(specs: LabelSpec[], opts: RunLabelsCommandOptions): Promise<RunLabelsCommandResult> {
  let firstError: unknown = null;
  for (const spec of specs) {
    try {
      await upsertLabel({
        name: spec.name,
        color: spec.color,
        description: spec.description,
        cwd: opts.cwd,
        bin: opts.bin,
      });
      event("daemon", "OK", null, `label "${spec.name}" upserted (#${spec.color})`);
    } catch (err) {
      firstError ??= err;
      const detail = err instanceof Error ? err.message : String(err);
      event("daemon", "ERROR", null, `failed to upsert label "${spec.name}": ${detail}`);
    }
  }
  if (firstError) throw firstError;
  return { upserted: specs };
}

function renderClashes(stdout: NodeJS.WritableStream, clashes: Label[]): void {
  if (clashes.length === 0) {
    stdout.write(`${chalk.dim("No clashes — none of the proposed labels exist on the repo yet.")}\n\n`);
    return;
  }
  stdout.write(`${chalk.bold(`Clashing labels already on this repo (${clashes.length} — would be overwritten):`)}\n`);
  writeLabelRows(stdout, clashes);
  stdout.write("\n");
}

/** Used by `--list`: print the repo's labels with no Minesweeper-set markup. */
function renderRepoLabels(stdout: NodeJS.WritableStream, existing: Label[]): void {
  if (existing.length === 0) {
    stdout.write(`${chalk.dim("No labels currently exist on this repo.")}\n`);
    return;
  }
  stdout.write(`${chalk.bold(`Labels on this repo (${existing.length}):`)}\n`);
  writeLabelRows(stdout, existing);
}

function writeLabelRows(stdout: NodeJS.WritableStream, labels: Label[]): void {
  const sorted = [...labels].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(...sorted.map((l) => l.name.length));
  for (const lbl of sorted) {
    const colored = colourName(lbl.name, lbl.color ?? "808080");
    const pad = " ".repeat(Math.max(0, nameWidth - lbl.name.length));
    const description = lbl.description ?? "";
    stdout.write(`  ${colored}${pad}  ${description}\n`);
  }
}

/** Render the proposed specs as a coloured-name + description table. */
function renderSpecsTable(specs: LabelSpec[]): string {
  const nameWidth = Math.max(...specs.map((s) => s.name.length));
  return specs
    .map((s) => {
      const colored = colourName(s.name, s.color);
      const pad = " ".repeat(Math.max(0, nameWidth - s.name.length));
      return `  ${colored}${pad}  ${s.description}`;
    })
    .join("\n");
}

function colourName(name: string, hexNoHash: string): string {
  return chalk.hex(`#${hexNoHash}`).bold(name);
}

async function defaultPrompt(question: string): Promise<LabelsPromptChoice> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return parsePromptAnswer(answer);
  } finally {
    rl.close();
  }
}

/**
 * Map a free-form answer onto a `LabelsPromptChoice`. Case-insensitive; an
 * unrecognised or empty answer is treated as "abort" (the safe default).
 *
 * Exported for tests.
 */
export function parsePromptAnswer(raw: string): LabelsPromptChoice {
  const s = raw.trim().toLowerCase();
  if (s === "o" || s === "overwrite") return "overwrite";
  if (s === "y" || s === "new" || s === "new-only") return "new-only";
  return "abort";
}
