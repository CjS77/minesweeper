import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openTranscript, transcriptPathFor } from "../transcript.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "minesweeper-transcript-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("transcriptPathFor", () => {
  it("zero-pads iteration to two digits and lives under .minesweeper/planning_history", () => {
    const path = transcriptPathFor({ cwd: "/x", role: "planner", iteration: 3 });
    expect(path).toBe("/x/.minesweeper/planning_history/planner-03.jsonl");
  });

  it("rejects non-positive iterations", () => {
    expect(() => transcriptPathFor({ cwd: "/x", role: "planner", iteration: 0 })).toThrow(/positive integer/);
    expect(() => transcriptPathFor({ cwd: "/x", role: "planner", iteration: -1 })).toThrow();
  });
});

describe("openTranscript", () => {
  it("creates the transcript directory and writes one JSON object per line", async () => {
    const transcript = openTranscript({ cwd: tempDir, role: "critic", iteration: 1 });
    transcript.write({ type: "assistant", text: "hello" });
    transcript.write({ type: "result", subtype: "success", result: "ok" });
    await transcript.close();

    const expected = join(tempDir, ".minesweeper/planning_history/critic-01.jsonl");
    expect(transcript.path).toBe(expected);
    const lines = readFileSync(expected, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "assistant", text: "hello" });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "result", subtype: "success", result: "ok" });
  });

  it("appends across two openings of the same (role, iteration)", async () => {
    const a = openTranscript({ cwd: tempDir, role: "planner", iteration: 2 });
    a.write({ n: 1 });
    await a.close();
    const b = openTranscript({ cwd: tempDir, role: "planner", iteration: 2 });
    b.write({ n: 2 });
    await b.close();

    const lines = readFileSync(join(tempDir, ".minesweeper/planning_history/planner-02.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });
});
