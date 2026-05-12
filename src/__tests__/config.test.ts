import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  loadConfig,
  redactSecrets,
  SECRET_NAME_RE,
  type Config,
  type ConfigFieldSource,
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

/**
 * Materialise a per-repo config under `<repoDir>/.minesweeper/config.json`.
 * Used by the repo-config tests below, which always pass an explicit `cwd`
 * so they never accidentally read the real project's `.minesweeper/`.
 */
function writeRepoConfigFile(repoDir: string, contents: unknown): string {
  const dir = join(repoDir, ".minesweeper");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadConfig", () => {
  it("returns the documented defaults when no env vars are set", () => {
    const cfg = loadConfig({}, { configFile: null });
    expect(cfg).toMatchObject({
      defaultEligible: false,
      alertsEligible: true,
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
    // `sources` is asserted in detail in the dedicated describe block below.
    expect(cfg.sources).toBeDefined();
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

  it.each([
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
  ])("parses MINESWEEPER_ALERTS_ELIGIBLE=%s as %s", (raw, expected) => {
    expect(loadConfig({ MINESWEEPER_ALERTS_ELIGIBLE: raw }, { configFile: null }).alertsEligible).toBe(expected);
  });

  it("alertsEligible defaults to true when no env or file overrides it", () => {
    const cfg = loadConfig({}, { configFile: null, repoConfigFile: null });
    expect(cfg.alertsEligible).toBe(true);
    expect(cfg.sources["alertsEligible"]?.source).toBe("default");
  });

  it("alertsEligible repo-config overrides global file but loses to envar", () => {
    const globalPath = writeConfigFile({ alertsEligible: true });
    writeRepoConfigFile(tmp, { alertsEligible: false });
    const repoOnly = loadConfig({}, { configFile: globalPath, cwd: tmp });
    expect(repoOnly.alertsEligible).toBe(false);
    expect(repoOnly.sources["alertsEligible"]?.source).toBe("repo-config");

    const withEnv = loadConfig({ MINESWEEPER_ALERTS_ELIGIBLE: "true" }, { configFile: globalPath, cwd: tmp });
    expect(withEnv.alertsEligible).toBe(true);
    expect(withEnv.sources["alertsEligible"]?.source).toBe("envar");
  });

  it("customPromptsPath is undefined when nothing sets it", () => {
    const cfg = loadConfig({}, { configFile: null, repoConfigFile: null });
    expect(cfg.customPromptsPath).toBeUndefined();
    expect(cfg.sources["customPromptsPath"]?.source).toBe("default");
  });

  it("customPromptsPath honours MINESWEEPER_CUSTOM_PROMPTS_PATH", () => {
    const cfg = loadConfig({ MINESWEEPER_CUSTOM_PROMPTS_PATH: "/abs/prompts" }, { configFile: null });
    expect(cfg.customPromptsPath).toBe("/abs/prompts");
    expect(cfg.sources["customPromptsPath"]?.source).toBe("envar");
  });

  it("customPromptsPath can be set via the per-repo config", () => {
    writeRepoConfigFile(tmp, { customPromptsPath: "/from/repo" });
    const cfg = loadConfig({}, { configFile: null, cwd: tmp });
    expect(cfg.customPromptsPath).toBe("/from/repo");
    expect(cfg.sources["customPromptsPath"]?.source).toBe("repo-config");
  });

  it("rejects empty MINESWEEPER_CUSTOM_PROMPTS_PATH", () => {
    const err = captureError(() => loadConfig({ MINESWEEPER_CUSTOM_PROMPTS_PATH: "" }, { configFile: null }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_CUSTOM_PROMPTS_PATH");
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
    const cfg = loadConfig({}, { configFile: path, repoConfigFile: null });
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
    const cfg = loadConfig({ MINESWEEPER_CONFIG_FILE: fileA }, { configFile: fileB, repoConfigFile: null });
    expect(cfg.alwaysFixLabel).toBe("from-A");
  });

  it("opts.configFile=null skips file loading even when one exists at the path", () => {
    writeConfigFile({ alwaysFixLabel: "should-not-be-read" });
    const cfg = loadConfig({}, { configFile: null });
    expect(cfg.alwaysFixLabel).toBe("autofix");
  });
});

// Every test below pins both file layers explicitly (`cwd: tmp` plus the
// global path, or a `null` sentinel) so they never read the real project's
// `~/.minesweeper/config.json` or `<project>/.minesweeper/config.json`.
describe("repo config file layer", () => {
  it("loads values from <cwd>/.minesweeper/config.json when present", () => {
    writeRepoConfigFile(tmp, { alwaysFixLabel: "from-repo", maxPlanningIterations: 7 });
    const cfg = loadConfig({}, { configFile: null, cwd: tmp });
    expect(cfg.alwaysFixLabel).toBe("from-repo");
    expect(cfg.maxPlanningIterations).toBe(7);
    expect(cfg.sources["alwaysFixLabel"]).toEqual<ConfigFieldSource>({ source: "repo-config", secret: false });
    expect(cfg.sources["maxPlanningIterations"]).toEqual<ConfigFieldSource>({ source: "repo-config", secret: false });
  });

  it("repo config overrides the global config on a per-key basis", () => {
    const globalPath = writeConfigFile({ alwaysFixLabel: "from-global", tryFixLabel: "from-global-try" });
    writeRepoConfigFile(tmp, { alwaysFixLabel: "from-repo" });
    const cfg = loadConfig({}, { configFile: globalPath, cwd: tmp });
    // repo wins for the overlapping key, global still supplies the rest
    expect(cfg.alwaysFixLabel).toBe("from-repo");
    expect(cfg.tryFixLabel).toBe("from-global-try");
    expect(cfg.sources["alwaysFixLabel"]?.source).toBe("repo-config");
    expect(cfg.sources["tryFixLabel"]?.source).toBe("config-file");
  });

  it("env vars beat the repo config", () => {
    writeRepoConfigFile(tmp, { alwaysFixLabel: "from-repo" });
    const cfg = loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: null, cwd: tmp });
    expect(cfg.alwaysFixLabel).toBe("from-env");
    expect(cfg.sources["alwaysFixLabel"]?.source).toBe("envar");
  });

  it("treats a missing repo config file as empty (falls through to global → default)", () => {
    // No file written; tmp/.minesweeper/config.json does not exist.
    const cfg = loadConfig({}, { configFile: null, cwd: tmp });
    expect(cfg.alwaysFixLabel).toBe("autofix");
    expect(cfg.sources["alwaysFixLabel"]?.source).toBe("default");
  });

  it("rejects malformed JSON in the repo config file", () => {
    writeRepoConfigFile(tmp, "{ not json");
    const err = captureError(() => loadConfig({}, { configFile: null, cwd: tmp }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_REPO_CONFIG_FILE");
  });

  it("rejects unknown keys in the repo config file", () => {
    writeRepoConfigFile(tmp, { bogus: 1 });
    const err = captureError(() => loadConfig({}, { configFile: null, cwd: tmp }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("MINESWEEPER_REPO_CONFIG_FILE");
  });

  it("MINESWEEPER_REPO_CONFIG_FILE env beats opts.repoConfigFile", () => {
    const fileA = join(tmp, "a.json");
    writeFileSync(fileA, JSON.stringify({ alwaysFixLabel: "from-A" }));
    const fileB = join(tmp, "b.json");
    writeFileSync(fileB, JSON.stringify({ alwaysFixLabel: "from-B" }));
    const cfg = loadConfig(
      { MINESWEEPER_REPO_CONFIG_FILE: fileA },
      { configFile: null, repoConfigFile: fileB, cwd: tmp },
    );
    expect(cfg.alwaysFixLabel).toBe("from-A");
    expect(cfg.sources["alwaysFixLabel"]?.source).toBe("repo-config");
  });

  it("opts.repoConfigFile=null skips repo file loading even when one exists at <cwd>/.minesweeper/config.json", () => {
    writeRepoConfigFile(tmp, { alwaysFixLabel: "should-not-be-read" });
    const cfg = loadConfig({}, { configFile: null, repoConfigFile: null, cwd: tmp });
    expect(cfg.alwaysFixLabel).toBe("autofix");
    expect(cfg.sources["alwaysFixLabel"]?.source).toBe("default");
  });

  it("schedule from repo config replaces schedule from global config", () => {
    const globalPath = writeConfigFile({ schedule: ["*/15 * * * *"] });
    writeRepoConfigFile(tmp, { schedule: ["0 9 * * *", "0 17 * * *"] });
    const cfg = loadConfig({}, { configFile: globalPath, cwd: tmp });
    expect(cfg.schedule).toEqual(["0 9 * * *", "0 17 * * *"]);
    expect(cfg.sources["schedule"]?.source).toBe("repo-config");
  });

  it("rejects invalid cron in the repo config schedule", () => {
    writeRepoConfigFile(tmp, { schedule: ["definitely not cron"] });
    const err = captureError(() => loadConfig({}, { configFile: null, cwd: tmp }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).envVar).toBe("schedule");
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
  "alertsEligible",
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
  "customPromptsPath",
] as const;

describe("config.sources (provenance embedded in the resolved Config)", () => {
  it("has all 23 non-derived keys with source 'default' when nothing is set", () => {
    const cfg = loadConfig({}, { configFile: null, repoConfigFile: null });

    expect(Object.keys(cfg.sources).sort()).toEqual([...EXPECTED_SUMMARY_KEYS].sort());
    for (const key of EXPECTED_SUMMARY_KEYS) {
      expect(cfg.sources[key]?.source).toBe("default");
      expect(cfg.sources[key]?.secret).toBe(false);
    }
    expect(cfg.sources["pollIntervalMs"]).toBeUndefined();
    expect(cfg.sources["pollCooldownMs"]).toBeUndefined();
  });

  it("tags env-var-supplied fields as 'envar' and leaves the value at the top level", () => {
    const cfg = loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: null, repoConfigFile: null });
    expect(cfg.alwaysFixLabel).toBe("from-env");
    expect(cfg.sources["alwaysFixLabel"]).toEqual<ConfigFieldSource>({ source: "envar", secret: false });
    expect(cfg.sources["tryFixLabel"]?.source).toBe("default");
  });

  it("tags config-file-supplied fields as 'config-file'", () => {
    const path = writeConfigFile({ tryFixLabel: "from-file", maxPlanningIterations: 9 });
    const cfg = loadConfig({}, { configFile: path, repoConfigFile: null });
    expect(cfg.tryFixLabel).toBe("from-file");
    expect(cfg.maxPlanningIterations).toBe(9);
    expect(cfg.sources["tryFixLabel"]).toEqual<ConfigFieldSource>({ source: "config-file", secret: false });
    expect(cfg.sources["maxPlanningIterations"]).toEqual<ConfigFieldSource>({ source: "config-file", secret: false });
  });

  it("env beats file in the source tag when both are set", () => {
    const path = writeConfigFile({ alwaysFixLabel: "from-file" });
    const cfg = loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: path });
    expect(cfg.alwaysFixLabel).toBe("from-env");
    expect(cfg.sources["alwaysFixLabel"]?.source).toBe("envar");
  });

  it("resolves the schedule source correctly (no env-var counterpart)", () => {
    const defaulted = loadConfig({}, { configFile: null, repoConfigFile: null });
    expect(defaulted.schedule).toEqual([]);
    expect(defaulted.sources["schedule"]?.source).toBe("default");

    const path = writeConfigFile({ schedule: ["*/15 * * * *"] });
    const fromFile = loadConfig({}, { configFile: path, repoConfigFile: null });
    expect(fromFile.schedule).toEqual(["*/15 * * * *"]);
    expect(fromFile.sources["schedule"]?.source).toBe("config-file");
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

  it("flags no field as secret today — every entry has `secret: false`", () => {
    const cfg = loadConfig({}, { configFile: null });
    for (const key of EXPECTED_SUMMARY_KEYS) {
      expect(cfg.sources[key]?.secret).toBe(false);
    }
  });
});

describe("redactSecrets", () => {
  it("is a no-op when no field is flagged secret", () => {
    const cfg = loadConfig({}, { configFile: null });
    expect(redactSecrets(cfg)).toEqual(cfg);
  });

  it("replaces the top-level value of any field flagged secret and keeps the sources map intact", () => {
    const cfg = loadConfig({}, { configFile: null });
    // Synthesise a Config whose `sources` claims one field is secret. We do not
    // mutate `cfg` — `redactSecrets` is pure, so we can hand it any Config.
    const withSecret: Config = {
      ...cfg,
      sources: {
        ...cfg.sources,
        alwaysFixLabel: { source: "envar", secret: true },
      },
    };
    const redacted = redactSecrets(withSecret);
    expect(redacted.alwaysFixLabel).toBe("<redacted>");
    // unrelated field untouched
    expect(redacted.tryFixLabel).toBe(cfg.tryFixLabel);
    // sources map preserved so operators still see the source tag
    expect(redacted.sources["alwaysFixLabel"]).toEqual<ConfigFieldSource>({ source: "envar", secret: true });
    // input is not mutated
    expect(withSecret.alwaysFixLabel).toBe(cfg.alwaysFixLabel);
  });
});

describe("loadConfig + redactSecrets integration with the real logger", () => {
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

  it("emits one 'config loaded' record carrying the resolved values and the sources map", () => {
    const filePath = join(logTmp, "logs", "daemon.log");
    createLogger({ filePath, stdout, sync: true });

    const cfg = loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "from-env" }, { configFile: null, repoConfigFile: null });
    event("daemon", "INFO", null, "config loaded", { config: redactSecrets(cfg) });

    const records = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const loaded = records.filter((r) => r["msg"] === "config loaded");
    expect(loaded).toHaveLength(1);
    const [record] = loaded;
    expect(record).toMatchObject({ role: "daemon", tag: "INFO", issueNumber: null, msg: "config loaded" });
    const logged = record?.["config"] as Config;
    expect(logged.alwaysFixLabel).toBe("from-env");
    expect(logged.sources["alwaysFixLabel"]).toEqual({ source: "envar", secret: false });
    expect(Object.keys(logged.sources).sort()).toEqual([...EXPECTED_SUMMARY_KEYS].sort());
  });
});
