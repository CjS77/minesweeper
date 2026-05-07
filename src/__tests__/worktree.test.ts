import { promises as fs } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  archiveWorktreeState,
  listOrphans,
  removeWorktree,
  sanitiseBranchName,
} from "../worktree.js";
import { initState, statePath } from "../child/state.js";

let scratch: string;
let repoRoot: string;
let worktreesRoot: string;
let archiveRoot: string;

async function gitInit(dir: string): Promise<void> {
  await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hello\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "minesweeper-wt-"));
  repoRoot = join(scratch, "repo");
  worktreesRoot = join(scratch, "worktrees");
  archiveRoot = join(scratch, "archives");
  await fs.mkdir(repoRoot, { recursive: true });
  await gitInit(repoRoot);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("sanitiseBranchName", () => {
  it("matches the documented example", () => {
    expect(sanitiseBranchName("Fix: bug in foo (issue!)")).toBe("fix-bug-in-foo-issue");
    expect(sanitiseBranchName("minesweeper-issue0001")).toBe("minesweeper-issue0001");
  });

  it("lowercases and replaces forbidden characters with hyphens", () => {
    expect(sanitiseBranchName("Hello World")).toBe("hello-world");
    expect(sanitiseBranchName("foo~bar^baz:qux?quux*[")).toBe("foo-bar-baz-qux-quux");
    expect(sanitiseBranchName("with\ttab\nand\rcr")).toBe("with-tab-and-cr");
    expect(sanitiseBranchName("back\\slash")).toBe("back-slash");
    expect(sanitiseBranchName(";cd /;rm *")).toBe("cd-/-rm");
  });

  it("preserves slashes (namespaced refs)", () => {
    expect(sanitiseBranchName("feature/Fix Login")).toBe("feature/fix-login");
  });

  it("collapses runs of hyphens and dots", () => {
    expect(sanitiseBranchName("a---b")).toBe("a-b");
    expect(sanitiseBranchName("a..b")).toBe("a.b");
    expect(sanitiseBranchName("...weird...")).toBe("weird");
  });

  it("trims leading and trailing dots, slashes, and hyphens", () => {
    expect(sanitiseBranchName("///foo///")).toBe("foo");
    expect(sanitiseBranchName("---foo---")).toBe("foo");
    expect(sanitiseBranchName(".foo.")).toBe("foo");
  });

  it("accepts the canonical {slug}-issue{N} pattern unchanged", () => {
    expect(sanitiseBranchName("minesweeper-issue42")).toBe("minesweeper-issue42");
    expect(sanitiseBranchName("my-repo-issue-007")).toBe("my-repo-issue-007");
  });

  it("throws when the input sanitises to an empty string", () => {
    expect(() => sanitiseBranchName("")).toThrow();
    expect(() => sanitiseBranchName("   ")).toThrow();
    expect(() => sanitiseBranchName("???")).toThrow();
  });

  it("rejects names that would end in .lock", () => {
    expect(() => sanitiseBranchName("foo.lock")).toThrow(/\.lock/);
    expect(() => sanitiseBranchName("foo.lock/bar")).toThrow(/\.lock/);
  });
});

describe("addWorktree", () => {
  it("creates a worktree at worktreesRoot/<branch> with the new branch checked out", async () => {
    const result = await addWorktree({
      repoRoot,
      worktreesRoot,
      branchName: "Fix: bug in foo",
    });

    expect(result.branch).toBe("fix-bug-in-foo");
    expect(result.path).toBe(join(worktreesRoot, "fix-bug-in-foo"));

    const stat = await fs.stat(result.path);
    expect(stat.isDirectory()).toBe(true);

    const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: result.path });
    expect(head.stdout.trim()).toBe(result.branch);

    const list = await execa("git", ["worktree", "list"], { cwd: repoRoot });
    expect(list.stdout).toContain(result.path);
    expect(list.stdout).toContain(result.branch);
  });

  it("creates worktreesRoot if missing", async () => {
    await rm(worktreesRoot, { recursive: true, force: true });
    const result = await addWorktree({ repoRoot, worktreesRoot, branchName: "feature/x" });
    expect(await fs.stat(result.path).then((s) => s.isDirectory())).toBe(true);
  });

  it("sanitises the branch name before passing it to git", async () => {
    const result = await addWorktree({
      repoRoot,
      worktreesRoot,
      branchName: "Add ?: weird !! chars",
    });
    expect(result.branch).toBe("add-weird-chars");
    const head = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: result.path });
    expect(head.stdout.trim()).toBe("add-weird-chars");
  });
});

describe("archiveWorktreeState", () => {
  it("copies .minesweeper/ contents into archiveRoot/<issue>-<iso>/ and returns the path", async () => {
    const { path: wtPath } = await addWorktree({
      repoRoot,
      worktreesRoot,
      branchName: "issue-42",
    });
    await initState(wtPath, "Planning", { issueNumber: 42, branchName: "issue-42", maxIterations: 5 });
    await fs.writeFile(join(wtPath, ".minesweeper", "extra.txt"), "trace data\n");

    const archiveDir = await archiveWorktreeState({
      worktreePath: wtPath,
      archiveRoot,
      issueNumber: 42,
    });

    expect(archiveDir.startsWith(archiveRoot)).toBe(true);
    expect(archiveDir).toMatch(/\/42-\d{4}-\d{2}-\d{2}T/);

    const archives = await fs.readdir(archiveRoot);
    expect(archives).toHaveLength(1);
    expect(join(archiveRoot, archives[0]!)).toBe(archiveDir);

    const archived = await fs.readdir(archiveDir);
    expect(archived.sort()).toEqual(["extra.txt", "state.json"]);

    const stateRaw = await fs.readFile(join(archiveDir, "state.json"), "utf8");
    expect(JSON.parse(stateRaw).issueNumber).toBe(42);
    expect((await fs.readFile(join(archiveDir, "extra.txt"), "utf8")).trim()).toBe("trace data");

    // archive is non-destructive: the worktree should still be on disk.
    expect((await fs.stat(wtPath)).isDirectory()).toBe(true);
  });

  it("creates an empty archive directory when .minesweeper is absent", async () => {
    const { path: wtPath } = await addWorktree({
      repoRoot,
      worktreesRoot,
      branchName: "no-state",
    });

    const archiveDir = await archiveWorktreeState({
      worktreePath: wtPath,
      archiveRoot,
      issueNumber: 7,
    });

    const archives = await fs.readdir(archiveRoot);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^7-/);
    expect(await fs.readdir(archiveDir)).toEqual([]);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory and deregisters it from the parent repo", async () => {
    const { path: wtPath } = await addWorktree({
      repoRoot,
      worktreesRoot,
      branchName: "to-remove",
    });

    await removeWorktree(wtPath);

    await expect(fs.stat(wtPath)).rejects.toThrow();
    const list = await execa("git", ["worktree", "list"], { cwd: repoRoot });
    expect(list.stdout).not.toContain(wtPath);
  });

  it("removes a worktree even when uncommitted files are present", async () => {
    const { path: wtPath } = await addWorktree({
      repoRoot,
      worktreesRoot,
      branchName: "dirty",
    });
    await fs.writeFile(join(wtPath, "scratch.txt"), "uncommitted\n");

    await removeWorktree(wtPath);

    await expect(fs.stat(wtPath)).rejects.toThrow();
  });
});

describe("listOrphans", () => {
  it("returns worktrees with valid state.json and ignores ones without it", async () => {
    const { path: wtA } = await addWorktree({ repoRoot, worktreesRoot, branchName: "alpha" });
    await initState(wtA, "Execution", { issueNumber: 11, branchName: "alpha", maxIterations: 3 });

    const { path: wtB } = await addWorktree({ repoRoot, worktreesRoot, branchName: "bravo" });
    await initState(wtB, "Planning", { issueNumber: 22, branchName: "bravo", maxIterations: 2 });

    await addWorktree({ repoRoot, worktreesRoot, branchName: "charlie" });

    const orphans = await listOrphans(worktreesRoot);
    expect(orphans).toHaveLength(2);
    const byIssue = Object.fromEntries(orphans.map((o) => [o.state?.issueNumber, o]));
    expect(byIssue[11]?.path).toBe(wtA);
    expect(byIssue[22]?.path).toBe(wtB);
    expect(byIssue[11]?.state?.mode).toBe("Execution");
    expect(byIssue[22]?.state?.mode).toBe("Planning");
  });

  it("returns an empty list when worktreesRoot does not exist", async () => {
    const orphans = await listOrphans(join(scratch, "does-not-exist"));
    expect(orphans).toEqual([]);
  });

  it("skips entries whose state.json fails schema validation", async () => {
    const { path: wt } = await addWorktree({ repoRoot, worktreesRoot, branchName: "broken" });
    await fs.mkdir(join(wt, ".minesweeper"), { recursive: true });
    await fs.writeFile(statePath(wt), JSON.stringify({ version: 1, mode: "BogusMode" }));
    const orphans = await listOrphans(worktreesRoot);
    expect(orphans).toEqual([]);
  });

  it("skips entries with malformed state JSON", async () => {
    const { path: wt } = await addWorktree({ repoRoot, worktreesRoot, branchName: "garbage" });
    await fs.mkdir(join(wt, ".minesweeper"), { recursive: true });
    await fs.writeFile(statePath(wt), "{not json");
    const orphans = await listOrphans(worktreesRoot);
    expect(orphans).toEqual([]);
  });
});
