import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import chalk from "chalk";

import { LogViewError, findTranscriptsForIssue, runLogViewCommand } from "../log.js";

chalk.level = 3;

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const FIXTURE_TEXT = readFileSync(join(FIX_DIR, "planner-sample.jsonl"), "utf8");

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

let tmp: string;

function makeStdout(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}

function writeFixture(targetRel: string): string {
  const path = join(tmp, targetRel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, FIXTURE_TEXT);
  return path;
}

function runWithFixtureAt(name: string, options: Partial<Parameters<typeof runLogViewCommand>[0]> = {}): string {
  const { stream, text } = makeStdout();
  runLogViewCommand({ name, cwd: tmp, stdout: stream, ...options });
  return text();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "minesweeper-log-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("runLogViewCommand", () => {
  it("renders the system init line as the first stripped line", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    const firstLine = out.split("\n")[0];
    expect(firstLine).toMatch(/^--:--:-- 🏛️ SYSTEM \(claude-opus-4-7\) — init$/);
  });

  it("renders system init detail line with cwd, permissionMode, claude_code_version", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toContain("cwd=/tmp/work");
    expect(out).toContain("permissionMode=plan");
    expect(out).toContain("claude_code_version=2.1.132");
  });

  it("renders an assistant tool_use as Tool(summary)", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toContain("Bash(ls /tmp/somedir)");
    const bashLine = out.split("\n").find((l) => l.includes("Bash("));
    expect(bashLine).toBeDefined();
    expect(bashLine!.length).toBeLessThanOrEqual(140);
  });

  it("uses the universal robot/silhouette emoji pair", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toMatch(/🤖 ASSISTANT/);
    expect(out).toMatch(/👤 USER/);
    expect(out).not.toMatch(/👩‍🏫/);
    expect(out).not.toMatch(/👨 USER/);
  });

  it("renders thinking blocks under an Assistant header", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toMatch(/ASSISTANT \(claude-opus-4-7\) — thinking/);
    expect(out).toContain("considering the task");
  });

  it("suppresses thinking blocks whose body is empty (API-redacted)", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    // The fixture contains exactly one non-empty thinking ("considering the task")
    // and one redacted thinking ({thinking: "", signature: "..."}). Only the first
    // produces a header.
    const thinkingHeaders = out.split("\n").filter((l) => /ASSISTANT.* — thinking$/.test(l));
    expect(thinkingHeaders).toHaveLength(1);
  });

  it("renders --:--:-- when no timestamp is available, then formatted time once seen", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    const lines = out.split("\n");
    const bashLine = lines.find((l) => l.includes("Bash("));
    expect(bashLine).toMatch(/^--:--:--/);
    const userToolResult = lines.find((l) => l.includes("tool_result (3 lines)"));
    expect(userToolResult).toMatch(/^\d{2}:\d{2}:\d{2}/);
  });

  it("renders user tool_result with file content as a header-only `tool_result <path> (N lines)` line", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toContain("tool_result /tmp/work/prompts/executor.md (63 lines)");
    // Body is intentionally omitted now.
    expect(out).not.toContain("    line 1");
    expect(out).not.toContain("    line 5");
  });

  it("shows the full input for tool_use blocks, indented under the header", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    // The Write call in the fixture has multi-line content; verify both the
    // header and the body show up.
    expect(out).toMatch(/Write\(\/tmp\/work\/note\.md\)/);
    expect(out).toContain("    file_path: /tmp/work/note.md");
    expect(out).toContain("    content:");
    expect(out).toContain("      hello");
    expect(out).toContain("      world");
  });

  it("respects --max-lines by capping the body and emitting a truncated footer for tool_use input", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01", { maxLines: 1 }));
    // The Write tool_use input has 4 body lines; with maxLines=1 we keep
    // only the first and emit a truncation footer.
    expect(out).toContain("    file_path: /tmp/work/note.md");
    expect(out).toContain("(truncated 3 more lines)");
  });

  it("--max-lines 0 means unlimited (no truncation in tool_use bodies)", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01", { maxLines: 0 }));
    expect(out).toContain("    file_path: /tmp/work/note.md");
    expect(out).toContain("      hello");
    expect(out).toContain("      world");
    expect(out).not.toMatch(/truncated/);
  });

  it("renders is_error tool_result in red, header notes stderr line count", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const raw = runWithFixtureAt("planner-01");
    const stripped = strip(raw);
    expect(stripped).toContain("tool_result (0 lines, stderr=1 lines)");
    // Body is no longer printed, even for errors.
    expect(stripped).not.toContain("    command not found");
    // Red ANSI escape present somewhere in the unstripped output (the error header).
    expect(raw).toContain(`${ESC}[31m`);
  });

  it("--no-color produces no ANSI escapes", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = runWithFixtureAt("planner-01", { color: false });
    expect(out).toBe(strip(out));
  });

  it("tolerates malformed JSON lines and continues", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toMatch(/⚠️ line 8 unparseable/);
    expect(out).toMatch(/🏁 RESULT/);
  });

  it("resolves a bare name to .minesweeper/planning_history/<name>.jsonl", () => {
    writeFixture(".minesweeper/planning_history/critic-02.jsonl");
    const out = strip(runWithFixtureAt("critic-02"));
    expect(out).toContain("SYSTEM");
  });

  it("resolves a relative path with .jsonl extension against cwd", () => {
    writeFixture("custom/somewhere/runlog.jsonl");
    const out = strip(runWithFixtureAt("custom/somewhere/runlog.jsonl"));
    expect(out).toContain("SYSTEM");
  });

  it("throws LogViewError when the file is missing, listing available transcripts", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    let caught: unknown = null;
    try {
      runLogViewCommand({ name: "no-such-name", cwd: tmp, stdout: makeStdout().stream });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LogViewError);
    expect((caught as Error).name).toBe("LogViewError");
    expect((caught as Error).message).toContain("no-such-name");
    expect((caught as Error).message).toContain("planner-01.jsonl");
  });

  it("notes 'no transcripts yet' when the planning_history dir does not exist either", () => {
    let caught: unknown = null;
    try {
      runLogViewCommand({ name: "missing", cwd: tmp, stdout: makeStdout().stream });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LogViewError);
    expect((caught as Error).message).toMatch(/no transcripts yet/);
  });

  it("throws when neither name nor issueNumber is given", () => {
    expect(() => runLogViewCommand({ cwd: tmp, stdout: makeStdout().stream })).toThrow(LogViewError);
  });

  it("renders the result line with stop_reason, turns, and duration", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toMatch(/🏁 RESULT — stop=end_turn, 3 turns, 12345ms/);
  });

  it("renders rate_limit_event lines", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toMatch(/⏱️ Rate-limit — allowed/);
  });

  it("falls through unknown message types as ❓ <type>", () => {
    const path = join(tmp, ".minesweeper/planning_history/weird-01.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "frobnicate" })}\n`);
    const out = strip(runWithFixtureAt("weird-01"));
    expect(out).toContain("❓ frobnicate");
  });

  it("with --issue, concatenates matched files and emits a banner per file", () => {
    // tmp acts as worktreePath: build worktrees/<dir>/.minesweeper/... and
    // archive/<issue>-<ts>/planning_history/...
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl", "critic-01.jsonl"]);
    seedArchive(tmp, "5-2026-05-08T12:14:58.270Z", ["planner-01.jsonl"]);

    const { stream, text } = makeStdout();
    runLogViewCommand({ issueNumber: 5, worktreePath: tmp, stdout: stream });
    const out = strip(text());

    // Three banners (basenames may collide; just count banner lines).
    const banners = out.split("\n").filter((l) => /═{6} .+\.jsonl {2}\(/.test(l));
    expect(banners).toHaveLength(3);
    // Ordered lexically by absolute path: archive/5-… comes before worktrees/…
    expect(banners[0]).toContain("/archive/5-");
    expect(banners[1]).toContain("/worktrees/issue-5-foo");
    expect(banners[2]).toContain("/worktrees/issue-5-foo");
    // Each transcript's content rendered.
    expect(out.match(/🏛️ SYSTEM/g)?.length).toBe(3);
  });

  it("with --issue + substring, filters basenames", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl", "critic-01.jsonl"]);

    const { stream, text } = makeStdout();
    runLogViewCommand({ issueNumber: 5, worktreePath: tmp, stdout: stream, name: "critic" });
    const out = strip(text());

    const banners = out.split("\n").filter((l) => /═{6} .+\.jsonl {2}\(/.test(l));
    // Only one file matches and it is the only file, so no banners (single-file path).
    expect(banners).toHaveLength(0);
    expect(out).toMatch(/🏛️ SYSTEM/);
  });

  it("with --issue, a bare role name matches every transcript with that prefix", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl", "planner-02.jsonl", "critic-01.jsonl"]);

    const { stream, text } = makeStdout();
    runLogViewCommand({ issueNumber: 5, worktreePath: tmp, stdout: stream, name: "planner" });
    const out = strip(text());

    const banners = out.split("\n").filter((l) => /═{6} .+\.jsonl {2}\(/.test(l));
    expect(banners).toHaveLength(2);
    expect(banners.every((l) => l.includes("planner-"))).toBe(true);
    expect(banners.some((l) => l.includes("critic-"))).toBe(false);
  });

  it("with --issue, throws when no matching transcripts exist", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl"]);
    expect(() => runLogViewCommand({ issueNumber: 999, worktreePath: tmp, stdout: makeStdout().stream })).toThrow(
      /no transcripts found for issue 999/,
    );
  });

  it("with --issue, throws an explanatory error when the substring matches nothing", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl"]);
    expect(() =>
      runLogViewCommand({ issueNumber: 5, worktreePath: tmp, stdout: makeStdout().stream, name: "reviewer" }),
    ).toThrow(/no transcripts for issue 5 match "reviewer"/);
  });

  it("with --issue, treats regex meta-characters as literals and reports no match", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl", "critic-01.jsonl"]);
    expect(() =>
      runLogViewCommand({ issueNumber: 5, worktreePath: tmp, stdout: makeStdout().stream, name: "(.*)" }),
    ).toThrow(/no transcripts for issue 5 match "\(\.\*\)"/);
  });

  it("with --issue, ignores worktrees whose state.json belongs to other issues", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl"]);
    seedActiveWorktree(tmp, "issue-8-bar", 8, ["planner-01.jsonl"]);

    const paths = findTranscriptsForIssue(5, tmp);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("issue-5-foo");
    expect(paths[0]).not.toContain("issue-8-bar");
  });
});

describe("findTranscriptsForIssue", () => {
  it("finds transcripts in active worktrees and archive for one issue", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl", "critic-01.jsonl"]);
    seedArchive(tmp, "5-2026-05-08T12:14:58.270Z", ["planner-01.jsonl"]);
    seedArchive(tmp, "8-2026-05-08T01:00:00.000Z", ["planner-01.jsonl"]);

    const paths = findTranscriptsForIssue(5, tmp);
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => !p.includes("8-2026-05-08T01:00:00.000Z"))).toBe(true);
    expect(paths).toEqual([...paths].sort());
  });

  it("filters by basename substring", () => {
    seedActiveWorktree(tmp, "issue-5-foo", 5, ["planner-01.jsonl", "critic-01.jsonl"]);
    const paths = findTranscriptsForIssue(5, tmp, "critic");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/critic-01\.jsonl$/);
  });

  it("throws when no transcripts exist for the issue", () => {
    expect(() => findTranscriptsForIssue(7, tmp)).toThrow(LogViewError);
  });
});

function seedActiveWorktree(root: string, dirName: string, issueNumber: number, files: string[]): void {
  const wt = join(root, "worktrees", dirName);
  const stateDir = join(wt, ".minesweeper");
  const planningDir = join(stateDir, "planning_history");
  mkdirSync(planningDir, { recursive: true });
  const now = "2026-05-08T12:00:00.000Z";
  writeFileSync(
    join(stateDir, "state.json"),
    JSON.stringify({
      version: 2,
      issueNumber,
      branchName: dirName,
      mode: "Planning",
      status: "InProgress",
      iterations: 0,
      maxIterations: 5,
      assessment: null,
      assessmentReason: null,
      startedAt: now,
      updatedAt: now,
    }),
  );
  for (const f of files) writeFileSync(join(planningDir, f), FIXTURE_TEXT);
}

function seedArchive(root: string, dirName: string, files: string[]): void {
  const planningDir = join(root, "archive", dirName, "planning_history");
  mkdirSync(planningDir, { recursive: true });
  for (const f of files) writeFileSync(join(planningDir, f), FIXTURE_TEXT);
}
