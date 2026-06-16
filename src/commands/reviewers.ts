/**
 * `minesweeper reviewers` — manage the extra authorised-reviewer
 * allowlist persisted at `.minesweeper/reviewers.json`.
 *
 * The PR-feedback poller authorises the repo owner and `CODEOWNERS`
 * logins out of the box. This command extends that set so the code owner
 * can curate a bot's review comments (e.g. CodeRabbit) with a `+1`:
 *
 *   minesweeper reviewers add 'coderabbitai[bot]'
 *   minesweeper reviewers list
 *   minesweeper reviewers remove 'coderabbitai[bot]'
 *
 * All persistence/validation lives in `src/reviewers.ts`; this is the
 * thin CLI surface. Output is written to an injectable stream so tests
 * can capture it.
 */

import { addReviewer, listReviewers, removeReviewer } from "../reviewers.js";

export interface RunReviewersCommandOptions {
  /** Repo root (the file lives at `<repoRoot>/.minesweeper/reviewers.json`). */
  repoRoot: string;
  action: "add" | "remove" | "list";
  /** Required for `add`/`remove`; ignored for `list`. */
  login?: string;
  /** Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
}

/** Run the reviewers command and return the resulting allowlist. */
export async function runReviewersCommand(opts: RunReviewersCommandOptions): Promise<string[]> {
  const out = opts.stdout ?? process.stdout;

  if (opts.action === "list") {
    const reviewers = await listReviewers(opts.repoRoot);
    writeList(out, reviewers);
    return reviewers;
  }

  if (opts.login === undefined || opts.login.trim().length === 0) {
    throw new Error(`'reviewers ${opts.action}' requires a GitHub login`);
  }

  if (opts.action === "add") {
    const reviewers = await addReviewer(opts.repoRoot, opts.login);
    out.write(`added ${opts.login.toLowerCase()}\n`);
    writeList(out, reviewers);
    return reviewers;
  }

  const reviewers = await removeReviewer(opts.repoRoot, opts.login);
  out.write(`removed ${opts.login.toLowerCase()}\n`);
  writeList(out, reviewers);
  return reviewers;
}

function writeList(out: NodeJS.WritableStream, reviewers: string[]): void {
  if (reviewers.length === 0) {
    out.write("no extra authorised reviewers configured\n");
    return;
  }
  out.write("extra authorised reviewers:\n");
  for (const login of reviewers) out.write(`  ${login}\n`);
}
