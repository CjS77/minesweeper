/**
 * Environment- and file-driven configuration loader for Minesweeper.
 *
 * Configuration sources, in order of precedence:
 *   1. Process environment variables (`MINESWEEPER_*`).
 *   2. JSON file at `~/.minesweeper/config.json` (path overridable via
 *      `MINESWEEPER_CONFIG_FILE`).
 *   3. Hard-coded defaults baked into this module.
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
 * Which layer supplied a single resolved `Config` field. `envar` wins over
 * `config-file`, which wins over the built-in `default`.
 */
export type ConfigSource = "envar" | "config-file" | "default";

const ConfigFieldSourceSchema = z.object({
  source: z.enum(["envar", "config-file", "default"]),
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

function readBool(env: Env, name: string, fileVal: boolean | undefined, defaultVal: boolean): Resolved<boolean> {
  const raw = env[name];
  if (raw !== undefined) {
    const s = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(s)) return { value: true, source: "envar" };
    if (FALSE_VALUES.has(s)) return { value: false, source: "envar" };
    throw new ConfigError(name, `expected a boolean (true/false/1/0/yes/no), got ${JSON.stringify(raw)}`);
  }
  if (fileVal !== undefined) return { value: fileVal, source: "config-file" };
  return { value: defaultVal, source: "default" };
}

function readInt(
  env: Env,
  name: string,
  min: number,
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
  if (fileVal !== undefined) return { value: fileVal, source: "config-file" };
  return { value: defaultVal, source: "default" };
}

function readString(env: Env, name: string, fileVal: string | undefined, defaultVal: string): Resolved<string> {
  const raw = env[name];
  if (raw !== undefined) {
    if (raw.length === 0) throw new ConfigError(name, "expected a non-empty string");
    return { value: raw, source: "envar" };
  }
  if (fileVal !== undefined) return { value: fileVal, source: "config-file" };
  return { value: defaultVal, source: "default" };
}

/**
 * `schedule` is file-only — there is no `MINESWEEPER_SCHEDULE` env var — so
 * it has its own resolver rather than overloading `readString`.
 */
function readSchedule(fileVal: readonly string[] | undefined): Resolved<string[]> {
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
 * Read and validate `~/.minesweeper/config.json` (or the explicit path).
 *
 * - `path === null`: skip file loading entirely (test sentinel).
 * - `path === undefined`: use the default path under `$HOME`.
 * - missing file: return an empty object (no file is fine).
 * - bad JSON, unknown keys, or invalid cron: throws `ConfigError`.
 */
export function readConfigFile(path: string | null | undefined): ConfigFile {
  if (path === null) return {};
  const resolved = path ?? join(homedir(), ".minesweeper", "config.json");

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError("MINESWEEPER_CONFIG_FILE", `failed to read ${resolved}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError("MINESWEEPER_CONFIG_FILE", `failed to parse ${resolved} as JSON: ${(err as Error).message}`);
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError("MINESWEEPER_CONFIG_FILE", `invalid config in ${resolved}: ${result.error.message}`);
  }

  for (const expression of result.data.schedule ?? []) {
    validateCron(expression);
  }

  return result.data;
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

export function loadConfig(env: Env = process.env, opts: { configFile?: string | null } = {}): Config {
  // Resolve the file path explicitly: a bare `??` would coerce `null` (the
  // "skip file" sentinel) to `undefined`, defeating the test injection point.
  const envPath = env["MINESWEEPER_CONFIG_FILE"];
  const filePath: string | null | undefined = envPath !== undefined ? envPath : opts.configFile;
  const file = readConfigFile(filePath);

  // Resolve every user-settable field as a `{ value, source }` pair so the
  // sources map is built alongside the candidate config — no post-hoc
  // reconstruction.
  const resolved = {
    defaultEligible: readBool(env, "MINESWEEPER_DEFAULT_ELIGIBLE", file.defaultEligible, false),
    alwaysFixLabel: readString(env, "MINESWEEPER_ALWAYS_FIX_LABEL", file.alwaysFixLabel, "autofix"),
    tryFixLabel: readString(env, "MINESWEEPER_TRY_FIX_LABEL", file.tryFixLabel, "tryFix"),
    neverFixLabel: readString(env, "MINESWEEPER_NEVER_FIX_LABEL", file.neverFixLabel, "manual"),
    possiblyDangerousLabel: readString(
      env,
      "MINESWEEPER_POSSIBLY_DANGEROUS_LABEL",
      file.possiblyDangerousLabel,
      "possiblyDangerous",
    ),
    manuallyApprovedLabel: readString(
      env,
      "MINESWEEPER_MANUALLY_APPROVED_LABEL",
      file.manuallyApprovedLabel,
      "manuallyReviewed",
    ),
    failedLabel: readString(env, "MINESWEEPER_FAILED_LABEL", file.failedLabel, "minesweeperFailed"),
    subtaskLabel: readString(env, "MINESWEEPER_SUBTASK_LABEL", file.subtaskLabel, "subtask"),
    maxPlanningIterations: readInt(env, "MINESWEEPER_MAX_PLANNING_ITERATIONS", 1, file.maxPlanningIterations, 5),
    maxReviewRounds: readInt(env, "MINESWEEPER_MAX_REVIEW_ROUNDS", 1, file.maxReviewRounds, 3),
    eligibilityAgent: readString(
      env,
      "MINESWEEPER_ELIGIBILITY_AGENT",
      file.eligibilityAgent,
      "claude-haiku-4-5-20251001",
    ),
    planningAgent: readString(env, "MINESWEEPER_PLANNING_AGENT", file.planningAgent, "claude-opus-4-7"),
    reviewAgent: readString(env, "MINESWEEPER_REVIEW_AGENT", file.reviewAgent, "claude-sonnet-4-6"),
    executionAgent: readString(env, "MINESWEEPER_EXECUTION_AGENT", file.executionAgent, "claude-opus-4-7"),
    issueWriterAgent: readString(env, "MINESWEEPER_ISSUE_WRITER_AGENT", file.issueWriterAgent, "claude-sonnet-4-6"),
    worktreePath: readString(env, "MINESWEEPER_WORKTREE_PATH", file.worktreePath, "/tmp/minesweeper"),
    prBaseBranch: readString(env, "MINESWEEPER_PR_BASE_BRANCH", file.prBaseBranch, "main"),
    pollIntervalSeconds: readInt(env, "MINESWEEPER_POLL_INTERVAL_SECONDS", 30, file.pollIntervalSeconds, 300),
    schedule: readSchedule(file.schedule),
    pollCooldownSeconds: readInt(env, "MINESWEEPER_POLL_COOLDOWN", 0, file.pollCooldownSeconds, 120),
    maxConcurrency: readInt(env, "MINESWEEPER_MAX_CONCURRENCY", 1, file.maxConcurrency, 1),
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
