import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import type { Issue } from "../../github/index.js";
import type { OrphanedWorktree } from "../../worktree.js";
import { parseIssueDraft, runIssueListCommand, runIssueNewCommand } from "../issues.js";

// Force chalk to emit ANSI in tests; vitest's pipe stdout otherwise auto-disables colour.
chalk.level = 3;

const mockExeca = vi.mocked(execa);

interface FakeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ok = (stdout = ""): FakeResult => ({ stdout, stderr: "", exitCode: 0 });

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

function makeIssue(overrides: Partial<Issue> & Pick<Issue, "number" | "title">): Issue {
  return {
    number: overrides.number,
    title: overrides.title,
    body: overrides.body ?? "",
    labels: overrides.labels ?? [],
    author: overrides.author ?? { login: "octocat" },
    state: overrides.state ?? "OPEN",
    url: overrides.url ?? `https://github.com/example/repo/issues/${overrides.number}`,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    ...(overrides.comments ? { comments: overrides.comments } : {}),
  };
}

function fakeGithub(issues: Issue[]): { listIssues: ReturnType<typeof vi.fn> } {
  return { listIssues: vi.fn().mockResolvedValue(issues) };
}

function fakeWorktree(orphans: OrphanedWorktree[]): { listOrphans: ReturnType<typeof vi.fn> } {
  return { listOrphans: vi.fn().mockResolvedValue(orphans) };
}

beforeEach(() => {
  mockExeca.mockReset();
  tmp = mkdtempSync(join(tmpdir(), "minesweeper-issues-"));
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

describe("runIssueListCommand — gh argument shape (Strategy A: execa boundary)", () => {
  it("invokes gh with --state open --limit 1000 to beat the silent default of 30", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);

    await runIssueListCommand({
      config: loadConfig({ MINESWEEPER_WORKTREE_PATH: tmp }, { configFile: null }),
      cwd: tmp,
      stdout: makeStdout().stream,
    });

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const args = mockExeca.mock.calls[0]?.[1] as readonly string[];
    expect(args.slice(0, 6)).toEqual(["issue", "list", "--state", "open", "--limit", "1000"]);
    expect(args).toContain("--json");
  });

  it("forwards cwd to gh", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);

    await runIssueListCommand({
      config: loadConfig({ MINESWEEPER_WORKTREE_PATH: tmp }, { configFile: null }),
      cwd: "/some/repo",
      stdout: makeStdout().stream,
    });

    const callOpts = mockExeca.mock.calls[0]?.[2] as { cwd?: string };
    expect(callOpts.cwd).toBe("/some/repo");
  });
});

describe("runIssueListCommand — eligibility tagging (Strategy B: module override)", () => {
  it("tags issues with the autofix label as [eligible] when defaultEligible=false", async () => {
    const issues = [
      makeIssue({ number: 1, title: "fix something", labels: [{ name: "autofix" }] }),
      makeIssue({ number: 2, title: "leave alone", labels: [] }),
    ];
    const out = makeStdout();
    const result = await runIssueListCommand({
      config: loadConfig({}, { configFile: null }),
      github: fakeGithub(issues),
      worktree: fakeWorktree([]),
      stdout: out.stream,
    });

    expect(result.rows).toEqual([
      { number: 1, title: "fix something", eligible: true, inProgress: null },
      { number: 2, title: "leave alone", eligible: false, inProgress: null },
    ]);
    const text = strip(out.text());
    expect(text).toMatch(/#1\s+fix something\s+\[eligible\]/);
    expect(text).toMatch(/#2\s+leave alone(?!\s+\[eligible\])/);
  });

  it("does NOT mark issues with the manual label as eligible (hard opt-out)", async () => {
    const issues = [
      makeIssue({
        number: 7,
        title: "humans only",
        labels: [{ name: "autofix" }, { name: "manual" }],
      }),
    ];
    const result = await runIssueListCommand({
      config: loadConfig({}, { configFile: null }),
      github: fakeGithub(issues),
      worktree: fakeWorktree([]),
      stdout: makeStdout().stream,
    });

    expect(result.rows[0]?.eligible).toBe(false);
  });

  it("tags issues with a matching state.json as [in-progress: <Mode>/<Status>] in orange", async () => {
    const issues = [makeIssue({ number: 5, title: "in flight" })];
    const orphan: OrphanedWorktree = {
      path: "/fake/worktrees/example-issue5",
      state: {
        version: 1,
        issueNumber: 5,
        branchName: "example-issue5",
        mode: "Planning",
        status: "InProgress",
        iterations: 0,
        maxIterations: 5,
        assessment: null,
        startedAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    };
    const out = makeStdout();
    const result = await runIssueListCommand({
      config: loadConfig({}, { configFile: null }),
      github: fakeGithub(issues),
      worktree: fakeWorktree([orphan]),
      stdout: out.stream,
    });

    expect(result.rows[0]?.inProgress).toEqual({ mode: "Planning", status: "InProgress" });
    const stripped = strip(out.text());
    expect(stripped).toContain("[in-progress: Planning/InProgress]");
    // Orange hex `#d93f0b` → 24-bit ANSI sequence containing 217;63;11.
    expect(out.text()).toContain("217;63;11");
  });

  it("renders [in-progress: …] before [eligible] when both apply", async () => {
    const issues = [makeIssue({ number: 9, title: "both", labels: [{ name: "autofix" }] })];
    const orphan: OrphanedWorktree = {
      path: "/fake/worktrees/example-issue9",
      state: {
        version: 1,
        issueNumber: 9,
        branchName: "example-issue9",
        mode: "Execution",
        status: "Writing",
        iterations: 1,
        maxIterations: 5,
        assessment: null,
        startedAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    };
    const out = makeStdout();
    const result = await runIssueListCommand({
      config: loadConfig({}, { configFile: null }),
      github: fakeGithub(issues),
      worktree: fakeWorktree([orphan]),
      stdout: out.stream,
    });

    expect(result.rows[0]).toEqual({
      number: 9,
      title: "both",
      eligible: true,
      inProgress: { mode: "Execution", status: "Writing" },
    });
    const stripped = strip(out.text());
    const inProgressIdx = stripped.indexOf("[in-progress:");
    const eligibleIdx = stripped.indexOf("[eligible]");
    expect(inProgressIdx).toBeGreaterThan(-1);
    expect(eligibleIdx).toBeGreaterThan(-1);
    expect(inProgressIdx).toBeLessThan(eligibleIdx);
  });

  it("prints 'No open issues.' and returns rows: [] when the list is empty", async () => {
    const out = makeStdout();
    const result = await runIssueListCommand({
      config: loadConfig({}, { configFile: null }),
      github: fakeGithub([]),
      worktree: fakeWorktree([]),
      stdout: out.stream,
    });

    expect(result.rows).toEqual([]);
    expect(strip(out.text())).toMatch(/No open issues\./);
    expect(strip(out.text())).not.toMatch(/Open issues \(/);
  });

  it("uses the worktree.listOrphans override and never touches the filesystem", async () => {
    const wt = fakeWorktree([]);
    await runIssueListCommand({
      config: loadConfig({ MINESWEEPER_WORKTREE_PATH: "/definitely/does/not/exist" }, { configFile: null }),
      github: fakeGithub([]),
      worktree: wt,
      stdout: makeStdout().stream,
    });
    expect(wt.listOrphans).toHaveBeenCalledTimes(1);
    // The override gets the resolved <worktreePath>/worktrees path.
    expect(wt.listOrphans.mock.calls[0]?.[0]).toBe("/definitely/does/not/exist/worktrees");
  });
});

function strictDraft(title: string, body: string): string {
  return `TITLE: ${title}\n---\n${body}`;
}

function fakeClaude(finalText: string): {
  runSubagent: ReturnType<typeof vi.fn>;
} {
  return {
    runSubagent: vi.fn().mockResolvedValue({
      finalText,
      events: 1,
      durationMs: 10,
      stopReason: "end_turn",
      transcriptPath: "/tmp/fake-transcript.jsonl",
    }),
  };
}

function fakeGithubCreate(
  number: number,
  url: string,
  failedLabels?: { label: string; reason: string }[],
): {
  createIssue: ReturnType<typeof vi.fn>;
} {
  return {
    createIssue: vi.fn().mockResolvedValue(failedLabels ? { number, url, failedLabels } : { number, url }),
  };
}

const NOOP_EDIT = async (): Promise<void> => undefined;
const EMPTY_STDIN = async (): Promise<string> => "";

describe("parseIssueDraft", () => {
  it("splits the strict TITLE:/--- form", () => {
    const out = parseIssueDraft("TITLE: feat: do the thing\n---\n## Problem\n\nIt is broken.\n");
    expect(out.title).toBe("feat: do the thing");
    expect(out.body).toBe("## Problem\n\nIt is broken.");
  });

  it("falls back to first-line/rest when markers are missing", () => {
    const out = parseIssueDraft("# bug: something\n\nA paragraph.\n");
    expect(out.title).toBe("bug: something");
    expect(out.body).toBe("A paragraph.");
  });

  it("returns empty title and body on whitespace-only input", () => {
    const out = parseIssueDraft("   \n  \n");
    expect(out).toEqual({ title: "", body: "" });
  });

  it("tolerates a preamble before the TITLE: line", () => {
    const out = parseIssueDraft("Here is the issue you asked for.\n\nTITLE: feat: x\n---\n## Problem\n\nbody\n");
    expect(out.title).toBe("feat: x");
    expect(out.body).toBe("## Problem\n\nbody");
  });

  it("parses YAML front-matter with a title key", () => {
    const out = parseIssueDraft("---\ntitle: feat: x\n---\n## Problem\n\ny\n");
    expect(out.title).toBe("feat: x");
    expect(out.body).toBe("## Problem\n\ny");
  });

  it("strips surrounding quotes from a front-matter title", () => {
    const out = parseIssueDraft('---\ntitle: "feat: x"\n---\n## Problem\n\ny\n');
    expect(out.title).toBe("feat: x");
  });

  it("never yields a '---' title when front-matter has no closing fence", () => {
    const out = parseIssueDraft("---\nbug: the daemon crashes on startup\n\nIt dies immediately.\n");
    expect(out.title).toBe("bug: the daemon crashes on startup");
    expect(out.body).toBe("It dies immediately.");
  });

  it("unwraps a whole reply wrapped in a fenced code block", () => {
    const out = parseIssueDraft("```\nTITLE: feat: x\n---\n## Problem\n\nbody\n```");
    expect(out.title).toBe("feat: x");
    expect(out.body).toBe("## Problem\n\nbody");
  });
});

describe("runIssueNewCommand", () => {
  it("calls the issuewriter and createIssue, applying the autofix label by default", async () => {
    const out = makeStdout();
    const claude = fakeClaude(strictDraft("feat: hello", "## Problem\n\nworld."));
    const github = fakeGithubCreate(42, "https://github.com/example/repo/issues/42");
    const labelsCommand = { runLabelsCommand: vi.fn().mockResolvedValue({ upserted: [] }) };

    const result = await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "hello world",
      autoConfirm: true,
      stdout: out.stream,
      claude,
      github,
      labelsCommand,
      readStdin: EMPTY_STDIN,
      editDraft: NOOP_EDIT,
    });

    expect(result).toEqual({
      issueNumber: 42,
      url: "https://github.com/example/repo/issues/42",
      failedLabels: [],
    });
    // No label failure → the labels command stays untouched and no warning prints.
    expect(labelsCommand.runLabelsCommand).not.toHaveBeenCalled();
    expect(strip(out.text())).not.toContain("⚠");
    expect(claude.runSubagent).toHaveBeenCalledTimes(1);
    const claudeArgs = claude.runSubagent.mock.calls[0]?.[0] as { role: string; userPrompt: string };
    expect(claudeArgs.role).toBe("issuewriter");
    expect(claudeArgs.userPrompt).toContain("hello world");
    expect(github.createIssue).toHaveBeenCalledTimes(1);
    expect(github.createIssue.mock.calls[0]?.[0]).toMatchObject({
      title: "feat: hello",
      body: "## Problem\n\nworld.",
      labels: ["autofix"],
      cwd: tmp,
    });
  });

  it("with -n omits the autofix label", async () => {
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: true,
      addAutoFixLabel: false,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: EMPTY_STDIN,
      editDraft: NOOP_EDIT,
    });

    expect(github.createIssue.mock.calls[0]?.[0]).toMatchObject({ labels: [] });
  });

  it("with -y skips the editor confirmation step", async () => {
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");
    const editDraft = vi.fn(NOOP_EDIT);

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: true,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: EMPTY_STDIN,
      editDraft,
    });

    expect(editDraft).not.toHaveBeenCalled();
  });

  it("opens the editor when -y is omitted, then uses the saved file", async () => {
    const claude = fakeClaude(strictDraft("original", "first body"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");
    const editDraft = vi.fn(async (path: string) => {
      writeFileSync(path, "TITLE: edited\n---\nrewritten body\n", "utf-8");
    });

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: false,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: EMPTY_STDIN,
      editDraft,
    });

    expect(editDraft).toHaveBeenCalledTimes(1);
    expect(github.createIssue.mock.calls[0]?.[0]).toMatchObject({
      title: "edited",
      body: "rewritten body",
    });
  });

  it("aborts (throws) when the editor leaves the draft empty", async () => {
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");
    const editDraft = vi.fn(async (path: string) => {
      writeFileSync(path, "", "utf-8");
    });

    await expect(
      runIssueNewCommand({
        config: loadConfig({}, { configFile: null }),
        cwd: tmp,
        message: "x",
        autoConfirm: false,
        stdout: makeStdout().stream,
        claude,
        github,
        readStdin: EMPTY_STDIN,
        editDraft,
      }),
    ).rejects.toThrow(/emptied in the editor/);
    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("appends -f file contents to the user prompt", async () => {
    const filePath = join(tmp, "extra.md");
    writeFileSync(filePath, "EXTRA_CONTEXT_MARKER: panic when foo=42", "utf-8");
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "short framing",
      filePath,
      autoConfirm: true,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: EMPTY_STDIN,
      editDraft: NOOP_EDIT,
    });

    const prompt = claude.runSubagent.mock.calls[0]?.[0].userPrompt as string;
    expect(prompt).toContain("short framing");
    expect(prompt).toContain("EXTRA_CONTEXT_MARKER: panic when foo=42");
  });

  it("reads from stdin when message and -f are empty", async () => {
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "",
      autoConfirm: true,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: async () => "PIPED_INPUT: the daemon crashes on startup",
      editDraft: NOOP_EDIT,
    });

    const prompt = claude.runSubagent.mock.calls[0]?.[0].userPrompt as string;
    expect(prompt).toContain("PIPED_INPUT: the daemon crashes on startup");
  });

  it("throws when message, -f, and stdin are all empty", async () => {
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");

    await expect(
      runIssueNewCommand({
        config: loadConfig({}, { configFile: null }),
        cwd: tmp,
        message: "",
        autoConfirm: true,
        stdout: makeStdout().stream,
        claude,
        github,
        readStdin: EMPTY_STDIN,
        editDraft: NOOP_EDIT,
      }),
    ).rejects.toThrow(/no input provided/);
    expect(claude.runSubagent).not.toHaveBeenCalled();
    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("falls back to first-line/rest when Claude's output has no TITLE:/--- markers", async () => {
    const claude = fakeClaude("# loose: malformed draft\n\nbody paragraph\n");
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: true,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: EMPTY_STDIN,
      editDraft: NOOP_EDIT,
    });

    expect(github.createIssue.mock.calls[0]?.[0]).toMatchObject({
      title: "loose: malformed draft",
      body: "body paragraph",
    });
  });

  it("writes the draft tmpfile and passes its path to editDraft", async () => {
    const claude = fakeClaude(strictDraft("draft-title", "draft body"));
    const github = fakeGithubCreate(1, "https://github.com/example/repo/issues/1");
    let observedPath = "";
    const editDraft = vi.fn(async (path: string) => {
      observedPath = path;
      // Leave the file unchanged.
    });

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: false,
      stdout: makeStdout().stream,
      claude,
      github,
      readStdin: EMPTY_STDIN,
      editDraft,
    });

    expect(observedPath).toMatch(/issue-draft\.md$/);
    const written = readFileSync(observedPath, "utf-8");
    expect(written).toContain("TITLE: draft-title");
    expect(written).toContain("draft body");
  });

  it("prints a warning and runs the labels command when a label could not be applied", async () => {
    const out = makeStdout();
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(7, "https://github.com/example/repo/issues/7", [
      { label: "autofix", reason: "could not add label: 'autofix' not found" },
    ]);
    const labelsCommand = { runLabelsCommand: vi.fn().mockResolvedValue({ upserted: [] }) };

    const result = await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: false,
      stdout: out.stream,
      claude,
      github,
      labelsCommand,
      readStdin: EMPTY_STDIN,
      editDraft: NOOP_EDIT,
    });

    // The issue was still filed — exit-0 path, no throw.
    expect(result.issueNumber).toBe(7);
    expect(result.url).toBe("https://github.com/example/repo/issues/7");
    expect(result.failedLabels).toEqual([{ label: "autofix", reason: "could not add label: 'autofix' not found" }]);

    const text = strip(out.text());
    expect(text).toContain('⚠ could not apply label "autofix"');
    expect(text).toContain("not found");
    expect(labelsCommand.runLabelsCommand).toHaveBeenCalledTimes(1);
    expect(labelsCommand.runLabelsCommand.mock.calls[0]?.[0]).toMatchObject({ cwd: tmp });
  });

  it("with -y prints the fallback hint instead of prompting", async () => {
    const out = makeStdout();
    const claude = fakeClaude(strictDraft("t", "b"));
    const github = fakeGithubCreate(8, "https://github.com/example/repo/issues/8", [
      { label: "autofix", reason: "not found" },
    ]);
    const labelsCommand = { runLabelsCommand: vi.fn().mockResolvedValue({ upserted: [] }) };

    await runIssueNewCommand({
      config: loadConfig({}, { configFile: null }),
      cwd: tmp,
      message: "x",
      autoConfirm: true,
      stdout: out.stream,
      claude,
      github,
      labelsCommand,
      readStdin: EMPTY_STDIN,
      editDraft: NOOP_EDIT,
    });

    const text = strip(out.text());
    expect(text).toContain("Run `minesweeper labels` to create the missing labels.");
    expect(labelsCommand.runLabelsCommand).not.toHaveBeenCalled();
  });
});
