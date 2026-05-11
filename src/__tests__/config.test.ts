import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "minesweeper-config-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfigFile(contents: unknown): string {
  const path = join(tmp, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadConfig", () => {
  it("returns the documented defaults when no env vars are set", () => {
    const cfg = loadConfig({}, { configFile: null });
    expect(cfg).toEqual({
      defaultEligible: false,
      alwaysFixLabel: "autofix",
      tryFixLabel: "tryFix",
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
      schedule: [],
      pollCooldownSeconds: 120,
      pollCooldownMs: 120_000,
      maxConcurrency: 1,
    });
  });

  it("ignores irrelevant env vars", () => {
    const cfg = loadConfig({ HOME: "/root", PATH: "/usr/bin" }, { configFile: null });
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
    expect(loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: raw }, { configFile: null }).defaultEligible).toBe(expected);
  });

  it("parses integer env vars", () => {
    const cfg = loadConfig(
      {
        MINESWEEPER_MAX_PLANNING_ITERATIONS: "10",
        MINESWEEPER_MAX_REVIEW_ROUNDS: "7",
        MINESWEEPER_POLL_INTERVAL_SECONDS: "60",
        MINESWEEPER_MAX_CONCURRENCY: "4",
      },
      { configFile: null },
    );
    expect(cfg.maxPlanningIterations).toBe(10);
    expect(cfg.maxReviewRounds).toBe(7);
    expect(cfg.pollIntervalSeconds).toBe(60);
    expect(cfg.pollIntervalMs).toBe(60_000);
    expect(cfg.maxConcurrency).toBe(4);
  });

  it("overrides string env vars", () => {
    const cfg = loadConfig(
      {
        MINESWEEPER_ALWAYS_FIX_LABEL: "🔧",
        MINESWEEPER_PLANNING_AGENT: "sonnet",
        MINESWEEPER_WORKTREE_PATH: "/var/wt",
        MINESWEEPER_PR_BASE_BRANCH: "develop",
      },
      { configFile: null },
    );
    expect(cfg.alwaysFixLabel).toBe("🔧");
    expect(cfg.planningAgent).toBe("sonnet");
    expect(cfg.worktreePath).toBe("/var/wt");
    expect(cfg.prBaseBranch).toBe("develop");
  });

  it("rejects non-integer values and points at the offending var", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_MAX_PLANNING_ITERATIONS: "foo" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_MAX_PLANNING_ITERATIONS");
    expect(err.message).toMatch(/MINESWEEPER_MAX_PLANNING_ITERATIONS/);
    expect(err.message).toMatch(/integer/);
  });

  it("rejects integers below the documented minimum", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_POLL_INTERVAL_SECONDS: "10" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_POLL_INTERVAL_SECONDS");
    expect(err.message).toMatch(/>= 30/);
  });

  it("rejects fractional integers", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_MAX_REVIEW_ROUNDS: "2.5" }, { configFile: null }));
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_MAX_REVIEW_ROUNDS");
  });

  it("rejects unparseable booleans", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "maybe" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_DEFAULT_ELIGIBLE");
  });

  it("rejects empty string overrides for required strings", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_ALWAYS_FIX_LABEL");
  });

  it("overrides MINESWEEPER_TRY_FIX_LABEL from env", () => {
    const cfg = loadConfig({ MINESWEEPER_TRY_FIX_LABEL: "screen-me" }, { configFile: null });
    expect(cfg.tryFixLabel).toBe("screen-me");
  });

  it("rejects empty MINESWEEPER_TRY_FIX_LABEL", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_TRY_FIX_LABEL: "" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_TRY_FIX_LABEL");
  });

  it("loads values from a JSON config file", () => {
    const path = writeConfigFile({
      alwaysFixLabel: "auto",
      pollCooldownSeconds: 30,
      schedule: ["*/15 * * * *"],
    });
    const cfg = loadConfig({}, { configFile: path });
    expect(cfg.alwaysFixLabel).toBe("auto");
    expect(cfg.pollCooldownSeconds).toBe(30);
    expect(cfg.pollCooldownMs).toBe(30_000);
    expect(cfg.schedule).toEqual(["*/15 * * * *"]);
  });

  it("env vars beat the config file", () => {
    const path = writeConfigFile({ alwaysFixLabel: "from-file" });
    const cfg = loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: path });
    expect(cfg.alwaysFixLabel).toBe("from-env");
  });

  it("treats a missing config file as empty", () => {
    const cfg = loadConfig({}, { configFile: join(tmp, "does-not-exist.json") });
    expect(cfg.alwaysFixLabel).toBe("autofix");
  });

  it("rejects malformed JSON in the config file", () => {
    const path = writeConfigFile("{ not json");
    const err = captureError(() => loadConfig({}, { configFile: path }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_CONFIG_FILE");
  });

  it("rejects unknown keys in the config file", () => {
    const path = writeConfigFile({ bogus: 1 });
    const err = captureError(() => loadConfig({}, { configFile: path }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_CONFIG_FILE");
  });

  it("rejects derived keys in the config file", () => {
    const path = writeConfigFile({ pollIntervalMs: 60_000 });
    const err = captureError(() => loadConfig({}, { configFile: path }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_CONFIG_FILE");
  });

  it("rejects an invalid cron expression in schedule", () => {
    const path = writeConfigFile({ schedule: ["not a cron"] });
    const err = captureError(() => loadConfig({}, { configFile: path }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("schedule");
    expect(err.message).toMatch(/not a cron/);
  });

  it("parses MINESWEEPER_POLL_COOLDOWN", () => {
    const cfg = loadConfig({ MINESWEEPER_POLL_COOLDOWN: "0" }, { configFile: null });
    expect(cfg.pollCooldownSeconds).toBe(0);
    expect(cfg.pollCooldownMs).toBe(0);
  });

  it("rejects negative cooldown values", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_POLL_COOLDOWN: "-1" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_POLL_COOLDOWN");
  });

  it("MINESWEEPER_CONFIG_FILE env beats opts.configFile", () => {
    const fileA = join(tmp, "a.json");
    writeFileSync(fileA, JSON.stringify({ alwaysFixLabel: "from-A" }));
    const fileB = join(tmp, "b.json");
    writeFileSync(fileB, JSON.stringify({ alwaysFixLabel: "from-B" }));
    const cfg = loadConfig({ MINESWEEPER_CONFIG_FILE: fileA }, { configFile: fileB });
    expect(cfg.alwaysFixLabel).toBe("from-A");
  });

  it("opts.configFile=null skips file loading even when one exists at the path", () => {
    writeConfigFile({ alwaysFixLabel: "should-not-be-read" });
    const cfg = loadConfig({}, { configFile: null });
    expect(cfg.alwaysFixLabel).toBe("autofix");
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
