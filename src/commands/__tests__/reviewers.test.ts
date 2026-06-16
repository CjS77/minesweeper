import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runReviewersCommand } from "../reviewers.js";
import { listReviewers } from "../../reviewers.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-reviewers-cmd-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("runReviewersCommand", () => {
  it("adds a login and prints it back", async () => {
    const out = capture();
    const result = await runReviewersCommand({
      repoRoot: tmp,
      action: "add",
      login: "coderabbitai[bot]",
      stdout: out.stream,
    });
    expect(result).toEqual(["coderabbitai[bot]"]);
    expect(out.text()).toContain("added coderabbitai[bot]");
    expect(await listReviewers(tmp)).toEqual(["coderabbitai[bot]"]);
  });

  it("lists nothing when empty", async () => {
    const out = capture();
    const result = await runReviewersCommand({ repoRoot: tmp, action: "list", stdout: out.stream });
    expect(result).toEqual([]);
    expect(out.text()).toContain("no extra authorised reviewers configured");
  });

  it("removes a login", async () => {
    await runReviewersCommand({ repoRoot: tmp, action: "add", login: "octocat", stdout: capture().stream });
    const out = capture();
    const result = await runReviewersCommand({
      repoRoot: tmp,
      action: "remove",
      login: "octocat",
      stdout: out.stream,
    });
    expect(result).toEqual([]);
    expect(out.text()).toContain("removed octocat");
  });

  it("requires a login for add/remove", async () => {
    await expect(runReviewersCommand({ repoRoot: tmp, action: "add" })).rejects.toThrow(/requires a GitHub login/);
  });
});
