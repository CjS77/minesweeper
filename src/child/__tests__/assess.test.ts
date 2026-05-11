import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import type { Issue } from "../../github/index.js";
import type { SubagentResult } from "../../claude/index.js";
import { initState, readState } from "../state.js";
import { FINAL_PLAN_FILE, parseAssessVerdict, runAssess, type RunSubagentFn } from "../modes/assess.js";

const FAKE_CONFIG: Config = {
  defaultEligible: false,
  alwaysFixLabel: "autofix",
  tryFixLabel: "tryFix",
  neverFixLabel: "manual",
  possiblyDangerousLabel: "danger",
  manuallyApprovedLabel: "ok",
  failedLabel: "failed",
  subtaskLabel: "subtask",
  maxPlanningIterations: 5,
  maxReviewRounds: 3,
  eligibilityAgent: "haiku-eligibility",
  planningAgent: "opus-planning",
  reviewAgent: "sonnet-review",
  executionAgent: "opus-execution",
  issueWriterAgent: "sonnet-issue-writer",
  worktreePath: "/tmp/wt",
  prBaseBranch: "main",
  pollIntervalSeconds: 60,
  pollIntervalMs: 60_000,
  schedule: [],
  pollCooldownSeconds: 120,
  pollCooldownMs: 120_000,
  maxConcurrency: 1,
};

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: "feat: add a thing",
    body: "Add the thing.",
    labels: [{ name: "autofix" }],
    author: { login: "alice" },
    state: "OPEN",
    url: `https://github.com/example/repo/issues/${number}`,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function fakeResult(text: string): SubagentResult {
  return {
    finalText: text,
    events: 1,
    durationMs: 1,
    stopReason: "end_turn",
    transcriptPath: "/tmp/transcript.jsonl",
  };
}

const PLAN_BODY = "# Execution Plan\n\n## Summary\nDo the thing.\n";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-assess-"));
  await initState(tmp, "Assess", {
    issueNumber: 42,
    branchName: "minesweeper-issue0042",
    maxIterations: 1,
  });
  await mkdir(join(tmp, ".minesweeper"), { recursive: true });
  await writeFile(join(tmp, FINAL_PLAN_FILE), PLAN_BODY, "utf8");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface RunArgs {
  /** Text the assessor subagent will return. */
  responseText: string;
  /** Override the issue returned by `gh.getIssue`. */
  issue?: Issue;
}

async function run(args: RunArgs): Promise<{
  result: Awaited<ReturnType<typeof runAssess>>;
  emit: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  runSubagent: ReturnType<typeof vi.fn>;
}> {
  const persisted = await readState(tmp);
  const issue = args.issue ?? makeIssue(persisted.issueNumber);
  const getIssue = vi.fn(async () => issue);
  const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult(args.responseText));
  const emit = vi.fn();
  const result = await runAssess({
    config: FAKE_CONFIG,
    cwd: tmp,
    state: persisted,
    github: { getIssue },
    runSubagent,
    emit,
  });
  return { result, emit, getIssue, runSubagent };
}

describe("parseAssessVerdict", () => {
  it("returns Execute for the bare token", () => {
    expect(parseAssessVerdict("Verdict: Execute")).toBe("Execute");
  });

  it("returns Refine for the bare token", () => {
    expect(parseAssessVerdict("Verdict: Refine")).toBe("Refine");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseAssessVerdict("\n  verdict :  EXECUTE  \n")).toBe("Execute");
  });

  it("uses the last matching line when multiple are present", () => {
    expect(parseAssessVerdict("Verdict: Refine\n\nupdated:\nVerdict: Execute\n")).toBe("Execute");
  });

  it("returns null when no line matches", () => {
    expect(parseAssessVerdict("the plan looks fine")).toBeNull();
  });
});

describe("runAssess", () => {
  it("Execute verdict → transitions to Execution/Writing with maxReviewRounds", async () => {
    const { result, runSubagent, emit } = await run({
      responseText: "## Reasoning\n\nFocused change in one module.\n\nVerdict: Execute\n",
    });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    const call = runSubagent.mock.calls[0]?.[0];
    expect(call?.role).toBe("assessor");
    expect(call?.userPrompt).toContain("# Approved plan");
    expect(call?.userPrompt).toContain(PLAN_BODY.trimEnd());
    expect(call?.userPrompt).toContain("# GitHub issue #42");

    expect(result.mode).toBe("Execution");
    expect(result.status).toBe("Writing");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(FAKE_CONFIG.maxReviewRounds);
    expect(result.assessment).toBe("Execute");
    expect(result.assessmentReason).toContain("Focused change");

    const persisted = await readState(tmp);
    expect(persisted.mode).toBe("Execution");
    expect(persisted.assessment).toBe("Execute");
    expect(persisted.assessmentReason).toContain("Focused change");

    const infoCalls = emit.mock.calls.filter((c) => c[1] === "INFO");
    expect(infoCalls.some((c) => String(c[3]).includes("verdict: Execute"))).toBe(true);
  });

  it("Refine verdict → transitions to Refine/InProgress with maxIterations=1", async () => {
    const { result, emit } = await run({
      responseText: "## Reasoning\n\nSpans three subsystems.\n\nVerdict: Refine\n",
    });

    expect(result.mode).toBe("Refine");
    expect(result.status).toBe("InProgress");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(1);
    expect(result.assessment).toBe("Refine");
    expect(result.assessmentReason).toContain("three subsystems");

    const persisted = await readState(tmp);
    expect(persisted.mode).toBe("Refine");
    expect(persisted.assessment).toBe("Refine");

    const infoCalls = emit.mock.calls.filter((c) => c[1] === "INFO");
    expect(infoCalls.some((c) => String(c[3]).includes("verdict: Refine"))).toBe(true);
  });

  it("unparseable response → defaults to Refine with a WARN log", async () => {
    const { result, emit } = await run({
      responseText: "I think this looks fine but I forgot the verdict line",
    });

    expect(result.mode).toBe("Refine");
    expect(result.assessment).toBe("Refine");

    const warnCalls = emit.mock.calls.filter((c) => c[1] === "WARN");
    expect(warnCalls.some((c) => String(c[3]).includes("did not emit a parseable Verdict"))).toBe(true);
  });

  it("empty response → assessmentReason is null, default Refine path", async () => {
    const { result } = await run({ responseText: "   \n  " });

    expect(result.assessment).toBe("Refine");
    expect(result.assessmentReason).toBeNull();
  });

  it("missing final_plan.md throws a helpful error", async () => {
    await rm(join(tmp, FINAL_PLAN_FILE));
    const persisted = await readState(tmp);
    const runSubagent = vi.fn<RunSubagentFn>();
    await expect(
      runAssess({
        config: FAKE_CONFIG,
        cwd: tmp,
        state: persisted,
        github: { getIssue: vi.fn(async () => makeIssue(42)) },
        runSubagent,
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/final_plan\.md not found/);
    expect(runSubagent).not.toHaveBeenCalled();
  });
});
