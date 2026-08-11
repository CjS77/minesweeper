import { describe, expect, it, vi } from "vitest";

import { type CommitPublisher } from "../../github/commit.js";
import { type GitOps } from "../modes/execution.js";
import { computeFileChanges, publishIncrementalCommit } from "../modes/publish.js";

// Minimal GitOps stub — only the methods used by publish.ts need real impls.
function makeGit(diffOutput: string, blobContent = "ZmFrZQ=="): GitOps {
  return {
    headSha: vi.fn(async () => "HEAD"),
    commitsAhead: vi.fn(async () => 1),
    mergeBase: vi.fn(async () => "BASE"),
    diff: vi.fn(async () => ""),
    diffStat: vi.fn(async () => ""),
    log: vi.fn(async () => ""),
    resetSoft: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    pushBranch: vi.fn(async () => undefined),
    diffNameStatus: vi.fn(async () => diffOutput),
    readBlob: vi.fn(async () => blobContent),
    subjects: vi.fn(async () => "add greet function"),
  };
}

function makePublisher(): CommitPublisher & { invocations: Array<{ method: string; args: readonly unknown[] }> } {
  const invocations: Array<{ method: string; args: readonly unknown[] }> = [];
  return {
    getRef: vi.fn(async () => {
      invocations.push({ method: "getRef", args: [] });
      return "REMOTE_HEAD";
    }),
    createBranchRef: vi.fn(async (...args) => {
      invocations.push({ method: "createBranchRef", args });
    }),
    createCommitOnBranch: vi.fn(async (...args) => {
      invocations.push({ method: "createCommitOnBranch", args });
      return "NEW_OID";
    }),
    createPullRequest: vi.fn(async (...args) => {
      invocations.push({ method: "createPullRequest", args });
      return { number: 1, url: "https://github.com/example/repo/pull/1" };
    }),
    invocations,
  };
}

describe("computeFileChanges", () => {
  it("returns empty FileChanges for an empty diff", async () => {
    const git = makeGit("");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result).toEqual({ additions: [], deletions: [] });
    expect(vi.mocked(git.diffNameStatus)).toHaveBeenCalledWith("/repo", "BASE", "HEAD");
  });

  it("parses Added files (A) as additions", async () => {
    const git = makeGit("A\tsrc/foo.ts\n", "aGVsbG8=");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.additions).toEqual([{ path: "src/foo.ts", contents: "aGVsbG8=" }]);
    expect(result.deletions).toEqual([]);
    expect(vi.mocked(git.readBlob)).toHaveBeenCalledWith("/repo", "HEAD", "src/foo.ts");
  });

  it("parses Modified files (M) as additions", async () => {
    const git = makeGit("M\tsrc/bar.ts\n");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]?.path).toBe("src/bar.ts");
    expect(result.deletions).toHaveLength(0);
  });

  it("parses Deleted files (D) as deletions", async () => {
    const git = makeGit("D\tsrc/old.ts\n");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.additions).toHaveLength(0);
    expect(result.deletions).toEqual([{ path: "src/old.ts" }]);
    expect(vi.mocked(git.readBlob)).not.toHaveBeenCalled();
  });

  it("parses Renames (R) as delete old + add new", async () => {
    const git = makeGit("R100\tsrc/old.ts\tsrc/new.ts\n");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.deletions).toEqual([{ path: "src/old.ts" }]);
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]?.path).toBe("src/new.ts");
  });

  it("parses Copies (C) as addition of the new path only", async () => {
    const git = makeGit("C100\tsrc/orig.ts\tsrc/copy.ts\n");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]?.path).toBe("src/copy.ts");
    expect(result.deletions).toHaveLength(0);
  });

  it("handles a mix of A/M/D lines", async () => {
    const diff = "A\tsrc/new.ts\nM\tsrc/existing.ts\nD\tsrc/gone.ts\n";
    const git = makeGit(diff);
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.additions).toHaveLength(2);
    expect(result.deletions).toHaveLength(1);
  });

  it("includes base64-encoded blob contents for each addition", async () => {
    const git = makeGit("A\tsrc/data.bin\n", "AQIDBA==");
    const result = await computeFileChanges(git, "/repo", "BASE", "HEAD");
    expect(result.additions[0]?.contents).toBe("AQIDBA==");
  });
});

describe("publishIncrementalCommit", () => {
  it("calls getRef, computes file changes from from..to, and creates a commit", async () => {
    const git = makeGit("A\tsrc/foo.ts\n", "dGVzdA==");
    const publisher = makePublisher();

    await publishIncrementalCommit({
      publisher,
      git,
      cwd: "/repo",
      branch: "feat",
      from: "BEFORE_SHA",
      to: "AFTER_SHA",
      headline: "Address PR review feedback",
    });

    expect(vi.mocked(publisher.getRef)).toHaveBeenCalledWith("feat");
    expect(vi.mocked(git.diffNameStatus)).toHaveBeenCalledWith("/repo", "BEFORE_SHA", "AFTER_SHA");
    expect(vi.mocked(git.subjects)).toHaveBeenCalledWith("/repo", "BEFORE_SHA");

    expect(vi.mocked(publisher.createCommitOnBranch)).toHaveBeenCalledOnce();
    const callArg = vi.mocked(publisher.createCommitOnBranch).mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      branchName: "feat",
      expectedHeadOid: "REMOTE_HEAD",
      headline: "Address PR review feedback",
      fileChanges: {
        additions: [{ path: "src/foo.ts", contents: "dGVzdA==" }],
        deletions: [],
      },
    });
  });

  it("uses getRef's sha as expectedHeadOid (not the local from sha)", async () => {
    const git = makeGit("M\tsrc/x.ts\n");
    const publisher = makePublisher();
    vi.mocked(publisher.getRef).mockResolvedValueOnce("SPECIFIC_REMOTE_HEAD");

    await publishIncrementalCommit({
      publisher,
      git,
      cwd: "/repo",
      branch: "feat",
      from: "LOCAL_BEFORE",
      to: "LOCAL_AFTER",
      headline: "Fix CI failures",
    });

    const callArg = vi.mocked(publisher.createCommitOnBranch).mock.calls[0]?.[0];
    expect(callArg?.expectedHeadOid).toBe("SPECIFIC_REMOTE_HEAD");
  });

  it("passes commit subjects as the commit body", async () => {
    const git = makeGit("A\tsrc/f.ts\n");
    vi.mocked(git.subjects).mockResolvedValueOnce("fix: correct typo\ntest: add unit test");
    const publisher = makePublisher();

    await publishIncrementalCommit({
      publisher,
      git,
      cwd: "/repo",
      branch: "feat",
      from: "A",
      to: "B",
      headline: "h",
    });

    const callArg = vi.mocked(publisher.createCommitOnBranch).mock.calls[0]?.[0];
    expect(callArg?.body).toBe("fix: correct typo\ntest: add unit test");
  });
});
