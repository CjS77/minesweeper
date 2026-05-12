import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execaNode: vi.fn(),
}));

import { execaNode } from "execa";

import { defaultSpawnChild } from "../supervisor.js";

const mockedExecaNode = vi.mocked(execaNode);

afterEach(() => {
  mockedExecaNode.mockReset();
  delete process.env["MINESWEEPER_REPO_CONFIG_FILE"];
});

function stubExeca(): void {
  // Return enough of a `ResultPromise` for defaultSpawnChild's `.then(...)`
  // chain and `.kill(...)` call to type-check at runtime.
  const stub = Object.assign(Promise.resolve({ exitCode: 0 }), {
    kill: vi.fn(),
  });
  mockedExecaNode.mockReturnValue(stub as never);
}

describe("defaultSpawnChild", () => {
  it("forwards a derived MINESWEEPER_REPO_CONFIG_FILE pointing at the daemon's repo root", () => {
    stubExeca();
    const spawn = defaultSpawnChild({ childScript: "/usr/local/bin/minesweeper.js", repoRoot: "/home/me/myrepo" });

    spawn({ issueNumber: 42, worktreePath: "/tmp/wt/myrepo-issue0042" });

    expect(mockedExecaNode).toHaveBeenCalledTimes(1);
    const [, , options] = mockedExecaNode.mock.calls[0]!;
    expect(options?.env?.["MINESWEEPER_REPO_CONFIG_FILE"]).toBe("/home/me/myrepo/.minesweeper/config.json");
  });

  it("lets an existing parent MINESWEEPER_REPO_CONFIG_FILE win over the derived default", () => {
    process.env["MINESWEEPER_REPO_CONFIG_FILE"] = "/opt/shared/minesweeper.json";
    stubExeca();
    const spawn = defaultSpawnChild({ childScript: "/usr/local/bin/minesweeper.js", repoRoot: "/home/me/myrepo" });

    spawn({ issueNumber: 1, worktreePath: "/tmp/wt/myrepo-issue0001" });

    const [, , options] = mockedExecaNode.mock.calls[0]!;
    expect(options?.env?.["MINESWEEPER_REPO_CONFIG_FILE"]).toBe("/opt/shared/minesweeper.json");
  });

  it("sets cwd to the worktree and forms the legacy issue-number argv for kind=issue", () => {
    stubExeca();
    const spawn = defaultSpawnChild({ childScript: "/cli.js", repoRoot: "/repo" });
    spawn({ issueNumber: 7, worktreePath: "/wt/foo" });

    const [script, argv, options] = mockedExecaNode.mock.calls[0]!;
    expect(script).toBe("/cli.js");
    expect(argv).toEqual(["handle", "7"]);
    expect(options?.cwd).toBe("/wt/foo");
  });

  it("forms the kind-namespaced argv for non-issue work items", () => {
    stubExeca();
    const spawn = defaultSpawnChild({ childScript: "/cli.js", repoRoot: "/repo" });
    spawn({ issueNumber: 13, worktreePath: "/wt/x", kind: "codeScanningAlert" });

    const [, argv] = mockedExecaNode.mock.calls[0]!;
    expect(argv).toEqual(["handle", "codeScanningAlert/13"]);
  });
});
