/**
 * On-disk state for a single child invocation.
 *
 * The state file lives at `.minesweeper/state.json` inside the worktree
 * and is the source of truth for the child's mode/status. Every mode
 * handler reads it on entry and writes it on transition so the daemon
 * can crash and resume from disk.
 *
 * Schema versions:
 *
 *   - v1 (plan 02): initial schema. Modes were `Planning | Execution |
 *     Delegated`; assessment was a nullable `Execute | Refine`.
 *   - v2 (plan 12): adds `Assess` and `Refine` to the mode enum and
 *     adds `assessmentReason: string | null` so we can store the
 *     assessor's rationale alongside its verdict.
 *   - v3 (issue #18): adds `AddressingPRFeedback` to the mode enum so
 *     the daemon can re-dispatch a worktree against PR review comments
 *     after the PR is opened. Adds `prNumber: number | null` (set by
 *     execution mode when the PR is created) and
 *     `prFeedbackProcessedAt: string | null` (watermark used by the PR
 *     feedback poller to dedup already-processed reviews/comments).
 *
 * Migrations run on read; v1 and v2 state files are upgraded
 * transparently. The migration chain is v1 → v2 → v3.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const Mode = z.enum(["Planning", "Assess", "Refine", "Execution", "AddressingPRFeedback", "Delegated"]);
export type Mode = z.infer<typeof Mode>;

export const Status = z.enum(["InProgress", "Writing", "Reviewing", "FixingReviewComments", "Complete", "Failed"]);
export type Status = z.infer<typeof Status>;

export const Assessment = z.enum(["Execute", "Refine"]);
export type Assessment = z.infer<typeof Assessment>;

export const STATE_SCHEMA_VERSION = 3;

export const StateSchema = z.object({
  version: z.literal(STATE_SCHEMA_VERSION),
  issueNumber: z.number().int().positive(),
  branchName: z.string().min(1),
  mode: Mode,
  status: Status,
  iterations: z.number().int().min(0),
  maxIterations: z.number().int().min(1),
  assessment: Assessment.nullable(),
  assessmentReason: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  prFeedbackProcessedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type State = z.infer<typeof StateSchema>;

/**
 * v1 schema, kept around purely for migration. The mode enum is the
 * narrower v1 set; everything else mirrors v2 minus `assessmentReason`.
 */
const StateV1Schema = z.object({
  version: z.literal(1),
  issueNumber: z.number().int().positive(),
  branchName: z.string().min(1),
  mode: z.enum(["Planning", "Execution", "Delegated"]),
  status: Status,
  iterations: z.number().int().min(0),
  maxIterations: z.number().int().min(1),
  assessment: Assessment.nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * v2 schema, kept around purely for migration. Mirrors the v2 enum set
 * (no `AddressingPRFeedback`) and lacks the v3 `prNumber` /
 * `prFeedbackProcessedAt` fields.
 */
const StateV2Schema = z.object({
  version: z.literal(2),
  issueNumber: z.number().int().positive(),
  branchName: z.string().min(1),
  mode: z.enum(["Planning", "Assess", "Refine", "Execution", "Delegated"]),
  status: Status,
  iterations: z.number().int().min(0),
  maxIterations: z.number().int().min(1),
  assessment: Assessment.nullable(),
  assessmentReason: z.string().nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const STATE_DIR = ".minesweeper";
export const STATE_FILE = "state.json";

export function stateDir(cwd: string): string {
  return join(cwd, STATE_DIR);
}

export function statePath(cwd: string): string {
  return join(stateDir(cwd), STATE_FILE);
}

export interface InitStateOptions {
  issueNumber: number;
  branchName: string;
  maxIterations: number;
}

const INITIAL_STATUS: Record<Mode, Status> = {
  Planning: "InProgress",
  Assess: "InProgress",
  Refine: "InProgress",
  Execution: "Writing",
  AddressingPRFeedback: "InProgress",
  Delegated: "Complete",
};

export async function initState(cwd: string, mode: Mode, opts: InitStateOptions): Promise<State> {
  const now = new Date().toISOString();
  const candidate: State = StateSchema.parse({
    version: STATE_SCHEMA_VERSION,
    issueNumber: opts.issueNumber,
    branchName: opts.branchName,
    mode,
    status: INITIAL_STATUS[mode],
    iterations: 0,
    maxIterations: opts.maxIterations,
    assessment: null,
    assessmentReason: null,
    prNumber: null,
    prFeedbackProcessedAt: null,
    startedAt: now,
    updatedAt: now,
  });
  return writeState(cwd, candidate);
}

export async function readState(cwd: string): Promise<State> {
  const path = statePath(cwd);
  const raw = await fs.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`state.json at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return StateSchema.parse(migrateIfNeeded(parsed));
}

/**
 * Walk a state object through every available migration up to the
 * current `STATE_SCHEMA_VERSION`. Anything that is not a plain object
 * with a recognised `version` is returned unchanged so the caller's
 * strict parse can produce the canonical error message for it.
 *
 * Exported so callers that swallow parse errors (notably
 * `worktree.readStateOrNull`) can apply the migration before the strict
 * parse — otherwise a v1/v2 file on disk would fail the v3 literal
 * check and silently disappear from `listOrphans`.
 *
 * The chain is v1 → v2 → v3. Each step is additive: v1 → v2 adds
 * `assessmentReason: null`; v2 → v3 adds `prNumber: null` and
 * `prFeedbackProcessedAt: null`.
 */
export function migrateIfNeeded(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const versioned = raw as { version?: unknown };

  let current: unknown = raw;
  if (versioned.version === 1) {
    const v1 = StateV1Schema.parse(current);
    current = { ...v1, version: 2, assessmentReason: null };
  }
  const afterV1 = current as { version?: unknown };
  if (afterV1.version === 2) {
    const v2 = StateV2Schema.parse(current);
    current = { ...v2, version: 3, prNumber: null, prFeedbackProcessedAt: null };
  }
  return current;
}

export async function writeState(cwd: string, state: State): Promise<State> {
  const validated = StateSchema.parse({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  const dir = stateDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJson(statePath(cwd), validated);
  return validated;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const tmp = join(dir, `.${basename(path)}.tmp.${suffix}`);
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
