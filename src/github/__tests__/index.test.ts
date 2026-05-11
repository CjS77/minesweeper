import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import {
  addLabel,
  comment,
  createIssue,
  createPr,
  GhError,
  GhMissingError,
  GhNotARepoError,
  getIssue,
  addReactionToReviewComment,
  getPullRequest,
  getRepoOwner,
  getReviewThreads,
  listIssues,
  listLabels,
  listPullRequests,
  removeLabel,
  runGh,
  upsertLabel,
} from "../index.js";

const mockExeca = vi.mocked(execa);

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const fixtureText = (name: string): string => readFileSync(join(FIX_DIR, name), "utf8");

interface FakeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function ok(stdout: string): FakeResult {
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

function lastCall(): { bin: string; args: readonly string[]; opts: Record<string, unknown> } {
  expect(mockExeca).toHaveBeenCalled();
  const [bin, args, opts] = mockExeca.mock.calls.at(-1) as unknown as [
    string,
    readonly string[],
    Record<string, unknown>,
  ];
  return { bin, args, opts };
}

describe("listIssues", () => {
  it("invokes gh with the documented flags and parses the fixture", async () => {
    mockExeca.mockResolvedValueOnce(ok(fixtureText("issue_list.json")) as never);
    const issues = await listIssues({ state: "open", limit: 50 });
    expect(issues).toHaveLength(2);

    const { bin, args } = lastCall();
    expect(bin).toBe("gh");
    expect(args.slice(0, 6)).toEqual(["issue", "list", "--state", "open", "--limit", "50"]);
    expect(args).toContain("--json");
    expect(args.at(-1)).toContain("createdAt");
  });

  it("defaults state to 'open' and limit to 30", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    await listIssues();
    const { args } = lastCall();
    expect(args).toContain("open");
    expect(args).toContain("30");
  });

  it("forwards cwd to execa", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    await listIssues({ cwd: "/tmp/wt" });
    expect(lastCall().opts.cwd).toBe("/tmp/wt");
  });
});

describe("getIssue", () => {
  it("invokes gh issue view and parses the result", async () => {
    mockExeca.mockResolvedValueOnce(ok(fixtureText("issue_view.json")) as never);
    const issue = await getIssue(17);
    expect(issue.number).toBe(17);
    expect(issue.comments).toHaveLength(1);
    expect(lastCall().args.slice(0, 3)).toEqual(["issue", "view", "17"]);
  });
});

describe("addLabel / removeLabel", () => {
  it("addLabel passes --add-label", async () => {
    mockExeca.mockResolvedValueOnce(ok("") as never);
    await addLabel(17, "autofix");
    expect(lastCall().args).toEqual(["issue", "edit", "17", "--add-label", "autofix"]);
  });

  it("removeLabel passes --remove-label", async () => {
    mockExeca.mockResolvedValueOnce(ok("") as never);
    await removeLabel(17, "manual");
    expect(lastCall().args).toEqual(["issue", "edit", "17", "--remove-label", "manual"]);
  });
});

describe("listLabels", () => {
  it("invokes gh label list with the documented flags and parses the response", async () => {
    mockExeca.mockResolvedValueOnce(
      ok(
        JSON.stringify([
          { name: "bug", color: "d73a4a", description: "Something is broken" },
          { name: "autofix", color: "0e8a16", description: "" },
        ]),
      ) as never,
    );
    const labels = await listLabels({ limit: 50 });
    expect(labels).toHaveLength(2);
    expect(labels[0]?.name).toBe("bug");
    const { args } = lastCall();
    expect(args.slice(0, 4)).toEqual(["label", "list", "--limit", "50"]);
    expect(args).toContain("--json");
    expect(args.at(-1)).toBe("name,color,description");
  });

  it("defaults limit to 200", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    await listLabels();
    expect(lastCall().args).toContain("200");
  });
});

describe("upsertLabel", () => {
  it("invokes gh label create with --force, color and description", async () => {
    mockExeca.mockResolvedValueOnce(ok("") as never);
    await upsertLabel({ name: "autofix", color: "0E8A16", description: "always handled" });
    expect(lastCall().args).toEqual([
      "label",
      "create",
      "autofix",
      "--color",
      "0E8A16",
      "--description",
      "always handled",
      "--force",
    ]);
  });

  it("forwards cwd", async () => {
    mockExeca.mockResolvedValueOnce(ok("") as never);
    await upsertLabel({
      name: "manual",
      color: "B60205",
      description: "never handled",
      cwd: "/tmp/wt",
    });
    expect(lastCall().opts.cwd).toBe("/tmp/wt");
  });

  it("propagates gh errors", async () => {
    mockExeca.mockResolvedValueOnce(fail("HTTP 422: validation failed") as never);
    await expect(upsertLabel({ name: "x", color: "ffffff", description: "y" })).rejects.toBeInstanceOf(GhError);
  });
});

describe("createIssue", () => {
  it("includes labels when provided", async () => {
    mockExeca.mockResolvedValueOnce(ok("https://github.com/example/repo/issues/123\n") as never);
    const result = await createIssue({
      title: "Track me",
      body: "Body",
      labels: ["subtask", "autofix"],
    });
    expect(result).toEqual({
      number: 123,
      url: "https://github.com/example/repo/issues/123",
    });
    const { args } = lastCall();
    expect(args).toContain("--label");
    expect(args[args.indexOf("--label") + 1]).toBe("subtask,autofix");
  });

  it("omits --label when no labels are passed", async () => {
    mockExeca.mockResolvedValueOnce(ok("https://github.com/example/repo/issues/9\n") as never);
    await createIssue({ title: "x", body: "y" });
    expect(lastCall().args).not.toContain("--label");
  });

  it("throws when stdout has no URL", async () => {
    mockExeca.mockResolvedValueOnce(ok("Creating issue...\n") as never);
    await expect(createIssue({ title: "x", body: "y" })).rejects.toThrow(/no.*URL/i);
  });
});

describe("comment", () => {
  it("invokes gh issue comment", async () => {
    mockExeca.mockResolvedValueOnce(ok("") as never);
    await comment(17, "Looks great!");
    expect(lastCall().args).toEqual(["issue", "comment", "17", "--body", "Looks great!"]);
  });
});

describe("createPr", () => {
  it("parses the PR number from the returned URL", async () => {
    mockExeca.mockResolvedValueOnce(ok("https://github.com/example/repo/pull/42\n") as never);
    const result = await createPr({
      base: "main",
      head: "fix/x",
      title: "Fix",
      body: "Body",
    });
    expect(result).toEqual({ number: 42, url: "https://github.com/example/repo/pull/42" });
  });

  it("appends --draft when requested", async () => {
    mockExeca.mockResolvedValueOnce(ok("https://github.com/example/repo/pull/2\n") as never);
    await createPr({ base: "main", head: "x", title: "t", body: "b", draft: true });
    expect(lastCall().args).toContain("--draft");
  });

  it("omits --draft otherwise", async () => {
    mockExeca.mockResolvedValueOnce(ok("https://github.com/example/repo/pull/3\n") as never);
    await createPr({ base: "main", head: "x", title: "t", body: "b" });
    expect(lastCall().args).not.toContain("--draft");
  });
});

describe("listPullRequests", () => {
  it("invokes gh pr list with the documented flags and parses the response", async () => {
    mockExeca.mockResolvedValueOnce(
      ok(
        JSON.stringify([
          {
            number: 5,
            headRefName: "minesweeper-issue0005",
            baseRefName: "main",
            state: "OPEN",
            author: { login: "minesweeper-bot" },
            url: "https://github.com/example/repo/pull/5",
            title: "ignored field",
          },
        ]),
      ) as never,
    );
    const prs = await listPullRequests({ state: "open", head: "minesweeper-issue0005", author: "@me", limit: 50 });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(5);

    const { args } = lastCall();
    expect(args.slice(0, 6)).toEqual(["pr", "list", "--state", "open", "--limit", "50"]);
    expect(args).toContain("--head");
    expect(args[args.indexOf("--head") + 1]).toBe("minesweeper-issue0005");
    expect(args).toContain("--author");
    expect(args[args.indexOf("--author") + 1]).toBe("@me");
    expect(args).toContain("--json");
  });

  it("omits --head and --author when not provided and defaults limit to 30", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    await listPullRequests();
    const { args } = lastCall();
    expect(args).not.toContain("--head");
    expect(args).not.toContain("--author");
    expect(args).toContain("30");
  });
});

describe("getPullRequest", () => {
  it("invokes gh pr view with the documented fields and parses reviews + reviewDecision", async () => {
    mockExeca.mockResolvedValueOnce(ok(fixtureText("pull_request_with_reviews.json")) as never);
    const pr = await getPullRequest(99);
    expect(pr.number).toBe(99);
    expect(pr.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(pr.reviews).toBeDefined();
    expect(pr.reviews?.[0]?.state).toBe("CHANGES_REQUESTED");

    const { args } = lastCall();
    expect(args.slice(0, 3)).toEqual(["pr", "view", "99"]);
    expect(args).toContain("--json");
    const jsonFields = args.at(-1) as string;
    expect(jsonFields).toContain("reviews");
    expect(jsonFields).toContain("reviewDecision");
    // reviewThreads is *not* a valid --json field for gh pr view; it must
    // be fetched separately via getReviewThreads (REST).
    expect(jsonFields).not.toContain("reviewThreads");
  });
});

describe("getReviewThreads", () => {
  it("calls gh api with the paginated comments endpoint and normalises into single-comment threads", async () => {
    mockExeca.mockResolvedValueOnce(ok(fixtureText("pr_review_comments_rest.json")) as never);
    const threads = await getReviewThreads(99);

    expect(threads).toHaveLength(2);
    expect(threads[0]?.isResolved).toBe(false);
    expect(threads[0]?.comments[0]?.author.login).toBe("codeowner-alice");
    expect(threads[0]?.comments[0]?.createdAt).toBe("2026-05-10T11:00:00Z");
    expect(threads[0]?.comments[0]?.path).toBe("src/util.ts");
    expect(threads[0]?.comments[0]?.line).toBe(22);
    // Falls back to original_line when REST `line` is null (outdated comment).
    expect(threads[1]?.comments[0]?.line).toBe(7);

    const { args } = lastCall();
    expect(args.slice(0, 2)).toEqual(["api", "--paginate"]);
    expect(args).toContain("repos/{owner}/{repo}/pulls/99/comments");
  });

  it("returns an empty array when the PR has no inline comments", async () => {
    mockExeca.mockResolvedValueOnce(ok("[]") as never);
    expect(await getReviewThreads(99)).toEqual([]);
  });
});

describe("addReactionToReviewComment", () => {
  it("POSTs to /repos/{o}/{r}/pulls/comments/{id}/reactions with the supplied content", async () => {
    mockExeca.mockResolvedValueOnce(ok('{"id":1,"content":"+1"}') as never);
    await addReactionToReviewComment(5001, "+1");
    const { args } = lastCall();
    expect(args.slice(0, 3)).toEqual(["api", "-X", "POST"]);
    expect(args).toContain("repos/{owner}/{repo}/pulls/comments/5001/reactions");
    expect(args).toContain("-f");
    expect(args).toContain("content=+1");
  });

  it("surfaces gh failures as a thrown GhError", async () => {
    mockExeca.mockResolvedValueOnce(fail("HTTP 422") as never);
    await expect(addReactionToReviewComment(5001, "+1")).rejects.toBeInstanceOf(GhError);
  });
});

describe("getRepoOwner", () => {
  it("returns the owner.login from gh repo view", async () => {
    mockExeca.mockResolvedValueOnce(ok(JSON.stringify({ owner: { login: "RepoOwner" } })) as never);
    const owner = await getRepoOwner();
    expect(owner).toBe("RepoOwner");
    const { args } = lastCall();
    expect(args.slice(0, 4)).toEqual(["repo", "view", "--json", "owner"]);
  });
});

describe("error mapping", () => {
  it("maps ENOENT to GhMissingError", async () => {
    const err = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    mockExeca.mockRejectedValueOnce(err);
    await expect(runGh(["issue", "list"])).rejects.toBeInstanceOf(GhMissingError);
  });

  it("maps 'not a git repository' stderr to GhNotARepoError", async () => {
    mockExeca.mockResolvedValueOnce(fail("fatal: not a git repository") as never);
    await expect(runGh(["issue", "list"])).rejects.toBeInstanceOf(GhNotARepoError);
  });

  it("maps other failures to GhError with stderr in message", async () => {
    mockExeca.mockResolvedValueOnce(fail("HTTP 401: bad credentials") as never);
    const err = await runGh(["issue", "list"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).message).toContain("HTTP 401");
    expect((err as GhError).exitCode).toBe(1);
  });

  it("propagates JSON parse errors with the raw stdout", async () => {
    mockExeca.mockResolvedValueOnce(ok("not json") as never);
    await expect(runGh(["issue", "list"], { json: true })).rejects.toThrow(/non-JSON/);
  });
});
