import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("returns the documented defaults when no env vars are set", () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual({
      defaultEligible: false,
      alwaysFixLabel: "autofix",
      neverFixLabel: "manual",
      possiblyDangerousLabel: "possiblyDangerous",
      manuallyApprovedLabel: "manuallyReviewed",
      failedLabel: "minesweeperFailed",
      subtaskLabel: "subtask",
      maxPlanningIterations: 5,
      maxReviewRounds: 3,
      eligibilityAgent: "claude-haiku-4-5-20251001",
      planningAgent: "claude-opus-4-7",
      reviewAgent: "claude-sonnet-4-6",
      executionAgent: "claude-opus-4-7",
      worktreePath: "/tmp/minesweeper",
      prBaseBranch: "main",
      pollIntervalSeconds: 300,
      pollIntervalMs: 300_000,
      maxConcurrency: 1,
    });
  });

  it("ignores irrelevant env vars", () => {
    const cfg = loadConfig({ HOME: "/root", PATH: "/usr/bin" });
    expect(cfg.defaultEligible).toBe(false);
    expect(cfg.alwaysFixLabel).toBe("autofix");
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["No", false],
    ["off", false],
  ])("parses MINESWEEPER_DEFAULT_ELIGIBLE=%s as %s", (raw, expected) => {
    expect(loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: raw }).defaultEligible).toBe(expected);
  });

  it("parses integer env vars", () => {
    const cfg = loadConfig({
      MINESWEEPER_MAX_PLANNING_ITERATIONS: "10",
      MINESWEEPER_MAX_REVIEW_ROUNDS: "7",
      MINESWEEPER_POLL_INTERVAL_SECONDS: "60",
      MINESWEEPER_MAX_CONCURRENCY: "4",
    });
    expect(cfg.maxPlanningIterations).toBe(10);
    expect(cfg.maxReviewRounds).toBe(7);
    expect(cfg.pollIntervalSeconds).toBe(60);
    expect(cfg.pollIntervalMs).toBe(60_000);
    expect(cfg.maxConcurrency).toBe(4);
  });

  it("overrides string env vars", () => {
    const cfg = loadConfig({
      MINESWEEPER_ALWAYS_FIX_LABEL: "🔧",
      MINESWEEPER_PLANNING_AGENT: "sonnet",
      MINESWEEPER_WORKTREE_PATH: "/var/wt",
      MINESWEEPER_PR_BASE_BRANCH: "develop",
    });
    expect(cfg.alwaysFixLabel).toBe("🔧");
    expect(cfg.planningAgent).toBe("sonnet");
    expect(cfg.worktreePath).toBe("/var/wt");
    expect(cfg.prBaseBranch).toBe("develop");
  });

  it("rejects non-integer values and points at the offending var", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_MAX_PLANNING_ITERATIONS: "foo" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_MAX_PLANNING_ITERATIONS");
    expect(err.message).toMatch(/MINESWEEPER_MAX_PLANNING_ITERATIONS/);
    expect(err.message).toMatch(/integer/);
  });

  it("rejects integers below the documented minimum", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_POLL_INTERVAL_SECONDS: "10" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_POLL_INTERVAL_SECONDS");
    expect(err.message).toMatch(/>= 30/);
  });

  it("rejects fractional integers", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_MAX_REVIEW_ROUNDS: "2.5" }));
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_MAX_REVIEW_ROUNDS");
  });

  it("rejects unparseable booleans", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "maybe" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_DEFAULT_ELIGIBLE");
  });

  it("rejects empty string overrides for required strings", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "" }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_ALWAYS_FIX_LABEL");
  });
});

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected fn to throw");
}
