import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConfigSummary,
  ConfigError,
  loadConfig,
  SECRET_NAME_RE,
  type Config,
  type ConfigFile,
  type ConfigSummary,
} from "../config.js";
import { createLogger, event, resetLoggerForTest } from "../logging.js";

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
      issueWriterAgent: "claude-sonnet-4-6",
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

const EXPECTED_SUMMARY_KEYS = [
  "defaultEligible",
  "alwaysFixLabel",
  "tryFixLabel",
  "neverFixLabel",
  "possiblyDangerousLabel",
  "manuallyApprovedLabel",
  "failedLabel",
  "subtaskLabel",
  "maxPlanningIterations",
  "maxReviewRounds",
  "eligibilityAgent",
  "planningAgent",
  "reviewAgent",
  "executionAgent",
  "issueWriterAgent",
  "worktreePath",
  "prBaseBranch",
  "pollIntervalSeconds",
  "schedule",
  "pollCooldownSeconds",
  "maxConcurrency",
] as const;

function captureSummary(fn: (onSummary: (s: ConfigSummary) => void) => Config): {
  config: Config;
  summary: ConfigSummary;
} {
  let captured: ConfigSummary | undefined;
  const config = fn((s) => {
    captured = s;
  });
  if (captured === undefined) throw new Error("onSummary was not invoked");
  return { config, summary: captured };
}

describe("buildConfigSummary", () => {
  it("emits all 21 non-derived keys with source 'default' when nothing is set", () => {
    const { summary } = captureSummary((onSummary) => loadConfig({}, { configFile: null, onSummary }));

    expect(Object.keys(summary).sort()).toEqual([...EXPECTED_SUMMARY_KEYS].sort());
    for (const key of EXPECTED_SUMMARY_KEYS) {
      expect(summary[key]?.source).toBe("default");
    }
    expect(summary["pollIntervalMs"]).toBeUndefined();
    expect(summary["pollCooldownMs"]).toBeUndefined();
  });

  it("tags env-var-supplied fields as 'envar' with the resolved value", () => {
    const { summary } = captureSummary((onSummary) =>
      loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: null, onSummary }),
    );
    expect(summary["alwaysFixLabel"]).toEqual({ value: "from-env", source: "envar" });
    expect(summary["tryFixLabel"]?.source).toBe("default");
  });

  it("tags config-file-supplied fields as 'config-file' with the resolved value", () => {
    const path = writeConfigFile({ tryFixLabel: "from-file", maxPlanningIterations: 9 });
    const { summary } = captureSummary((onSummary) => loadConfig({}, { configFile: path, onSummary }));
    expect(summary["tryFixLabel"]).toEqual({ value: "from-file", source: "config-file" });
    expect(summary["maxPlanningIterations"]).toEqual({ value: 9, source: "config-file" });
  });

  it("env beats file in the source tag when both are set", () => {
    const path = writeConfigFile({ alwaysFixLabel: "from-file" });
    const { summary } = captureSummary((onSummary) =>
      loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: path, onSummary }),
    );
    expect(summary["alwaysFixLabel"]).toEqual({ value: "from-env", source: "envar" });
  });

  it("resolves the schedule source correctly (no env-var counterpart)", () => {
    const { summary: defaulted } = captureSummary((onSummary) => loadConfig({}, { configFile: null, onSummary }));
    expect(defaulted["schedule"]).toEqual({ value: [], source: "default" });

    const path = writeConfigFile({ schedule: ["*/15 * * * *"] });
    const { summary: fromFile } = captureSummary((onSummary) => loadConfig({}, { configFile: path, onSummary }));
    expect(fromFile["schedule"]).toEqual({ value: ["*/15 * * * *"], source: "config-file" });
  });

  it("called directly with synthesized inputs returns the documented shape", () => {
    const env = { MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" } as const;
    const file: ConfigFile = { tryFixLabel: "from-file" };
    const config: Config = {
      defaultEligible: false,
      alwaysFixLabel: "from-env",
      tryFixLabel: "from-file",
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
      issueWriterAgent: "claude-sonnet-4-6",
      worktreePath: "/tmp/minesweeper",
      prBaseBranch: "main",
      pollIntervalSeconds: 300,
      pollIntervalMs: 300_000,
      schedule: [],
      pollCooldownSeconds: 120,
      pollCooldownMs: 120_000,
      maxConcurrency: 1,
    };
    const summary = buildConfigSummary(env, file, config);
    expect(summary["alwaysFixLabel"]).toEqual({ value: "from-env", source: "envar" });
    expect(summary["tryFixLabel"]).toEqual({ value: "from-file", source: "config-file" });
    expect(summary["maxConcurrency"]).toEqual({ value: 1, source: "default" });
    expect(Object.keys(summary)).toHaveLength(EXPECTED_SUMMARY_KEYS.length);
  });

  it("redaction predicate matches secret-shaped names and rejects non-secret names", () => {
    expect(SECRET_NAME_RE.test("anthropicApiKey")).toBe(true);
    expect(SECRET_NAME_RE.test("someSecret")).toBe(true);
    expect(SECRET_NAME_RE.test("accessToken")).toBe(true);
    expect(SECRET_NAME_RE.test("API_KEY")).toBe(true);
    expect(SECRET_NAME_RE.test("alwaysFixLabel")).toBe(false);
    expect(SECRET_NAME_RE.test("pollIntervalSeconds")).toBe(false);
    expect(SECRET_NAME_RE.test("schedule")).toBe(false);
  });

  it("today's Config has no secret-named field — no redaction occurs in any summary", () => {
    const { summary } = captureSummary((onSummary) => loadConfig({}, { configFile: null, onSummary }));
    for (const key of EXPECTED_SUMMARY_KEYS) {
      expect(summary[key]?.value).not.toBe("<redacted>");
    }
  });

  it("does not invoke onSummary when loadConfig throws a ConfigError", () => {
    let calls = 0;
    const onSummary = (): void => {
      calls += 1;
    };
    expect(() => loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "maybe" }, { configFile: null, onSummary })).toThrow(
      ConfigError,
    );
    expect(calls).toBe(0);
  });

  it("invokes onSummary exactly once on a successful load", () => {
    let calls = 0;
    loadConfig(
      {},
      {
        configFile: null,
        onSummary: () => {
          calls += 1;
        },
      },
    );
    expect(calls).toBe(1);
  });
});

describe("loadConfig + onSummary integration with the real logger", () => {
  let logTmp: string;
  let stdout: PassThrough;

  beforeEach(() => {
    logTmp = mkdtempSync(join(tmpdir(), "minesweeper-config-log-"));
    stdout = new PassThrough();
    stdout.resume();
  });

  afterEach(() => {
    resetLoggerForTest();
    rmSync(logTmp, { recursive: true, force: true });
  });

  it("emits one 'config loaded' record with the 21-key summary as meta", () => {
    const filePath = join(logTmp, "logs", "daemon.log");
    createLogger({ filePath, stdout, sync: true });

    loadConfig(
      {},
      {
        configFile: null,
        onSummary: (summary) => event("daemon", "INFO", null, "config loaded", { config: summary }),
      },
    );

    const records = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const loaded = records.filter((r) => r["msg"] === "config loaded");
    expect(loaded).toHaveLength(1);
    const [record] = loaded;
    expect(record).toMatchObject({ role: "daemon", tag: "INFO", issueNumber: null, msg: "config loaded" });
    const cfg = record?.["config"] as Record<string, { value: unknown; source: string }>;
    expect(Object.keys(cfg).sort()).toEqual([...EXPECTED_SUMMARY_KEYS].sort());
    expect(cfg["alwaysFixLabel"]?.source).toBe("default");
    expect(cfg["alwaysFixLabel"]?.value).toBe("autofix");
  });
});
