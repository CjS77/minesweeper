import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import type * as ghModule from "../../github/index.js";
import type { Issue } from "../../github/index.js";
import type * as worktreeModule from "../../worktree.js";
import type * as stateModule from "../../child/state.js";
import { branchNameFor, createSupervisor, type ChildHandle, type SupervisorDeps } from "../supervisor.js";
import type { State } from "../../child/state.js";

interface FakeChild {
  handle: ChildHandle;
  resolve(code: number): void;
  reject(err: Error): void;
}

function fakeChild(): FakeChild {
  let resolveExit!: (code: number) => void;
  let rejectExit!: (err: Error) => void;
  const exit = new Promise<number>((resolveFn, rejectFn) => {
    resolveExit = resolveFn;
    rejectExit = rejectFn;
  });
  return {
    handle: { exit, kill: vi.fn() },
    resolve: (code) => resolveExit(code),
    reject: (err) => rejectExit(err),
  };
}

function makeIssue(number: number, labels: readonly string[] = ["autofix"]): Issue {
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

function makeOrphanState(issueNumber: number, status: State["status"] = "InProgress"): State {
  return {
    version: 1,
    issueNumber,
    branchName: `minesweeper-issue${String(issueNumber).padStart(4, "0")}`,
    mode: "Planning",
    status,
    iterations: 0,
    maxIterations: 5,
    assessment: null,
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeDeps(overrides: Partial<SupervisorDeps> = {}): {
  deps: SupervisorDeps;
  spawnChildMock: ReturnType<typeof vi.fn>;
  addLabelMock: ReturnType<typeof vi.fn>;
  getIssueMock: ReturnType<typeof vi.fn>;
  addWorktreeMock: ReturnType<typeof vi.fn>;
  archiveMock: ReturnType<typeof vi.fn>;
  removeMock: ReturnType<typeof vi.fn>;
  listOrphansMock: ReturnType<typeof vi.fn>;
  initStateMock: ReturnType<typeof vi.fn>;
  pathExistsMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  childrenSpawned: FakeChild[];
} {
  const childrenSpawned: FakeChild[] = [];
  const spawnChildMock = vi.fn(({ worktreePath }: { issueNumber: number; worktreePath: string }) => {
    void worktreePath;
    const child = fakeChild();
    childrenSpawned.push(child);
    return child.handle;
  });

  const addLabelMock = vi.fn(async () => undefined);
  const getIssueMock = vi.fn(async () => makeIssue(0));
  const addWorktreeMock = vi.fn(
    async ({ worktreesRoot, branchName }: { worktreesRoot: string; branchName: string }) => ({
      path: `${worktreesRoot}/${branchName}`,
      branch: branchName,
    }),
  );
  const archiveMock = vi.fn(async () => "/tmp/archive/x");
  const removeMock = vi.fn(async () => undefined);
  const listOrphansMock = vi.fn(async () => [] as Array<{ path: string; state?: State }>);
  const initStateMock = vi.fn(async () => makeOrphanState(0));
  const pathExistsMock = vi.fn(async () => false);
  const emitMock = vi.fn();

  const deps: SupervisorDeps = {
    config: loadConfig({}),
    repoRoot: "/tmp/repos/minesweeper",
    worktreesRoot: "/tmp/wt",
    archiveRoot: "/tmp/archive",
    spawnChild: spawnChildMock,
    github: {
      addLabel: addLabelMock as unknown as typeof ghModule.addLabel,
      getIssue: getIssueMock as unknown as typeof ghModule.getIssue,
    },
    worktree: {
      addWorktree: addWorktreeMock as unknown as typeof worktreeModule.addWorktree,
      archiveWorktreeState: archiveMock as unknown as typeof worktreeModule.archiveWorktreeState,
      removeWorktree: removeMock as unknown as typeof worktreeModule.removeWorktree,
      listOrphans: listOrphansMock as unknown as typeof worktreeModule.listOrphans,
    },
    initState: initStateMock as unknown as typeof stateModule.initState,
    pathExists: pathExistsMock,
    emit: emitMock,
    ...overrides,
  };

  return {
    deps,
    spawnChildMock,
    addLabelMock,
    getIssueMock,
    addWorktreeMock,
    archiveMock,
    removeMock,
    listOrphansMock,
    initStateMock,
    pathExistsMock,
    emitMock,
    childrenSpawned,
  };
}

/** Drain pending microtasks so spawn/exit listeners catch up. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("branchNameFor", () => {
  it("uses the repoRoot basename and zero-pads the issue number to 4 digits", () => {
    expect(branchNameFor("/tmp/repos/minesweeper", 1)).toBe("minesweeper-issue0001");
    expect(branchNameFor("/tmp/repos/minesweeper", 99)).toBe("minesweeper-issue0099");
    expect(branchNameFor("/tmp/repos/my-repo", 12345)).toBe("my-repo-issue12345");
  });
});

describe("createSupervisor.dispatch", () => {
  it("creates a worktree, seeds state, and spawns the child", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);

    const accepted = await sup.dispatch(makeIssue(7));
    expect(accepted).toBe(true);
    await flush();

    expect(ctx.addWorktreeMock).toHaveBeenCalledTimes(1);
    expect(ctx.addWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/tmp/repos/minesweeper",
      worktreesRoot: "/tmp/wt",
      branchName: "minesweeper-issue0007",
    });
    expect(ctx.initStateMock).toHaveBeenCalledTimes(1);
    expect(ctx.initStateMock).toHaveBeenCalledWith("/tmp/wt/minesweeper-issue0007", "Planning", {
      issueNumber: 7,
      branchName: "minesweeper-issue0007",
      maxIterations: ctx.deps.config.maxPlanningIterations,
    });
    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(1);
    expect(ctx.spawnChildMock).toHaveBeenCalledWith({
      issueNumber: 7,
      worktreePath: "/tmp/wt/minesweeper-issue0007",
    });
    expect(sup.inFlight()).toEqual([7]);
  });

  it("leaves the worktree on disk on exit code 0 (sweep handles cleanup)", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssue(7));
    await flush();

    expect(ctx.childrenSpawned).toHaveLength(1);
    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();

    expect(ctx.archiveMock).not.toHaveBeenCalled();
    expect(ctx.removeMock).not.toHaveBeenCalled();
    expect(ctx.addLabelMock).not.toHaveBeenCalled();
    expect(sup.inFlight()).toEqual([]);
    expect(ctx.emitMock).toHaveBeenCalledWith("daemon", "OK", 7, expect.stringContaining("kept until issue is closed"));
  });

  it("labels the issue and leaves the worktree on non-zero exit", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssue(11));
    await flush();

    ctx.childrenSpawned[0]!.resolve(2);
    await sup.drain();

    expect(ctx.addLabelMock).toHaveBeenCalledWith(11, ctx.deps.config.failedLabel, {
      cwd: "/tmp/repos/minesweeper",
    });
    expect(ctx.archiveMock).not.toHaveBeenCalled();
    expect(ctx.removeMock).not.toHaveBeenCalled();
  });

  it("skips dispatch when the same issue is already in-flight", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssue(7));
    await flush();
    const accepted = await sup.dispatch(makeIssue(7));
    expect(accepted).toBe(false);
    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when the worktree directory already exists", async () => {
    const ctx = makeDeps();
    ctx.pathExistsMock.mockResolvedValueOnce(true);
    const sup = createSupervisor(ctx.deps);
    const accepted = await sup.dispatch(makeIssue(7));
    expect(accepted).toBe(false);
    expect(ctx.addWorktreeMock).not.toHaveBeenCalled();
    expect(ctx.spawnChildMock).not.toHaveBeenCalled();
  });

  it("enforces maxConcurrency by queueing extra work", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "1" }) });
    const sup = createSupervisor(ctx.deps);

    await sup.dispatch(makeIssue(1));
    await sup.dispatch(makeIssue(2));
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(1);
    expect(sup.inFlight()).toEqual([1]);
    expect(sup.queueLength()).toBe(1);

    ctx.childrenSpawned[0]!.resolve(0);
    await flush();
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(2);
    expect(sup.inFlight()).toEqual([2]);
    expect(sup.queueLength()).toBe(0);

    ctx.childrenSpawned[1]!.resolve(0);
    await sup.drain();
  });

  it("starts both children at once when maxConcurrency=2", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "2" }) });
    const sup = createSupervisor(ctx.deps);

    await sup.dispatch(makeIssue(1));
    await sup.dispatch(makeIssue(2));
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(2);
    expect(sup.inFlight().sort()).toEqual([1, 2]);

    ctx.childrenSpawned[0]!.resolve(0);
    ctx.childrenSpawned[1]!.resolve(0);
    await sup.drain();
  });
});

describe("createSupervisor.resume", () => {
  it("re-spawns against the existing worktree without recreating it", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);

    const accepted = await sup.resume({
      path: "/tmp/wt/minesweeper-issue0042",
      state: makeOrphanState(42, "InProgress"),
    });
    expect(accepted).toBe(true);
    await flush();

    expect(ctx.addWorktreeMock).not.toHaveBeenCalled();
    expect(ctx.initStateMock).not.toHaveBeenCalled();
    expect(ctx.spawnChildMock).toHaveBeenCalledWith({
      issueNumber: 42,
      worktreePath: "/tmp/wt/minesweeper-issue0042",
    });

    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();
  });

  it("refuses to resume orphans whose state is Failed", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    const accepted = await sup.resume({
      path: "/tmp/wt/x",
      state: makeOrphanState(99, "Failed"),
    });
    expect(accepted).toBe(false);
    expect(ctx.spawnChildMock).not.toHaveBeenCalled();
  });

  it("refuses to resume orphans whose state is already Complete", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    const accepted = await sup.resume({
      path: "/tmp/wt/x",
      state: makeOrphanState(42, "Complete"),
    });
    expect(accepted).toBe(false);
    expect(ctx.spawnChildMock).not.toHaveBeenCalled();
  });
});

describe("createSupervisor.sweepClosedIssues", () => {
  it("archives + removes worktrees whose issue is CLOSED", async () => {
    const ctx = makeDeps();
    ctx.listOrphansMock.mockResolvedValueOnce([
      { path: "/tmp/wt/minesweeper-issue0042", state: makeOrphanState(42, "Complete") },
    ]);
    ctx.getIssueMock.mockResolvedValueOnce({ ...makeIssue(42), state: "CLOSED" });

    const sup = createSupervisor(ctx.deps);
    await sup.sweepClosedIssues();

    expect(ctx.getIssueMock).toHaveBeenCalledWith(42, { cwd: "/tmp/repos/minesweeper" });
    expect(ctx.archiveMock).toHaveBeenCalledWith({
      worktreePath: "/tmp/wt/minesweeper-issue0042",
      archiveRoot: "/tmp/archive",
      issueNumber: 42,
    });
    expect(ctx.removeMock).toHaveBeenCalledWith("/tmp/wt/minesweeper-issue0042");
  });

  it("also reaps worktrees whose state is Failed once the issue is CLOSED", async () => {
    const ctx = makeDeps();
    ctx.listOrphansMock.mockResolvedValueOnce([
      { path: "/tmp/wt/minesweeper-issue0099", state: makeOrphanState(99, "Failed") },
    ]);
    ctx.getIssueMock.mockResolvedValueOnce({ ...makeIssue(99), state: "CLOSED" });

    const sup = createSupervisor(ctx.deps);
    await sup.sweepClosedIssues();

    expect(ctx.archiveMock).toHaveBeenCalledTimes(1);
    expect(ctx.removeMock).toHaveBeenCalledWith("/tmp/wt/minesweeper-issue0099");
  });

  it("leaves worktrees alone when the issue is still OPEN", async () => {
    const ctx = makeDeps();
    ctx.listOrphansMock.mockResolvedValueOnce([
      { path: "/tmp/wt/minesweeper-issue0007", state: makeOrphanState(7, "Complete") },
    ]);
    ctx.getIssueMock.mockResolvedValueOnce({ ...makeIssue(7), state: "OPEN" });

    const sup = createSupervisor(ctx.deps);
    await sup.sweepClosedIssues();

    expect(ctx.archiveMock).not.toHaveBeenCalled();
    expect(ctx.removeMock).not.toHaveBeenCalled();
  });

  it("skips worktrees whose issue is currently in-flight", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssue(7));
    await flush();

    ctx.listOrphansMock.mockResolvedValueOnce([
      { path: "/tmp/wt/minesweeper-issue0007", state: makeOrphanState(7, "InProgress") },
    ]);

    await sup.sweepClosedIssues();

    expect(ctx.getIssueMock).not.toHaveBeenCalled();
    expect(ctx.archiveMock).not.toHaveBeenCalled();

    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();
  });

  it("logs a WARN and skips when gh.getIssue throws", async () => {
    const ctx = makeDeps();
    ctx.listOrphansMock.mockResolvedValueOnce([
      { path: "/tmp/wt/minesweeper-issue0042", state: makeOrphanState(42, "Complete") },
    ]);
    ctx.getIssueMock.mockRejectedValueOnce(new Error("gh down"));

    const sup = createSupervisor(ctx.deps);
    await sup.sweepClosedIssues();

    expect(ctx.archiveMock).not.toHaveBeenCalled();
    expect(ctx.removeMock).not.toHaveBeenCalled();
    expect(ctx.emitMock).toHaveBeenCalledWith("daemon", "WARN", 42, expect.stringContaining("gh getIssue failed"));
  });
});

describe("createSupervisor.drain", () => {
  it("stops accepting new work after drain begins", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssue(1));
    await flush();
    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();
    const accepted = await sup.dispatch(makeIssue(2));
    expect(accepted).toBe(false);
  });

  it("waits for every in-flight child to exit before resolving", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "2" }) });
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssue(1));
    await sup.dispatch(makeIssue(2));
    await flush();

    let drained = false;
    const drainPromise = sup.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    ctx.childrenSpawned[0]!.resolve(0);
    await flush();
    expect(drained).toBe(false);

    ctx.childrenSpawned[1]!.resolve(0);
    await drainPromise;
    expect(drained).toBe(true);
  });
});
