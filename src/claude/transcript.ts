/**
 * Append-only JSONL transcripts for SDK events emitted by `runSubagent`.
 *
 * One file per `(role, iteration)`: every SDK event the role emits is
 * serialised as a single JSON object on its own line. The orchestrator owns
 * these files; subagents do not read them. They exist so that:
 *
 *   1. A human supervisor can replay any planning round after the fact.
 *   2. After a successful run the parent archives `.minesweeper/` (per the
 *      cross-cutting decision in `plans/00_index.md`) — so the full
 *      conversation history travels with the issue's archive.
 *   3. A crash mid-iteration leaves a partial-but-valid file; the resume
 *      path can decide whether to bump the iteration counter or replay.
 *
 * Append-mode is deliberate: `runSubagent` may be called more than once
 * for the same `(role, iteration)` (e.g. resume after crash) and the
 * earlier events should not be lost.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";

import type { RoleName } from "./roles.js";

/**
 * Repo-relative directory holding all transcripts for a worktree.
 *
 * Lives under `.minesweeper/` so it is archived (and then removed) with
 * the rest of the worktree's state by the parent daemon on success.
 */
export const TRANSCRIPT_DIR = join(".minesweeper", "planning_history");

export interface OpenTranscriptOptions {
  /**
   * Worktree root. Defaults to `process.cwd()`. In production callers are
   * already chdir'd into the worktree, so the default is correct; the
   * parameter exists primarily for tests and for the supervisor (which
   * may resolve a transcript without changing its own cwd).
   */
  cwd?: string;
  /** Which subagent role produced the events. Used in the filename. */
  role: RoleName;
  /**
   * 1-based iteration index. Each planner ↔ critic round (or executor ↔
   * reviewer round) increments this. Zero-padded to two digits in the
   * filename — see `transcriptPathFor`. Must be a positive integer.
   */
  iteration: number;
}

export interface Transcript {
  /** Absolute path to the JSONL file on disk. */
  readonly path: string;
  /**
   * Append one SDK event as a JSON line. The event is serialised with
   * `JSON.stringify`; circular references will throw (the SDK's own
   * message types are tree-shaped, so this is not a real concern in
   * practice).
   *
   * Writes are buffered by the underlying `WriteStream`. Callers that
   * need durability before continuing must `await close()`.
   */
  write(event: unknown): void;
  /**
   * Flush and close the underlying stream. Resolves once the OS has
   * acknowledged the final write. Always `await` this — `runSubagent`
   * does so in a `finally` block so the file lands on disk even when
   * the SDK throws mid-stream.
   */
  close(): Promise<void>;
}

/**
 * Compute the on-disk path for a given `(cwd, role, iteration)` triple
 * without touching the filesystem.
 *
 * The two-digit zero-padding (`planner-01.jsonl`, `planner-02.jsonl`, …)
 * keeps a directory listing in lexical = chronological order for
 * iteration counts up to 99 — well above `MINESWEEPER_MAX_PLANNING_ITERATIONS`
 * and `MINESWEEPER_MAX_REVIEW_ROUNDS`, both of which are single-digit
 * defaults (5 and 3).
 *
 * @throws Error if `iteration` is not a positive integer.
 */
export function transcriptPathFor(opts: OpenTranscriptOptions): string {
  if (!Number.isInteger(opts.iteration) || opts.iteration < 1) {
    throw new Error(`transcript iteration must be a positive integer, got ${opts.iteration}`);
  }
  const root = opts.cwd ?? process.cwd();
  const padded = String(opts.iteration).padStart(2, "0");
  return join(root, TRANSCRIPT_DIR, `${opts.role}-${padded}.jsonl`);
}

/**
 * Open (or re-open in append mode) a transcript for one `(role, iteration)`.
 *
 * Creates `${cwd}/.minesweeper/planning_history/` if it does not exist.
 * The returned handle owns the underlying file descriptor; the caller
 * must call `close()` exactly once.
 *
 * Re-opening the same `(role, iteration)` is intentionally supported:
 * a child process that crashes after writing some events can be resumed
 * and its new events will be appended to the existing file rather than
 * overwriting it. See the `appends across two openings` test for the
 * contract.
 */
export function openTranscript(opts: OpenTranscriptOptions): Transcript {
  const path = transcriptPathFor(opts);
  mkdirSync(dirname(path), { recursive: true });
  const stream: WriteStream = createWriteStream(path, { flags: "a" });

  return {
    path,
    write(event: unknown): void {
      stream.write(`${JSON.stringify(event)}\n`);
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stream.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()));
      });
    },
  };
}
