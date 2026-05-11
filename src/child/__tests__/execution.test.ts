import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import type { Issue } from "../../github/index.js";
import { initState, readState, type State } from "../state.js";
import {
  FINAL_PLAN_FILE,
  REVIEW_COMMENTS_FILE,
  parseReviewerVerdict,
  runExecution,
  type GitOps,
  type RunSubagentFn,
} from "../modes/execution.js";
import type { SubagentResult } from "../../claude/index.js";

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
    title: `feat: add greet function`,
    body: "Add a greet(name: string) helper to src/util.ts.",
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

type ScriptedRole = "executor" | "reviewer" | "prwriter";

interface ScriptedCall {
  role: ScriptedRole;
  iteration: number;
  userPrompt: string;
}

interface ExecutorScript {
  role: "executor";
  text: string;
  /** When set, the simulated executor produces a new HEAD sha. */
  newHeadSha?: string;
}

interface ReviewerScript {
  role: "reviewer";
  text: string;
}

interface PrWriterScript {
  role: "prwriter";
  text: string;
}

type Script = ExecutorScript | ReviewerScript | PrWriterScript;

const DEFAULT_PRWRITER_RESPONSE: PrWriterScript = {
  role: "prwriter",
  text:
    "Adds a `greet(name)` helper to keep formatting consistent across callers.\n\n" +
    "## Changes\n- src/util.ts: new exported function\n\n" +
    "## Test plan\n- ran the project test suite locally\n",
};

function scriptedRunner(responses: readonly Script[], git: StubGit): { fn: RunSubagentFn; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const queue: Script[] = [...responses];
  const fn: RunSubagentFn = async (opts) => {
    const next = queue.shift();
    if (!next) {
      throw new Error(`scriptedRunner: no scripted response for call to ${opts.role}`);
    }
    if (next.role !== opts.role) {
      throw new Error(`scriptedRunner: expected ${next.role}, got ${opts.role} (iteration=${opts.iteration ?? "?"})`);
    }
    calls.push({
      role: opts.role as ScriptedRole,
      iteration: opts.iteration ?? -1,
      userPrompt: opts.userPrompt,
    });
    if (next.role === "executor" && next.newHeadSha) {
      git.advanceHead(next.newHeadSha);
    }
    return fakeResult(next.text);
  };
  return { fn, calls };
}

interface StubGit extends GitOps {
  /** Test helper: rotate HEAD as if a commit was made. */
  advanceHead(sha: string): void;
  /** Snapshot of all stub method calls (for assertions). */
  readonly invocations: Array<{ method: string; args: readonly unknown[] }>;
  /** SHA of HEAD as of the most recent state. */
  readonly currentHead: () => string;
}

function makeStubGit(initial: { headSha: string; mergeBaseSha: string }): StubGit {
  let head = initial.headSha;
  const invocations: Array<{ method: string; args: readonly unknown[] }> = [];
  // commitsAhead is computed against the merge-base sha — anything beyond
  // it counts as one commit, mirroring `git rev-list --count base..HEAD`.
  const mergeBaseSha = initial.mergeBaseSha;

  const recorder =
    <Args extends readonly unknown[], R>(method: string, impl: (...args: Args) => R) =>
    (...args: Args): R => {
      invocations.push({ method, args });
      return impl(...args);
    };

  const stub: StubGit = {
    headSha: recorder("headSha", async (_cwd: string) => head),
    commitsAhead: recorder("commitsAhead", async (_cwd: string, _base: string) => (head === mergeBaseSha ? 0 : 1)),
    mergeBase: recorder("mergeBase", async (_cwd: string, _base: string) => mergeBaseSha),
    diff: recorder("diff", async (_cwd: string, _base: string) =>
      head === mergeBaseSha ? "" : `--- a/file\n+++ b/file\n@@\n+new\n`,
    ),
    diffStat: recorder("diffStat", async (_cwd: string, _base: string) =>
      head === mergeBaseSha ? "" : ` file | 1 +\n 1 file changed, 1 insertion(+)\n`,
    ),
    log: recorder("log", async (_cwd: string, _base: string) =>
      head === mergeBaseSha ? "" : `${head.slice(0, 7)} executor commit\n`,
    ),
    resetSoft: recorder("resetSoft", async (_cwd: string, _ref: string) => undefined),
    commit: recorder("commit", async (_cwd: string, _msg: string) => undefined),
    pushBranch: recorder("pushBranch", async (_cwd: string, _branch: string) => undefined),
    advanceHead(sha: string) {
      head = sha;
    },
    invocations,
    currentHead: () => head,
  };
  return stub;
}

const PLAN_BODY = "# Execution Plan\n\n## Summary\nAdd greet(name).\n\n## Files to change\n- src/util.ts\n";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-execution-"));
  await initState(tmp, "Execution", {
    issueNumber: 42,
    branchName: "minesweeper-issue0042",
    maxIterations: 3,
  });
  // Seed the approved plan that planning mode would have written.
  await mkdir(join(tmp, ".minesweeper"), { recursive: true });
  await writeFile(join(tmp, FINAL_PLAN_FILE), PLAN_BODY, "utf8");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface RunArgs {
  responses: readonly Script[];
  state?: Partial<Pick<State, "iterations" | "maxIterations" | "status">>;
  prCreate?: ReturnType<typeof vi.fn>;
}

async function run(args: RunArgs): Promise<{
  result: Awaited<ReturnType<typeof runExecution>>;
  calls: ScriptedCall[];
  emit: ReturnType<typeof vi.fn>;
  git: StubGit;
  getIssue: ReturnType<typeof vi.fn>;
  createPr: ReturnType<typeof vi.fn>;
  runCheckHook: ReturnType<typeof vi.fn>;
}> {
  const persisted = await readState(tmp);
  const state: State = { ...persisted, ...args.state };
  const issue = makeIssue(state.issueNumber);
  const getIssue = vi.fn(async () => issue);
  const createPr =
    args.prCreate ??
    vi.fn(async () => ({
      number: 101,
      url: "https://github.com/example/repo/pull/101",
    }));
  const git = makeStubGit({ headSha: "BASE_SHA", mergeBaseSha: "BASE_SHA" });
  const { fn: runSubagent, calls } = scriptedRunner(args.responses, git);
  const emit = vi.fn();
  const runCheckHook = vi.fn(async () => undefined);
  const result = await runExecution({
    config: FAKE_CONFIG,
    cwd: tmp,
    state,
    github: { getIssue, createPr },
    runSubagent,
    git,
    runCheckHook,
    emit,
  });
  return { result, calls, emit, git, getIssue, createPr, runCheckHook };
}

describe("parseReviewerVerdict", () => {
  it("returns Approved for the bare token", () => {
    expect(parseReviewerVerdict("Verdict: Approved")).toBe("Approved");
  });

  it("prefers 'with minor concerns' over plain Approved", () => {
    expect(parseReviewerVerdict("Verdict: Approved with minor concerns")).toBe("Approved with minor concerns");
  });

  it("recognises Changes requested case-insensitively", () => {
    expect(parseReviewerVerdict("\nverdict :  CHANGES REQUESTED  \n")).toBe("Changes requested");
  });

  it("uses the last matching line when multiple are present", () => {
    const text = "Verdict: Changes requested\n\nupdated:\nVerdict: Approved\n";
    expect(parseReviewerVerdict(text)).toBe("Approved");
  });

  it("returns null when no line matches", () => {
    expect(parseReviewerVerdict("looks fine to me")).toBeNull();
  });
});

describe("runExecution — clean approval first round", () => {
  it("runs executor once, reviewer once, then squashes, pushes, opens a PR, and records the PR number", async () => {
    const { result, calls, git, createPr, runCheckHook, emit } = await run({
      responses: [
        { role: "executor", text: "# Execution summary\n\ndone\n", newHeadSha: "AFTER_SHA" },
        { role: "reviewer", text: "# Review\n## Findings\nNone.\n\nVerdict: Approved\n" },
        DEFAULT_PRWRITER_RESPONSE,
      ],
    });

    expect(result.prNumber).toBe(101);

    expect(calls.map((c) => c.role)).toEqual(["executor", "reviewer", "prwriter"]);
    expect(calls[0]?.iteration).toBe(1);
    expect(calls[1]?.iteration).toBe(1);
    expect(calls[1]?.userPrompt).toContain("# Approved plan");
    expect(calls[1]?.userPrompt).toContain(PLAN_BODY.trimEnd());

    // The prwriter received the issue, plan, executor summary, log, and diff stat.
    const prwriterPrompt = calls[2]?.userPrompt ?? "";
    expect(prwriterPrompt).toContain("# Approved plan");
    expect(prwriterPrompt).toContain(PLAN_BODY.trimEnd());
    expect(prwriterPrompt).toContain("# Executor summary");
    expect(prwriterPrompt).toContain("# Execution summary\n\ndone");
    expect(prwriterPrompt).toContain("# Diff stat");
    expect(prwriterPrompt).toContain("1 file changed");

    // Best-effort hook ran exactly once and before squashing.
    expect(runCheckHook).toHaveBeenCalledTimes(1);

    // Squash: resetSoft to merge-base, then a single commit, then push.
    const methods = git.invocations.map((i) => i.method);
    const squashIdx = methods.indexOf("resetSoft");
    const commitIdx = methods.indexOf("commit");
    const pushIdx = methods.indexOf("pushBranch");
    expect(squashIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(squashIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);

    // PR creation got the right base/head; the body comes from the prwriter,
    // is normalised to end with `Fixes #42`, and contains no planning artifacts.
    expect(createPr).toHaveBeenCalledTimes(1);
    const prArgs = createPr.mock.calls[0]?.[0] as Record<string, string>;
    expect(prArgs?.base).toBe("main");
    expect(prArgs?.head).toBe("minesweeper-issue0042");
    expect(prArgs?.title).toBe("feat: add greet function");
    expect(prArgs?.body).toContain("greet(name)");
    expect(prArgs?.body).toContain("## Changes");
    expect(prArgs?.body).toContain("## Test plan");
    expect(prArgs?.body.trimEnd().endsWith("Fixes #42")).toBe(true);
    expect(prArgs?.body).not.toContain("Approved plan");
    expect(prArgs?.body).not.toContain("Critique");

    // State ends in Complete with iterations unchanged (no fix rounds).
    expect(result.status).toBe("Complete");
    expect(result.iterations).toBe(0);

    const review = await readFile(join(tmp, REVIEW_COMMENTS_FILE), "utf8");
    expect(review).toContain("Verdict: Approved");

    // No WARN about missing approval.
    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("without approval"))).toBe(false);
  });

  it("treats 'Approved with minor concerns' as approval", async () => {
    const { result, calls } = await run({
      responses: [
        { role: "executor", text: "done", newHeadSha: "AFTER_SHA" },
        {
          role: "reviewer",
          text: "# Review\n## Findings\n- nit: rename foo\n\nVerdict: Approved with minor concerns\n",
        },
        DEFAULT_PRWRITER_RESPONSE,
      ],
    });

    expect(calls.map((c) => c.role)).toEqual(["executor", "reviewer", "prwriter"]);
    expect(result.status).toBe("Complete");
  });
});

describe("runExecution — one round of changes then approval", () => {
  it("re-runs the executor with review feedback and finalises after approval", async () => {
    const { result, calls, createPr, emit } = await run({
      responses: [
        { role: "executor", text: "first attempt", newHeadSha: "AFTER1" },
        {
          role: "reviewer",
          text: "# Review\n## Findings\n- missing test\n\nVerdict: Changes requested\n",
        },
        { role: "executor", text: "fixed it: added the missing test", newHeadSha: "AFTER2" },
        { role: "reviewer", text: "# Review\n## Findings\nNone.\n\nVerdict: Approved\n" },
        DEFAULT_PRWRITER_RESPONSE,
      ],
    });

    expect(calls.map((c) => c.role)).toEqual(["executor", "reviewer", "executor", "reviewer", "prwriter"]);
    expect(calls.map((c) => c.iteration).slice(0, 4)).toEqual([1, 1, 2, 2]);

    // The second executor invocation receives the prior reviewer's comments
    // under `# Review feedback`.
    expect(calls[2]?.userPrompt).toContain("# Review feedback");
    expect(calls[2]?.userPrompt).toContain("missing test");

    // The prwriter receives the *latest* executor summary, not the first one.
    expect(calls[4]?.userPrompt).toContain("fixed it: added the missing test");
    expect(calls[4]?.userPrompt).not.toContain("first attempt");

    expect(result.status).toBe("Complete");
    // One fix round happened, so iterations = 1 just before finalise.
    expect(result.iterations).toBe(1);

    expect(createPr).toHaveBeenCalledTimes(1);

    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("without approval"))).toBe(false);
  });
});

describe("runExecution — max rounds without approval", () => {
  it("logs a WARN and proceeds to PR per spec", async () => {
    const changes = "# Review\n## Findings\n- not yet\n\nVerdict: Changes requested\n";
    const { result, calls, createPr, emit } = await run({
      state: { maxIterations: 2 },
      responses: [
        { role: "executor", text: "attempt 1", newHeadSha: "S1" },
        { role: "reviewer", text: changes },
        { role: "executor", text: "attempt 2", newHeadSha: "S2" },
        { role: "reviewer", text: changes },
        DEFAULT_PRWRITER_RESPONSE,
      ],
    });

    // 2 rounds, 4 loop calls + 1 prwriter call = 5 total.
    expect(calls).toHaveLength(5);
    expect(calls.map((c) => c.role)).toEqual(["executor", "reviewer", "executor", "reviewer", "prwriter"]);

    // Did not throw — proceeded to PR.
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("Complete");

    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("without approval"))).toBe(true);
  });
});

describe("runExecution — commit carve-out validation", () => {
  it("logs a WARN when the executor finishes without producing a commit", async () => {
    // The first executor produces no new HEAD; the reviewer requests changes
    // (sees an empty diff), the second executor does produce a commit and
    // is approved.
    const { calls, emit, createPr, result } = await run({
      responses: [
        { role: "executor", text: "no edits made" }, // no newHeadSha → HEAD unchanged
        {
          role: "reviewer",
          text: "# Review\n## Findings\n- diff empty\n\nVerdict: Changes requested\n",
        },
        { role: "executor", text: "now with a commit", newHeadSha: "REAL_SHA" },
        { role: "reviewer", text: "# Review\n## Findings\nNone.\n\nVerdict: Approved\n" },
        DEFAULT_PRWRITER_RESPONSE,
      ],
    });

    expect(calls).toHaveLength(5);

    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("without producing a new commit"))).toBe(true);

    // Once the executor finally commits, the rest of the pipeline runs.
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("Complete");
  });

  it("throws if the branch has no commits ahead of base when finalising", async () => {
    // Reviewer approves immediately even though no commit was produced — a
    // misbehaving subagent. We refuse to PR an empty change set.
    await expect(
      run({
        responses: [
          { role: "executor", text: "no edits" }, // HEAD unchanged
          { role: "reviewer", text: "Verdict: Approved\n" },
        ],
      }),
    ).rejects.toThrow(/no commits ahead/);
  });
});

describe("runExecution — resumption", () => {
  it("skips the executor when entering with status=Reviewing", async () => {
    // Simulate the prior session: the executor already produced a commit
    // (HEAD has advanced past the merge-base) before the child crashed.
    const persisted = await readState(tmp);
    const state: State = { ...persisted, status: "Reviewing", iterations: 0 };
    const issue = makeIssue(state.issueNumber);
    const getIssue = vi.fn(async () => issue);
    const createPr = vi.fn(async () => ({
      number: 101,
      url: "https://github.com/example/repo/pull/101",
    }));
    const git = makeStubGit({ headSha: "AFTER_CRASH_SHA", mergeBaseSha: "BASE_SHA" });
    const { fn: runSubagent, calls } = scriptedRunner(
      [{ role: "reviewer", text: "Verdict: Approved\n" }, DEFAULT_PRWRITER_RESPONSE],
      git,
    );

    await runExecution({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      github: { getIssue, createPr },
      runSubagent,
      git,
      runCheckHook: vi.fn(async () => undefined),
      emit: vi.fn(),
    });

    expect(calls.map((c) => c.role)).toEqual(["reviewer", "prwriter"]);
    expect(createPr).toHaveBeenCalledTimes(1);
  });

  it("treats an unparseable reviewer response as Changes requested with a warning", async () => {
    const { calls, emit } = await run({
      state: { maxIterations: 2 },
      responses: [
        { role: "executor", text: "x", newHeadSha: "S1" },
        { role: "reviewer", text: "i forgot the verdict line" },
        { role: "executor", text: "y", newHeadSha: "S2" },
        { role: "reviewer", text: "Verdict: Approved\n" },
        DEFAULT_PRWRITER_RESPONSE,
      ],
    });

    expect(calls).toHaveLength(5);
    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("did not emit a parseable Verdict"))).toBe(true);
  });
});

describe("runExecution — PR body normalisation", () => {
  it("appends `Fixes #N` if the prwriter forgot it", async () => {
    const { createPr } = await run({
      responses: [
        { role: "executor", text: "done", newHeadSha: "S1" },
        { role: "reviewer", text: "Verdict: Approved\n" },
        {
          role: "prwriter",
          text: "Adds a thing.\n\n## Changes\n- src/x.ts: thing\n\n## Test plan\n- ran tests\n",
        },
      ],
    });
    const body = (createPr.mock.calls[0]?.[0] as Record<string, string>).body;
    expect(body.trimEnd().endsWith("Fixes #42")).toBe(true);
    // The earlier content survives.
    expect(body).toContain("Adds a thing.");
    expect(body).toContain("## Changes");
  });

  it("dedupes duplicate `Fixes` lines and tolerates `Closes`/`Resolves`", async () => {
    const { createPr } = await run({
      responses: [
        { role: "executor", text: "done", newHeadSha: "S1" },
        { role: "reviewer", text: "Verdict: Approved\n" },
        {
          role: "prwriter",
          text: "Body.\n\nFixes #42.\n\n## Changes\n- x\n\nResolves #42\nFixes #42",
        },
      ],
    });
    const body = (createPr.mock.calls[0]?.[0] as Record<string, string>).body;
    const matches = body.match(/^[ \t]*(?:fixes|closes|resolves)[ \t]+#\d+/gim) ?? [];
    expect(matches).toHaveLength(1);
    expect(body.trimEnd().endsWith("Fixes #42")).toBe(true);
  });

  it("falls back to a bare `Fixes #N` if the prwriter returns empty text", async () => {
    const { createPr } = await run({
      responses: [
        { role: "executor", text: "done", newHeadSha: "S1" },
        { role: "reviewer", text: "Verdict: Approved\n" },
        { role: "prwriter", text: "   \n   \n" },
      ],
    });
    const body = (createPr.mock.calls[0]?.[0] as Record<string, string>).body;
    expect(body.trim()).toBe("Fixes #42");
  });
});
