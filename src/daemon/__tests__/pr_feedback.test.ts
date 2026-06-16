import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import type * as ghModule from "../../github/index.js";
import type { PrReviewThread, PullRequest, ReviewCommentReaction } from "../../github/index.js";
import type * as worktreeModule from "../../worktree.js";
import { pollPrFeedback, type PrFeedbackDeps } from "../pr_feedback.js";
import {
  PR_REVIEW_COMMENT_ACKS_FILE,
  PR_REVIEW_COMMENTS_FILE,
  PrReviewCommentAcksSchema,
} from "../../child/modes/feedback.js";
import { initState, readState, writeState, type State } from "../../child/state.js";

const config = loadConfig({}, { configFile: null });

interface MakeStateOpts {
  issueNumber: number;
  prNumber: number;
  mode?: State["mode"];
  status?: State["status"];
  prFeedbackProcessedAt?: string | null;
  prReactionsProcessedAt?: string | null;
}

async function seedWorktree(root: string, opts: MakeStateOpts): Promise<string> {
  const path = join(root, `wt-${opts.issueNumber}`);
  await mkdir(path, { recursive: true });
  await initState(path, opts.mode ?? "Execution", {
    issueNumber: opts.issueNumber,
    branchName: `branch-${opts.issueNumber}`,
    maxIterations: 3,
  });
  const after = await readState(path);
  await writeState(path, {
    ...after,
    mode: opts.mode ?? "Execution",
    status: opts.status ?? "Complete",
    prNumber: opts.prNumber,
    prFeedbackProcessedAt: opts.prFeedbackProcessedAt ?? null,
    prReactionsProcessedAt: opts.prReactionsProcessedAt ?? null,
  });
  return path;
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 101,
    title: "PR",
    body: "",
    url: "https://github.com/example/repo/pull/101",
    state: "OPEN",
    author: { login: "minesweeper-bot" },
    headRefName: "branch-42",
    baseRefName: "main",
    isDraft: false,
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [],
    comments: [],
    ...overrides,
  };
}

let scratch: string;
let worktreesRoot: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "minesweeper-prfb-"));
  worktreesRoot = join(scratch, "worktrees");
  await mkdir(worktreesRoot, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<PrFeedbackDeps> = {}): {
  deps: PrFeedbackDeps;
  getPullRequest: ReturnType<typeof vi.fn>;
  getReviewThreads: ReturnType<typeof vi.fn>;
  getReviewCommentReactions: ReturnType<typeof vi.fn>;
  getRepoOwner: ReturnType<typeof vi.fn>;
  listOrphans: ReturnType<typeof vi.fn>;
  loadCodeownerLogins: ReturnType<typeof vi.fn>;
  loadExtraReviewers: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
} {
  const getPullRequest = vi.fn(async () => makePr());
  const getReviewThreads = vi.fn(async () => [] as PrReviewThread[]);
  const getReviewCommentReactions = vi.fn(async () => [] as ReviewCommentReaction[]);
  const getRepoOwner = vi.fn(async () => "repoOwner");
  const listOrphans = vi.fn(async () => [] as Array<{ path: string; state?: State }>);
  const loadCodeownerLogins = vi.fn(async () => new Set<string>());
  const loadExtraReviewers = vi.fn(async () => new Set<string>());
  const resume = vi.fn(async () => true);
  const emit = vi.fn();
  const deps: PrFeedbackDeps = {
    config,
    repoRoot: scratch,
    worktreesRoot,
    isInFlight: () => false,
    resume,
    github: {
      getPullRequest: getPullRequest as unknown as typeof ghModule.getPullRequest,
      getReviewThreads: getReviewThreads as unknown as typeof ghModule.getReviewThreads,
      getReviewCommentReactions: getReviewCommentReactions as unknown as typeof ghModule.getReviewCommentReactions,
      getRepoOwner: getRepoOwner as unknown as typeof ghModule.getRepoOwner,
    },
    worktree: {
      listOrphans: listOrphans as unknown as typeof worktreeModule.listOrphans,
    },
    loadCodeownerLogins,
    loadExtraReviewers,
    emit,
    ...overrides,
  };
  return {
    deps,
    getPullRequest,
    getReviewThreads,
    getReviewCommentReactions,
    getRepoOwner,
    listOrphans,
    loadCodeownerLogins,
    loadExtraReviewers,
    resume,
    emit,
  };
}

describe("pollPrFeedback", () => {
  it("dispatches on a fresh COMMENTED review whose body has content", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(
      makePr({
        reviewDecision: null,
        reviews: [
          {
            author: { login: "RepoOwner" },
            body: "Linewidths should be 120 characters",
            state: "COMMENTED",
            submittedAt: "2026-05-11T09:45:50Z",
          },
        ],
      }),
    );

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    const fileContent = await readFile(join(path, PR_REVIEW_COMMENTS_FILE), "utf8");
    expect(fileContent).toContain("Linewidths should be 120 characters");
  });

  it("ignores a COMMENTED review with an empty body (it is the GitHub container for inline comments)", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(
      makePr({
        reviews: [
          {
            author: { login: "RepoOwner" },
            body: "",
            state: "COMMENTED",
            submittedAt: "2026-05-11T09:45:50Z",
          },
        ],
      }),
    );

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("renders fresh CHANGES_REQUESTED reviews and dispatches via resume", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(
      makePr({
        reviews: [
          {
            author: { login: "RepoOwner" },
            body: "Add a test.",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-10T12:00:00Z",
          },
        ],
      }),
    );

    await pollPrFeedback(ctx.deps);

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    const fileContent = await readFile(join(path, PR_REVIEW_COMMENTS_FILE), "utf8");
    expect(fileContent).toContain("@RepoOwner");
    expect(fileContent).toContain("Add a test.");

    const after = await readState(path);
    expect(after.mode).toBe("AddressingPRFeedback");
    expect(after.status).toBe("InProgress");
    expect(after.iterations).toBe(0);
    expect(after.prFeedbackProcessedAt).toBe("2026-05-10T12:00:00.000Z");
  });

  it("skips when the watermark is already at or past the review timestamp", async () => {
    const path = await seedWorktree(worktreesRoot, {
      issueNumber: 42,
      prNumber: 101,
      prFeedbackProcessedAt: "2026-05-10T12:00:00.000Z",
    });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(
      makePr({
        reviews: [
          {
            author: { login: "RepoOwner" },
            body: "stale",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-10T12:00:00Z",
          },
        ],
      }),
    );

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("does nothing when reviewDecision is APPROVED and there is no fresh feedback", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(makePr({ reviewDecision: "APPROVED" }));

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("dispatches when an unresolved CODEOWNERS comment is fresh even if the PR is APPROVED", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.loadCodeownerLogins.mockResolvedValueOnce(new Set(["codeowner-alice"]));
    ctx.getPullRequest.mockResolvedValueOnce(makePr({ reviewDecision: "APPROVED" }));
    ctx.getReviewThreads.mockResolvedValueOnce([
      {
        id: "5001",
        isResolved: false,
        path: "src/foo.ts",
        line: 3,
        comments: [
          {
            id: "5001",
            author: { login: "codeowner-alice" },
            body: "Add JSDoc here.",
            createdAt: "2026-05-10T12:00:00Z",
          },
        ],
      },
    ] satisfies PrReviewThread[]);

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    // Sidecar acks file should contain the REST IDs of the dispatched inline comments.
    const acksJson = await readFile(join(path, PR_REVIEW_COMMENT_ACKS_FILE), "utf8");
    const acks = PrReviewCommentAcksSchema.parse(JSON.parse(acksJson));
    expect(acks.commentIds).toEqual([5001]);
  });

  it("writes an empty acks file when only a top-level review triggered the dispatch (no inline comments)", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(
      makePr({
        reviews: [
          {
            author: { login: "RepoOwner" },
            body: "Add a test.",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-10T12:00:00Z",
          },
        ],
      }),
    );

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    const acksJson = await readFile(join(path, PR_REVIEW_COMMENT_ACKS_FILE), "utf8");
    const acks = PrReviewCommentAcksSchema.parse(JSON.parse(acksJson));
    expect(acks.commentIds).toEqual([]);
  });

  it("ignores resolved threads and drive-by users", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockResolvedValueOnce(
      makePr({
        reviews: [
          {
            author: { login: "drive-by" },
            body: "Hmm",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-10T12:00:00Z",
          },
        ],
      }),
    );
    ctx.getReviewThreads.mockResolvedValueOnce([
      {
        isResolved: true,
        path: "x",
        line: 1,
        comments: [
          {
            author: { login: "repoOwner" },
            body: "fixed",
            createdAt: "2026-05-10T13:00:00Z",
          },
        ],
      },
    ] satisfies PrReviewThread[]);

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("logs a WARN and skips on gh.getPullRequest failures", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getPullRequest.mockRejectedValueOnce(new Error("gh down"));

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(ctx.getReviewThreads).not.toHaveBeenCalled();
    const warnings = ctx.emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("gh pr view #101 failed"))).toBe(true);
  });

  it("logs a WARN and skips on gh.getReviewThreads failures", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
    ctx.getReviewThreads.mockRejectedValueOnce(new Error("rest 500"));

    await pollPrFeedback(ctx.deps);
    expect(ctx.resume).not.toHaveBeenCalled();
    const warnings = ctx.emit.mock.calls.filter((c) => c[1] === "WARN").map((c) => String(c[3]));
    expect(warnings.some((m) => m.includes("gh api pulls/101/comments failed"))).toBe(true);
  });

  it("short-circuits when the issue is currently in-flight (no PR query)", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
    const ctx = makeDeps({ isInFlight: (n) => n === 42 });
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);

    await pollPrFeedback(ctx.deps);
    expect(ctx.getPullRequest).not.toHaveBeenCalled();
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("ignores worktrees with no prNumber recorded yet", async () => {
    const path = await seedWorktree(worktreesRoot, { issueNumber: 99, prNumber: 1 });
    const current = await readState(path);
    await writeState(path, { ...current, prNumber: null });

    const ctx = makeDeps();
    ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);

    await pollPrFeedback(ctx.deps);
    expect(ctx.getPullRequest).not.toHaveBeenCalled();
  });

  describe("+1-curated comments", () => {
    const botThread = (overrides: Partial<PrReviewThread["comments"][number]> = {}): PrReviewThread => ({
      id: "7001",
      isResolved: false,
      path: "src/foo.ts",
      line: 22,
      comments: [
        {
          id: "7001",
          author: { login: "coderabbitai[bot]" },
          body: "Avoid the unbounded loop here.",
          createdAt: "2026-05-01T00:00:00Z",
          plusOneCount: 1,
          ...overrides,
        },
      ],
    });

    it("dispatches a bot comment approved by a trusted reviewer's fresh +1", async () => {
      const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
      const ctx = makeDeps();
      ctx.loadExtraReviewers.mockResolvedValueOnce(new Set(["coderabbitai[bot]"]));
      ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
      ctx.getReviewThreads.mockResolvedValueOnce([botThread()]);
      ctx.getReviewCommentReactions.mockResolvedValueOnce([
        { content: "+1", createdAt: "2026-06-01T10:00:00Z", user: { login: "repoOwner" } },
      ] satisfies ReviewCommentReaction[]);

      await pollPrFeedback(ctx.deps);

      expect(ctx.resume).toHaveBeenCalledTimes(1);
      const fileContent = await readFile(join(path, PR_REVIEW_COMMENTS_FILE), "utf8");
      expect(fileContent).toContain("Avoid the unbounded loop here.");
      expect(fileContent).toContain("selected via 👍");
      expect(fileContent).toContain("@coderabbitai[bot]");

      const acksJson = await readFile(join(path, PR_REVIEW_COMMENT_ACKS_FILE), "utf8");
      expect(PrReviewCommentAcksSchema.parse(JSON.parse(acksJson)).commentIds).toEqual([7001]);

      // Reaction axis advances to the +1 time; the feedback axis stays put.
      const after = await readState(path);
      expect(after.prReactionsProcessedAt).toBe("2026-06-01T10:00:00.000Z");
      expect(after.prFeedbackProcessedAt).toBeNull();
    });

    it("does not dispatch when the +1 comes from a non-trusted reactor", async () => {
      const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
      const ctx = makeDeps();
      ctx.loadExtraReviewers.mockResolvedValueOnce(new Set(["coderabbitai[bot]"]));
      ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
      ctx.getReviewThreads.mockResolvedValueOnce([botThread()]);
      ctx.getReviewCommentReactions.mockResolvedValueOnce([
        { content: "+1", createdAt: "2026-06-01T10:00:00Z", user: { login: "random-passerby" } },
      ] satisfies ReviewCommentReaction[]);

      await pollPrFeedback(ctx.deps);
      expect(ctx.resume).not.toHaveBeenCalled();
    });

    it("never fetches reactions for a comment whose author is not authorised", async () => {
      const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
      const ctx = makeDeps();
      // No extra reviewers: coderabbit is not an allowed author.
      ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
      ctx.getReviewThreads.mockResolvedValueOnce([botThread()]);

      await pollPrFeedback(ctx.deps);
      expect(ctx.getReviewCommentReactions).not.toHaveBeenCalled();
      expect(ctx.resume).not.toHaveBeenCalled();
    });

    it("never fetches reactions when the +1 summary count is zero", async () => {
      const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
      const ctx = makeDeps();
      ctx.loadExtraReviewers.mockResolvedValueOnce(new Set(["coderabbitai[bot]"]));
      ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
      ctx.getReviewThreads.mockResolvedValueOnce([botThread({ plusOneCount: 0 })]);

      await pollPrFeedback(ctx.deps);
      expect(ctx.getReviewCommentReactions).not.toHaveBeenCalled();
      expect(ctx.resume).not.toHaveBeenCalled();
    });

    it("ignores a +1 that predates the reactions watermark", async () => {
      const path = await seedWorktree(worktreesRoot, {
        issueNumber: 42,
        prNumber: 101,
        prReactionsProcessedAt: "2026-06-01T10:00:00.000Z",
      });
      const ctx = makeDeps();
      ctx.loadExtraReviewers.mockResolvedValueOnce(new Set(["coderabbitai[bot]"]));
      ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
      ctx.getReviewThreads.mockResolvedValueOnce([botThread()]);
      ctx.getReviewCommentReactions.mockResolvedValueOnce([
        { content: "+1", createdAt: "2026-06-01T10:00:00Z", user: { login: "repoOwner" } },
      ] satisfies ReviewCommentReaction[]);

      await pollPrFeedback(ctx.deps);
      expect(ctx.resume).not.toHaveBeenCalled();
    });

    it("treats a trusted reviewer's own comment as actionable without a +1 (path 3 dedupe)", async () => {
      const path = await seedWorktree(worktreesRoot, { issueNumber: 42, prNumber: 101 });
      const ctx = makeDeps();
      ctx.listOrphans.mockResolvedValueOnce([{ path, state: await readState(path) }]);
      ctx.getReviewThreads.mockResolvedValueOnce([
        botThread({ author: { login: "repoOwner" }, createdAt: "2026-06-02T00:00:00Z" }),
      ]);

      await pollPrFeedback(ctx.deps);

      expect(ctx.resume).toHaveBeenCalledTimes(1);
      // Authored path keys off createdAt, so the reactions fetch is never needed.
      expect(ctx.getReviewCommentReactions).not.toHaveBeenCalled();
      const acksJson = await readFile(join(path, PR_REVIEW_COMMENT_ACKS_FILE), "utf8");
      expect(PrReviewCommentAcksSchema.parse(JSON.parse(acksJson)).commentIds).toEqual([7001]);

      const after = await readState(path);
      expect(after.prFeedbackProcessedAt).toBe("2026-06-02T00:00:00.000Z");
      expect(after.prReactionsProcessedAt).toBeNull();
    });
  });
});
