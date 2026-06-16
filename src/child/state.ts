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
 *   - v4 (alerts): adds `kind: "issue" | "codeScanningAlert" |
 *     "secretScanningAlert"` so the supervisor and child can dispatch the
 *     right `gh` API on resume. Legacy state files are migrated with
 *     `kind: "issue"` (every pre-v4 worktree was an issue worktree).
 *   - v5 (issue #55): adds `canResumeAt: string | null` (UTC instant
 *     after which a rate-limited worktree may be retried; `null` means
 *     retry next poll cycle) and `pausedFromStatus: Status | null` (the
 *     working status captured at pause time, restored verbatim on
 *     resume). Legacy v4 files are migrated with both fields `null`.
 *   - v6 (CI feedback): adds `AddressingCIFailure` to the mode enum;
 *     adds `ciChecksProcessedAt: string | null` (HEAD SHA of the most
 *     recent commit whose failing checks triggered a dispatch — prevents
 *     re-acting on the same SHA) and `ciFixIterations: number | null`
 *     (count of CI-fix dispatches over the worktree's lifetime; `null`
 *     means the CI-fix mode has never been entered). Legacy v5 files are
 *     migrated with both fields `null`.
 *   - v7 (👍-curated feedback): adds `prReactionsProcessedAt: string |
 *     null` — a watermark, independent of `prFeedbackProcessedAt`, that
 *     records the newest `+1` reaction timestamp the PR-feedback poller
 *     has acted on. Reactions live on their own clock (a `+1` can land
 *     long after the comment it approves), so folding them into the
 *     feedback watermark would skip unrelated reviews/comments. Legacy
 *     v6 files are migrated with the field `null`.
 *
 * Migrations run on read; v1 through v6 state files are upgraded
 * transparently. The migration chain is v1 → v2 → v3 → v4 → v5 → v6 → v7.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const Mode = z.enum([
  "Planning",
  "Assess",
  "Refine",
  "Execution",
  "AddressingPRFeedback",
  "AddressingCIFailure",
  "Delegated",
]);
export type Mode = z.infer<typeof Mode>;

export const Status = z.enum([
  "InProgress",
  "Writing",
  "Reviewing",
  "FixingReviewComments",
  "Complete",
  "Failed",
  "Paused",
]);
export type Status = z.infer<typeof Status>;

export const Assessment = z.enum(["Execute", "Refine"]);
export type Assessment = z.infer<typeof Assessment>;

/**
 * Discriminator for the work-item kind a worktree was opened against. Issues
 * are the legacy default; `codeScanningAlert` and `secretScanningAlert` are
 * the GitHub Advanced Security sources added in v4. Branches and CLI args
 * use the same string here as their human-readable namespace prefix.
 */
export const WorkItemKind = z.enum(["issue", "codeScanningAlert", "secretScanningAlert"]);
export type WorkItemKind = z.infer<typeof WorkItemKind>;

export const STATE_SCHEMA_VERSION = 7;

export const StateSchema = z.object({
  version: z.literal(STATE_SCHEMA_VERSION),
  kind: WorkItemKind,
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
  prReactionsProcessedAt: z.iso.datetime().nullable(),
  ciChecksProcessedAt: z.string().nullable(),
  ciFixIterations: z.number().int().min(0).nullable(),
  canResumeAt: z.iso.datetime().nullable(),
  pausedFromStatus: Status.nullable(),
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

/**
 * v3 schema, kept around purely for migration. Identical to the v4 schema
 * minus the `kind` discriminator.
 */
const StateV3Schema = z.object({
  version: z.literal(3),
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

/**
 * v4 schema, kept around purely for migration. Identical to the v5 schema
 * minus the v5 `canResumeAt` / `pausedFromStatus` fields.
 */
const StateV4Schema = z.object({
  version: z.literal(4),
  kind: WorkItemKind,
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

/**
 * v5 schema, kept around purely for migration. Identical to the current
 * `StateSchema` minus the v6 `ciChecksProcessedAt` / `ciFixIterations` fields.
 */
const StateV5Schema = z.object({
  version: z.literal(5),
  kind: WorkItemKind,
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
  canResumeAt: z.iso.datetime().nullable(),
  pausedFromStatus: Status.nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * v6 schema, kept around purely for migration. Identical to the current
 * `StateSchema` minus the v7 `prReactionsProcessedAt` field.
 */
const StateV6Schema = z.object({
  version: z.literal(6),
  kind: WorkItemKind,
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
  ciChecksProcessedAt: z.string().nullable(),
  ciFixIterations: z.number().int().min(0).nullable(),
  canResumeAt: z.iso.datetime().nullable(),
  pausedFromStatus: Status.nullable(),
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
  /** Defaults to `"issue"` for callers (and tests) that pre-date alert support. */
  kind?: WorkItemKind;
  issueNumber: number;
  branchName: string;
  maxIterations: number;
}

export const INITIAL_STATUS: Record<Mode, Status> = {
  Planning: "InProgress",
  Assess: "InProgress",
  Refine: "InProgress",
  Execution: "Writing",
  AddressingPRFeedback: "InProgress",
  AddressingCIFailure: "InProgress",
  Delegated: "Complete",
};

export async function initState(cwd: string, mode: Mode, opts: InitStateOptions): Promise<State> {
  const now = new Date().toISOString();
  const candidate: State = StateSchema.parse({
    version: STATE_SCHEMA_VERSION,
    kind: opts.kind ?? "issue",
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
    prReactionsProcessedAt: null,
    ciChecksProcessedAt: null,
    ciFixIterations: null,
    canResumeAt: null,
    pausedFromStatus: null,
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
 * The chain is v1 → v2 → v3 → v4 → v5 → v6 → v7. Each step is additive:
 * v1 → v2 adds `assessmentReason: null`; v2 → v3 adds `prNumber: null`
 * and `prFeedbackProcessedAt: null`; v3 → v4 adds `kind: "issue"`;
 * v4 → v5 adds `canResumeAt: null` and `pausedFromStatus: null`;
 * v5 → v6 adds `ciChecksProcessedAt: null` and `ciFixIterations: null`;
 * v6 → v7 adds `prReactionsProcessedAt: null`.
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
  const afterV2 = current as { version?: unknown };
  if (afterV2.version === 3) {
    const v3 = StateV3Schema.parse(current);
    current = { ...v3, version: 4, kind: "issue" };
  }
  const afterV3 = current as { version?: unknown };
  if (afterV3.version === 4) {
    const v4 = StateV4Schema.parse(current);
    current = { ...v4, version: 5, canResumeAt: null, pausedFromStatus: null };
  }
  const afterV4 = current as { version?: unknown };
  if (afterV4.version === 5) {
    const v5 = StateV5Schema.parse(current);
    current = { ...v5, version: 6, ciChecksProcessedAt: null, ciFixIterations: null };
  }
  const afterV5 = current as { version?: unknown };
  if (afterV5.version === 6) {
    const v6 = StateV6Schema.parse(current);
    current = { ...v6, version: 7, prReactionsProcessedAt: null };
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
