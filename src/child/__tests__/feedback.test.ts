import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { initState, readState } from "../state.js";
import { PR_REVIEW_COMMENTS_FILE, runAddressingPrFeedback } from "../modes/feedback.js";
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
    advanceHead(sha) {
      head = sha;
    },
    invocations,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-feedback-"));
  await initState(tmp, "AddressingPRFeedback", {
    issueNumber: 42,
    branchName: "minesweeper-issue0042",
    maxIterations: 3,
  });
  await mkdir(join(tmp, ".minesweeper"), { recursive: true });
  await writeFile(join(tmp, FINAL_PLAN_FILE), "# Final plan\n\nDo the thing.\n", "utf8");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("runAddressingPrFeedback", () => {
  it("runs the executor, pushes the branch, and ends in Complete", async () => {
    await writeFile(join(tmp, PR_REVIEW_COMMENTS_FILE), "## Review by @owner\n\nPlease add a test.\n", "utf8");

    const git = makeStubGit("BEFORE");
    const promptSeen: string[] = [];
    const runSubagent: RunSubagentFn = vi.fn(async (opts) => {
      promptSeen.push(opts.userPrompt);
      git.advanceHead("AFTER");
      return fakeResult("done");
    });
    const emit = vi.fn();

    const state = await readState(tmp);
    const result = await runAddressingPrFeedback({
      config: FAKE_CONFIG,
      cwd: tmp,
      state,
      runSubagent,
      git,
      emit,
    });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(promptSeen[0]).toContain("# Review Comments");
    expect(promptSeen[0]).toContain("Please add a test.");

    expect(git.invocations.some((i) => i.method === "pushBranch")).toBe(true);
    expect(result.mode).toBe("AddressingPRFeedback");
    expect(result.status).toBe("Complete");
  });

  it("logs a WARN and skips pushing when HEAD did not move", async () => {
    await writeFile(join(tmp, PR_REVIEW_COMMENTS_FILE), "## Review by @owner\n\nMissing test.\n", "utf8");

    const git = makeStubGit("STILL_HERE");
    const runSubagent: RunSubagentFn = vi.fn(async () => fakeResult("no edits"));
    const emit = vi.fn();

    const state = await readState(tmp);
    const result = await runAddressingPrFeedback({
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

  it("throws if pr_review_comments.md is missing", async () => {
    // Only final_plan.md exists; pr_review_comments.md is intentionally absent.
    const git = makeStubGit("X");
    const runSubagent: RunSubagentFn = vi.fn(async () => fakeResult(""));

    const state = await readState(tmp);
    await expect(
      runAddressingPrFeedback({
        config: FAKE_CONFIG,
        cwd: tmp,
        state,
        runSubagent,
        git,
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/pr_review_comments\.md not found/);
    expect(runSubagent).not.toHaveBeenCalled();
  });
});
