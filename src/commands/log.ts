/**
 * `minesweeper log view` — pretty-print a JSONL transcript captured by
 * `runSubagent` (`src/claude/transcript.ts`).
 *
 * Renders each SDK message as a single emoji-tagged line in the same style
 * as the structured logger (`src/logging.ts`). Tool uses are summarised, tool
 * results are folded with a per-line cap, and unrecognised event types fall
 * through to a `❓ <type>` line so future SDK additions are visible rather
 * than silently dropped.
 *
 * Pure renderer (`renderTranscriptLine`) is exported for tests; the
 * top-level `runLogViewCommand` wires up file reading, name resolution, and
 * stdout writing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";

import chalk from "chalk";

import { TRANSCRIPT_DIR } from "../claude/transcript.js";

/** Thrown by `runLogViewCommand` when the requested transcript can't be located. */
export class LogViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogViewError";
  }
}

export interface RunLogViewCommandOptions {
  /** Bare transcript name (`planner-01`), explicit `.jsonl` filename, or path. */
  name: string;
  /** Working directory used to resolve a bare name. Default: `process.cwd()`. */
  cwd?: string;
  /** Stream to render into. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** When false, suppress all ANSI escapes. Default: `true`. */
  color?: boolean;
  /**
   * Maximum number of body lines emitted per message (text/thinking/tool result).
   * `0` means unlimited. Default: `40`.
   */
  maxLines?: number;
}

/**
 * Per-message rendering state. The SDK's `assistant` events have no
 * top-level `timestamp` (only `user` events do), so we carry forward the
 * last timestamp we saw to keep every line dated. `lastModel` is captured
 * from `system.init` and refreshed on every assistant `message.model` —
 * this lets `user` lines (tool results) cite the model that produced them.
 */
export interface RenderContext {
  lastTimestamp: string | null;
  lastModel: string | null;
  maxLines: number;
}

interface SdkMessage {
  type?: string;
  subtype?: string;
  timestamp?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  claude_code_version?: string;
  message?: {
    model?: string;
    content?: unknown;
  };
  tool_use_result?: unknown;
  rate_limit_info?: { status?: string };
  stop_reason?: string;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
}

interface ContentBlock {
  type?: string;
  thinking?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ToolUseResult {
  stdout?: string;
  stderr?: string;
  file?: { filePath?: string; content?: string; numLines?: number };
  type?: string;
}

/**
 * Read a JSONL transcript and write a pretty rendering to stdout. Tolerates
 * malformed lines (records the line number and continues).
 */
export function runLogViewCommand(opts: RunLogViewCommandOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;
  const wantColor = opts.color ?? true;
  const maxLines = opts.maxLines ?? 40;

  const path = resolveTranscriptPath(opts.name, cwd);

  const previousLevel = chalk.level;
  if (wantColor) {
    if (chalk.level === 0) chalk.level = 3;
  } else {
    chalk.level = 0;
  }

  try {
    const text = readTranscript(path, cwd);
    const lines = text.split("\n");
    const ctx: RenderContext = { lastTimestamp: null, lastModel: null, maxLines };
    lines.forEach((raw, idx) => {
      if (raw.length === 0) return;
      const lineNumber = idx + 1;
      let parsed: SdkMessage;
      try {
        parsed = JSON.parse(raw) as SdkMessage;
      } catch {
        stdout.write(`${chalk.yellow(`⚠️ line ${lineNumber} unparseable`)}\n`);
        return;
      }
      const rendered = renderTranscriptLine(parsed, ctx);
      if (rendered.length > 0) stdout.write(`${rendered}\n`);
    });
  } finally {
    chalk.level = previousLevel;
  }
}

/**
 * Render one SDK message into one or more newline-joined display lines. Pure
 * function over `(message, ctx)`; mutates `ctx` to track the running model
 * and timestamp. Returned string never has a trailing newline.
 */
export function renderTranscriptLine(message: SdkMessage, ctx: RenderContext): string {
  if (message.timestamp) ctx.lastTimestamp = message.timestamp;
  const time = formatTimeOrPlaceholder(ctx.lastTimestamp);
  const isError = Boolean(message.is_error);

  switch (message.type) {
    case "system":
      return renderSystem(message, ctx, time);
    case "assistant":
      return renderAssistant(message, ctx, time);
    case "user":
      return renderUser(message, ctx, time, isError);
    case "result":
      return renderResult(message, time);
    case "rate_limit_event":
      return renderRateLimit(message, time);
    default:
      return `${time} ${chalk.dim(`❓ ${message.type ?? "unknown"}`)}`;
  }
}

function renderSystem(message: SdkMessage, ctx: RenderContext, time: string): string {
  const modelFromInit = typeof message.model === "string" ? message.model : null;
  if (modelFromInit) ctx.lastModel = modelFromInit;
  const headerLabel = chalk.white.bold("SYSTEM");
  const modelTag = ctx.lastModel ? ` (${ctx.lastModel})` : "";
  const subtype = message.subtype ?? "event";
  const header = `${time} 🏛️ ${headerLabel}${modelTag} — ${subtype}`;
  if (message.subtype === "init") {
    const cwd = message.cwd ?? "";
    const mode = message.permissionMode ?? "";
    const version = message.claude_code_version ?? "";
    const detail = chalk.dim(`    cwd=${cwd} permissionMode=${mode} claude_code_version=${version}`);
    return `${header}\n${detail}`;
  }
  return header;
}

function renderAssistant(message: SdkMessage, ctx: RenderContext, time: string): string {
  const innerModel = message.message?.model;
  if (typeof innerModel === "string") ctx.lastModel = innerModel;
  const blocks = extractBlocks(message.message?.content);
  if (blocks.length === 0) return assistantHeader(ctx, time, "message");
  return blocks.map((block) => renderAssistantBlock(block, ctx, time)).join("\n");
}

function renderAssistantBlock(block: ContentBlock, ctx: RenderContext, time: string): string {
  if (block.type === "thinking") {
    const header = assistantHeader(ctx, time, "thinking");
    const body = typeof block.thinking === "string" ? block.thinking.trim() : "";
    return body.length > 0 ? `${header}\n${indentBody(body, ctx.maxLines)}` : header;
  }
  if (block.type === "tool_use") {
    const name = block.name ?? "Tool";
    const summary = summariseToolInput(name, block.input);
    return assistantHeader(ctx, time, `${name}(${summary})`);
  }
  if (block.type === "text") {
    const header = assistantHeader(ctx, time, "text");
    const body = typeof block.text === "string" ? block.text.trim() : "";
    return body.length > 0 ? `${header}\n${indentBody(body, ctx.maxLines)}` : header;
  }
  return assistantHeader(ctx, time, block.type ?? "block");
}

function assistantHeader(ctx: RenderContext, time: string, suffix: string): string {
  const label = chalk.cyan.bold("ASSISTANT");
  const modelTag = ctx.lastModel ? ` (${ctx.lastModel})` : "";
  return `${time} 👩‍🏫 ${label}${modelTag} — ${suffix}`;
}

function renderUser(message: SdkMessage, ctx: RenderContext, time: string, isError: boolean): string {
  const blocks = extractBlocks(message.message?.content);
  const toolBlock = blocks.find((b) => b.type === "tool_result");
  if (!toolBlock) {
    const header = userHeader(ctx, time, "prompt", isError);
    const body = blocks
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .filter((s) => s.length > 0)
      .join("\n")
      .trim();
    return body.length > 0 ? `${header}\n${indentBody(body, ctx.maxLines)}` : header;
  }
  const errorFlag = isError || Boolean(toolBlock.is_error);
  const result = (message.tool_use_result ?? null) as ToolUseResult | null;
  return renderToolResult(result, toolBlock, ctx, time, errorFlag);
}

function renderToolResult(
  result: ToolUseResult | null,
  toolBlock: ContentBlock,
  ctx: RenderContext,
  time: string,
  isError: boolean,
): string {
  if (result?.file?.content !== undefined) {
    const path = result.file.filePath ?? "<file>";
    const numLines = result.file.numLines ?? countLines(result.file.content);
    const header = userHeader(ctx, time, `tool_result ${path} (${numLines} lines)`, isError);
    return `${header}\n${indentBody(result.file.content, ctx.maxLines)}`;
  }
  if (typeof result?.stdout === "string") {
    const numLines = countLines(result.stdout);
    const header = userHeader(ctx, time, `tool_result (${numLines} lines)`, isError);
    const body = indentBody(result.stdout, ctx.maxLines);
    if (typeof result.stderr === "string" && result.stderr.length > 0) {
      const stderrLabel = chalk.dim("    stderr:");
      const stderrBody = indentBody(result.stderr, ctx.maxLines);
      return `${header}\n${body}\n${stderrLabel}\n${stderrBody}`;
    }
    return `${header}\n${body}`;
  }
  const inlineContent = typeof toolBlock.content === "string" ? toolBlock.content : "";
  const numLines = countLines(inlineContent);
  const header = userHeader(ctx, time, `tool_result (${numLines} lines)`, isError);
  return inlineContent.length > 0 ? `${header}\n${indentBody(inlineContent, ctx.maxLines)}` : header;
}

function userHeader(ctx: RenderContext, time: string, suffix: string, isError: boolean): string {
  const label = chalk.green.bold("USER");
  const modelTag = ctx.lastModel ? ` (${ctx.lastModel})` : "";
  const head = `${time} 👨 ${label}${modelTag} — ${suffix}`;
  return isError ? chalk.red(head) : head;
}

function renderResult(message: SdkMessage, time: string): string {
  const stop = message.stop_reason ?? "?";
  const turns = message.num_turns ?? "?";
  const dur = message.duration_ms ?? "?";
  const label = chalk.magenta.bold("RESULT");
  const head = `${time} 🏁 ${label} — stop=${stop}, ${turns} turns, ${dur}ms`;
  return message.subtype === "error" ? chalk.red(head) : head;
}

function renderRateLimit(message: SdkMessage, time: string): string {
  const status = message.rate_limit_info?.status ?? "unknown";
  return `${time} ${chalk.yellow(`⏱️ Rate-limit — ${status}`)}`;
}

/**
 * Best-effort one-line summary of a tool's input. We pluck the most
 * informative single field per tool, falling back to the first string-valued
 * key. Result is clipped to 80 characters so it stays on one line.
 */
function summariseToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const candidate = pickSummaryField(name, input);
  const text = candidate === null ? "" : candidate.replace(/\s+/g, " ").trim();
  return clip(text, 80);
}

function pickSummaryField(name: string, input: Record<string, unknown>): string | null {
  const byTool: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["file_path"],
    Write: ["file_path"],
    Edit: ["file_path"],
    Grep: ["pattern"],
    Glob: ["pattern"],
    WebFetch: ["url"],
  };
  const preferred = byTool[name] ?? [];
  for (const key of preferred) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function extractBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ContentBlock => typeof b === "object" && b !== null);
}

/**
 * Indent every line of `body` by four spaces, capped to `maxLines` source
 * lines. `maxLines === 0` disables truncation. Adds a dimmed `… (truncated)`
 * footer when the body was clipped.
 */
function indentBody(body: string, maxLines: number): string {
  const lines = body.split("\n");
  if (maxLines > 0 && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines).map((l) => `    ${l}`);
    const rest = lines.length - maxLines;
    kept.push(chalk.dim(`    … (truncated ${rest} more line${rest === 1 ? "" : "s"})`));
    return kept.join("\n");
  }
  return lines.map((l) => `    ${l}`).join("\n");
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split("\n").length;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatTimeOrPlaceholder(iso: string | null): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Resolve `name` to an absolute transcript path. Bare names are interpreted
 * relative to `<cwd>/.minesweeper/planning_history/`; anything containing a
 * path separator or ending in `.jsonl` is taken as an explicit path.
 */
function resolveTranscriptPath(name: string, cwd: string): string {
  if (isAbsolute(name)) return name;
  if (name.includes("/") || name.endsWith(".jsonl")) return join(cwd, name);
  return join(cwd, TRANSCRIPT_DIR, `${name}.jsonl`);
}

function readTranscript(path: string, cwd: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) {
      throw new LogViewError(missingTranscriptMessage(path, cwd));
    }
    throw err;
  }
}

function missingTranscriptMessage(path: string, cwd: string): string {
  const dir = dirname(path);
  const available = listJsonl(dir);
  if (available.length > 0) {
    return `transcript not found: ${path}\navailable in ${dir}:\n  ${available.join("\n  ")}`;
  }
  const fallbackDir = join(cwd, TRANSCRIPT_DIR);
  const fallback = listJsonl(fallbackDir);
  if (fallback.length > 0) {
    return `transcript not found: ${path}\navailable in ${fallbackDir}:\n  ${fallback.join("\n  ")}`;
  }
  return `transcript not found: ${path}\nno transcripts yet`;
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";
}
