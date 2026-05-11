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
 * `minesweeper issue new` (alias: `issue create`) takes a free-text
 * description (positional, `-f <file>`, or stdin), pipes it through the
 * `issuewriter` subagent to shape it into the autofix template, optionally
 * lets the operator tweak the draft in `$EDITOR`, and opens the issue via
 * `gh`. The `autofix` label is applied unless `-n` was passed.
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import chalk from "chalk";
import { execa } from "execa";

import type { Config } from "../config.js";
import * as defaultClaude from "../claude/index.js";
import * as defaultGithub from "../github/index.js";
import type { Issue } from "../github/index.js";
import { isEligible } from "../daemon/eligibility.js";
import { event } from "../logging.js";
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

/** Parsed `{title, body}` after splitting the issuewriter's output. */
export interface IssueDraft {
  title: string;
  body: string;
}

export interface RunIssueNewCommandOptions {
  config: Config;
  /** Working directory passed through to `gh` and to the Claude SDK. Default: `process.cwd()`. */
  cwd?: string;
  /** Override the gh binary (tests). */
  bin?: string;
  /** Free-text message (already joined from the variadic CLI positional). May be `""`. */
  message: string;
  /** Path to a file whose contents are appended to the message (`-f`). */
  filePath?: string;
  /** Skip the `$EDITOR` confirmation step (`-y`). */
  autoConfirm?: boolean;
  /** Apply the `config.alwaysFixLabel` label to the new issue. Default: `true`. */
  addAutoFixLabel?: boolean;
  /** Stream for human-readable output. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<typeof defaultGithub, "createIssue">;
  /** Override the Claude wrapper (tests). */
  claude?: Pick<typeof defaultClaude, "runSubagent">;
  /** Read a file from disk (tests). Default: `readFileSync(path, "utf-8")`. */
  readFile?: (path: string) => string;
  /**
   * Read stdin to EOF (tests). Default returns `""` when stdin is a TTY,
   * otherwise drains `process.stdin` as utf-8.
   */
  readStdin?: () => Promise<string>;
  /**
   * Hand control to the operator for editing the draft tmpfile (tests).
   * Default spawns `$EDITOR` (falling back to `vi`, then `nano`).
   */
  editDraft?: (path: string) => Promise<void>;
}

export interface RunIssueNewCommandResult {
  issueNumber: number;
  url: string;
}

/**
 * Assemble the user input from the message arg, the `-f` file, and stdin
 * (if piped); call the `issuewriter` subagent; let the operator tweak the
 * draft in `$EDITOR` (unless `-y`); open the issue via `gh`. Returns the
 * created issue's number and URL.
 */
export async function runIssueNewCommand(opts: RunIssueNewCommandOptions): Promise<RunIssueNewCommandResult> {
  const stdout = opts.stdout ?? process.stdout;
  const gh = opts.github ?? defaultGithub;
  const claude = opts.claude ?? defaultClaude;
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const readStdin = opts.readStdin ?? defaultReadStdin;
  const editDraft = opts.editDraft ?? defaultEditDraft;
  const addAutoFixLabel = opts.addAutoFixLabel ?? true;

  const input = await assembleInput(opts.message, opts.filePath, readFile, readStdin);

  stdout.write(`${chalk.dim("Shaping issue with the issue-writer agent…")}\n`);
  const { finalText } = await claude.runSubagent({
    role: "issuewriter",
    config: opts.config,
    userPrompt: buildIssueWriterPrompt(input),
    issueNumber: null,
    cwd: opts.cwd,
  });

  const initial = parseIssueDraft(finalText);
  const draft = opts.autoConfirm ? initial : await confirmInEditor(initial, stdout, editDraft);

  const labels = addAutoFixLabel ? [opts.config.alwaysFixLabel] : [];
  const { number, url } = await gh.createIssue({
    title: draft.title,
    body: draft.body,
    labels,
    cwd: opts.cwd,
    bin: opts.bin,
  });

  event("daemon", "OK", number, `created issue #${number} at ${url}`);
  stdout.write(`${chalk.green("✔")} created issue #${number}: ${url}\n`);
  return { issueNumber: number, url };
}

/**
 * Concatenate the CLI message, optional `-f` file contents, and piped stdin
 * into a single blob the issuewriter can read. Sections are separated by a
 * `---` line so the agent can tell them apart. Throws if the result is
 * empty.
 */
async function assembleInput(
  message: string,
  filePath: string | undefined,
  readFile: (path: string) => string,
  readStdin: () => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  const trimmedMessage = message.trim();
  if (trimmedMessage.length > 0) parts.push(trimmedMessage);
  if (filePath) parts.push(readFile(filePath).trim());
  const piped = (await readStdin()).trim();
  if (piped.length > 0) parts.push(piped);

  const combined = parts.filter((p) => p.length > 0).join("\n\n---\n\n");
  if (combined.length === 0) {
    throw new Error("issue new: no input provided. Pass a message, `-f <path>`, or pipe text on stdin.");
  }
  return combined;
}

function buildIssueWriterPrompt(input: string): string {
  return [
    "Format the following request into a Minesweeper autofix issue.",
    "Follow the strict output format from your system prompt (TITLE: …, then --- then the body).",
    "Do not invent facts the operator did not provide.",
    "",
    "## User input",
    "",
    input,
  ].join("\n");
}

/**
 * Split the issuewriter's output into `{title, body}`. Strict form:
 *
 *   TITLE: <title>
 *   ---
 *   <body…>
 *
 * Fallback (logged as WARN): first non-empty line is the title; everything
 * after it is the body. We never throw — even a sloppy draft is better than
 * forcing the operator to re-run the command.
 */
export function parseIssueDraft(text: string): IssueDraft {
  const stripped = text.trim();
  const strictMatch = stripped.match(/^TITLE:\s*(.+?)\s*\n+---\s*\n([\s\S]*)$/);
  if (strictMatch) {
    return { title: strictMatch[1]!.trim(), body: strictMatch[2]!.trim() };
  }
  event("daemon", "WARN", null, "issuewriter output did not match TITLE:/--- format; falling back to first-line split");
  const lines = stripped.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) {
    return { title: "", body: "" };
  }
  const title = lines[firstIdx]!.replace(/^#+\s*/, "")
    .replace(/^TITLE:\s*/i, "")
    .trim();
  const body = lines
    .slice(firstIdx + 1)
    .join("\n")
    .trim();
  return { title, body };
}

/**
 * Write the draft to a tmpfile, hand it to `$EDITOR`, and re-parse the
 * result. Throws if the operator saved an empty file (taken as an abort
 * signal, à la `git commit`).
 */
async function confirmInEditor(
  draft: IssueDraft,
  stdout: NodeJS.WritableStream,
  editDraft: (path: string) => Promise<void>,
): Promise<IssueDraft> {
  const dir = mkdtempSync(join(tmpdir(), "minesweeper-issue-"));
  const path = join(dir, "issue-draft.md");
  writeFileSync(path, formatDraftForEditor(draft), "utf-8");
  stdout.write(`${chalk.dim(`Editing draft at ${path}…`)}\n`);

  await editDraft(path);

  const edited = readFileSync(path, "utf-8");
  if (edited.trim().length === 0) {
    throw new Error("issue new: draft was emptied in the editor; aborting without creating an issue.");
  }
  return parseIssueDraft(edited);
}

function formatDraftForEditor(draft: IssueDraft): string {
  return `TITLE: ${draft.title}\n---\n${draft.body}\n`;
}

const EDITOR_FALLBACKS = ["vi", "nano"] as const;

/**
 * Spawn the operator's `$EDITOR` (or fall back to `vi`/`nano`) on the draft
 * tmpfile, inheriting stdio so the editor takes over the terminal. We do not
 * parse the editor's exit code beyond rejecting on a real spawn failure —
 * `git commit` doesn't either, and a non-zero exit usually still leaves a
 * usable file behind.
 */
async function defaultEditDraft(path: string): Promise<void> {
  const candidates = [process.env["EDITOR"], process.env["VISUAL"], ...EDITOR_FALLBACKS].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  for (const editor of candidates) {
    try {
      await execa(editor, [path], { stdio: "inherit", reject: false });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  throw new Error("issue new: no editor available (set $EDITOR or install vi/nano).");
}

/**
 * Drain `process.stdin` to a utf-8 string when it is not a TTY (i.e. the
 * caller piped or redirected something in). When it *is* a TTY we return
 * empty immediately — otherwise the command would hang waiting for input
 * that will never come.
 */
async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
