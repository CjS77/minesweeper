import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import type * as ghModule from "../../github/index.js";
import type { Issue } from "../../github/index.js";
import { pollOnce, runPollLoop, type PollerDeps } from "../poller.js";

const config = loadConfig({});

function makeIssue(number: number, labels: readonly string[] = []): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: "body",
    labels: labels.map((name) => ({ name })),
    author: { login: "alice" },
    state: "OPEN",
    url: `https://github.com/example/repo/issues/${number}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeDeps(
  overrides: Partial<PollerDeps> = {},
): PollerDeps & { listIssuesMock: ReturnType<typeof vi.fn>; emitMock: ReturnType<typeof vi.fn> } {
  const listIssuesMock = vi.fn(async () => [] as Issue[]);
  const addLabelMock = vi.fn(async () => undefined);
  const commentMock = vi.fn(async () => undefined);
  const emitMock = vi.fn();
  return {
    config,
    cwd: "/tmp/repo",
    github: {
      listIssues: listIssuesMock as unknown as typeof ghModule.listIssues,
      addLabel: addLabelMock as unknown as typeof ghModule.addLabel,
      comment: commentMock as unknown as typeof ghModule.comment,
    },
    emit: emitMock,
    listIssuesMock,
    emitMock,
    ...overrides,
  };
}

describe("pollOnce", () => {
  it("returns only issues that pass the eligibility filter", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([
      makeIssue(1, ["autofix"]),
      makeIssue(2, ["bug"]),
      makeIssue(3, ["autofix", "p1"]),
    ]);
    const eligible = await pollOnce(deps);
    expect(eligible.map((i) => i.number)).toEqual([1, 3]);
  });

  it("calls listIssues with state=open and forwards cwd", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([]);
    await pollOnce(deps);
    expect(deps.listIssuesMock).toHaveBeenCalledWith({ cwd: "/tmp/repo", state: "open" });
  });

  it("uses a custom isEligible predicate when provided", async () => {
    const deps = makeDeps({ isEligible: (issue) => issue.number % 2 === 0 });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)]);
    const eligible = await pollOnce(deps);
    expect(eligible.map((i) => i.number)).toEqual([2, 4]);
  });

  it("supports an async custom isEligible predicate", async () => {
    const deps = makeDeps({ isEligible: async (issue) => issue.number > 1 });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1), makeIssue(2), makeIssue(3)]);
    const eligible = await pollOnce(deps);
    expect(eligible.map((i) => i.number)).toEqual([2, 3]);
  });

  it("invokes the injected screener for default-eligible unlabelled issues", async () => {
    const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" });
    const deps = makeDeps({
      config: permissive,
      screenIssue: vi.fn(async (issue) => ({
        verdict: "safe" as const,
        reason: "fine",
        issueUpdatedAt: issue.updatedAt,
        screenedAt: "2026-05-08T12:00:00.000Z",
      })),
    });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1), makeIssue(2, [permissive.alwaysFixLabel])]);
    const eligible = await pollOnce(deps);
    expect(eligible.map((i) => i.number).sort()).toEqual([1, 2]);
    // Only the unlabelled issue went through the screener; the alwaysFix one
    // short-circuited.
    expect((deps.screenIssue as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.screenIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].number).toBe(1);
  });

  it("the screener can flag an issue as dangerous and the poller drops it", async () => {
    const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" });
    const deps = makeDeps({
      config: permissive,
      screenIssue: vi.fn(async (issue) => ({
        verdict: "dangerous" as const,
        reason: "obvious injection",
        issueUpdatedAt: issue.updatedAt,
        screenedAt: "2026-05-08T12:00:00.000Z",
      })),
    });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(7)]);
    const eligible = await pollOnce(deps);
    expect(eligible).toEqual([]);
    const addLabel = deps.github!.addLabel as unknown as ReturnType<typeof vi.fn>;
    const comment = deps.github!.comment as unknown as ReturnType<typeof vi.fn>;
    expect(addLabel).toHaveBeenCalledWith(7, permissive.possiblyDangerousLabel, { cwd: "/tmp/repo" });
    expect(comment).toHaveBeenCalledTimes(1);
  });
});

describe("runPollLoop", () => {
  /**
   * Flush microtasks so an in-flight `tick()` can settle. We use real
   * timers for these tests because vitest's fake timers go infinite under
   * a `setInterval` that re-schedules itself, so we keep intervals short
   * and rely on `setImmediate`/sleep to step the loop deterministically.
   */
  const flushMicrotasks = async (): Promise<void> => {
    await new Promise<void>((resolveFn) => setImmediate(resolveFn));
    await new Promise<void>((resolveFn) => setImmediate(resolveFn));
  };
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolveFn) => setTimeout(resolveFn, ms));

  it("polls immediately on startup and emits onIssue per eligible result", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"]), makeIssue(2, ["bug"])]);
    const onIssue = vi.fn();
    const handle = runPollLoop(deps, [3_600_000], { onIssue });
    await flushMicrotasks();
    expect(onIssue).toHaveBeenCalledTimes(1);
    expect((onIssue.mock.calls[0]?.[0] as Issue).number).toBe(1);
    handle.stop();
  });

  it("polls again after each interval", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValue([makeIssue(1, ["autofix"])]);
    const onIssue = vi.fn();
    const handle = runPollLoop(deps, [25], { onIssue });
    await sleep(80);
    handle.stop();
    expect(onIssue.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("logs the eligible count via emit", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"]), makeIssue(2, ["autofix"])]);
    const handle = runPollLoop(deps, [3_600_000], { onIssue: vi.fn() });
    await flushMicrotasks();
    expect(deps.emitMock).toHaveBeenCalledWith("daemon", "INFO", null, "polled (2 eligible)");
    handle.stop();
  });

  it("calls onTickEnd once per tick after all onIssue callbacks have settled", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"]), makeIssue(2, ["autofix"])]);
    const order: string[] = [];
    const onIssue = vi.fn(async (issue: Issue) => {
      order.push(`issue:${issue.number}`);
    });
    const onTickEnd = vi.fn(async () => {
      order.push("tick-end");
    });
    const handle = runPollLoop(deps, [3_600_000], { onIssue, onTickEnd });
    await flushMicrotasks();
    handle.stop();
    expect(onTickEnd).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["issue:1", "issue:2", "tick-end"]);
  });

  it("logs an ERROR but does not throw when listIssues rejects", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockRejectedValueOnce(new Error("gh down"));
    const handle = runPollLoop(deps, [3_600_000], { onIssue: vi.fn() });
    await flushMicrotasks();
    expect(deps.emitMock).toHaveBeenCalledWith("daemon", "ERROR", null, "poll failed: gh down");
    handle.stop();
  });

  it("stop() clears all timers so no more ticks fire", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValue([]);
    const onIssue = vi.fn();
    const handle = runPollLoop(deps, [25], { onIssue });
    await flushMicrotasks();
    handle.stop();
    deps.listIssuesMock.mockClear();
    await sleep(80);
    expect(deps.listIssuesMock).not.toHaveBeenCalled();
  });
});
