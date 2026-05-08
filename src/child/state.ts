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
 *     assessor's rationale alongside its verdict. v1 state files are
 *     migrated on read by adding `assessmentReason: null`.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const Mode = z.enum(["Planning", "Assess", "Refine", "Execution", "Delegated"]);
export type Mode = z.infer<typeof Mode>;

export const Status = z.enum(["InProgress", "Writing", "Reviewing", "FixingReviewComments", "Complete", "Failed"]);
export type Status = z.infer<typeof Status>;

export const Assessment = z.enum(["Execute", "Refine"]);
export type Assessment = z.infer<typeof Assessment>;

export const STATE_SCHEMA_VERSION = 2;

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
 * Convert a v1 state object to v2 by adding `assessmentReason: null`.
 * Anything that is not a plain object with `version === 1` is returned
 * unchanged so the caller's strict v2 parse can produce the canonical
 * error message for it.
 */
function migrateIfNeeded(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const versioned = raw as { version?: unknown };
  if (versioned.version !== 1) return raw;
  const v1 = StateV1Schema.parse(raw);
  return { ...v1, version: STATE_SCHEMA_VERSION, assessmentReason: null };
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
