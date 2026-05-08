import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { handleChild } from "../handler.js";
import { initState, readState, writeState, type State } from "../state.js";

const FAKE_CONFIG: Config = {
  defaultEligible: false,
  alwaysFixLabel: "autofix",
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
  worktreePath: "/tmp/wt",
  prBaseBranch: "main",
  pollIntervalSeconds: 60,
  pollIntervalMs: 60_000,
  maxConcurrency: 1,
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
      async (deps: { state: State; cwd: string }): Promise<State> =>
        writeState(deps.cwd, deps.state),
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
    ).rejects.toThrow(/issue #99 but child invoked with #42/);
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
