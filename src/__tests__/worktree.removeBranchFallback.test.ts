/**
 * Pins the post-removal `git branch -D` fallback behaviour of {@link removeWorktree}.
 *
 * This file is a deliberate exception to the one-test-file-per-source-file convention: the
 * sibling `worktree.test.ts` exercises `removeWorktree` against a real git repo (the codebase
 * convention for fs/worktree code), and mocking `execa` in the same file would force every
 * other test to coexist with a module-level `vi.mock("execa")`. Keeping the mock-based unit
 * tests in their own file leaves the real-git tests untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { removeWorktree } from "../worktree.js";

const mockExeca = vi.mocked(execa);

interface FakeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function ok(stdout = ""): FakeResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): FakeResult {
  return { stdout: "", stderr, exitCode };
}

beforeEach(() => {
  mockExeca.mockReset();
});

afterEach(() => {
  mockExeca.mockReset();
});

describe("removeWorktree post-removal branch delete", () => {
  // Mock chain order matches the implementation: findMainRepoFromWorktree (rev-parse
  // --git-common-dir), then branch resolution (rev-parse --abbrev-ref HEAD), then worktree
  // remove, then branch -D. Stubs that use `reject: false` are dispatched via mockResolvedValueOnce
  // even when the simulated git invocation has a non-zero exitCode.

  it("treats a `not found` failure from `git branch -D` as success (branch already deleted)", async () => {
    mockExeca
      .mockResolvedValueOnce(ok("/fake/repo/.git\n") as never) // rev-parse --git-common-dir
      .mockResolvedValueOnce(ok("gone\n") as never) // rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce(ok() as never) // worktree remove --force
      .mockResolvedValueOnce(fail("error: branch 'gone' not found.\n") as never); // branch -D gone

    await expect(removeWorktree("/fake/wt")).resolves.toBeUndefined();

    expect(mockExeca).toHaveBeenCalledTimes(4);
    const [bin, args, opts] = mockExeca.mock.calls.at(-1) as unknown as [
      string,
      readonly string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe("git");
    expect(args).toEqual(["branch", "-D", "gone"]);
    expect(opts).toMatchObject({ cwd: "/fake/repo", reject: false });
  });

  it("propagates an unexpected `git branch -D` failure", async () => {
    mockExeca
      .mockResolvedValueOnce(ok("/fake/repo/.git\n") as never) // rev-parse --git-common-dir
      .mockResolvedValueOnce(ok("gone\n") as never) // rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce(ok() as never) // worktree remove --force
      .mockResolvedValueOnce(fail("fatal: cannot lock ref 'refs/heads/gone': unable to write\n", 128) as never);

    await expect(removeWorktree("/fake/wt")).rejects.toThrow(/git branch -D gone failed \(exit 128\)/);
  });
});
