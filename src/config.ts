/**
 * Environment- and file-driven configuration loader for Minesweeper.
 *
 * Configuration sources, in order of precedence (highest wins):
 *   1. Process environment variables (`MINESWEEPER_*`).
 *   2. Per-repo JSON file at `<cwd>/.minesweeper/config.json` (path
 *      overridable via `MINESWEEPER_REPO_CONFIG_FILE`).
 *   3. Global JSON file at `~/.minesweeper/config.json` (path overridable
 *      via `MINESWEEPER_CONFIG_FILE`).
 *   4. Hard-coded defaults baked into this module.
 *
 * The single exported `loadConfig()` is called once at the CLI entry and
 * threaded through DI. Library code should never call it directly.
 *
 * The resolved `Config` carries its own provenance under `config.sources`:
 * for each user-settable field there is a `{ source, secret }` entry built
 * during resolution (not reconstructed afterwards), so operators can see at
 * startup where each value came from. Use `redactSecrets()` before logging
 * if any field is flagged `secret`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import cronParser from "cron-parser";
import { z } from "zod";

/**
 * Which layer supplied a single resolved `Config` field. Order of precedence,
 * highest first: `envar` > `repo-config` > `config-file` (global) > `default`.
 */
export type ConfigSource = "envar" | "repo-config" | "config-file" | "default";

const ConfigFieldSourceSchema = z.object({
  source: z.enum(["envar", "repo-config", "config-file", "default"]),
  secret: z.boolean(),
});

/**
 * Per-field provenance entry. `secret: true` flags fields whose top-level
 * value must be redacted before logging — see `redactSecrets()`. The actual
 * resolved value lives at the top of `Config`, not here.
 */
export type ConfigFieldSource = z.infer<typeof ConfigFieldSourceSchema>;

/**
 * The `sources` field on `Config`: a map from field name to its provenance.
 * One entry per user-settable field; derived fields (`pollIntervalMs`,
 * `pollCooldownMs`) are intentionally absent.
 */
export type ConfigSources = Record<string, ConfigFieldSource>;

export const ConfigSchema = z.object({
  defaultEligible: z.boolean(),
  /**
   * Whether code-scanning and secret-scanning alerts are auto-eligible.
   * Sits at the same precedence as `alwaysFixLabel` for issues — when
   * `true`, alerts skip the screener; when `false`, alerts are hard-
   * ineligible (the daemon also stops calling the alert APIs).
   */
  alertsEligible: z.boolean(),
  alwaysFixLabel: z.string().min(1),
  tryFixLabel: z.string().min(1),
  neverFixLabel: z.string().min(1),
  possiblyDangerousLabel: z.string().min(1),
  manuallyApprovedLabel: z.string().min(1),
  failedLabel: z.string().min(1),
  subtaskLabel: z.string().min(1),
  maxPlanningIterations: z.number().int().min(1),
  maxReviewRounds: z.number().int().min(1),
  eligibilityAgent: z.string().min(1),
  planningAgent: z.string().min(1),
  reviewAgent: z.string().min(1),
  executionAgent: z.string().min(1),
  issueWriterAgent: z.string().min(1),
  worktreePath: z.string().min(1),
  prBaseBranch: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(30),
  pollIntervalMs: z.number().int().min(30_000),
  schedule: z.array(z.string().min(1)).default([]),
  pollCooldownSeconds: z.number().int().min(0),
  pollCooldownMs: z.number().int().min(0),
  maxConcurrency: z.number().int().min(1),
  sources: z.record(z.string(), ConfigFieldSourceSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Schema for `~/.minesweeper/config.json`. Derived fields (`pollIntervalMs`,
 * `pollCooldownMs`) and the loader-populated `sources` map are stripped — the
 * file may not set them. `.strict()` rejects unknown keys; `.partial()` makes
 * every key optional.
 */
export const ConfigFileSchema = ConfigSchema.omit({
  pollIntervalMs: true,
  pollCooldownMs: true,
  sources: true,
})
  .partial()
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export class ConfigError extends Error {
  readonly envVar: string;

  constructor(envVar: string, detail: string) {
    super(`Invalid value for ${envVar}: ${detail}`);
    this.name = "ConfigError";
    this.envVar = envVar;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Field-name predicate for redacting potentially sensitive values. Matches
 * any name containing "key", "secret", or "token" (case-insensitive). Today
 * no `Config` field matches this; the test suite pins both the predicate
 * and that fact so a future addition surfaces in review.
 */
export const SECRET_NAME_RE = /key|secret|token/i;
const REDACTED = "<redacted>";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Internal shape returned by the `read*` helpers — both the resolved value
 * and the layer it came from. The caller threads `source` into the `sources`
 * map being built alongside the candidate config.
 */
interface Resolved<T> {
  value: T;
  source: ConfigSource;
}

function readBool(
  env: Env,
  name: string,
  repoVal: boolean | undefined,
  fileVal: boolean | undefined,
  defaultVal: boolean,
): Resolved<boolean> {
  const raw = env[name];
  if (raw !== undefined) {
    const s = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(s)) return { value: true, source: "envar" };
    if (FALSE_VALUES.has(s)) return { value: false, source: "envar" };
    throw new ConfigError(name, `expected a boolean (true/false/1/0/yes/no), got ${JSON.stringify(raw)}`);
  }
  if (repoVal !== undefined) return { value: repoVal, source: "repo-config" };
  if (fileVal !== undefined) return { value: fileVal, source: "config-file" };
  return { value: defaultVal, source: "default" };
}

function readInt(
  env: Env,
  name: string,
  min: number,
  repoVal: number | undefined,
  fileVal: number | undefined,
  defaultVal: number,
): Resolved<number> {
  const raw = env[name];
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "") throw new ConfigError(name, "expected an integer, got an empty string");
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new ConfigError(name, `expected an integer, got ${JSON.stringify(raw)}`);
    }
    if (n < min) throw new ConfigError(name, `must be >= ${min}, got ${n}`);
    return { value: n, source: "envar" };
  }
  if (repoVal !== undefined) return { value: repoVal, source: "repo-config" };
  if (fileVal !== undefined) return { value: fileVal, source: "config-file" };
  return { value: defaultVal, source: "default" };
}

function readString(
  env: Env,
  name: string,
  repoVal: string | undefined,
  fileVal: string | undefined,
  defaultVal: string,
): Resolved<string> {
  const raw = env[name];
  if (raw !== undefined) {
    if (raw.length === 0) throw new ConfigError(name, "expected a non-empty string");
    return { value: raw, source: "envar" };
  }
  if (repoVal !== undefined) return { value: repoVal, source: "repo-config" };
  if (fileVal !== undefined) return { value: fileVal, source: "config-file" };
  return { value: defaultVal, source: "default" };
}

/**
 * `schedule` is file-only — there is no `MINESWEEPER_SCHEDULE` env var — so
 * it has its own resolver rather than overloading `readString`.
 */
function readSchedule(
  repoVal: readonly string[] | undefined,
  fileVal: readonly string[] | undefined,
): Resolved<string[]> {
  if (repoVal !== undefined) return { value: [...repoVal], source: "repo-config" };
  if (fileVal !== undefined) return { value: [...fileVal], source: "config-file" };
  return { value: [], source: "default" };
}

/**
 * Validate a single cron expression, throwing a `ConfigError` keyed on the
 * `schedule` field if it does not parse. Pure check — no side effects.
 */
export function validateCron(expression: string): void {
  try {
    cronParser.parseExpression(expression);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError("schedule", `invalid cron expression ${JSON.stringify(expression)}: ${detail}`);
  }
}

/**
 * Read and validate a JSON config file at `resolvedPath`. Missing files are
 * not an error (returns `{}`); JSON / schema / cron failures throw a
 * `ConfigError` keyed on `envVarName` so the operator sees which layer is
 * misconfigured. Shared by the global and per-repo loaders below.
 */
function loadAndValidate(resolvedPath: string, envVarName: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(envVarName, `failed to read ${resolvedPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(envVarName, `failed to parse ${resolvedPath} as JSON: ${(err as Error).message}`);
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(envVarName, `invalid config in ${resolvedPath}: ${result.error.message}`);
  }

  for (const expression of result.data.schedule ?? []) {
    validateCron(expression);
  }

  return result.data;
}

/**
 * Read and validate the global `~/.minesweeper/config.json` (or the explicit
 * path).
 *
 * - `path === null`: skip file loading entirely (test sentinel).
 * - `path === undefined`: use the default path under `$HOME`.
 * - missing file: return an empty object (no file is fine).
 * - bad JSON, unknown keys, or invalid cron: throws `ConfigError`.
 */
export function readConfigFile(path: string | null | undefined): ConfigFile {
  if (path === null) return {};
  const resolved = path ?? join(homedir(), ".minesweeper", "config.json");
  return loadAndValidate(resolved, "MINESWEEPER_CONFIG_FILE");
}

/**
 * Read and validate the per-repo `<cwd>/.minesweeper/config.json` (or the
 * explicit path). Same sentinel rules as `readConfigFile`. The default path
 * is anchored to `cwd` rather than `$HOME` so each working tree carries its
 * own overrides.
 */
export function readRepoConfigFile(cwd: string, path: string | null | undefined): ConfigFile {
  if (path === null) return {};
  const resolved = path ?? join(cwd, ".minesweeper", "config.json");
  return loadAndValidate(resolved, "MINESWEEPER_REPO_CONFIG_FILE");
}

/**
 * Replace the top-level value of any field flagged `secret` in
 * `config.sources` with `<redacted>`. The `sources` map itself is preserved
 * intact so operators still see the source tag for redacted fields. Pure —
 * the input is not mutated.
 */
export function redactSecrets(config: Config): Config {
  const redacted: Record<string, unknown> = { ...config };
  for (const [key, { secret }] of Object.entries(config.sources)) {
    if (secret) redacted[key] = REDACTED;
  }
  return redacted as Config;
}

export function loadConfig(
  env: Env = process.env,
  opts: { configFile?: string | null; repoConfigFile?: string | null; cwd?: string } = {},
): Config {
  // Resolve each file path explicitly: a bare `??` would coerce `null` (the
  // "skip file" sentinel) to `undefined`, defeating the test injection point.
  const envPath = env["MINESWEEPER_CONFIG_FILE"];
  const filePath: string | null | undefined = envPath !== undefined ? envPath : opts.configFile;
  const file = readConfigFile(filePath);

  const envRepoPath = env["MINESWEEPER_REPO_CONFIG_FILE"];
  const repoPath: string | null | undefined = envRepoPath !== undefined ? envRepoPath : opts.repoConfigFile;
  const cwd = opts.cwd ?? process.cwd();
  const repoFile = readRepoConfigFile(cwd, repoPath);

  // Resolve every user-settable field as a `{ value, source }` pair so the
  // sources map is built alongside the candidate config — no post-hoc
  // reconstruction. Each resolver checks env → repo → global → default.
  const resolved = {
    defaultEligible: readBool(
      env,
      "MINESWEEPER_DEFAULT_ELIGIBLE",
      repoFile.defaultEligible,
      file.defaultEligible,
      false,
    ),
    alertsEligible: readBool(env, "MINESWEEPER_ALERTS_ELIGIBLE", repoFile.alertsEligible, file.alertsEligible, true),
    alwaysFixLabel: readString(
      env,
      "MINESWEEPER_ALWAYS_FIX_LABEL",
      repoFile.alwaysFixLabel,
      file.alwaysFixLabel,
      "autofix",
    ),
    tryFixLabel: readString(env, "MINESWEEPER_TRY_FIX_LABEL", repoFile.tryFixLabel, file.tryFixLabel, "tryFix"),
    neverFixLabel: readString(env, "MINESWEEPER_NEVER_FIX_LABEL", repoFile.neverFixLabel, file.neverFixLabel, "manual"),
    possiblyDangerousLabel: readString(
      env,
      "MINESWEEPER_POSSIBLY_DANGEROUS_LABEL",
      repoFile.possiblyDangerousLabel,
      file.possiblyDangerousLabel,
      "possiblyDangerous",
    ),
    manuallyApprovedLabel: readString(
      env,
      "MINESWEEPER_MANUALLY_APPROVED_LABEL",
      repoFile.manuallyApprovedLabel,
      file.manuallyApprovedLabel,
      "manuallyReviewed",
    ),
    failedLabel: readString(
      env,
      "MINESWEEPER_FAILED_LABEL",
      repoFile.failedLabel,
      file.failedLabel,
      "minesweeperFailed",
    ),
    subtaskLabel: readString(env, "MINESWEEPER_SUBTASK_LABEL", repoFile.subtaskLabel, file.subtaskLabel, "subtask"),
    maxPlanningIterations: readInt(
      env,
      "MINESWEEPER_MAX_PLANNING_ITERATIONS",
      1,
      repoFile.maxPlanningIterations,
      file.maxPlanningIterations,
      5,
    ),
    maxReviewRounds: readInt(
      env,
      "MINESWEEPER_MAX_REVIEW_ROUNDS",
      1,
      repoFile.maxReviewRounds,
      file.maxReviewRounds,
      3,
    ),
    eligibilityAgent: readString(
      env,
      "MINESWEEPER_ELIGIBILITY_AGENT",
      repoFile.eligibilityAgent,
      file.eligibilityAgent,
      "claude-haiku-4-5-20251001",
    ),
    planningAgent: readString(
      env,
      "MINESWEEPER_PLANNING_AGENT",
      repoFile.planningAgent,
      file.planningAgent,
      "claude-opus-4-7",
    ),
    reviewAgent: readString(
      env,
      "MINESWEEPER_REVIEW_AGENT",
      repoFile.reviewAgent,
      file.reviewAgent,
      "claude-sonnet-4-6",
    ),
    executionAgent: readString(
      env,
      "MINESWEEPER_EXECUTION_AGENT",
      repoFile.executionAgent,
      file.executionAgent,
      "claude-opus-4-7",
    ),
    issueWriterAgent: readString(
      env,
      "MINESWEEPER_ISSUE_WRITER_AGENT",
      repoFile.issueWriterAgent,
      file.issueWriterAgent,
      "claude-sonnet-4-6",
    ),
    worktreePath: readString(
      env,
      "MINESWEEPER_WORKTREE_PATH",
      repoFile.worktreePath,
      file.worktreePath,
      "/tmp/minesweeper",
    ),
    prBaseBranch: readString(env, "MINESWEEPER_PR_BASE_BRANCH", repoFile.prBaseBranch, file.prBaseBranch, "main"),
    pollIntervalSeconds: readInt(
      env,
      "MINESWEEPER_POLL_INTERVAL_SECONDS",
      30,
      repoFile.pollIntervalSeconds,
      file.pollIntervalSeconds,
      300,
    ),
    schedule: readSchedule(repoFile.schedule, file.schedule),
    pollCooldownSeconds: readInt(
      env,
      "MINESWEEPER_POLL_COOLDOWN",
      0,
      repoFile.pollCooldownSeconds,
      file.pollCooldownSeconds,
      120,
    ),
    maxConcurrency: readInt(env, "MINESWEEPER_MAX_CONCURRENCY", 1, repoFile.maxConcurrency, file.maxConcurrency, 1),
  };

  const entries = Object.entries(resolved);
  const values = Object.fromEntries(entries.map(([key, { value }]) => [key, value]));
  const sources: ConfigSources = Object.fromEntries(
    entries.map(([key, { source }]) => [key, { source, secret: SECRET_NAME_RE.test(key) }]),
  );

  const candidate = {
    ...values,
    pollIntervalMs: resolved.pollIntervalSeconds.value * 1000,
    pollCooldownMs: resolved.pollCooldownSeconds.value * 1000,
    sources,
  };

  return ConfigSchema.parse(candidate);
}
