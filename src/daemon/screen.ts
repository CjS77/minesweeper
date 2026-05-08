/**
 * Prompt-injection screener (plan 11).
 *
 * `screenIssue` runs the `screener` subagent against a single GitHub
 * issue and returns one of `safe` / `dangerous` / `uncertain`. The
 * caller — typically `decideEligibility` in `eligibility.ts` — decides
 * what to do with the verdict (label, comment, mark ineligible).
 *
 * The screener is never the authoritative decision: it is a leaf in the
 * eligibility hierarchy, only consulted when an issue lacks both an
 * `alwaysFix` opt-in and a `manuallyApproved` human signoff but
 * `defaultEligible=true` would otherwise let it through. By running
 * before the planner, we keep untrusted user-supplied text from steering
 * the planner.
 *
 * ## Caching
 *
 * The verdict for a given issue depends on the issue body and metadata.
 * Both are summarised by `issue.updatedAt` — GitHub bumps that whenever
 * the issue is edited or a label is changed. We cache verdicts on disk
 * at `<cwd>/.minesweeper/.screen-cache/<issue#>.json` keyed by the
 * `updatedAt` we screened. On the next poll, if `updatedAt` is
 * unchanged we return the cached verdict without spending tokens. If
 * it has changed, we re-screen (issue was edited — it might be a
 * different issue now).
 *
 * The cache only short-circuits "safe" verdicts in steady state:
 * a `dangerous`/`uncertain` verdict triggers `addLabel` of
 * `possiblyDangerousLabel`, after which `decideEligibility` returns
 * `false` at the label-hierarchy step before reaching the screener.
 *
 * ## Failure mode
 *
 * If the screener subagent runs but does not emit a parseable
 * `Verdict:` line, we record the verdict as `uncertain` (with a WARN)
 * — the conservative choice, matching the "err on uncertain" rule in
 * `prompts/screener.md`.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { runSubagent as defaultRunSubagent } from "../claude/index.js";
import type { RunSubagentOptions, SubagentResult } from "../claude/index.js";
import type { Config } from "../config.js";
import type { Issue } from "../github/index.js";
import { event as defaultEvent, type Logger } from "../logging.js";

/** The three possible verdicts. Narrower than the general role pattern. */
export type ScreenVerdict = "safe" | "dangerous" | "uncertain";

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** The screener's free-text reason — useful for logs and for cache replays. */
  reason: string;
  /** Snapshot of `issue.updatedAt` at screen time. The cache key. */
  issueUpdatedAt: string;
  /** ISO timestamp of when the screener last ran. Informational. */
  screenedAt: string;
}

/** Path under `cwd` where verdict JSONs live. */
export const SCREEN_CACHE_DIR = join(".minesweeper", ".screen-cache");

/** Subagent runner shape — kept narrow so tests can inject a fake. */
export type RunSubagentFn = (opts: RunSubagentOptions) => Promise<SubagentResult>;

export interface ScreenDeps {
  /** Loaded config — used to look up the screener model. */
  config: Config;
  /** Daemon cwd; the cache lives at `<cwd>/.minesweeper/.screen-cache/`. */
  cwd: string;
  /**
   * Where to find `prompts/screener.md`. Defaults to `cwd`. Override
   * when `cwd` is a scratch directory that does not have `prompts/`
   * (tests, or future non-dogfood usage where the daemon and the
   * target repo are separate trees).
   */
  promptRoot?: string;
  /** Override the subagent runner (tests). */
  runSubagent?: RunSubagentFn;
  /** Override the logger event sink. */
  emit?: Logger["event"];
  /** Override the clock for the `screenedAt` field (tests). */
  now?: () => Date;
}

/**
 * Same parsing rule as the other verdict regexes in the codebase.
 * Anchored to a line, case-insensitive, tolerates surrounding tabs and
 * spaces. We use the global flag with `matchAll` so a screener that
 * accidentally writes more than one `Verdict:` line still parses (we
 * take the last one — same convention as critic / reviewer).
 */
const VERDICT_RE = /^[ \t]*verdict[ \t]*:[ \t]*(safe|dangerous|uncertain)[ \t]*$/gim;

/**
 * Parse a screener response and return the **last** verdict line found,
 * or `null` if none match. Callers treat `null` as `uncertain` and log
 * a warning.
 */
export function parseScreenVerdict(text: string): ScreenVerdict | null {
  const matches = [...text.matchAll(VERDICT_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const value = (last[1] ?? "").toLowerCase();
  if (value === "safe") return "safe";
  if (value === "dangerous") return "dangerous";
  return "uncertain";
}

/** On-disk path for the cached verdict of a single issue. */
function cachePath(cwd: string, issueNumber: number): string {
  return join(cwd, SCREEN_CACHE_DIR, `${issueNumber}.json`);
}

/**
 * Read the cached verdict for `issueNumber`, or `null` if there is no
 * cache file or the file is malformed. Malformed files are treated as
 * a miss rather than an error so a corrupted cache cannot wedge the
 * daemon — the next screen run will overwrite it.
 */
export async function readScreenCache(cwd: string, issueNumber: number): Promise<ScreenResult | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cachePath(cwd, issueNumber), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCachedShape(parsed)) return null;
  return parsed;
}

/**
 * Atomically replace the cached verdict for `issueNumber`. Creates the
 * cache directory on demand.
 */
export async function writeScreenCache(cwd: string, issueNumber: number, result: ScreenResult): Promise<void> {
  const path = cachePath(cwd, issueNumber);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function isCachedShape(value: unknown): value is ScreenResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.verdict !== "safe" && v.verdict !== "dangerous" && v.verdict !== "uncertain") return false;
  if (typeof v.reason !== "string") return false;
  if (typeof v.issueUpdatedAt !== "string") return false;
  if (typeof v.screenedAt !== "string") return false;
  return true;
}

/**
 * Screen `issue` for prompt-injection / out-of-scope content. Returns a
 * cached verdict if one exists for the same `issue.updatedAt`,
 * otherwise calls the screener subagent and persists the verdict.
 *
 * This function does **not** apply labels or post comments — those are
 * the caller's responsibility (`decideEligibility` in
 * `eligibility.ts`). Keeping the screen and the side effects separate
 * makes the screener trivially testable and lets the caller compose
 * different policies (e.g. the assess mode might screen without
 * labelling).
 */
export async function screenIssue(issue: Issue, deps: ScreenDeps): Promise<ScreenResult> {
  const emit = deps.emit ?? defaultEvent;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const now = deps.now ?? (() => new Date());

  const cached = await readScreenCache(deps.cwd, issue.number);
  if (cached !== null && cached.issueUpdatedAt === issue.updatedAt) {
    emit("screener", "INFO", issue.number, `cache hit (verdict=${cached.verdict})`);
    return cached;
  }

  emit("screener", "WORK", issue.number, "screening issue body");
  const result = await runSubagent({
    role: "screener",
    config: deps.config,
    userPrompt: screenerPromptFor(issue),
    issueNumber: issue.number,
    iteration: 1,
    cwd: deps.cwd,
    promptRoot: deps.promptRoot,
  });

  const parsed = parseScreenVerdict(result.finalText);
  const verdict: ScreenVerdict = parsed ?? "uncertain";
  if (parsed === null) {
    emit("screener", "WARN", issue.number, "screener did not emit a parseable Verdict line; treating as uncertain");
  } else {
    emit("screener", "INFO", issue.number, `verdict: ${verdict}`);
  }

  const screened: ScreenResult = {
    verdict,
    reason: result.finalText.trim(),
    issueUpdatedAt: issue.updatedAt,
    screenedAt: now().toISOString(),
  };

  await writeScreenCache(deps.cwd, issue.number, screened);
  return screened;
}

function screenerPromptFor(issue: Issue): string {
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
  lines.push("", "Screen this issue per your system prompt. End with a `Verdict: ...` line.");
  return lines.join("\n");
}
