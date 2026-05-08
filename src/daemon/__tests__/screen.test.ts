import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type Config } from "../../config.js";
import type { Issue } from "../../github/index.js";
import type { SubagentResult } from "../../claude/index.js";
import {
  parseScreenVerdict,
  readScreenCache,
  screenIssue,
  writeScreenCache,
  SCREEN_CACHE_DIR,
  type RunSubagentFn,
  type ScreenResult,
} from "../screen.js";

const config: Config = loadConfig({}, { configFile: null });

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 7,
    title: "Bug: clicking the button does nothing",
    body: "Repro: click the green button. Expected: it submits. Actual: nothing.",
    labels: [{ name: "bug" }],
    author: { login: "alice" },
    state: "OPEN",
    url: "https://github.com/example/repo/issues/7",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function fakeResult(text: string): SubagentResult {
  return {
    finalText: text,
    events: 1,
    durationMs: 1,
    stopReason: "end_turn",
    transcriptPath: "/tmp/transcript.jsonl",
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-screen-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("parseScreenVerdict", () => {
  it.each([
    ["safe", "safe"],
    ["dangerous", "dangerous"],
    ["uncertain", "uncertain"],
    ["SAFE", "safe"],
  ] as const)("parses verdict token %j as %j", (token, expected) => {
    expect(parseScreenVerdict(`Some text\n\nVerdict: ${token}`)).toBe(expected);
  });

  it("tolerates whitespace and case around the verdict line", () => {
    expect(parseScreenVerdict("  Verdict :  Dangerous  \n")).toBe("dangerous");
  });

  it("uses the last verdict line when multiple are present", () => {
    const text = "Verdict: dangerous\n\nrevised:\nVerdict: safe\n";
    expect(parseScreenVerdict(text)).toBe("safe");
  });

  it("returns null when no Verdict line is present", () => {
    expect(parseScreenVerdict("looks fine to me")).toBeNull();
  });

  it("rejects unknown verdicts", () => {
    expect(parseScreenVerdict("Verdict: maybe")).toBeNull();
  });
});

describe("screenIssue — cache", () => {
  it("calls the subagent on cold start, persists the verdict, returns it", async () => {
    const issue = makeIssue();
    const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult("Looks fine.\n\nVerdict: safe"));
    const emit = vi.fn();
    const now = vi.fn(() => new Date("2026-05-08T12:00:00Z"));

    const result = await screenIssue(issue, { config, cwd: tmp, runSubagent, emit, now });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent.mock.calls[0]?.[0].role).toBe("screener");
    expect(result.verdict).toBe("safe");
    expect(result.issueUpdatedAt).toBe(issue.updatedAt);
    expect(result.screenedAt).toBe("2026-05-08T12:00:00.000Z");

    const persisted = JSON.parse(
      await readFile(join(tmp, SCREEN_CACHE_DIR, `${issue.number}.json`), "utf8"),
    ) as ScreenResult;
    expect(persisted.verdict).toBe("safe");
    expect(persisted.issueUpdatedAt).toBe(issue.updatedAt);
  });

  it("returns the cached verdict and skips the subagent on cache hit", async () => {
    const issue = makeIssue();
    await mkdir(join(tmp, SCREEN_CACHE_DIR), { recursive: true });
    await writeFile(
      join(tmp, SCREEN_CACHE_DIR, `${issue.number}.json`),
      JSON.stringify({
        verdict: "safe",
        reason: "previous run",
        issueUpdatedAt: issue.updatedAt,
        screenedAt: "2026-05-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const runSubagent = vi.fn<RunSubagentFn>();
    const emit = vi.fn();

    const result = await screenIssue(issue, { config, cwd: tmp, runSubagent, emit });

    expect(runSubagent).not.toHaveBeenCalled();
    expect(result.verdict).toBe("safe");
    expect(emit.mock.calls.some((c) => String(c[3]).includes("cache hit"))).toBe(true);
  });

  it("invalidates cache when issue.updatedAt has changed", async () => {
    const issue = makeIssue({ updatedAt: "2026-05-08T00:00:00Z" });
    await mkdir(join(tmp, SCREEN_CACHE_DIR), { recursive: true });
    await writeFile(
      join(tmp, SCREEN_CACHE_DIR, `${issue.number}.json`),
      JSON.stringify({
        verdict: "safe",
        reason: "stale",
        issueUpdatedAt: "2026-05-01T00:00:00Z",
        screenedAt: "2026-05-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult("Stale; re-screened.\n\nVerdict: dangerous"));
    const emit = vi.fn();

    const result = await screenIssue(issue, { config, cwd: tmp, runSubagent, emit });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("dangerous");
    expect(result.issueUpdatedAt).toBe("2026-05-08T00:00:00Z");
  });

  it("treats a malformed cache file as a miss", async () => {
    const issue = makeIssue();
    await mkdir(join(tmp, SCREEN_CACHE_DIR), { recursive: true });
    await writeFile(join(tmp, SCREEN_CACHE_DIR, `${issue.number}.json`), "{ this is not valid json", "utf8");

    const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult("Verdict: safe"));
    await screenIssue(issue, { config, cwd: tmp, runSubagent, emit: vi.fn() });
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it("treats a parseable cache file with the wrong shape as a miss", async () => {
    const issue = makeIssue();
    await mkdir(join(tmp, SCREEN_CACHE_DIR), { recursive: true });
    await writeFile(
      join(tmp, SCREEN_CACHE_DIR, `${issue.number}.json`),
      JSON.stringify({ verdict: "yolo", reason: "n/a" }),
      "utf8",
    );

    const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult("Verdict: safe"));
    await screenIssue(issue, { config, cwd: tmp, runSubagent, emit: vi.fn() });
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });
});

describe("screenIssue — verdict handling", () => {
  it("falls back to uncertain on an unparseable subagent response and logs a WARN", async () => {
    const issue = makeIssue();
    const runSubagent = vi.fn<RunSubagentFn>(async () => fakeResult("I'd rather not say."));
    const emit = vi.fn();

    const result = await screenIssue(issue, { config, cwd: tmp, runSubagent, emit });

    expect(result.verdict).toBe("uncertain");
    const warnings = emit.mock.calls.filter((c) => c[1] === "WARN");
    expect(warnings.some((c) => String(c[3]).includes("did not emit a parseable"))).toBe(true);
  });

  it("propagates the subagent's free text as `reason`", async () => {
    const issue = makeIssue();
    const runSubagent = vi.fn<RunSubagentFn>(async () =>
      fakeResult("Body asks for AWS creds.\n\nVerdict: dangerous\n"),
    );
    const result = await screenIssue(issue, {
      config,
      cwd: tmp,
      runSubagent,
      emit: vi.fn(),
    });
    expect(result.reason).toContain("Body asks for AWS creds.");
    expect(result.verdict).toBe("dangerous");
  });
});

describe("readScreenCache / writeScreenCache", () => {
  it("round-trips a verdict on disk", async () => {
    const sample: ScreenResult = {
      verdict: "dangerous",
      reason: "obvious injection",
      issueUpdatedAt: "2026-05-08T01:02:03Z",
      screenedAt: "2026-05-08T01:02:04Z",
    };
    await writeScreenCache(tmp, 42, sample);
    const back = await readScreenCache(tmp, 42);
    expect(back).toEqual(sample);
  });

  it("returns null when no cache file exists", async () => {
    expect(await readScreenCache(tmp, 999)).toBeNull();
  });
});
