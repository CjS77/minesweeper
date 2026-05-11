import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import chalk from "chalk";
import { execa } from "execa";
import { loadConfig } from "../../config.js";
import { createLogger, resetLoggerForTest } from "../../logging.js";
import { buildLabelSpecs, parsePromptAnswer, runLabelsCommand } from "../labels.js";

// Force chalk to emit ANSI in tests; vitest's pipe stdout otherwise auto-disables colour.
chalk.level = 3;

const mockExeca = vi.mocked(execa);

interface FakeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ok = (stdout = ""): FakeResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): FakeResult => ({ stdout: "", stderr, exitCode: 1 });

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");

let tmp: string;

function makeStdout(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}

function upsertCalls(): readonly (readonly string[])[] {
  return mockExeca.mock.calls
    .filter(([, args]) => {
      const a = args as readonly string[];
      return a[0] === "label" && a[1] === "create";
    })
    .map(([, args]) => args as readonly string[]);
}

beforeEach(() => {
  mockExeca.mockReset();
  tmp = mkdtempSync(join(tmpdir(), "minesweeper-labels-"));
  createLogger({
    filePath: join(tmp, "logs", "test.log"),
    quiet: true,
    sync: true,
    stdout: new PassThrough(),
  });
});

afterEach(async () => {
  resetLoggerForTest();
  mockExeca.mockReset();
  await rm(tmp, { recursive: true, force: true });
});

describe("buildLabelSpecs", () => {
  it("uses the configured label names from env", () => {
    const config = loadConfig(
      {
        MINESWEEPER_ALWAYS_FIX_LABEL: "fix-me",
        MINESWEEPER_NEVER_FIX_LABEL: "hands-off",
        MINESWEEPER_SUBTASK_LABEL: "child-of",
      },
      { configFile: null },
    );
    const byKey = Object.fromEntries(buildLabelSpecs(config).map((s) => [s.key, s]));
    expect(byKey["alwaysFix"]?.name).toBe("fix-me");
    expect(byKey["neverFix"]?.name).toBe("hands-off");
    expect(byKey["subtask"]?.name).toBe("child-of");
  });

  it("covers every Minesweeper label exactly once", () => {
    const specs = buildLabelSpecs(loadConfig({}, { configFile: null }));
    const keys = specs.map((s) => s.key).sort();
    expect(keys).toEqual([
      "alwaysFix",
      "failed",
      "manuallyApproved",
      "neverFix",
      "possiblyDangerous",
      "subtask",
      "tryFix",
    ]);
  });

  it("registers the tryFix label with the configured name and a non-default colour", () => {
    const config = loadConfig({ MINESWEEPER_TRY_FIX_LABEL: "screen-me" }, { configFile: null });
    const byKey = Object.fromEntries(buildLabelSpecs(config).map((s) => [s.key, s]));
    expect(byKey["tryFix"]?.name).toBe("screen-me");
    expect(byKey["tryFix"]?.color).toMatch(/^[0-9A-Fa-f]{6}$/);
    expect(byKey["tryFix"]?.color).not.toBe(byKey["alwaysFix"]?.color);
  });

  it("uses 6-char hex colours without a leading hash", () => {
    for (const spec of buildLabelSpecs(loadConfig({}, { configFile: null }))) {
      expect(spec.color).toMatch(/^[0-9A-Fa-f]{6}$/);
    }
  });

  it("gives every label a non-empty description", () => {
    for (const spec of buildLabelSpecs(loadConfig({}, { configFile: null }))) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });
});

describe("parsePromptAnswer", () => {
  it.each([
    ["o", "overwrite"],
    ["O", "overwrite"],
    ["overwrite", "overwrite"],
    ["OVERWRITE", "overwrite"],
    ["y", "new-only"],
    ["Y", "new-only"],
    ["new", "new-only"],
    ["new-only", "new-only"],
    ["a", "abort"],
    ["A", "abort"],
    ["abort", "abort"],
    ["", "abort"], // empty defaults to safe choice
    ["maybe", "abort"], // unrecognised → abort
    ["  o  ", "overwrite"], // trims whitespace
  ])("maps %j to %s", (input, expected) => {
    expect(parsePromptAnswer(input)).toBe(expected);
  });
});

describe("runLabelsCommand --list", () => {
  it("prints the labels currently registered on the repo and makes no mutations", async () => {
    const repoLabels = [
      { name: "bug", color: "d73a4a", description: "Something is broken" },
      { name: "autofix", color: "0e8a16", description: "auto-handled" },
      { name: "documentation", color: "0075ca", description: "Docs change" },
    ];
    mockExeca.mockResolvedValueOnce(ok(JSON.stringify(repoLabels)) as never);

    const out = makeStdout();
    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      list: true,
      stdout: out.stream,
    });

    // Exactly one gh call — `gh label list` — and no mutating calls.
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const args = mockExeca.mock.calls[0]?.[1] as readonly string[];
    expect(args.slice(0, 2)).toEqual(["label", "list"]);
    expect(upsertCalls()).toHaveLength(0);

    expect(result.listed).toEqual(repoLabels);
    expect(result.upserted).toEqual([]);

    const text = strip(out.text());
    expect(text).toMatch(/Labels on this repo \(3\):/);
    expect(text).toContain("bug");
    expect(text).toContain("autofix");
    expect(text).toContain("documentation");
    expect(text).toContain("Something is broken");
    // No "Proposed Minesweeper labels" header in --list mode.
    expect(text).not.toMatch(/Proposed Minesweeper labels/);
  });

  it("forwards cwd to gh label list", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      list: true,
      cwd: "/some/repo",
      stdout: makeStdout().stream,
    });
    expect((mockExeca.mock.calls[0]?.[2] as { cwd?: string }).cwd).toBe("/some/repo");
  });

  it("handles a repo with no labels", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    const out = makeStdout();
    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      list: true,
      stdout: out.stream,
    });
    expect(result.listed).toEqual([]);
    expect(strip(out.text())).toMatch(/No labels currently exist on this repo/);
  });

  it("emits ANSI colour for label names", async () => {
    mockExeca.mockResolvedValueOnce(ok(JSON.stringify([{ name: "bug", color: "d73a4a", description: "x" }])) as never);
    const out = makeStdout();
    await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      list: true,
      stdout: out.stream,
    });
    expect(out.text()).toMatch(ANSI);
  });
});

describe("runLabelsCommand confirmation flow", () => {
  it("upserts every spec when force is set, after listing pre-existing labels", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never); // listLabels
    mockExeca.mockResolvedValue(ok("") as never); // upserts

    const out = makeStdout();
    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: "/repo",
      force: true,
      stdout: out.stream,
    });

    expect(result.upserted).toHaveLength(7);
    const names = upsertCalls().map((a) => a[2]);
    expect(names).toEqual([
      "autofix",
      "tryFix",
      "manual",
      "possiblyDangerous",
      "manuallyReviewed",
      "minesweeperFailed",
      "subtask",
    ]);
    for (const args of upsertCalls()) {
      expect(args).toContain("--force");
      expect(args).toContain("--color");
      expect(args).toContain("--description");
    }
  });

  it("forwards cwd to every gh call", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    mockExeca.mockResolvedValue(ok("") as never);
    await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: "/some/repo",
      force: true,
      stdout: makeStdout().stream,
    });
    for (const call of mockExeca.mock.calls) {
      const opts = call[2] as { cwd?: string };
      expect(opts.cwd).toBe("/some/repo");
    }
  });

  it("prompts when force is not set, and aborts on (A)bort", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never); // listLabels
    const out = makeStdout();
    const prompt = vi.fn().mockResolvedValue("abort" as const);

    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      stdout: out.stream,
      prompt,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    const question = prompt.mock.calls[0]?.[0] as string;
    expect(question).toMatch(/\(A\)bort/i);
    expect(question).toMatch(/\(O\)verwrite/i);
    expect(question).toMatch(/onl\(Y\)/i);
    expect(question).toContain("[A/O/Y]");
    expect(result.cancelled).toBe(true);
    expect(result.upserted).toEqual([]);
    expect(upsertCalls()).toHaveLength(0);
    expect(strip(out.text())).toMatch(/Aborted/);
  });

  it("upserts everything when prompt returns 'overwrite'", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    mockExeca.mockResolvedValue(ok("") as never);
    const prompt = vi.fn().mockResolvedValue("overwrite" as const);

    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      stdout: makeStdout().stream,
      prompt,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.upserted).toHaveLength(7);
    expect(upsertCalls()).toHaveLength(7);
  });

  it("'new-only' skips existing labels and only creates the missing ones", async () => {
    // Two of the canonical labels already exist; four don't.
    mockExeca.mockResolvedValueOnce(
      ok(
        JSON.stringify([
          { name: "autofix", color: "ffffff", description: "old" },
          { name: "subtask", color: "ffffff", description: "old" },
          { name: "bug", color: "d73a4a", description: "Something is broken" },
        ]),
      ) as never,
    );
    mockExeca.mockResolvedValue(ok("") as never);

    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      stdout: makeStdout().stream,
      prompt: async () => "new-only",
    });

    expect(result.newOnly).toBe(true);
    const created = upsertCalls().map((a) => a[2]);
    expect(created).toEqual(["tryFix", "manual", "possiblyDangerous", "manuallyReviewed", "minesweeperFailed"]);
    // autofix and subtask must NOT be re-upserted.
    expect(created).not.toContain("autofix");
    expect(created).not.toContain("subtask");
  });

  it("'new-only' is a no-op when every proposed label already exists", async () => {
    const allCanonical = [
      "autofix",
      "tryFix",
      "manual",
      "possiblyDangerous",
      "manuallyReviewed",
      "minesweeperFailed",
      "subtask",
    ].map((name) => ({ name, color: "ffffff", description: "" }));
    mockExeca.mockResolvedValueOnce(ok(JSON.stringify(allCanonical)) as never);

    const out = makeStdout();
    const result = await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      stdout: out.stream,
      prompt: async () => "new-only",
    });

    expect(result.newOnly).toBe(true);
    expect(result.upserted).toEqual([]);
    expect(upsertCalls()).toHaveLength(0);
    expect(strip(out.text())).toMatch(/already exists?/);
  });

  it("only renders existing labels that clash with the planned writes", async () => {
    mockExeca.mockResolvedValueOnce(
      ok(
        JSON.stringify([
          { name: "bug", color: "d73a4a", description: "Something is broken" },
          { name: "autofix", color: "0e8a16", description: "old description" },
          { name: "documentation", color: "0075ca", description: "Docs" },
        ]),
      ) as never,
    );
    const out = makeStdout();
    await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      stdout: out.stream,
      prompt: async () => "abort",
    });
    const text = strip(out.text());
    // Header reflects the count of clashes (1 — autofix only).
    expect(text).toMatch(/Clashing labels.*\(1\b/);
    // 'autofix' clashes (also appears in the proposed section above, so we
    // can't assert a count, but the clash header confirms it).
    expect(text).toContain("autofix");
    // Non-clashing labels must not be listed.
    expect(text).not.toContain("bug");
    expect(text).not.toContain("documentation");
  });

  it("reports 'no clashes' when none of the proposed labels exist on the repo", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    const out = makeStdout();
    await runLabelsCommand({
      config: loadConfig({}, { configFile: null }),
      stdout: out.stream,
      prompt: async () => "abort",
    });
    expect(strip(out.text())).toMatch(/No clashes/i);
  });

  it("attempts every spec even when one upsert fails, then rethrows the first error", async () => {
    mockExeca
      .mockResolvedValueOnce(ok("[]") as never) // listLabels
      .mockResolvedValueOnce(ok("") as never)
      .mockResolvedValueOnce(fail("HTTP 422: validation failed") as never)
      .mockResolvedValue(ok("") as never);

    await expect(
      runLabelsCommand({
        config: loadConfig({}, { configFile: null }),
        force: true,
        stdout: makeStdout().stream,
      }),
    ).rejects.toThrow(/422/);
    expect(upsertCalls()).toHaveLength(7);
  });
});
