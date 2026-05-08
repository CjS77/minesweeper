import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../../config.js";
import { runSubagent } from "../index.js";
import { ROLES } from "../roles.js";

const mockedQuery = vi.mocked(query);

const FAKE_CONFIG: Config = {
  defaultEligible: false,
  alwaysFixLabel: "autofix",
  neverFixLabel: "manual",
  possiblyDangerousLabel: "danger",
  manuallyApprovedLabel: "ok",
  failedLabel: "failed",
  subtaskLabel: "subtask",
  maxPlanningIterations: 3,
  maxReviewRounds: 2,
  eligibilityAgent: "haiku-eligibility",
  planningAgent: "opus-planning",
  reviewAgent: "sonnet-review",
  executionAgent: "opus-execution",
  worktreePath: "/tmp/wt",
  prBaseBranch: "main",
  pollIntervalSeconds: 60,
  pollIntervalMs: 60_000,
  maxConcurrency: 1,
};

interface FakeAssistantBlock {
  type: "text" | "tool_use";
  text?: string;
  name?: string;
}

function assistantMessage(blocks: FakeAssistantBlock[]): unknown {
  return {
    type: "assistant",
    message: { content: blocks },
    parent_tool_use_id: null,
    uuid: "fake-uuid",
    session_id: "fake-session",
  };
}

function resultMessage(text: string, stopReason = "end_turn"): unknown {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: stopReason,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: "fake-result-uuid",
    session_id: "fake-session",
  };
}

async function* makeStream(messages: unknown[]): AsyncGenerator<unknown> {
  for (const m of messages) yield m;
}

let tempCwd: string;
let promptRoot: string;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), "minesweeper-runsub-"));
  promptRoot = mkdtempSync(join(tmpdir(), "minesweeper-prompts-"));
  for (const role of Object.values(ROLES)) {
    const promptPath = join(promptRoot, role.systemPromptPath);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, `# ${role.name} test prompt\n`, "utf8");
  }
  mockedQuery.mockReset();
});

afterEach(() => {
  rmSync(tempCwd, { recursive: true, force: true });
  rmSync(promptRoot, { recursive: true, force: true });
});

describe("runSubagent", () => {
  it("passes the model, allowedTools, permissionMode, cwd, and appended system prompt to query()", async () => {
    mockedQuery.mockReturnValue(makeStream([resultMessage("done")]) as never);

    const emit = vi.fn();
    const result = await runSubagent({
      role: "planner",
      config: FAKE_CONFIG,
      userPrompt: "go fix issue 42",
      issueNumber: 42,
      cwd: tempCwd,
      promptRoot,
      emit,
    });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [params] = mockedQuery.mock.calls[0]!;
    expect(params.prompt).toBe("go fix issue 42");
    expect(params.options?.cwd).toBe(tempCwd);
    expect(params.options?.model).toBe("opus-planning");
    expect(params.options?.permissionMode).toBe("plan");
    expect(params.options?.allowedTools).toEqual([...ROLES.planner.allowedTools]);
    expect(params.options?.tools).toEqual([...ROLES.planner.allowedTools]);
    expect(params.options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "# planner test prompt\n",
    });
    expect(result.finalText).toBe("done");
    expect(result.stopReason).toBe("end_turn");
    expect(result.events).toBe(1);
  });

  it("uses the executor's model and acceptEdits permission mode when role=executor", async () => {
    mockedQuery.mockReturnValue(makeStream([resultMessage("ship it", "stop_sequence")]) as never);

    await runSubagent({
      role: "executor",
      config: FAKE_CONFIG,
      userPrompt: "execute the plan",
      issueNumber: 7,
      cwd: tempCwd,
      promptRoot,
      emit: vi.fn(),
    });

    const [params] = mockedQuery.mock.calls[0]!;
    expect(params.options?.model).toBe("opus-execution");
    expect(params.options?.permissionMode).toBe("acceptEdits");
    expect(params.options?.allowedTools).toContain("Edit");
    expect(params.options?.allowedTools).toContain("Write");
  });

  it("writes one JSON line per SDK event to the per-(role,iteration) transcript", async () => {
    const messages = [
      assistantMessage([{ type: "text", text: "thinking..." }]),
      assistantMessage([{ type: "tool_use", name: "Read" }]),
      resultMessage("ok"),
    ];
    mockedQuery.mockReturnValue(makeStream(messages) as never);

    const result = await runSubagent({
      role: "critic",
      config: FAKE_CONFIG,
      userPrompt: "review",
      issueNumber: null,
      cwd: tempCwd,
      promptRoot,
      iteration: 4,
      emit: vi.fn(),
    });

    expect(result.transcriptPath).toBe(join(tempCwd, ".minesweeper/planning_history/critic-04.jsonl"));
    const lines = readFileSync(result.transcriptPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).type).toBe("assistant");
    expect(JSON.parse(lines[2]!).type).toBe("result");
    expect(result.events).toBe(3);
  });

  it("emits high-level milestones to the logger", async () => {
    const messages = [
      assistantMessage([{ type: "text", text: "investigating now" }]),
      assistantMessage([{ type: "tool_use", name: "Grep" }]),
      resultMessage("done"),
    ];
    mockedQuery.mockReturnValue(makeStream(messages) as never);

    const emit = vi.fn();
    await runSubagent({
      role: "planner",
      config: FAKE_CONFIG,
      userPrompt: "plan",
      issueNumber: 9,
      cwd: tempCwd,
      promptRoot,
      emit,
    });

    const messagesEmitted = emit.mock.calls.map((c) => c[3] as string);
    expect(messagesEmitted.some((m) => m.includes("start"))).toBe(true);
    expect(messagesEmitted.some((m) => m.includes("assistant text: investigating now"))).toBe(true);
    expect(messagesEmitted.some((m) => m.includes("tool call: Grep"))).toBe(true);
    expect(messagesEmitted.some((m) => m.includes("done"))).toBe(true);

    for (const call of emit.mock.calls) {
      expect(call[0]).toBe("planner");
      expect(call[2]).toBe(9);
    }
  });

  it("returns finalText='' and stopReason='unknown' when no result message arrives", async () => {
    mockedQuery.mockReturnValue(makeStream([assistantMessage([{ type: "text", text: "..." }])]) as never);

    const result = await runSubagent({
      role: "reviewer",
      config: FAKE_CONFIG,
      userPrompt: "review",
      issueNumber: 1,
      cwd: tempCwd,
      promptRoot,
      emit: vi.fn(),
    });

    expect(result.finalText).toBe("");
    expect(result.stopReason).toBe("unknown");
    expect(result.events).toBe(1);
  });

  it("closes the transcript even if the stream throws", async () => {
    async function* boom(): AsyncGenerator<unknown> {
      yield assistantMessage([{ type: "text", text: "before crash" }]);
      throw new Error("stream blew up");
    }
    mockedQuery.mockReturnValue(boom() as never);

    const result = runSubagent({
      role: "planner",
      config: FAKE_CONFIG,
      userPrompt: "x",
      issueNumber: 1,
      cwd: tempCwd,
      promptRoot,
      emit: vi.fn(),
    });

    await expect(result).rejects.toThrow(/stream blew up/);
    const path = join(tempCwd, ".minesweeper/planning_history/planner-01.jsonl");
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });
});
