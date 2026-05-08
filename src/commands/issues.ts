/**
 * `minesweeper issue list` — read-only triage view of the repository's open
 * issues. For every open issue returned by `gh issue list`, the command
 * renders the number/title and tags it with two markers:
 *
 *   - `[in-progress: <Mode>/<Status>]` — the issue currently has a worktree
 *     under `${MINESWEEPER_WORKTREE_PATH}/worktrees/` whose `state.json`
 *     parses cleanly. The mode/status come straight from that file.
 *   - `[eligible]` — `isEligible(issue, config)` returns true. We
 *     deliberately call the synchronous label-only filter and **not**
 *     `decideEligibility`: the latter has side effects (it labels and
 *     comments on issues when the prompt-injection screener fires) which
 *     have no business running inside a read-only inspection command.
 *
 * The command is capped at the first 1000 open issues — that is `gh`'s own
 * page ceiling. Pagination beyond that is out of scope: anyone with more
 * than 1000 open issues already has bigger problems than `minesweeper
 * issue list`.
 *
 * `runIssueNewCommand` is a placeholder mirroring the `once` stub in
 * `src/cli.ts`: it writes a one-line "not yet implemented" notice and
 * returns. The subcommand is registered now so the CLI shape is fixed
 * before a future plan implements actual issue creation.
 */

import { resolve } from "node:path";

import chalk from "chalk";

import type { Config } from "../config.js";
import * as defaultGithub from "../github/index.js";
import type { Issue } from "../github/index.js";
import { isEligible } from "../daemon/eligibility.js";
import * as defaultWorktree from "../worktree.js";
import type { Mode, Status } from "../child/state.js";

/** Hex colours match `buildLabelSpecs` in `src/commands/labels.ts`. */
const ELIGIBLE_HEX = "#0e8a16";
const IN_PROGRESS_HEX = "#d93f0b";

/** GitHub's own ceiling on `gh issue list --limit`. */
const MAX_ISSUES = 1000;

/** Structured row used both for rendering and for tests. */
export interface IssueRow {
  number: number;
  title: string;
  eligible: boolean;
  inProgress: { mode: Mode; status: Status } | null;
}

export interface RunIssueListCommandOptions {
  config: Config;
  /** Working directory passed through to `gh`. Default: `process.cwd()`. */
  cwd?: string;
  /** Override the gh binary (tests). */
  bin?: string;
  /** Stream for human-readable output. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<typeof defaultGithub, "listIssues">;
  /** Override the worktree wrapper (tests). */
  worktree?: Pick<typeof defaultWorktree, "listOrphans">;
}

export interface RunIssueListCommandResult {
  rows: IssueRow[];
}

/**
 * Fetch the repo's open issues, correlate against on-disk worktree state,
 * and render a one-line-per-issue summary. Returns the structured row data
 * so tests can assert without scraping ANSI escapes.
 */
export async function runIssueListCommand(opts: RunIssueListCommandOptions): Promise<RunIssueListCommandResult> {
  const stdout = opts.stdout ?? process.stdout;
  const gh = opts.github ?? defaultGithub;
  const wt = opts.worktree ?? defaultWorktree;

  const issues = await gh.listIssues({
    cwd: opts.cwd,
    bin: opts.bin,
    state: "open",
    limit: MAX_ISSUES,
  });

  const stateMap = await loadInProgressMap(opts.config, wt);
  const rows = issues.map((issue) => buildRow(issue, opts.config, stateMap));

  if (rows.length === 0) {
    stdout.write(`${chalk.dim("No open issues.")}\n`);
    return { rows };
  }

  stdout.write(`${chalk.bold(`Open issues (${rows.length}):`)}\n`);
  for (const row of rows) {
    stdout.write(`${renderRow(row)}\n`);
  }
  return { rows };
}

async function loadInProgressMap(
  config: Config,
  wt: Pick<typeof defaultWorktree, "listOrphans">,
): Promise<Map<number, { mode: Mode; status: Status }>> {
  const worktreesRoot = resolve(config.worktreePath, "worktrees");
  const orphans = await wt.listOrphans(worktreesRoot);
  const map = new Map<number, { mode: Mode; status: Status }>();
  for (const orphan of orphans) {
    // `OrphanedWorktree.state` is typed as optional even though `listOrphans`
    // filters out entries without a parsed state. Guarding here keeps us
    // honest if that contract ever weakens.
    if (!orphan.state) continue;
    map.set(orphan.state.issueNumber, {
      mode: orphan.state.mode,
      status: orphan.state.status,
    });
  }
  return map;
}

function buildRow(issue: Issue, config: Config, stateMap: Map<number, { mode: Mode; status: Status }>): IssueRow {
  return {
    number: issue.number,
    title: issue.title,
    eligible: isEligible(issue, config),
    inProgress: stateMap.get(issue.number) ?? null,
  };
}

function renderRow(row: IssueRow): string {
  const tags: string[] = [];
  if (row.inProgress) {
    tags.push(chalk.hex(IN_PROGRESS_HEX)(`[in-progress: ${row.inProgress.mode}/${row.inProgress.status}]`));
  }
  if (row.eligible) {
    tags.push(chalk.hex(ELIGIBLE_HEX)("[eligible]"));
  }
  const head = `  #${row.number}  ${row.title}`;
  return tags.length === 0 ? head : `${head}  ${tags.join(" ")}`;
}

export interface RunIssueNewCommandOptions {
  /** Stream for human-readable output. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
}

/**
 * Stub for `minesweeper issue new`. Prints a one-line "not yet implemented"
 * notice. Mirrors the `once` placeholder in `src/cli.ts`; a future plan
 * will replace this with real issue-creation logic.
 */
export function runIssueNewCommand(opts: RunIssueNewCommandOptions = {}): void {
  const stdout = opts.stdout ?? process.stdout;
  stdout.write("minesweeper issue new — not yet implemented\n");
}
