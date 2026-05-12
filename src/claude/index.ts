import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { query as defaultQuery, type Options as SdkOptions, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Config } from "../config.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { BUNDLED_PROMPTS_ROOT, getRole, modelFor, type Role, type RoleName } from "./roles.js";
import { openTranscript } from "./transcript.js";

export {
  BUNDLED_PROMPTS_ROOT,
  ROLES,
  ROLE_NAMES,
  getRole,
  modelFor,
  type Role,
  type RoleName,
  type RolePermissionMode,
} from "./roles.js";
export {
  openTranscript,
  transcriptPathFor,
  TRANSCRIPT_DIR,
  type Transcript,
  type OpenTranscriptOptions,
} from "./transcript.js";

/** The bits of `query()` we depend on. Kept narrow so tests can mock it. */
export type QueryFn = typeof defaultQuery;

/** Hook for tests to inject the logger or capture events without a real Logger. */
export type EventFn = Logger["event"];

export interface RunSubagentOptions {
  /** Which role to run. Determines model, allowed tools, system prompt. */
  role: RoleName;
  /** Loaded config — used to look up the model name. */
  config: Config;
  /** The user-message body sent to the subagent. */
  userPrompt: string;
  /** Issue number, used for log lines and (eventually) state correlation. */
  issueNumber: number | null;
  /**
   * Iteration index for transcript naming. Defaults to 1. Each
   * planner ↔ critic round bumps this; reviewer ↔ executor uses it too.
   */
  iteration?: number;
  /** Working directory for the SDK and transcript. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Where to look up role prompts. When omitted, falls back to
   * `config.customPromptsPath` if set, otherwise to {@link BUNDLED_PROMPTS_ROOT}
   * (the `prompts/` dir shipped inside the npm package). Tests pass an
   * explicit fixture dir.
   */
  promptRoot?: string;
  /** Override the SDK `query` (tests). */
  queryFn?: QueryFn;
  /** Override the logger event sink (tests, or to suppress logging). */
  emit?: EventFn;
  /** Optional abort controller propagated to the SDK. */
  abortController?: AbortController;
}

export interface SubagentResult {
  /** The final assistant text from the `result` message, or empty if none arrived. */
  finalText: string;
  /** Total number of SDK events seen. */
  events: number;
  /** Wall-clock time spent in `runSubagent`. */
  durationMs: number;
  /** `stop_reason` from the `result` message, or `"unknown"` if none arrived. */
  stopReason: string;
  /** Path to the JSONL transcript on disk. */
  transcriptPath: string;
}

const TEXT_TRUNCATE = 160;

export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const role = getRole(opts.role);
  const iteration = opts.iteration ?? 1;
  const cwd = opts.cwd ?? process.cwd();
  const promptRoot = opts.promptRoot ?? opts.config.customPromptsPath ?? BUNDLED_PROMPTS_ROOT;
  const emit = opts.emit ?? defaultEvent;
  const queryFn = opts.queryFn ?? defaultQuery;

  const systemPrompt = readSystemPrompt(role, promptRoot);
  const model = modelFor(role, opts.config);

  const transcript = openTranscript({ cwd, role: opts.role, iteration });

  const sdkOptions: SdkOptions = {
    cwd,
    model,
    permissionMode: role.permissionMode,
    allowedTools: [...role.allowedTools],
    tools: [...role.allowedTools],
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
  };
  if (opts.abortController) sdkOptions.abortController = opts.abortController;

  emit(opts.role, "WORK", opts.issueNumber, `start (model=${model}, iteration=${iteration})`);

  const startedAt = Date.now();
  let events = 0;
  let finalText = "";
  let stopReason = "unknown";

  try {
    const stream = queryFn({ prompt: opts.userPrompt, options: sdkOptions });
    for await (const message of stream) {
      events += 1;
      transcript.write(message);
      forwardToLogger(message, opts.role, opts.issueNumber, emit);
      if (message.type === "result") {
        stopReason = message.stop_reason ?? "unknown";
        if (message.subtype === "success") {
          finalText = message.result;
        }
      }
    }
  } finally {
    await transcript.close();
  }

  const durationMs = Date.now() - startedAt;
  emit(opts.role, "OK", opts.issueNumber, `done (${events} events, stop=${stopReason}, ${durationMs}ms)`);

  return { finalText, events, durationMs, stopReason, transcriptPath: transcript.path };
}

function readSystemPrompt(role: Role, promptRoot: string): string {
  return readFileSync(resolve(promptRoot, role.systemPromptPath), "utf-8");
}

function forwardToLogger(message: SDKMessage, role: RoleName, issueNumber: number | null, emit: EventFn): void {
  if (message.type !== "assistant") return;
  const blocks = extractContentBlocks(message);
  blocks.forEach((block) => {
    if (block.type === "tool_use") {
      emit(role, "INFO", issueNumber, `tool call: ${block.name ?? "<unknown>"}`);
    } else if (block.type === "text" && block.text) {
      const text = block.text.trim();
      if (text.length > 0) {
        const truncated = text.length > TEXT_TRUNCATE ? `${text.slice(0, TEXT_TRUNCATE)}…` : text;
        emit(role, "INFO", issueNumber, `assistant text: ${truncated}`);
      }
    }
  });
}

interface MaybeContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

function extractContentBlocks(message: SDKMessage): MaybeContentBlock[] {
  if (message.type !== "assistant") return [];
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is MaybeContentBlock => typeof block === "object" && block !== null);
}

export type { SDKMessage };
