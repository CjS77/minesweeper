import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCodeownerLogins, parseCodeowners } from "../codeowners.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-codeowners-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("parseCodeowners", () => {
  it("collects bare @username tokens from non-comment lines", () => {
    const logins = parseCodeowners(["# top comment", "* @alice @bob", "src/**/*.ts @carol"].join("\n"));
    expect(logins).toEqual(new Set(["alice", "bob", "carol"]));
  });

  it("ignores @org/team handles (team resolution is deferred)", () => {
    const logins = parseCodeowners("* @alice @acme/platform");
    expect(logins).toEqual(new Set(["alice"]));
  });

  it("lowercases logins and deduplicates", () => {
    const logins = parseCodeowners(["* @Alice @ALICE", "src/foo @alice"].join("\n"));
    expect(logins).toEqual(new Set(["alice"]));
  });

  it("treats trailing # as a comment delimiter", () => {
    const logins = parseCodeowners("* @alice # primary owner");
    expect(logins).toEqual(new Set(["alice"]));
  });

  it("ignores tokens with no @ prefix and email-style entries", () => {
    const logins = parseCodeowners("* alice@example.com @bob");
    expect(logins).toEqual(new Set(["bob"]));
  });
});

describe("loadCodeownerLogins", () => {
  it("returns an empty set when no CODEOWNERS file is present", async () => {
    expect(await loadCodeownerLogins(tmp)).toEqual(new Set<string>());
  });

  it("reads .github/CODEOWNERS as the primary location", async () => {
    await mkdir(join(tmp, ".github"), { recursive: true });
    await writeFile(join(tmp, ".github", "CODEOWNERS"), "* @alice @bob\n", "utf8");
    const logins = await loadCodeownerLogins(tmp);
    expect(logins).toEqual(new Set(["alice", "bob"]));
  });

  it("falls back to top-level CODEOWNERS when .github/CODEOWNERS is absent", async () => {
    await writeFile(join(tmp, "CODEOWNERS"), "* @carol\n", "utf8");
    const logins = await loadCodeownerLogins(tmp);
    expect(logins).toEqual(new Set(["carol"]));
  });

  it("falls back to docs/CODEOWNERS as a last resort", async () => {
    await mkdir(join(tmp, "docs"), { recursive: true });
    await writeFile(join(tmp, "docs", "CODEOWNERS"), "* @dave\n", "utf8");
    const logins = await loadCodeownerLogins(tmp);
    expect(logins).toEqual(new Set(["dave"]));
  });

  it("prefers .github/CODEOWNERS over the fallbacks when both exist", async () => {
    await mkdir(join(tmp, ".github"), { recursive: true });
    await writeFile(join(tmp, ".github", "CODEOWNERS"), "* @primary\n", "utf8");
    await writeFile(join(tmp, "CODEOWNERS"), "* @fallback\n", "utf8");
    const logins = await loadCodeownerLogins(tmp);
    expect(logins).toEqual(new Set(["primary"]));
  });
});
