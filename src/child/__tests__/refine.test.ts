import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import type { Issue } from "../../github/index.js";
import type { SubagentResult } from "../../claude/index.js";
import { initState, readState } from "../state.js";
import { FINAL_PLAN_FILE, parseSubTasks, runRefine, type RunSubagentFn } from "../modes/refine.js";

const FAKE_CONFIG: Config = {
  defaultEligible: false,
  alwaysFixLabel: "autofix",
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
  worktreePath: "/tmp/wt",
  prBaseBranch: "main",
  pollIntervalSeconds: 60,
  pollIntervalMs: 60_000,
  maxConcurrency: 1,
};

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: "epic: rewrite the world",
    body: "Big work item.",
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

const PLAN_BODY = "# Execution Plan\n\n## Summary\nDo lots of things.\n";

const REFINER_OUTPUT = [
  "Splitting the plan into 2 sub-tasks.",
  "",
  "## Task 1: Add the foo module",
  "",
  "### Description",
  "",
  "Introduce a new `src/foo.ts` module with the public API the parent issue requires.",
  "",
  "### Recommended plan",
  "",
  "- create `src/foo.ts`",
  "- export `doFoo`",
  "- add unit tests in `src/__tests__/foo.test.ts`",
  "",
  "## Task 2: Wire foo into the CLI",
  "",
  "### Description",
  "",
  "Once Task 1 has landed, add a `foo` subcommand to the CLI.",
  "",
  "### Recommended plan",
  "",
  "- register the subcommand in `src/cli.ts`",
  "- update the README",
  "",
].join("\n");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-refine-"));
  await initState(tmp, "Refine", {
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

interface SubIssueResp {
  number: number;
  url: string;
}

interface RunArgs {
  responseText?: string;
  issue?: Issue;
  /** Per-call response from gh.createIssue, in order. */
  createIssueResponses?: readonly SubIssueResp[];
  createIssueImpl?: (args: { title: string; body: string; labels?: readonly string[] }) => Promise<SubIssueResp>;
}

async function run(args: RunArgs = {}) {
  const persisted = await readState(tmp);
  const issue = args.issue ?? makeIssue(persisted.issueNumber);
  const getIssue = vi.fn(async () => issue);
  const responses = args.createIssueResponses ?? [
    { number: 100, url: "https://github.com/example/repo/issues/100" },
    { number: 101, url: "https://github.com/example/repo/issues/101" },
    { number: 102, url: "https://github.com/example/repo/issues/102" },
  ];
  const queued = [...responses];
  const createIssue = vi.fn(
    args.createIssueImpl ??
      (async () => {
        const next = queued.shift();
        if (!next) throw new Error("no more createIssue responses queued");
        return next;
      }),
  );
  const comment = vi.fn(async () => undefined);
  const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult(args.responseText ?? REFINER_OUTPUT));
  const emit = vi.fn();
  const result = await runRefine({
    config: FAKE_CONFIG,
    cwd: tmp,
    state: persisted,
    github: { getIssue, createIssue, comment },
    runSubagent,
    emit,
  });
  return { result, emit, getIssue, createIssue, comment, runSubagent };
}

describe("parseSubTasks", () => {
  it("parses the canonical structure into title/description/recommended plan", () => {
    const tasks = parseSubTasks(REFINER_OUTPUT);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.title).toBe("Add the foo module");
    expect(tasks[0]?.description).toContain("Introduce a new `src/foo.ts`");
    expect(tasks[0]?.recommendedPlan).toContain("create `src/foo.ts`");
    expect(tasks[1]?.title).toBe("Wire foo into the CLI");
    expect(tasks[1]?.recommendedPlan).toContain("register the subcommand");
  });

  it("ignores preamble before the first Task heading", () => {
    const tasks = parseSubTasks(`Some intro paragraph.\n\n${REFINER_OUTPUT}`);
    expect(tasks).toHaveLength(2);
  });

  it("is case-insensitive on the Task keyword and the subsection headings", () => {
    const text = [
      "## task 1: lowercase header",
      "",
      "### DESCRIPTION",
      "",
      "uppercase subsection",
      "",
      "### Recommended Plan",
      "",
      "mixed-case",
    ].join("\n");
    const tasks = parseSubTasks(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("lowercase header");
    expect(tasks[0]?.description).toBe("uppercase subsection");
    expect(tasks[0]?.recommendedPlan).toBe("mixed-case");
  });

  it("returns empty when no Task headings are present", () => {
    expect(parseSubTasks("nothing here\n\n## other heading")).toEqual([]);
  });

  it("missing subsections come through as empty strings", () => {
    const text = "## Task 1: Bare task\n\nSome text but no subsections.\n";
    const tasks = parseSubTasks(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.description).toBe("");
    expect(tasks[0]?.recommendedPlan).toBe("");
  });
});

describe("runRefine", () => {
  it("creates one issue per sub-task with the subtask label, then comments parent with checklist", async () => {
    const { result, createIssue, comment, runSubagent } = await run();

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent.mock.calls[0]?.[0].role).toBe("refiner");

    expect(createIssue).toHaveBeenCalledTimes(2);
    const firstArgs = createIssue.mock.calls[0]?.[0];
    expect(firstArgs?.title).toBe("Add the foo module");
    expect(firstArgs?.body).toContain("Refined from parent issue #42");
    expect(firstArgs?.body).toContain("## Description");
    expect(firstArgs?.body).toContain("Introduce a new `src/foo.ts`");
    expect(firstArgs?.body).toContain("## Recommended plan");
    expect(firstArgs?.body).toContain("create `src/foo.ts`");
    // Parent has both `autofix` (alwaysFixLabel) and the implicit subtask label.
    expect(firstArgs?.labels).toEqual(expect.arrayContaining(["subtask", "autofix"]));

    const secondArgs = createIssue.mock.calls[1]?.[0];
    expect(secondArgs?.title).toBe("Wire foo into the CLI");
    expect(secondArgs?.labels).toEqual(expect.arrayContaining(["subtask", "autofix"]));

    expect(comment).toHaveBeenCalledTimes(1);
    const commentArgs = comment.mock.calls[0];
    expect(commentArgs?.[0]).toBe(42);
    const commentBody = String(commentArgs?.[1]);
    expect(commentBody).toContain("Refined into the following sub-tasks:");
    expect(commentBody).toContain("- [ ] #100 — Add the foo module");
    expect(commentBody).toContain("- [ ] #101 — Wire foo into the CLI");

    expect(result.mode).toBe("Delegated");
    expect(result.status).toBe("Complete");
    const persisted = await readState(tmp);
    expect(persisted.mode).toBe("Delegated");
    expect(persisted.status).toBe("Complete");
  });

  it("does NOT propagate the alwaysFixLabel when the parent does not carry it", async () => {
    const issue = makeIssue(42, { labels: [{ name: "bug" }] });
    const { createIssue } = await run({ issue });

    for (const call of createIssue.mock.calls) {
      const labels = (call[0] as { labels?: readonly string[] }).labels ?? [];
      expect(labels).toContain("subtask");
      expect(labels).not.toContain("autofix");
    }
  });

  it("throws when refiner produces no parseable sub-tasks", async () => {
    const persisted = await readState(tmp);
    const createIssue = vi.fn();
    const comment = vi.fn();
    const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult("I forgot the format"));
    await expect(
      runRefine({
        config: FAKE_CONFIG,
        cwd: tmp,
        state: persisted,
        github: { getIssue: vi.fn(async () => makeIssue(42)), createIssue, comment },
        runSubagent,
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/no parseable sub-tasks/);
    expect(createIssue).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it("missing final_plan.md throws a helpful error before invoking the subagent", async () => {
    await rm(join(tmp, FINAL_PLAN_FILE));
    const persisted = await readState(tmp);
    const runSubagent = vi.fn<RunSubagentFn>();
    await expect(
      runRefine({
        config: FAKE_CONFIG,
        cwd: tmp,
        state: persisted,
        github: {
          getIssue: vi.fn(async () => makeIssue(42)),
          createIssue: vi.fn(),
          comment: vi.fn(),
        },
        runSubagent,
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/final_plan\.md not found/);
    expect(runSubagent).not.toHaveBeenCalled();
  });
});
