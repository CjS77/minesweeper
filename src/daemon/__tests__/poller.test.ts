import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import type * as ghModule from "../../github/index.js";
import type { CodeScanningAlert, Issue, SecretScanningAlert } from "../../github/index.js";
import { pollOnce, runPollLoop, type PollerDeps } from "../poller.js";
import { workItemNumber, type WorkItem } from "../../workitem.js";

const config = loadConfig({}, { configFile: null });

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

function makeCsa(number: number, state: "open" | "fixed" = "open"): CodeScanningAlert {
  return {
    number,
    state,
    html_url: `https://github.com/example/repo/security/code-scanning/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    rule: { id: "js/test-rule", severity: "warning" },
  };
}

function makeSsa(number: number, state: "open" | "resolved" = "open"): SecretScanningAlert {
  return {
    number,
    state,
    html_url: `https://github.com/example/repo/security/secret-scanning/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    secret_type: "generic_token",
  };
}

function makeDeps(overrides: Partial<PollerDeps> = {}): PollerDeps & {
  listIssuesMock: ReturnType<typeof vi.fn>;
  listCsaMock: ReturnType<typeof vi.fn>;
  listSsaMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
} {
  const listIssuesMock = vi.fn(async () => [] as Issue[]);
  const listCsaMock = vi.fn(async () => [] as CodeScanningAlert[]);
  const listSsaMock = vi.fn(async () => [] as SecretScanningAlert[]);
  const addLabelMock = vi.fn(async () => undefined);
  const commentMock = vi.fn(async () => undefined);
  const emitMock = vi.fn();
  return {
    config,
    cwd: "/tmp/repo",
    github: {
      listIssues: listIssuesMock as unknown as typeof ghModule.listIssues,
      listCodeScanningAlerts: listCsaMock as unknown as typeof ghModule.listCodeScanningAlerts,
      listSecretScanningAlerts: listSsaMock as unknown as typeof ghModule.listSecretScanningAlerts,
      addLabel: addLabelMock as unknown as typeof ghModule.addLabel,
      comment: commentMock as unknown as typeof ghModule.comment,
    },
    emit: emitMock,
    listIssuesMock,
    listCsaMock,
    listSsaMock,
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
    expect(eligible.map(workItemNumber)).toEqual([1, 3]);
    expect(eligible.every((i) => i.kind === "issue")).toBe(true);
  });

  it("calls listIssues with state=open and forwards cwd", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([]);
    await pollOnce(deps);
    expect(deps.listIssuesMock).toHaveBeenCalledWith({ cwd: "/tmp/repo", state: "open" });
  });

  it("uses a custom isEligible predicate when provided", async () => {
    const deps = makeDeps({ isEligible: (item) => workItemNumber(item) % 2 === 0 });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)]);
    const eligible = await pollOnce(deps);
    expect(eligible.map(workItemNumber)).toEqual([2, 4]);
  });

  it("supports an async custom isEligible predicate", async () => {
    const deps = makeDeps({ isEligible: async (item) => workItemNumber(item) > 1 });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1), makeIssue(2), makeIssue(3)]);
    const eligible = await pollOnce(deps);
    expect(eligible.map(workItemNumber)).toEqual([2, 3]);
  });

  it("invokes the injected screener for default-eligible unlabelled issues", async () => {
    const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" }, { configFile: null });
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
    expect(eligible.map(workItemNumber).sort()).toEqual([1, 2]);
    // Only the unlabelled issue went through the screener; the alwaysFix one
    // short-circuited.
    expect((deps.screenIssue as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.screenIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].number).toBe(1);
  });

  it("the screener can flag an issue as dangerous and the poller drops it", async () => {
    const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" }, { configFile: null });
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

  it("merges code-scanning and secret-scanning alerts as work items when alertsEligible=true", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"])]);
    deps.listCsaMock.mockResolvedValueOnce([makeCsa(11), makeCsa(12)]);
    deps.listSsaMock.mockResolvedValueOnce([makeSsa(21)]);
    const eligible = await pollOnce(deps);
    expect(eligible.map((i) => `${i.kind}:${workItemNumber(i)}`).sort()).toEqual([
      "codeScanningAlert:11",
      "codeScanningAlert:12",
      "issue:1",
      "secretScanningAlert:21",
    ]);
  });

  it("does not call alert endpoints when alertsEligible=false", async () => {
    const strict = loadConfig({ MINESWEEPER_ALERTS_ELIGIBLE: "false" }, { configFile: null });
    const deps = makeDeps({ config: strict });
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"])]);
    await pollOnce(deps);
    expect(deps.listCsaMock).not.toHaveBeenCalled();
    expect(deps.listSsaMock).not.toHaveBeenCalled();
  });

  it("a 403 from one alert endpoint does not drop the issue list (fail-soft)", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"])]);
    deps.listCsaMock.mockRejectedValueOnce(new Error("HTTP 403: Forbidden"));
    deps.listSsaMock.mockResolvedValueOnce([makeSsa(21)]);
    const eligible = await pollOnce(deps);
    expect(eligible.map((i) => `${i.kind}:${workItemNumber(i)}`).sort()).toEqual([
      "issue:1",
      "secretScanningAlert:21",
    ]);
    const warns = deps.emitMock.mock.calls.filter((c) => c[1] === "WARN");
    expect(warns.some((c) => String(c[3]).includes("code-scanning alerts fetch failed"))).toBe(true);
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

  it("polls immediately on startup and emits onWorkItem per eligible result", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"]), makeIssue(2, ["bug"])]);
    const onWorkItem = vi.fn();
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 3_600_000 }], { onWorkItem });
    await flushMicrotasks();
    expect(onWorkItem).toHaveBeenCalledTimes(1);
    expect(workItemNumber(onWorkItem.mock.calls[0]?.[0] as WorkItem)).toBe(1);
    handle.stop();
  });

  it("polls again after each interval", async () => {
    const deps = makeDeps({ cooldownMs: 0 });
    deps.listIssuesMock.mockResolvedValue([makeIssue(1, ["autofix"])]);
    const onWorkItem = vi.fn();
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 25 }], { onWorkItem });
    await sleep(80);
    handle.stop();
    expect(onWorkItem.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("logs the eligible count via emit", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"]), makeIssue(2, ["autofix"])]);
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 3_600_000 }], { onWorkItem: vi.fn() });
    await flushMicrotasks();
    expect(deps.emitMock).toHaveBeenCalledWith("daemon", "INFO", null, "polled (2 eligible)");
    handle.stop();
  });

  it("calls onTickEnd once per tick after all onWorkItem callbacks have settled", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockResolvedValueOnce([makeIssue(1, ["autofix"]), makeIssue(2, ["autofix"])]);
    const order: string[] = [];
    const onWorkItem = vi.fn(async (item: WorkItem) => {
      order.push(`issue:${workItemNumber(item)}`);
    });
    const onTickEnd = vi.fn(async () => {
      order.push("tick-end");
    });
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 3_600_000 }], { onWorkItem, onTickEnd });
    await flushMicrotasks();
    handle.stop();
    expect(onTickEnd).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["issue:1", "issue:2", "tick-end"]);
  });

  it("emits a WARN but does not throw when listIssues rejects (safeList fail-soft)", async () => {
    const deps = makeDeps();
    deps.listIssuesMock.mockRejectedValueOnce(new Error("gh down"));
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 3_600_000 }], { onWorkItem: vi.fn() });
    await flushMicrotasks();
    const warns = deps.emitMock.mock.calls.filter((c) => c[1] === "WARN");
    expect(warns.some((c) => String(c[3]).includes("issues fetch failed"))).toBe(true);
    expect(warns.some((c) => String(c[3]).includes("gh down"))).toBe(true);
    handle.stop();
  });

  it("stop() clears all timers so no more ticks fire", async () => {
    const deps = makeDeps({ cooldownMs: 0 });
    deps.listIssuesMock.mockResolvedValue([]);
    const onWorkItem = vi.fn();
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 25 }], { onWorkItem });
    await flushMicrotasks();
    handle.stop();
    deps.listIssuesMock.mockClear();
    await sleep(80);
    expect(deps.listIssuesMock).not.toHaveBeenCalled();
  });

  it("cron-only schedules do not fire an immediate tick on startup", async () => {
    const deps = makeDeps();
    // 2026-05-08T00:00:00Z; "0 0 * * *" matches once a day at midnight UTC,
    // so the next match is well into the future from this anchor.
    const anchor = new Date("2026-05-08T00:00:01Z").getTime();
    deps.now = () => anchor;
    deps.listIssuesMock.mockResolvedValue([]);
    const onWorkItem = vi.fn();
    const handle = runPollLoop(deps, [{ kind: "cron", expression: "0 0 * * *" }], { onWorkItem });
    // No immediate tick.
    await flushMicrotasks();
    expect(deps.listIssuesMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("cron schedule fires once at the computed delay", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ cooldownMs: 0 });
      const anchor = new Date("2026-05-08T00:00:00Z").getTime();
      deps.now = () => Date.now();
      vi.setSystemTime(anchor);
      deps.listIssuesMock.mockResolvedValue([]);
      const onWorkItem = vi.fn();
      // "* * * * *" matches every minute. The first match after anchor is at
      // anchor + 60_000 ms.
      const handle = runPollLoop(deps, [{ kind: "cron", expression: "* * * * *" }], { onWorkItem });
      // Just before the first match.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(deps.listIssuesMock).not.toHaveBeenCalled();
      // Cross the threshold.
      await vi.advanceTimersByTimeAsync(2);
      expect(deps.listIssuesMock).toHaveBeenCalledTimes(1);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooldown gate skips overlapping interval ticks", async () => {
    const deps = makeDeps({ cooldownMs: 60_000 });
    deps.listIssuesMock.mockResolvedValue([]);
    const onWorkItem = vi.fn();
    const handle = runPollLoop(
      deps,
      [
        { kind: "interval", intervalMs: 5 },
        { kind: "interval", intervalMs: 5 },
      ],
      { onWorkItem },
    );
    await sleep(40);
    handle.stop();
    // Immediate tick + each subsequent tick should be gated by the 60s cooldown.
    expect(deps.listIssuesMock).toHaveBeenCalledTimes(1);
    const skipMessages = deps.emitMock.mock.calls.filter(
      (call) => typeof call[3] === "string" && call[3].startsWith("skipped poll: within cooldown"),
    );
    expect(skipMessages.length).toBeGreaterThan(0);
  });

  it("cooldown=0 disables the gate and lets every timer fire", async () => {
    const deps = makeDeps({ cooldownMs: 0 });
    deps.listIssuesMock.mockResolvedValue([]);
    const onWorkItem = vi.fn();
    const handle = runPollLoop(deps, [{ kind: "interval", intervalMs: 10 }], { onWorkItem });
    await sleep(50);
    handle.stop();
    expect(deps.listIssuesMock.mock.calls.length).toBeGreaterThan(2);
  });

  it("stop() cancels pending cron timeouts", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const anchor = new Date("2026-05-08T00:00:00Z").getTime();
      deps.now = () => Date.now();
      vi.setSystemTime(anchor);
      deps.listIssuesMock.mockResolvedValue([]);
      const onWorkItem = vi.fn();
      const handle = runPollLoop(deps, [{ kind: "cron", expression: "* * * * *" }], { onWorkItem });
      handle.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(deps.listIssuesMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
