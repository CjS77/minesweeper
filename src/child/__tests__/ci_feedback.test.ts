import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { type CommitPublisher } from "../../github/commit.js";
import { initState, readState } from "../state.js";
import { CI_CHECK_FAILURES_FILE, runAddressingCIFailure } from "../modes/ci_feedback.js";
import { FINAL_PLAN_FILE, type GitOps, type RunSubagentFn } from "../modes/execution.js";
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
  eligibilityAgent: "h",
  planningAgent: "p",
  reviewAgent: "r",
  executionAgent: "e",
  issueWriterAgent: "i",
  worktreePath: "/tmp/wt",
  prBaseBranch: "main",
  pollIntervalSeconds: 60,
  pollIntervalMs: 60_000,
  schedule: [],
  pollCooldownSeconds: 120,
  pollCooldownMs: 120_000,
  maxConcurrency: 1,
};

function fakeResult(text: string): SubagentResult {
  return { finalText: text, events: 1, durationMs: 1, stopReason: "end_turn", transcriptPath: "/tmp/x.jsonl" };
}

interface StubGit extends GitOps {
  advanceHead(sha: string): void;
  readonly invocations: Array<{ method: string; args: readonly unknown[] }>;
}

function makeStubGit(initialHead: string): StubGit {
  let head = initialHead;
  const invocations: Array<{ method: string; args: readonly unknown[] }> = [];
  const recorder =
    <Args extends readonly unknown[], R>(method: string, impl: (...args: Args) => R) =>
    (...args: Args): R => {
      invocations.push({ method, args });
      return impl(...args);
    };
  return {
    headSha: recorder("headSha", async (_cwd: string) => head),
    commitsAhead: recorder("commitsAhead", async () => 0),
    mergeBase: recorder("mergeBase", async () => "BASE"),
    diff: recorder("diff", async () => ""),
    diffStat: recorder("diffStat", async () => ""),
    log: recorder("log", async () => ""),
    resetSoft: recorder("resetSoft", async () => undefined),
    commit: recorder("commit", async () => undefined),
    pushBranch: recorder("pushBranch", async () => undefined),
    diffNameStatus: recorder("diffNameStatus", async () => "M\tsrc/util.ts\n"),
    readBlob: recorder("readBlob", async () => "aGVsbG8="),
    subjects: recorder("subjects", async () => "fix ci failure"),
    advanceHead(sha) {
      head = sha;
    },
    invocations,
  };
}

function makeFakePublisher(): CommitPublisher & { invocations: Array<{ method: string; args: readonly unknown[] }> } {
  const invocations: Array<{ method: string; args: readonly unknown[] }> = [];
  return {
    getRef: vi.fn(async (...args) => {
      invocations.push({ method: "getRef", args });
      return "REMOTE_HEAD";
    }),
    createBranchRef: vi.fn(async (...args) => {
      invocations.push({ method: "createBranchRef", args });
    }),
    createCommitOnBranch: vi.fn(async (...args) => {
      invocations.push({ method: "createCommitOnBranch", args });
      return "OID";
    }),
    createPullRequest: vi.fn(async (...args) => {
      invocations.push({ method: "createPullRequest", args });
      return { number: 1, url: "https://github.com/example/repo/pull/1" };
    }),
    invocations,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-ci-feedback-"));
  await initState(tmp, "AddressingCIFailure", {
    issueNumber: 99,
    branchName: "minesweeper-issue0099",
    maxIterations: 3,
  });
  await mkdir(join(tmp, ".minesweeper"), { recursive: true });
  await writeFile(join(tmp, FINAL_PLAN_FILE), "# Final plan\n\nDo the thing.\n", "utf8");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("runAddressingCIFailure", () => {
  it("runs the executor, pushes the branch, and ends in Complete", async () => {
    await writeFile(join(tmp, CI_CHECK_FAILURES_FILE), "## CI failure\n\nTest timed out.\n", "utf8");

    const git = makeStubGit("BEFORE");
    const promptSeen: string[] = [];
    const runSubagent: RunSubagentFn = vi.fn(async (opts) => {
      promptSeen.push(opts.userPrompt);
      git.advanceHead("AFTER");
      return fakeResult("done");
    });
    const emit = vi.fn();

    const state = await readState(tmp);
    const result = await runAddressingCIFailure({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      runSubagent,
      git,
      emit,
    });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(promptSeen[0]).toContain("# CI Failures");
    expect(promptSeen[0]).toContain("Test timed out.");

    expect(git.invocations.some((i) => i.method === "pushBranch")).toBe(true);
    expect(result.mode).toBe("AddressingCIFailure");
    expect(result.status).toBe("Complete");
  });

  it("logs a WARN and skips pushing when HEAD did not move", async () => {
    await writeFile(join(tmp, CI_CHECK_FAILURES_FILE), "## CI failure\n\nBuild error.\n", "utf8");

    const git = makeStubGit("STILL_HERE");
    const runSubagent: RunSubagentFn = vi.fn(async () => fakeResult("no edits"));
    const emit = vi.fn();

    const state = await readState(tmp);
    const result = await runAddressingCIFailure({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      runSubagent,
      git,
      emit,
    });

    expect(git.invocations.some((i) => i.method === "pushBranch")).toBe(false);
    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("without producing a new commit"))).toBe(true);
    expect(result.status).toBe("Complete");
  });

  it("throws if ci_check_failures.md is missing", async () => {
    // Only final_plan.md exists; ci_check_failures.md is intentionally absent.
    const git = makeStubGit("X");
    const runSubagent: RunSubagentFn = vi.fn(async () => fakeResult(""));

    const state = await readState(tmp);
    await expect(
      runAddressingCIFailure({
        config: FAKE_CONFIG,
        cwd: tmp,
        state,
        runSubagent,
        git,
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/ci_check_failures\.md not found/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it("throws if final_plan.md is missing", async () => {
    // Remove final_plan.md (written in beforeEach) and add ci_check_failures.md.
    const { unlink } = await import("node:fs/promises");
    await unlink(join(tmp, FINAL_PLAN_FILE));
    await writeFile(join(tmp, CI_CHECK_FAILURES_FILE), "## CI failure\n\nFailed.\n", "utf8");

    const git = makeStubGit("X");
    const runSubagent: RunSubagentFn = vi.fn(async () => fakeResult(""));

    const state = await readState(tmp);
    await expect(
      runAddressingCIFailure({
        config: FAKE_CONFIG,
        cwd: tmp,
        state,
        runSubagent,
        git,
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/final_plan\.md not found/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it("app mode: uses publishIncrementalCommit (getRef + createCommitOnBranch), not pushBranch", async () => {
    await writeFile(join(tmp, CI_CHECK_FAILURES_FILE), "## CI failure\n\nLint error.\n", "utf8");

    const git = makeStubGit("BEFORE");
    const runSubagent: RunSubagentFn = vi.fn(async () => {
      git.advanceHead("AFTER");
      return fakeResult("done");
    });
    const publisher = makeFakePublisher();

    const state = await readState(tmp);
    const result = await runAddressingCIFailure({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      runSubagent,
      git,
      commitPublisher: publisher,
      emit: vi.fn(),
    });

    // API publish, not git push
    expect(git.invocations.some((i) => i.method === "pushBranch")).toBe(false);
    expect(publisher.invocations.some((i) => i.method === "getRef")).toBe(true);
    expect(publisher.invocations.some((i) => i.method === "createCommitOnBranch")).toBe(true);

    const commitCall = vi.mocked(publisher.createCommitOnBranch).mock.calls[0]?.[0];
    expect(commitCall?.branchName).toBe("minesweeper-issue0099");
    expect(commitCall?.expectedHeadOid).toBe("REMOTE_HEAD");
    expect(commitCall?.headline).toBe("Fix CI failures");

    expect(result.status).toBe("Complete");
  });

  it("app mode: no-op (HEAD unchanged) skips both publishIncrementalCommit and pushBranch", async () => {
    await writeFile(join(tmp, CI_CHECK_FAILURES_FILE), "## CI failure\n\nBuild broken.\n", "utf8");

    const git = makeStubGit("STILL_HERE");
    const runSubagent: RunSubagentFn = vi.fn(async () => fakeResult("no edits"));
    const publisher = makeFakePublisher();

    const state = await readState(tmp);
    await runAddressingCIFailure({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      runSubagent,
      git,
      commitPublisher: publisher,
      emit: vi.fn(),
    });

    expect(git.invocations.some((i) => i.method === "pushBranch")).toBe(false);
    expect(publisher.invocations).toHaveLength(0);
  });

  it("ambient mode (no publisher): still calls pushBranch on HEAD move", async () => {
    await writeFile(join(tmp, CI_CHECK_FAILURES_FILE), "## CI failure\n\nTypecheck failed.\n", "utf8");

    const git = makeStubGit("BEFORE");
    const runSubagent: RunSubagentFn = vi.fn(async () => {
      git.advanceHead("AFTER");
      return fakeResult("done");
    });

    const state = await readState(tmp);
    await runAddressingCIFailure({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      runSubagent,
      git,
      // no commitPublisher → ambient mode
      emit: vi.fn(),
    });

    expect(git.invocations.some((i) => i.method === "pushBranch")).toBe(true);
  });
});
