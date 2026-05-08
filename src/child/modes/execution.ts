/**
 * Execution mode: drives the executor ↔ reviewer loop until the reviewer
 * approves the change set, then squashes the branch, pushes it to
 * `origin`, and opens the pull request.
 *
 * The mode is entered with `state.mode = "Execution"` and either
 * `status = "Writing"` (fresh from planning) or `status = "Reviewing"` /
 * `status = "FixingReviewComments"` (resuming after a mid-loop crash).
 * `state.iterations` counts *fix rounds* — i.e. the number of times the
 * reviewer requested changes — so on a clean first-round approval it
 * remains 0.
 *
 * Per-iteration timeline:
 *
 *   1. Executor runs (`runSubagent("executor", …)`). The subagent makes
 *      edits and commits via the Bash carve-out (`git commit` from
 *      inside the agent — see `prompts/executor.md`). The orchestrator
 *      records HEAD before/after; if HEAD didn't move, a WARN is logged
 *      and the iteration is treated as a no-op (the reviewer will
 *      almost certainly request changes, eventually tripping the
 *      max-iterations exit).
 *   2. State transitions to `status = "Reviewing"` and is persisted.
 *   3. Reviewer runs with the cumulative diff against
 *      `config.prBaseBranch` and the list of commits on the branch.
 *      Its response is saved to `.minesweeper/review_comments.md`,
 *      overwriting the prior round's comments per spec.
 *   4. The verdict line (same format as the critic's, but with
 *      `Approved with minor concerns` / `Changes requested` tokens) is
 *      parsed. `Approved` and `Approved with minor concerns` both end
 *      the loop; `Changes requested` (or an unparseable response)
 *      bumps `state.iterations`, sets
 *      `status = "FixingReviewComments"`, and loops.
 *
 * If the loop exits without approval (`iterations >= maxIterations`),
 * we proceed to PR anyway — per spec: "If tests fail at this point we
 * do not go back. CI will pick this up and the code owner will decide
 * what to do." A WARN is logged.
 *
 * Finalisation:
 *
 *   - Best-effort `npm run check` if the worktree's package.json
 *     defines that script. Failures are logged but do not abort.
 *   - Squash via `git reset --soft <merge-base>` + `git commit`. The
 *     merge-base is computed against `config.prBaseBranch`. The commit
 *     message uses the issue title; the body starts with `Fixes #N`
 *     followed by a digest of the approved plan.
 *   - `git push -u origin <branch>` and `gh pr create`.
 *   - State transitions to `status = "Complete"`.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { execa } from "execa";

import type { Config } from "../../config.js";
import * as defaultGithub from "../../github/index.js";
import type { Issue } from "../../github/index.js";
import { event as defaultEvent, type Logger } from "../../logging.js";
import { runSubagent as defaultRunSubagent } from "../../claude/index.js";
import type { RunSubagentOptions, SubagentResult } from "../../claude/index.js";
import * as defaultState from "../state.js";
import type { State } from "../state.js";

/** Path (worktree-relative) the planning mode wrote the approved plan to. */
export const FINAL_PLAN_FILE = join(".minesweeper", "final_plan.md");

/**
 * Path (worktree-relative) where the most recent reviewer response is
 * persisted. Overwritten each round per spec — only the latest round's
 * findings are passed back to the executor.
 */
export const REVIEW_COMMENTS_FILE = join(".minesweeper", "review_comments.md");

/** Max characters of the plan included verbatim in the squashed commit body. */
const PLAN_DIGEST_LIMIT = 1500;

/** Signals the executor's first invocation in this mode (no prior review). */
const FIRST_ROUND = Symbol("first round");

export type ReviewerVerdict = "Approved" | "Approved with minor concerns" | "Changes requested";

/**
 * Same parsing rule as the critic verdict in `planning.ts`, but with the
 * reviewer's three accepted tokens. Anchored to a line, case-insensitive,
 * tolerates surrounding tabs/spaces. The longer alternative is listed
 * first so alternation prefers "approved with minor concerns" over
 * "approved".
 */
const REVIEWER_VERDICT_RE =
  /^[ \t]*verdict[ \t]*:[ \t]*(approved with minor concerns|changes requested|approved)[ \t]*$/gim;

/**
 * Parse a reviewer response and return the **last** verdict line found,
 * or `null` if none match. Callers treat `null` as `Changes requested`
 * (and log a warning).
 */
export function parseReviewerVerdict(text: string): ReviewerVerdict | null {
  const matches = [...text.matchAll(REVIEWER_VERDICT_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const value = (last[1] ?? "").toLowerCase();
  if (value === "approved with minor concerns") return "Approved with minor concerns";
  if (value === "approved") return "Approved";
  return "Changes requested";
}

/** Subagent runner shape — kept narrow so tests can inject a fake easily. */
export type RunSubagentFn = (opts: RunSubagentOptions) => Promise<SubagentResult>;

/**
 * The git operations the execution loop relies on. Exposed as a
 * dependency so tests can inject a stub instead of running real git in
 * a temp repo.
 */
export interface GitOps {
  /** SHA of HEAD inside `cwd`. */
  headSha(cwd: string): Promise<string>;
  /** Number of commits on HEAD that are not on `base` (i.e. `base..HEAD`). */
  commitsAhead(cwd: string, base: string): Promise<number>;
  /** SHA of the merge-base of `base` and HEAD. */
  mergeBase(cwd: string, base: string): Promise<string>;
  /** `git diff base..HEAD`. Stdout returned verbatim. */
  diff(cwd: string, base: string): Promise<string>;
  /** `git log --oneline base..HEAD`. Stdout returned verbatim. */
  log(cwd: string, base: string): Promise<string>;
  /** `git reset --soft <ref>`. Used to collapse the branch before squashing. */
  resetSoft(cwd: string, ref: string): Promise<void>;
  /** `git commit -m <message>`. The orchestrator-owned squash commit. */
  commit(cwd: string, message: string): Promise<void>;
  /** `git push -u origin <branch>`. */
  pushBranch(cwd: string, branch: string): Promise<void>;
}

/** Production implementation of {@link GitOps}, backed by `execa`. */
export const defaultGit: GitOps = {
  async headSha(cwd) {
    const r = await execa("git", ["rev-parse", "HEAD"], { cwd });
    return r.stdout.trim();
  },
  async commitsAhead(cwd, base) {
    const r = await execa("git", ["rev-list", "--count", `${base}..HEAD`], { cwd });
    return Number(r.stdout.trim());
  },
  async mergeBase(cwd, base) {
    const r = await execa("git", ["merge-base", base, "HEAD"], { cwd });
    return r.stdout.trim();
  },
  async diff(cwd, base) {
    const r = await execa("git", ["diff", `${base}..HEAD`], { cwd });
    return r.stdout;
  },
  async log(cwd, base) {
    const r = await execa("git", ["log", "--oneline", `${base}..HEAD`], { cwd });
    return r.stdout;
  },
  async resetSoft(cwd, ref) {
    await execa("git", ["reset", "--soft", ref], { cwd });
  },
  async commit(cwd, message) {
    await execa("git", ["commit", "-m", message], { cwd });
  },
  async pushBranch(cwd, branch) {
    await execa("git", ["push", "-u", "origin", branch], { cwd });
  },
};

/** Hook fired after approval, before the squash. Best-effort by contract. */
export type RunCheckHookFn = (cwd: string) => Promise<void>;

export interface ExecutionDeps {
  /** Loaded config — model lookup, base branch, max review rounds. */
  config: Config;
  /** Worktree root (== this child's cwd in production). */
  cwd: string;
  /** State as just read from disk by the handler. */
  state: State;
  /** Override the GitHub wrapper (tests). */
  github?: Pick<typeof defaultGithub, "getIssue" | "createPr">;
  /** Override the subagent runner (tests). */
  runSubagent?: RunSubagentFn;
  /** Override the state writer (tests can wrap to assert call sequence). */
  writeState?: typeof defaultState.writeState;
  /** Override the git wrapper (tests). */
  git?: GitOps;
  /** Override the optional `npm run check` hook (tests use a no-op). */
  runCheckHook?: RunCheckHookFn;
  /** Override the logger event sink (tests, or to suppress logging). */
  emit?: Logger["event"];
}

/**
 * Run the execution state machine to completion. On the success path
 * the returned state has `status = "Complete"`; the caller's child
 * handler exits 0 and the supervisor archives + removes the worktree.
 *
 * Throws on unrecoverable errors (subagent throws, git failures, the
 * branch having no commits at finalise time). The caller is expected
 * to translate uncaught exceptions to a non-zero exit so the supervisor
 * can label the issue `failedLabel`.
 */
export async function runExecution(deps: ExecutionDeps): Promise<State> {
  const { config, cwd } = deps;
  const emit = deps.emit ?? defaultEvent;
  const gh = deps.github ?? defaultGithub;
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const writeState = deps.writeState ?? defaultState.writeState;
  const git = deps.git ?? defaultGit;
  const runCheckHook = deps.runCheckHook ?? defaultRunCheckHook;

  let state = deps.state;
  const issueNumber = state.issueNumber;
  const branch = state.branchName;
  const baseBranch = config.prBaseBranch;

  emit(
    "executor",
    "WORK",
    issueNumber,
    `execution starting (round ${state.iterations + 1}/${state.maxIterations}, status=${state.status})`,
  );

  const finalPlan = await readFinalPlan(join(cwd, FINAL_PLAN_FILE));
  const issue = await gh.getIssue(issueNumber, { cwd });

  let approved = false;
  let lastVerdict: ReviewerVerdict | null = null;

  while (state.iterations < state.maxIterations) {
    if (state.status === "Writing" || state.status === "FixingReviewComments") {
      const reviewComments =
        state.status === "Writing" ? FIRST_ROUND : await readReviewComments(cwd);
      const userPrompt = executorPromptFor(finalPlan, reviewComments);
      const headBefore = await git.headSha(cwd);
      await runSubagent({
        role: "executor",
        config,
        userPrompt,
        issueNumber,
        iteration: state.iterations + 1,
        cwd,
      });
      const headAfter = await git.headSha(cwd);
      if (headBefore === headAfter) {
        emit(
          "executor",
          "WARN",
          issueNumber,
          "executor finished without producing a new commit; treating as no-op iteration",
        );
      }
      state = await writeState(cwd, { ...state, status: "Reviewing" });
    }

    const diff = await git.diff(cwd, baseBranch);
    const log = await git.log(cwd, baseBranch);
    const reviewerResult = await runSubagent({
      role: "reviewer",
      config,
      userPrompt: reviewerPromptFor(issue, finalPlan, diff, log),
      issueNumber,
      iteration: state.iterations + 1,
      cwd,
    });

    await writeReviewComments(cwd, reviewerResult.finalText);
    lastVerdict = parseReviewerVerdict(reviewerResult.finalText);
    const verdict: ReviewerVerdict = lastVerdict ?? "Changes requested";
    if (lastVerdict === null) {
      emit(
        "reviewer",
        "WARN",
        issueNumber,
        "reviewer did not emit a parseable Verdict line; treating as Changes requested",
      );
    } else {
      emit("reviewer", "INFO", issueNumber, `verdict: ${verdict}`);
    }

    if (verdict === "Approved" || verdict === "Approved with minor concerns") {
      approved = true;
      break;
    }

    state = await writeState(cwd, {
      ...state,
      status: "FixingReviewComments",
      iterations: state.iterations + 1,
    });
  }

  if (!approved) {
    emit(
      "reviewer",
      "WARN",
      issueNumber,
      `execution exited without approval (last verdict: ${lastVerdict ?? "none"}, iterations=${state.iterations}/${state.maxIterations}); proceeding to PR per spec`,
    );
  }

  await runCheckHookSafely(runCheckHook, cwd, issueNumber, emit);

  const ahead = await git.commitsAhead(cwd, baseBranch);
  if (ahead === 0) {
    throw new Error(
      `execution: cannot finalise — branch ${branch} has no commits ahead of ${baseBranch}`,
    );
  }

  const mergeBaseSha = await git.mergeBase(cwd, baseBranch);
  const { title, body } = composePrMessage(issue, finalPlan);
  await git.resetSoft(cwd, mergeBaseSha);
  await git.commit(cwd, buildCommitMessage(title, body));
  await git.pushBranch(cwd, branch);

  const pr = await gh.createPr({ base: baseBranch, head: branch, title, body, cwd });
  emit("daemon", "SHIP", issueNumber, `opened PR #${pr.number}: ${pr.url}`);

  return writeState(cwd, { ...state, status: "Complete" });
}

async function readFinalPlan(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `execution: ${path} not found — planning mode must run first`,
      );
    }
    throw err;
  }
}

async function readReviewComments(cwd: string): Promise<string | null> {
  try {
    return await fs.readFile(join(cwd, REVIEW_COMMENTS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeReviewComments(cwd: string, content: string): Promise<void> {
  const path = join(cwd, REVIEW_COMMENTS_FILE);
  await fs.mkdir(dirname(path), { recursive: true });
  const payload = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(path, payload, "utf8");
}

async function runCheckHookSafely(
  hook: RunCheckHookFn,
  cwd: string,
  issueNumber: number,
  emit: Logger["event"],
): Promise<void> {
  try {
    await hook(cwd);
  } catch (err) {
    emit(
      "executor",
      "WARN",
      issueNumber,
      `check hook failed (best-effort, continuing): ${(err as Error).message}`,
    );
  }
}

/**
 * Default check hook: if the worktree's package.json defines a `check`
 * script, run `npm run check`. Both the lookup and the execution are
 * best-effort — failures bubble up to {@link runCheckHookSafely} which
 * downgrades them to a WARN.
 */
async function defaultRunCheckHook(cwd: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(join(cwd, "package.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts;
  if (!scripts || typeof scripts.check !== "string") return;
  await execa("npm", ["run", "check"], { cwd });
}

function executorPromptFor(plan: string, reviewComments: string | null | typeof FIRST_ROUND): string {
  const base = ["# Execution Plan", "", plan.trimEnd(), ""];
  if (reviewComments === FIRST_ROUND || reviewComments === null) {
    base.push(
      "Implement the plan as described. End your work with a `git commit -m \"...\"` covering all changes.",
    );
    return base.join("\n");
  }
  return [
    ...base,
    "# Review feedback",
    "",
    reviewComments.trimEnd(),
    "",
    "Address each bullet under `# Review feedback` while keeping the rest of the plan intact. End with a `git commit`.",
  ].join("\n");
}

function reviewerPromptFor(
  issue: Issue,
  plan: string,
  diff: string,
  log: string,
): string {
  return [
    formatIssue(issue),
    "",
    "# Approved plan",
    "",
    plan.trimEnd(),
    "",
    "# Commits on this branch (oldest → newest)",
    "",
    "```",
    log.trim() || "(no commits)",
    "```",
    "",
    "# Cumulative diff against the base branch",
    "",
    "```diff",
    diff.trim() || "(empty)",
    "```",
  ].join("\n");
}

function formatIssue(issue: Issue): string {
  const labels = issue.labels.map((l) => l.name).join(", ") || "(none)";
  return [
    `# GitHub issue #${issue.number}`,
    `Title: ${issue.title}`,
    `Author: ${issue.author.login}`,
    `Labels: ${labels}`,
    `URL: ${issue.url}`,
    "",
    "## Body",
    "",
    issue.body.length > 0 ? issue.body : "(empty body)",
  ].join("\n");
}

function composePrMessage(issue: Issue, plan: string): { title: string; body: string } {
  const title = issue.title.trim();
  const body = [`Fixes #${issue.number}.`, "", "## Approved plan", "", digestPlan(plan)].join("\n");
  return { title, body };
}

function digestPlan(plan: string): string {
  const trimmed = plan.trim();
  if (trimmed.length <= PLAN_DIGEST_LIMIT) return trimmed;
  return `${trimmed.slice(0, PLAN_DIGEST_LIMIT)}\n\n…(plan truncated; full plan in .minesweeper/final_plan.md)`;
}

function buildCommitMessage(title: string, body: string): string {
  const trailer = body.endsWith("\n") ? body : `${body}\n`;
  return `${title}\n\n${trailer}`;
}
