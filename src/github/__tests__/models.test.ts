import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IssueListSchema,
  IssueSchema,
  IssueStateSchema,
  LabelSchema,
  PullRequestSchema,
  UserSchema,
} from "../models.js";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX_DIR, name), "utf8")) as unknown;

describe("UserSchema", () => {
  it("accepts a typical user", () => {
    const u = UserSchema.parse({ login: "octocat", id: "x", name: "The Octocat", is_bot: false });
    expect(u.login).toBe("octocat");
  });

  it("accepts a bot user with name=null", () => {
    const u = UserSchema.parse({ login: "dependabot[bot]", is_bot: true, name: null });
    expect(u.is_bot).toBe(true);
    expect(u.name).toBeNull();
  });

  it("rejects payloads missing login", () => {
    expect(() => UserSchema.parse({ id: "x" })).toThrow();
  });
});

describe("LabelSchema", () => {
  it("accepts a typical label and tolerates extra fields", () => {
    const parsed = LabelSchema.parse({
      name: "bug",
      id: "LA_x",
      description: "Something is wrong",
      color: "d73a4a",
      newGhField: "ignored but preserved",
    });
    expect(parsed.name).toBe("bug");
    expect((parsed as Record<string, unknown>).newGhField).toBe("ignored but preserved");
  });
});

describe("IssueStateSchema", () => {
  it.each(["OPEN", "CLOSED"] as const)("accepts %s", (s) => {
    expect(IssueStateSchema.parse(s)).toBe(s);
  });

  it("rejects lowercase forms", () => {
    expect(() => IssueStateSchema.parse("open")).toThrow();
  });
});

describe("IssueSchema", () => {
  it("parses a list fixture", () => {
    const issues = IssueListSchema.parse(fixture("issue_list.json"));
    expect(issues).toHaveLength(2);
    expect(issues[0]?.number).toBe(17);
    expect(issues[0]?.labels.map((l) => l.name)).toEqual(["bug", "autofix"]);
    expect(issues[1]?.author.is_bot).toBe(true);
  });

  it("preserves unknown future fields via passthrough", () => {
    const issues = IssueListSchema.parse(fixture("issue_list.json"));
    expect((issues[1] as Record<string, unknown>).extraFutureField).toBe(
      "tolerated by passthrough",
    );
  });

  it("parses a single-issue view with comments", () => {
    const issue = IssueSchema.parse(fixture("issue_view.json"));
    expect(issue.number).toBe(17);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments?.[0]?.author.login).toBe("maintainer");
  });

  it("rejects an issue missing required fields", () => {
    expect(() =>
      IssueSchema.parse({ number: 1, title: "x", body: "x", labels: [], state: "OPEN" }),
    ).toThrow();
  });

  it("rejects an issue with a non-positive number", () => {
    const list = fixture("issue_list.json") as Array<Record<string, unknown>>;
    const bad = { ...list[0], number: 0 };
    expect(() => IssueSchema.parse(bad)).toThrow();
  });

  it("rejects an issue with a malformed url", () => {
    const list = fixture("issue_list.json") as Array<Record<string, unknown>>;
    const bad = { ...list[0], url: "not a url" };
    expect(() => IssueSchema.parse(bad)).toThrow();
  });
});

describe("PullRequestSchema", () => {
  it("parses a typical PR fixture", () => {
    const pr = PullRequestSchema.parse(fixture("pull_request.json"));
    expect(pr.number).toBe(42);
    expect(pr.headRefName).toBe("fix/crash-on-empty-input");
    expect(pr.isDraft).toBe(false);
  });

  it("tolerates additional fields like additions/deletions", () => {
    const pr = PullRequestSchema.parse(fixture("pull_request.json")) as Record<string, unknown>;
    expect(pr.additions).toBe(12);
    expect(pr.deletions).toBe(3);
  });
});
