import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { handleChild } from "../handler.js";
import { initState, readState, writeState, type State, type Status } from "../state.js";

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
  maxReviewRounds: 2,
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
  sources: {},
};

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-handler-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("handleChild", () => {
  it("loops Planning → Execution end-to-end inside one invocation", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 42,
      branchName: "minesweeper-issue0042",
      maxIterations: 5,
    });

    const callOrder: string[] = [];
    const runPlanning = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("planning");
      return writeState(deps.cwd, {
        ...deps.state,
        mode: "Execution",
        status: "Writing",
        iterations: 0,
        maxIterations: 2,
      });
    });
    const runExecution = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("execution");
      return writeState(deps.cwd, { ...deps.state, status: "Complete" });
    });

    const result = await handleChild({
      issueNumber: 42,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      runExecution,
      emit: vi.fn(),
    });

    expect(runPlanning).toHaveBeenCalledTimes(1);
    expect(runExecution).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["planning", "execution"]);
    expect(result.mode).toBe("Execution");
    expect(result.status).toBe("Complete");
    const persisted = await readState(tmp);
    expect(persisted.mode).toBe("Execution");
    expect(persisted.status).toBe("Complete");
  });

  it("throws when a mode handler returns without advancing state", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 42,
      branchName: "minesweeper-issue0042",
      maxIterations: 5,
    });

    const runPlanning = vi.fn(
      async (deps: { state: State; cwd: string }): Promise<State> => writeState(deps.cwd, deps.state),
    );

    await expect(
      handleChild({
        issueNumber: 42,
        cwd: tmp,
        loadConfig: () => FAKE_CONFIG,
        runPlanning,
        runExecution: vi.fn(),
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/returned without advancing state/);
    expect(runPlanning).toHaveBeenCalledTimes(1);
  });

  it("throws when state.json's issueNumber doesn't match the CLI argument", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 99,
      branchName: "minesweeper-issue0099",
      maxIterations: 2,
    });

    await expect(
      handleChild({
        issueNumber: 42,
        cwd: tmp,
        loadConfig: () => FAKE_CONFIG,
        runPlanning: vi.fn(),
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/issue #99 but child invoked with issue #42/);
  });

  it("throws when state.json's kind doesn't match the CLI argument", async () => {
    await initState(tmp, "Planning", {
      kind: "codeScanningAlert",
      issueNumber: 5,
      branchName: "minesweeper-codeScanningAlert0005",
      maxIterations: 2,
    });

    await expect(
      handleChild({
        issueNumber: 5,
        kind: "issue",
        cwd: tmp,
        loadConfig: () => FAKE_CONFIG,
        runPlanning: vi.fn(),
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/codeScanningAlert #5 but child invoked with issue #5/);
  });

  it("dispatches Execution mode to runExecution and returns its result", async () => {
    await initState(tmp, "Execution", {
      issueNumber: 7,
      branchName: "minesweeper-issue0007",
      maxIterations: 3,
    });

    const runExecution = vi.fn(
      async (deps: { state: State; cwd: string }): Promise<State> =>
        writeState(deps.cwd, { ...deps.state, status: "Complete" }),
    );

    const result = await handleChild({
      issueNumber: 7,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning: vi.fn(),
      runExecution,
      emit: vi.fn(),
    });

    expect(runExecution).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("Complete");
    const persisted = await readState(tmp);
    expect(persisted.status).toBe("Complete");
  });

  it("loops Planning → Assess → Execution end-to-end (Execute verdict)", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 7,
      branchName: "minesweeper-issue0007",
      maxIterations: 5,
    });

    const callOrder: string[] = [];
    const runPlanning = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("planning");
      return writeState(deps.cwd, {
        ...deps.state,
        mode: "Assess",
        status: "InProgress",
        iterations: 0,
        maxIterations: 1,
      });
    });
    const runAssess = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("assess");
      return writeState(deps.cwd, {
        ...deps.state,
        mode: "Execution",
        status: "Writing",
        iterations: 0,
        maxIterations: 2,
        assessment: "Execute",
      });
    });
    const runExecution = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("execution");
      return writeState(deps.cwd, { ...deps.state, status: "Complete" });
    });
    const runRefine = vi.fn();

    const result = await handleChild({
      issueNumber: 7,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      runAssess,
      runExecution,
      runRefine,
      emit: vi.fn(),
    });

    expect(callOrder).toEqual(["planning", "assess", "execution"]);
    expect(runRefine).not.toHaveBeenCalled();
    expect(result.mode).toBe("Execution");
    expect(result.status).toBe("Complete");
    expect(result.assessment).toBe("Execute");
  });

  it("loops Planning → Assess → Refine end-to-end (Refine verdict)", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 8,
      branchName: "minesweeper-issue0008",
      maxIterations: 5,
    });

    const callOrder: string[] = [];
    const runPlanning = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("planning");
      return writeState(deps.cwd, {
        ...deps.state,
        mode: "Assess",
        status: "InProgress",
        iterations: 0,
        maxIterations: 1,
      });
    });
    const runAssess = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("assess");
      return writeState(deps.cwd, {
        ...deps.state,
        mode: "Refine",
        status: "InProgress",
        iterations: 0,
        maxIterations: 1,
        assessment: "Refine",
      });
    });
    const runRefine = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      callOrder.push("refine");
      return writeState(deps.cwd, { ...deps.state, mode: "Delegated", status: "Complete" });
    });
    const runExecution = vi.fn();

    const result = await handleChild({
      issueNumber: 8,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      runAssess,
      runExecution,
      runRefine,
      emit: vi.fn(),
    });

    expect(callOrder).toEqual(["planning", "assess", "refine"]);
    expect(runExecution).not.toHaveBeenCalled();
    expect(result.mode).toBe("Delegated");
    expect(result.status).toBe("Complete");
    expect(result.assessment).toBe("Refine");
  });

  it("dispatches AddressingPRFeedback to runAddressingPrFeedback (DispatchDeps wiring)", async () => {
    await initState(tmp, "AddressingPRFeedback", {
      issueNumber: 13,
      branchName: "minesweeper-issue0013",
      maxIterations: 2,
    });

    const runAddressingPrFeedback = vi.fn(
      async (deps: { state: State; cwd: string }): Promise<State> =>
        writeState(deps.cwd, { ...deps.state, status: "Complete" }),
    );
    const runPlanning = vi.fn();
    const runExecution = vi.fn();

    const result = await handleChild({
      issueNumber: 13,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      runExecution,
      runAddressingPrFeedback,
      emit: vi.fn(),
    });

    expect(runAddressingPrFeedback).toHaveBeenCalledTimes(1);
    expect(runPlanning).not.toHaveBeenCalled();
    expect(runExecution).not.toHaveBeenCalled();
    expect(result.mode).toBe("AddressingPRFeedback");
    expect(result.status).toBe("Complete");
  });

  it("pauses the child on an API rate-limit error during a mode run", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 42,
      branchName: "minesweeper-issue0042",
      maxIterations: 5,
    });

    const apiLimitErr = Object.assign(new Error("overloaded"), { status: 529 });
    const runPlanning = vi.fn(async (): Promise<State> => {
      throw apiLimitErr;
    });

    const result = await handleChild({
      issueNumber: 42,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      emit: vi.fn(),
    });

    expect(result.status).toBe("Paused");
    expect(result.pausedFromStatus).toBe("InProgress");
    const persisted = await readState(tmp);
    expect(persisted.status).toBe("Paused");
    expect(persisted.pausedFromStatus).toBe("InProgress");
  });

  it("re-throws non-API errors unchanged", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 42,
      branchName: "minesweeper-issue0042",
      maxIterations: 5,
    });

    const compileErr = new Error("tsc failed: cannot find module");
    const runPlanning = vi.fn(async (): Promise<State> => {
      throw compileErr;
    });

    await expect(
      handleChild({
        issueNumber: 42,
        cwd: tmp,
        loadConfig: () => FAKE_CONFIG,
        runPlanning,
        emit: vi.fn(),
      }),
    ).rejects.toThrow("tsc failed: cannot find module");
  });

  it("un-pauses a Paused worktree on resume and runs the mode with the captured sub-step", async () => {
    await initState(tmp, "Execution", {
      issueNumber: 7,
      branchName: "minesweeper-issue0007",
      maxIterations: 3,
    });

    // Simulate a paused state mid-execution at "Reviewing"
    const initial = await readState(tmp);
    await writeState(tmp, {
      ...initial,
      status: "Paused",
      pausedFromStatus: "Reviewing" as Status,
      canResumeAt: null,
    });

    let receivedStatus: string | undefined;
    const runExecution = vi.fn(async (deps: { state: State; cwd: string }): Promise<State> => {
      receivedStatus = deps.state.status;
      return writeState(deps.cwd, { ...deps.state, status: "Complete" });
    });

    const result = await handleChild({
      issueNumber: 7,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning: vi.fn(),
      runExecution,
      emit: vi.fn(),
    });

    expect(runExecution).toHaveBeenCalledTimes(1);
    expect(receivedStatus).toBe("Reviewing");
    expect(result.status).toBe("Complete");
  });

  it("records canResumeAt from an error that carries a reset timestamp", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 42,
      branchName: "minesweeper-issue0042",
      maxIterations: 5,
    });

    const resetAt = "2026-06-01T12:00:00.000Z";
    const apiLimitErr = Object.assign(new Error(`rate limit hit; retry after ${resetAt}`), { status: 429 });
    const runPlanning = vi.fn(async (): Promise<State> => {
      throw apiLimitErr;
    });

    const result = await handleChild({
      issueNumber: 42,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      emit: vi.fn(),
    });

    expect(result.status).toBe("Paused");
    expect(result.canResumeAt).toBe(resetAt);
  });

  it("returns immediately when state is already terminal (Delegated/Complete)", async () => {
    await initState(tmp, "Delegated", {
      issueNumber: 11,
      branchName: "minesweeper-issue0011",
      maxIterations: 2,
    });

    const runPlanning = vi.fn();
    const runExecution = vi.fn();

    const result = await handleChild({
      issueNumber: 11,
      cwd: tmp,
      loadConfig: () => FAKE_CONFIG,
      runPlanning,
      runExecution,
      emit: vi.fn(),
    });

    expect(runPlanning).not.toHaveBeenCalled();
    expect(runExecution).not.toHaveBeenCalled();
    expect(result.mode).toBe("Delegated");
    expect(result.status).toBe("Complete");
  });
});
