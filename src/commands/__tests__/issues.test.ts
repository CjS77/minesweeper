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
import type { Issue } from "../../github/index.js";
import type { OrphanedWorktree } from "../../worktree.js";
import { runIssueListCommand, runIssueNewCommand } from "../issues.js";

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
});

afterEach(async () => {
  mockExeca.mockReset();
  await rm(tmp, { recursive: true, force: true });
});

describe("runIssueListCommand — gh argument shape (Strategy A: execa boundary)", () => {
  it("invokes gh with --state open --limit 1000 to beat the silent default of 30", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);

    await runIssueListCommand({
      config: loadConfig({ MINESWEEPER_WORKTREE_PATH: tmp }),
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
      config: loadConfig({ MINESWEEPER_WORKTREE_PATH: tmp }),
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
      config: loadConfig({}),
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
      config: loadConfig({}),
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
      config: loadConfig({}),
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
      config: loadConfig({}),
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
      config: loadConfig({}),
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
      config: loadConfig({ MINESWEEPER_WORKTREE_PATH: "/definitely/does/not/exist" }),
      github: fakeGithub([]),
      worktree: wt,
      stdout: makeStdout().stream,
    });
    expect(wt.listOrphans).toHaveBeenCalledTimes(1);
    // The override gets the resolved <worktreePath>/worktrees path.
    expect(wt.listOrphans.mock.calls[0]?.[0]).toBe("/definitely/does/not/exist/worktrees");
  });
});

describe("runIssueNewCommand", () => {
  it("writes the stub message to stdout", () => {
    const out = makeStdout();
    runIssueNewCommand({ stdout: out.stream });
    expect(out.text()).toContain("not yet implemented");
  });
});
