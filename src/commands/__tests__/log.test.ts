import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import chalk from "chalk";

import { LogViewError, runLogViewCommand } from "../log.js";

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

  it("renders thinking blocks under an Assistant header", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toMatch(/ASSISTANT \(claude-opus-4-7\) — thinking/);
    expect(out).toContain("considering the task");
  });

  it("renders --:--:-- when no timestamp is available, then formatted time once seen", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    const lines = out.split("\n");
    // The assistant tool_use line for Bash precedes the first user line — should still be --:--:--
    const bashLine = lines.find((l) => l.includes("Bash("));
    expect(bashLine).toMatch(/^--:--:--/);
    // The user tool_result that follows has a real timestamp
    const userToolResult = lines.find((l) => l.includes("tool_result (3 lines)"));
    expect(userToolResult).toMatch(/^\d{2}:\d{2}:\d{2}/);
  });

  it("renders user tool_result with file content as `tool_result <path> (N lines)` plus body", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01"));
    expect(out).toContain("tool_result /tmp/work/prompts/executor.md (63 lines)");
    expect(out).toContain("    line 1");
    expect(out).toContain("    line 5");
  });

  it("respects --max-lines by capping the body and emitting a truncated footer", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01", { maxLines: 2 }));
    expect(out).toContain("    line 1");
    expect(out).toContain("    line 2");
    expect(out).not.toContain("    line 3");
    expect(out).toContain("(truncated 3 more lines)");
  });

  it("--max-lines 0 means unlimited", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const out = strip(runWithFixtureAt("planner-01", { maxLines: 0 }));
    expect(out).toContain("    line 1");
    expect(out).toContain("    line 2");
    expect(out).toContain("    line 3");
    expect(out).toContain("    line 4");
    expect(out).toContain("    line 5");
    expect(out).not.toMatch(/truncated/);
  });

  it("renders is_error tool_result in red while the stripped header still says tool_result", () => {
    writeFixture(".minesweeper/planning_history/planner-01.jsonl");
    const raw = runWithFixtureAt("planner-01");
    const stripped = strip(raw);
    // The error tool_result has an empty stdout (0 lines)
    expect(stripped).toContain("tool_result (0 lines)");
    // Stderr block should appear with command not found
    expect(stripped).toContain("command not found");
    // Red ANSI escape present somewhere in the unstripped output
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
    // The result line is still rendered after the malformed line
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
});
