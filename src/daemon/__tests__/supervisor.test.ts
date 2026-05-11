import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import type * as ghModule from "../../github/index.js";
import type { CodeScanningAlert, Issue, SecretScanningAlert } from "../../github/index.js";
import type * as worktreeModule from "../../worktree.js";
import type * as stateModule from "../../child/state.js";
import { branchNameFor, createSupervisor, type ChildHandle, type SupervisorDeps } from "../supervisor.js";
import type { State, WorkItemKind } from "../../child/state.js";
import { asCodeScanningWorkItem, asIssueWorkItem, asSecretScanningWorkItem, type WorkItem } from "../../workitem.js";

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

function makeIssueWorkItem(number: number, labels: readonly string[] = ["autofix"]): WorkItem {
  return asIssueWorkItem(makeIssue(number, labels));
}

function makeCsaWorkItem(number: number, state: "open" | "fixed" = "open"): WorkItem {
  const alert: CodeScanningAlert = {
    number,
    state,
    html_url: `https://github.com/example/repo/security/code-scanning/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    rule: { id: "js/test", severity: "error" },
  };
  return asCodeScanningWorkItem(alert);
}

function makeSsaWorkItem(number: number): WorkItem {
  const alert: SecretScanningAlert = {
    number,
    state: "open",
    html_url: `https://github.com/example/repo/security/secret-scanning/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    secret_type: "generic_token",
  };
  return asSecretScanningWorkItem(alert);
}

function makeOrphanState(
  issueNumber: number,
  status: State["status"] = "InProgress",
  kind: WorkItemKind = "issue",
): State {
  const branchPrefix = kind === "issue" ? "minesweeper-issue" : `minesweeper-${kind}`;
  return {
    version: 4,
    kind,
    issueNumber,
    branchName: `${branchPrefix}${String(issueNumber).padStart(4, "0")}`,
    mode: "Planning",
    status,
    iterations: 0,
    maxIterations: 5,
    assessment: null,
    assessmentReason: null,
    prNumber: null,
    prFeedbackProcessedAt: null,
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeDeps(overrides: Partial<SupervisorDeps> = {}): {
  deps: SupervisorDeps;
  spawnChildMock: ReturnType<typeof vi.fn>;
  addLabelMock: ReturnType<typeof vi.fn>;
  getIssueMock: ReturnType<typeof vi.fn>;
  getCodeScanningAlertMock: ReturnType<typeof vi.fn>;
  getSecretScanningAlertMock: ReturnType<typeof vi.fn>;
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
  const spawnChildMock = vi.fn(
    ({ worktreePath }: { kind?: WorkItemKind; issueNumber: number; worktreePath: string }) => {
      void worktreePath;
      const child = fakeChild();
      childrenSpawned.push(child);
      return child.handle;
    },
  );

  const addLabelMock = vi.fn(async () => undefined);
  const getIssueMock = vi.fn(async () => makeIssue(0));
  const getCodeScanningAlertMock = vi.fn(async (): Promise<CodeScanningAlert> => {
    throw new Error("getCodeScanningAlert not stubbed");
  });
  const getSecretScanningAlertMock = vi.fn(async (): Promise<SecretScanningAlert> => {
    throw new Error("getSecretScanningAlert not stubbed");
  });
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
    config: loadConfig({}, { configFile: null }),
    repoRoot: "/tmp/repos/minesweeper",
    worktreesRoot: "/tmp/wt",
    archiveRoot: "/tmp/archive",
    spawnChild: spawnChildMock,
    github: {
      addLabel: addLabelMock as unknown as typeof ghModule.addLabel,
      getIssue: getIssueMock as unknown as typeof ghModule.getIssue,
      getCodeScanningAlert: getCodeScanningAlertMock as unknown as typeof ghModule.getCodeScanningAlert,
      getSecretScanningAlert: getSecretScanningAlertMock as unknown as typeof ghModule.getSecretScanningAlert,
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
    getCodeScanningAlertMock,
    getSecretScanningAlertMock,
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

  it("namespaces alert kinds with their own branch prefix", () => {
    expect(branchNameFor("/tmp/repos/minesweeper", 7, "codeScanningAlert")).toBe("minesweeper-codeScanningAlert0007");
    expect(branchNameFor("/tmp/repos/minesweeper", 7, "secretScanningAlert")).toBe(
      "minesweeper-secretScanningAlert0007",
    );
  });
});

describe("createSupervisor.dispatch", () => {
  it("creates a worktree, seeds state, and spawns the child", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);

    const accepted = await sup.dispatch(makeIssueWorkItem(7));
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
      kind: "issue",
      issueNumber: 7,
      branchName: "minesweeper-issue0007",
      maxIterations: ctx.deps.config.maxPlanningIterations,
    });
    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(1);
    expect(ctx.spawnChildMock).toHaveBeenCalledWith({
      kind: "issue",
      issueNumber: 7,
      worktreePath: "/tmp/wt/minesweeper-issue0007",
    });
    expect(sup.inFlight()).toEqual(["issue:7"]);
  });

  it("dispatches a code-scanning alert into an alert-prefixed worktree", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);

    const accepted = await sup.dispatch(makeCsaWorkItem(42));
    expect(accepted).toBe(true);
    await flush();

    expect(ctx.addWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/tmp/repos/minesweeper",
      worktreesRoot: "/tmp/wt",
      branchName: "minesweeper-codeScanningAlert0042",
    });
    expect(ctx.spawnChildMock).toHaveBeenCalledWith({
      kind: "codeScanningAlert",
      issueNumber: 42,
      worktreePath: "/tmp/wt/minesweeper-codeScanningAlert0042",
    });
    expect(sup.inFlight()).toEqual(["codeScanningAlert:42"]);
  });

  it("issue #N and alert #N are independent dispatches (no collision)", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "2" }, { configFile: null }) });
    const sup = createSupervisor(ctx.deps);

    await sup.dispatch(makeIssueWorkItem(5));
    await sup.dispatch(makeCsaWorkItem(5));
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(2);
    expect(sup.inFlight().sort()).toEqual(["codeScanningAlert:5", "issue:5"]);

    ctx.childrenSpawned[0]!.resolve(0);
    ctx.childrenSpawned[1]!.resolve(0);
    await sup.drain();
  });

  it("dispatches a secret-scanning alert into its own prefixed worktree", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);

    const accepted = await sup.dispatch(makeSsaWorkItem(13));
    expect(accepted).toBe(true);
    await flush();

    expect(ctx.addWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/tmp/repos/minesweeper",
      worktreesRoot: "/tmp/wt",
      branchName: "minesweeper-secretScanningAlert0013",
    });
    expect(sup.inFlight()).toEqual(["secretScanningAlert:13"]);
  });

  it("leaves the worktree on disk on exit code 0 (sweep handles cleanup)", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssueWorkItem(7));
    await flush();

    expect(ctx.childrenSpawned).toHaveLength(1);
    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();

    expect(ctx.archiveMock).not.toHaveBeenCalled();
    expect(ctx.removeMock).not.toHaveBeenCalled();
    expect(ctx.addLabelMock).not.toHaveBeenCalled();
    expect(sup.inFlight()).toEqual([]);
    expect(
      ctx.emitMock.mock.calls.some(
        (c) => c[0] === "daemon" && c[1] === "OK" && c[2] === 7 && String(c[3]).includes("kept until issue is closed"),
      ),
    ).toBe(true);
  });

  it("labels the issue and leaves the worktree on non-zero exit", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssueWorkItem(11));
    await flush();

    ctx.childrenSpawned[0]!.resolve(2);
    await sup.drain();

    expect(ctx.addLabelMock).toHaveBeenCalledWith(11, ctx.deps.config.failedLabel, {
      cwd: "/tmp/repos/minesweeper",
    });
    expect(ctx.archiveMock).not.toHaveBeenCalled();
    expect(ctx.removeMock).not.toHaveBeenCalled();
  });

  it("does NOT label an alert (no label support) when its child exits non-zero", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeCsaWorkItem(11));
    await flush();

    ctx.childrenSpawned[0]!.resolve(2);
    await sup.drain();

    expect(ctx.addLabelMock).not.toHaveBeenCalled();
    expect(
      ctx.emitMock.mock.calls.some(
        (c) => c[0] === "daemon" && c[1] === "WARN" && c[2] === 11 && String(c[3]).includes("cannot be labelled"),
      ),
    ).toBe(true);
  });

  it("skips dispatch when the same issue is already in-flight", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssueWorkItem(7));
    await flush();
    const accepted = await sup.dispatch(makeIssueWorkItem(7));
    expect(accepted).toBe(false);
    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when the worktree directory already exists", async () => {
    const ctx = makeDeps();
    ctx.pathExistsMock.mockResolvedValueOnce(true);
    const sup = createSupervisor(ctx.deps);
    const accepted = await sup.dispatch(makeIssueWorkItem(7));
    expect(accepted).toBe(false);
    expect(ctx.addWorktreeMock).not.toHaveBeenCalled();
    expect(ctx.spawnChildMock).not.toHaveBeenCalled();
  });

  it("enforces maxConcurrency by queueing extra work", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "1" }, { configFile: null }) });
    const sup = createSupervisor(ctx.deps);

    await sup.dispatch(makeIssueWorkItem(1));
    await sup.dispatch(makeIssueWorkItem(2));
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(1);
    expect(sup.inFlight()).toEqual(["issue:1"]);
    expect(sup.queueLength()).toBe(1);

    ctx.childrenSpawned[0]!.resolve(0);
    await flush();
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(2);
    expect(sup.inFlight()).toEqual(["issue:2"]);
    expect(sup.queueLength()).toBe(0);

    ctx.childrenSpawned[1]!.resolve(0);
    await sup.drain();
  });

  it("starts both children at once when maxConcurrency=2", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "2" }, { configFile: null }) });
    const sup = createSupervisor(ctx.deps);

    await sup.dispatch(makeIssueWorkItem(1));
    await sup.dispatch(makeIssueWorkItem(2));
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledTimes(2);
    expect(sup.inFlight().sort()).toEqual(["issue:1", "issue:2"]);

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
      kind: "issue",
      issueNumber: 42,
      worktreePath: "/tmp/wt/minesweeper-issue0042",
    });

    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();
  });

  it("resumes an alert orphan with its kind preserved", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);

    const accepted = await sup.resume({
      path: "/tmp/wt/minesweeper-codeScanningAlert0042",
      state: makeOrphanState(42, "InProgress", "codeScanningAlert"),
    });
    expect(accepted).toBe(true);
    await flush();

    expect(ctx.spawnChildMock).toHaveBeenCalledWith({
      kind: "codeScanningAlert",
      issueNumber: 42,
      worktreePath: "/tmp/wt/minesweeper-codeScanningAlert0042",
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
      kind: "issue",
    });
    expect(ctx.removeMock).toHaveBeenCalledWith("/tmp/wt/minesweeper-issue0042");
  });

  it("dispatches on kind to the matching gh.get*Alert helper", async () => {
    const ctx = makeDeps();
    ctx.listOrphansMock.mockResolvedValueOnce([
      {
        path: "/tmp/wt/minesweeper-codeScanningAlert0042",
        state: makeOrphanState(42, "Complete", "codeScanningAlert"),
      },
      {
        path: "/tmp/wt/minesweeper-secretScanningAlert0013",
        state: makeOrphanState(13, "Complete", "secretScanningAlert"),
      },
    ]);
    ctx.getCodeScanningAlertMock.mockResolvedValueOnce({
      number: 42,
      state: "fixed",
      html_url: "https://example/x",
      created_at: "2026-01-01T00:00:00Z",
      rule: { id: "r", severity: "warning" },
    });
    ctx.getSecretScanningAlertMock.mockResolvedValueOnce({
      number: 13,
      state: "resolved",
      html_url: "https://example/y",
      created_at: "2026-01-01T00:00:00Z",
      secret_type: "x",
    });

    const sup = createSupervisor(ctx.deps);
    await sup.sweepClosedIssues();

    expect(ctx.getIssueMock).not.toHaveBeenCalled();
    expect(ctx.getCodeScanningAlertMock).toHaveBeenCalledWith(42, { cwd: "/tmp/repos/minesweeper" });
    expect(ctx.getSecretScanningAlertMock).toHaveBeenCalledWith(13, { cwd: "/tmp/repos/minesweeper" });
    expect(ctx.archiveMock).toHaveBeenCalledTimes(2);
    expect(ctx.archiveMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "codeScanningAlert" }));
    expect(ctx.archiveMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "secretScanningAlert" }));
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
    await sup.dispatch(makeIssueWorkItem(7));
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
    expect(
      ctx.emitMock.mock.calls.some((c) => c[1] === "WARN" && c[2] === 42 && String(c[3]).includes("gh fetch failed")),
    ).toBe(true);
  });
});

describe("createSupervisor.pollPrFeedback", () => {
  it("delegates to the injected pollPrFeedback with the supervisor's resume hook", async () => {
    const ctx = makeDeps();
    const pollPrFeedbackMock = vi.fn(async () => undefined);
    const sup = createSupervisor({ ...ctx.deps, pollPrFeedback: pollPrFeedbackMock });
    await sup.pollPrFeedback();
    expect(pollPrFeedbackMock).toHaveBeenCalledTimes(1);
    const args = pollPrFeedbackMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.repoRoot).toBe("/tmp/repos/minesweeper");
    expect(args.worktreesRoot).toBe("/tmp/wt");
    expect(typeof args.isInFlight).toBe("function");
    expect(typeof args.resume).toBe("function");
  });

  it("propagates in-flight state to the poller's isInFlight predicate", async () => {
    const ctx = makeDeps();
    const pollPrFeedbackMock = vi.fn(async () => undefined);
    const sup = createSupervisor({ ...ctx.deps, pollPrFeedback: pollPrFeedbackMock });

    await sup.dispatch(makeIssueWorkItem(7));
    await flush();
    await sup.pollPrFeedback();

    const args = pollPrFeedbackMock.mock.calls[0]?.[0] as { isInFlight: (n: number) => boolean };
    expect(args.isInFlight(7)).toBe(true);
    expect(args.isInFlight(99)).toBe(false);

    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();
  });
});

describe("createSupervisor.drain", () => {
  it("stops accepting new work after drain begins", async () => {
    const ctx = makeDeps();
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssueWorkItem(1));
    await flush();
    ctx.childrenSpawned[0]!.resolve(0);
    await sup.drain();
    const accepted = await sup.dispatch(makeIssueWorkItem(2));
    expect(accepted).toBe(false);
  });

  it("waits for every in-flight child to exit before resolving", async () => {
    const ctx = makeDeps({ config: loadConfig({ MINESWEEPER_MAX_CONCURRENCY: "2" }, { configFile: null }) });
    const sup = createSupervisor(ctx.deps);
    await sup.dispatch(makeIssueWorkItem(1));
    await sup.dispatch(makeIssueWorkItem(2));
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
