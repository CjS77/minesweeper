import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import type { Issue } from "../../github/index.js";
import { initState, readState, writeState as realWriteState, type State } from "../state.js";
import {
  CURRENT_PLAN_FILE,
  FINAL_PLAN_FILE,
  parseVerdict,
  runPlanning,
  sanitisePlan,
  type RunSubagentFn,
} from "../modes/planning.js";
import type { SubagentResult } from "../../claude/index.js";

const FAKE_CONFIG: Config = {
  defaultEligible: false,
  alwaysFixLabel: "autofix",
  neverFixLabel: "manual",
  possiblyDangerousLabel: "danger",
  manuallyApprovedLabel: "ok",
  failedLabel: "failed",
  subtaskLabel: "subtask",
  maxPlanningIterations: 5,
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

function makeIssue(number: number): Issue {
  return {
    number,
    title: `Bug in widget #${number}`,
    body: "Reproduction steps:\n1. Use widget.\n2. Observe crash.",
    labels: [{ name: "autofix" }, { name: "bug" }],
    author: { login: "alice" },
    state: "OPEN",
    url: `https://github.com/example/repo/issues/${number}`,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
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

interface ScriptedCall {
  role: "planner" | "critic";
  iteration: number;
  userPrompt: string;
}

function scriptedRunner(responses: Array<{ role: "planner" | "critic"; text: string }>): {
  fn: RunSubagentFn;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const queue = [...responses];
  const fn: RunSubagentFn = async (opts) => {
    const next = queue.shift();
    if (!next) {
      throw new Error(`scriptedRunner: no scripted response for call to ${opts.role}`);
    }
    if (next.role !== opts.role) {
      throw new Error(
        `scriptedRunner: expected role ${next.role}, got ${opts.role} (iteration=${opts.iteration ?? "?"})`,
      );
    }
    calls.push({
      role: opts.role as "planner" | "critic",
      iteration: opts.iteration ?? -1,
      userPrompt: opts.userPrompt,
    });
    return fakeResult(next.text);
  };
  return { fn, calls };
}

const PLAN_BODY = "# Execution Plan\n\n## Summary\nFix the widget.\n\n## Files to change\n- src/widget.ts\n";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-planning-"));
  await initState(tmp, "Planning", {
    issueNumber: 42,
    branchName: "minesweeper-issue0042",
    maxIterations: 5,
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function setup(
  responses: Array<{ role: "planner" | "critic"; text: string }>,
  overrides: { maxIterations?: number; emit?: ReturnType<typeof vi.fn> } = {},
): Promise<{
  result: Awaited<ReturnType<typeof runPlanning>>;
  calls: ScriptedCall[];
  emit: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
}> {
  const state = await readState(tmp);
  const adjusted = { ...state, maxIterations: overrides.maxIterations ?? state.maxIterations };
  const getIssue = vi.fn(async () => makeIssue(42));
  const { fn: runSubagent, calls } = scriptedRunner(responses);
  const emit = overrides.emit ?? vi.fn();
  const result = await runPlanning({
    config: FAKE_CONFIG,
    cwd: tmp,
    state: adjusted,
    github: { getIssue },
    runSubagent,
    emit,
  });
  return { result, calls, emit, getIssue };
}

describe("parseVerdict", () => {
  it("returns Approved for a clean Verdict line", () => {
    expect(parseVerdict("Verdict: Approved")).toBe("Approved");
  });

  it("returns Approved with comments and prefers it over plain Approved", () => {
    expect(parseVerdict("Verdict: Approved with comments")).toBe("Approved with comments");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseVerdict("\n  verdict :  REQUEST CHANGES  \n")).toBe("Request changes");
  });

  it("uses the last matching line when multiple are present", () => {
    const text = "Verdict: Request changes\n\nupdated:\nVerdict: Approved\n";
    expect(parseVerdict(text)).toBe("Approved");
  });

  it("returns null when no line matches", () => {
    expect(parseVerdict("the plan looks fine")).toBeNull();
  });
});

describe("runPlanning", () => {
  it("planner-only when maxIterations is 1: writes final_plan, transitions to Execution", async () => {
    const { result, calls, emit } = await setup([{ role: "planner", text: PLAN_BODY }], { maxIterations: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBe("planner");
    expect(calls[0]?.iteration).toBe(1);

    const final = await readFile(join(tmp, FINAL_PLAN_FILE), "utf8");
    expect(final).toBe(PLAN_BODY);
    const current = await readFile(join(tmp, CURRENT_PLAN_FILE), "utf8");
    expect(current).toBe(PLAN_BODY);

    expect(result.mode).toBe("Execution");
    expect(result.status).toBe("Writing");
    expect(result.iterations).toBe(0);
    expect(result.maxIterations).toBe(FAKE_CONFIG.maxReviewRounds);

    const persisted = await readState(tmp);
    expect(persisted.mode).toBe("Execution");
    expect(persisted.status).toBe("Writing");
    expect(persisted.iterations).toBe(0);

    const warnCalls = emit.mock.calls.filter((c) => c[1] === "WARN");
    expect(warnCalls.some((c) => String(c[3]).includes("hit maxIterations"))).toBe(true);
  });

  it("planner → critic Approved: finalises without modifying the plan", async () => {
    const { result, calls } = await setup([
      { role: "planner", text: PLAN_BODY },
      { role: "critic", text: "# Critique\n## Findings\nNone.\n\nVerdict: Approved\n" },
    ]);

    expect(calls.map((c) => c.role)).toEqual(["planner", "critic"]);
    expect(calls[1]?.iteration).toBe(2);
    expect(calls[1]?.userPrompt).toContain(PLAN_BODY);

    const final = await readFile(join(tmp, FINAL_PLAN_FILE), "utf8");
    expect(final).toBe(PLAN_BODY);
    expect(final).not.toContain("Points to consider");
    expect(final).not.toContain("Execution Plan review");

    expect(result.mode).toBe("Execution");
    expect(result.iterations).toBe(0);
  });

  it("planner → critic Approved-with-comments: appends Points to consider in current, strips it from final", async () => {
    const critique = "# Critique\n## Findings\n- nit: rename foo.\n\nVerdict: Approved with comments\n";
    const { result, calls } = await setup([
      { role: "planner", text: PLAN_BODY },
      { role: "critic", text: critique },
    ]);

    expect(calls.map((c) => c.role)).toEqual(["planner", "critic"]);

    // current_plan.md keeps the appendix — the next planner round (if there
    // were one) needs the critic's nits as feedback.
    const current = await readFile(join(tmp, CURRENT_PLAN_FILE), "utf8");
    expect(current).toContain(PLAN_BODY.trimEnd());
    expect(current).toContain("## Points to consider");
    expect(current).toContain("nit: rename foo");

    // final_plan.md is sanitised: no critic appendix, no critic content.
    const final = await readFile(join(tmp, FINAL_PLAN_FILE), "utf8");
    expect(final).toContain(PLAN_BODY.trimEnd());
    expect(final).not.toContain("Points to consider");
    expect(final).not.toContain("nit: rename foo");
    expect(final).not.toContain("Execution Plan review");

    expect(result.mode).toBe("Execution");
  });

  it("planner → critic-changes → planner → critic-approved: re-plans with feedback", async () => {
    const REVISED_PLAN = "# Execution Plan\n\n## Summary\nFix v2.\n";
    const critique1 = "# Critique\n## Findings\n- missing test plan.\n\nVerdict: Request changes\n";
    const { result, calls, emit } = await setup([
      { role: "planner", text: PLAN_BODY },
      { role: "critic", text: critique1 },
      { role: "planner", text: REVISED_PLAN },
      { role: "critic", text: "# Critique\n## Findings\nNone.\n\nVerdict: Approved\n" },
    ]);

    expect(calls.map((c) => c.role)).toEqual(["planner", "critic", "planner", "critic"]);
    expect(calls.map((c) => c.iteration)).toEqual([1, 2, 3, 4]);

    // The re-plan should see the prior plan and the critic's review
    expect(calls[2]?.userPrompt).toContain("## Execution Plan review");
    expect(calls[2]?.userPrompt).toContain("missing test plan");
    expect(calls[2]?.userPrompt).toContain(PLAN_BODY.trimEnd());

    const final = await readFile(join(tmp, FINAL_PLAN_FILE), "utf8");
    expect(final).toBe(REVISED_PLAN);

    expect(result.mode).toBe("Execution");
    expect(result.iterations).toBe(0);

    const warnCalls = emit.mock.calls.filter((c) => c[1] === "WARN");
    expect(warnCalls.some((c) => String(c[3]).includes("maxIterations"))).toBe(false);
  });

  it("hits maxIterations before approval: logs warning and finalises last plan", async () => {
    const REVISED = "# Execution Plan\n\n## Summary\nv2.\n";
    const { result, calls, emit } = await setup(
      [
        { role: "planner", text: PLAN_BODY },
        { role: "critic", text: "Verdict: Request changes\n" },
        { role: "planner", text: REVISED },
        { role: "critic", text: "Verdict: Request changes\n" },
      ],
      { maxIterations: 4 },
    );

    expect(calls).toHaveLength(4);

    const persisted = await readState(tmp);
    expect(persisted.mode).toBe("Execution");

    // current_plan.md retains the last critic's feedback — it is the input
    // the *next* planner round would have consumed if we had one.
    const current = await readFile(join(tmp, CURRENT_PLAN_FILE), "utf8");
    expect(current).toContain(REVISED.trimEnd());
    expect(current).toContain("## Execution Plan review");

    // final_plan.md is sanitised — appendix dropped before it ships.
    const final = await readFile(join(tmp, FINAL_PLAN_FILE), "utf8");
    expect(final).toContain(REVISED.trimEnd());
    expect(final).not.toContain("Execution Plan review");

    expect(result.iterations).toBe(0);
    expect(result.mode).toBe("Execution");

    const warnCalls = emit.mock.calls.filter((c) => c[1] === "WARN");
    expect(warnCalls.some((c) => String(c[3]).includes("hit maxIterations"))).toBe(true);
  });

  it("treats an unparseable critic response as Request changes with a warning", async () => {
    const { calls, emit } = await setup(
      [
        { role: "planner", text: PLAN_BODY },
        { role: "critic", text: "i forgot the verdict line" },
        { role: "planner", text: PLAN_BODY },
      ],
      { maxIterations: 3 },
    );

    expect(calls.map((c) => c.role)).toEqual(["planner", "critic", "planner"]);
    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("did not emit a parseable Verdict"))).toBe(true);
  });

  it("sanitisePlan: leaves a clean plan unchanged (modulo trailing whitespace)", () => {
    const emit = vi.fn();
    const out = sanitisePlan(PLAN_BODY, emit, 1);
    expect(out).toBe(PLAN_BODY.trimEnd());
    expect(emit).not.toHaveBeenCalled();
  });

  it("sanitisePlan: strips planner preamble before # Execution Plan", () => {
    const emit = vi.fn();
    const polluted =
      "I don't see an `ExitPlanMode` tool available, so I can't call it directly.\n" +
      "The plan file is written at /tmp/plan.md.\n\n" +
      PLAN_BODY;
    const out = sanitisePlan(polluted, emit, 1);
    expect(out.startsWith("# Execution Plan")).toBe(true);
    expect(out).not.toContain("ExitPlanMode");
    expect(out).not.toContain("plan file is written at");
    expect(emit).not.toHaveBeenCalled();
  });

  it("sanitisePlan: drops `## Points to consider` and everything after", () => {
    const emit = vi.fn();
    const withAppendix = `${PLAN_BODY.trimEnd()}\n\n## Points to consider\n\n# Critique\n## Findings\n- nit: rename foo.\n`;
    const out = sanitisePlan(withAppendix, emit, 1);
    expect(out).toContain("# Execution Plan");
    expect(out).not.toContain("Points to consider");
    expect(out).not.toContain("Critique");
    expect(out).not.toContain("nit: rename foo");
    expect(emit).not.toHaveBeenCalled();
  });

  it("sanitisePlan: drops `## Execution Plan review` and everything after", () => {
    const emit = vi.fn();
    const withReview = `${PLAN_BODY.trimEnd()}\n\n## Execution Plan review\n\n- needs more tests\n`;
    const out = sanitisePlan(withReview, emit, 1);
    expect(out).toContain("# Execution Plan");
    expect(out).not.toContain("Execution Plan review");
    expect(out).not.toContain("needs more tests");
  });

  it("sanitisePlan: missing # Execution Plan heading emits a WARN and passes through", () => {
    const emit = vi.fn();
    const noHeading = "## Summary\nthis plan forgot its top-level heading\n";
    const out = sanitisePlan(noHeading, emit, 99);
    expect(out).toBe(noHeading.trimEnd());
    const warnCalls = emit.mock.calls.filter((c) => c[1] === "WARN");
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[2]).toBe(99);
    expect(String(warnCalls[0]?.[3])).toContain("Execution Plan");
  });

  it("persists state after every iteration", async () => {
    const writeState = vi.fn(async (cwd: string, state: State) => realWriteState(cwd, state));

    const state = await readState(tmp);
    const getIssue = vi.fn(async () => makeIssue(42));
    const { fn } = scriptedRunner([
      { role: "planner", text: PLAN_BODY },
      { role: "critic", text: "Verdict: Approved\n" },
    ]);

    await runPlanning({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      github: { getIssue },
      runSubagent: fn,
      writeState,
      emit: vi.fn(),
    });

    // 1 per planner iter, 1 per critic iter (approved), and 1 final mode-transition write.
    expect(writeState.mock.calls.length).toBeGreaterThanOrEqual(3);
    const iterationsSeen = writeState.mock.calls.map((c) => c[1].iterations);
    expect(iterationsSeen).toContain(1);
    expect(iterationsSeen).toContain(2);
  });
});
