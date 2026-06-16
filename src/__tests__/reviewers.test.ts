import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addReviewer,
  assertValidLogin,
  listReviewers,
  loadExtraReviewers,
  removeReviewer,
  REVIEWERS_FILE,
} from "../reviewers.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-reviewers-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("loadExtraReviewers", () => {
  it("returns an empty set when no file exists", async () => {
    expect(await loadExtraReviewers(tmp)).toEqual(new Set());
  });
});

describe("addReviewer", () => {
  it("creates the file with the lowercased login", async () => {
    const list = await addReviewer(tmp, "CodeRabbitAI[bot]");
    expect(list).toEqual(["coderabbitai[bot]"]);

    const raw = JSON.parse(await readFile(join(tmp, REVIEWERS_FILE), "utf8"));
    expect(raw).toEqual({ reviewers: ["coderabbitai[bot]"] });
    expect(await loadExtraReviewers(tmp)).toEqual(new Set(["coderabbitai[bot]"]));
  });

  it("is idempotent and keeps the list sorted", async () => {
    await addReviewer(tmp, "zeta");
    await addReviewer(tmp, "alpha");
    const list = await addReviewer(tmp, "ZETA");
    expect(list).toEqual(["alpha", "zeta"]);
  });

  it("rejects logins that are not valid GitHub handles", async () => {
    await expect(addReviewer(tmp, "not a login")).rejects.toThrow(/invalid GitHub login/);
    await expect(addReviewer(tmp, "bad/slash")).rejects.toThrow(/invalid GitHub login/);
  });
});

describe("removeReviewer", () => {
  it("removes a login case-insensitively", async () => {
    await addReviewer(tmp, "coderabbitai[bot]");
    await addReviewer(tmp, "octocat");
    const list = await removeReviewer(tmp, "CodeRabbitAI[bot]");
    expect(list).toEqual(["octocat"]);
  });

  it("is a no-op for an absent login", async () => {
    await addReviewer(tmp, "octocat");
    const list = await removeReviewer(tmp, "nobody");
    expect(list).toEqual(["octocat"]);
  });
});

describe("listReviewers", () => {
  it("returns a sorted list", async () => {
    await addReviewer(tmp, "gamma");
    await addReviewer(tmp, "beta");
    expect(await listReviewers(tmp)).toEqual(["beta", "gamma"]);
  });
});

describe("assertValidLogin", () => {
  it("accepts bot logins and plain handles, rejects junk", () => {
    expect(() => assertValidLogin("coderabbitai[bot]")).not.toThrow();
    expect(() => assertValidLogin("octo-cat")).not.toThrow();
    expect(() => assertValidLogin("")).toThrow();
    expect(() => assertValidLogin("@octocat")).toThrow();
  });
});
