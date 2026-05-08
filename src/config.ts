import { z } from "zod";

export const ConfigSchema = z.object({
  defaultEligible: z.boolean(),
  alwaysFixLabel: z.string().min(1),
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
  worktreePath: z.string().min(1),
  prBaseBranch: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(30),
  pollIntervalMs: z.number().int().min(30_000),
  maxConcurrency: z.number().int().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  readonly envVar: string;

  constructor(envVar: string, detail: string) {
    super(`Invalid value for ${envVar}: ${detail}`);
    this.name = "ConfigError";
    this.envVar = envVar;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function readBool(env: Env, name: string, defaultVal: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return defaultVal;
  const s = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  throw new ConfigError(name, `expected a boolean (true/false/1/0/yes/no), got ${JSON.stringify(raw)}`);
}

function readInt(env: Env, name: string, min: number, defaultVal: number): number {
  const raw = env[name];
  if (raw === undefined) return defaultVal;
  const trimmed = raw.trim();
  if (trimmed === "") throw new ConfigError(name, "expected an integer, got an empty string");
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ConfigError(name, `expected an integer, got ${JSON.stringify(raw)}`);
  }
  if (n < min) throw new ConfigError(name, `must be >= ${min}, got ${n}`);
  return n;
}

function readString(env: Env, name: string, defaultVal: string): string {
  const raw = env[name];
  if (raw === undefined) return defaultVal;
  if (raw.length === 0) throw new ConfigError(name, "expected a non-empty string");
  return raw;
}

export function loadConfig(env: Env = process.env): Config {
  const pollIntervalSeconds = readInt(env, "MINESWEEPER_POLL_INTERVAL_SECONDS", 30, 300);

  const candidate = {
    defaultEligible: readBool(env, "MINESWEEPER_DEFAULT_ELIGIBLE", false),
    alwaysFixLabel: readString(env, "MINESWEEPER_ALWAYS_FIX_LABEL", "autofix"),
    neverFixLabel: readString(env, "MINESWEEPER_NEVER_FIX_LABEL", "manual"),
    possiblyDangerousLabel: readString(env, "MINESWEEPER_POSSIBLY_DANGEROUS_LABEL", "possiblyDangerous"),
    manuallyApprovedLabel: readString(env, "MINESWEEPER_MANUALLY_APPROVED_LABEL", "manuallyReviewed"),
    failedLabel: readString(env, "MINESWEEPER_FAILED_LABEL", "minesweeperFailed"),
    subtaskLabel: readString(env, "MINESWEEPER_SUBTASK_LABEL", "subtask"),
    maxPlanningIterations: readInt(env, "MINESWEEPER_MAX_PLANNING_ITERATIONS", 1, 5),
    maxReviewRounds: readInt(env, "MINESWEEPER_MAX_REVIEW_ROUNDS", 1, 3),
    eligibilityAgent: readString(env, "MINESWEEPER_ELIGIBILITY_AGENT", "haiku"),
    planningAgent: readString(env, "MINESWEEPER_PLANNING_AGENT", "claude-opus-4-7"),
    reviewAgent: readString(env, "MINESWEEPER_REVIEW_AGENT", "claude-sonnet-4-6"),
    executionAgent: readString(env, "MINESWEEPER_EXECUTION_AGENT", "claude-opus-4-7"),
    worktreePath: readString(env, "MINESWEEPER_WORKTREE_PATH", "/tmp/minesweeper"),
    prBaseBranch: readString(env, "MINESWEEPER_PR_BASE_BRANCH", "main"),
    pollIntervalSeconds,
    pollIntervalMs: pollIntervalSeconds * 1000,
    maxConcurrency: readInt(env, "MINESWEEPER_MAX_CONCURRENCY", 1, 1),
  };

  return ConfigSchema.parse(candidate);
}
