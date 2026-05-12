import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigFileSchema } from "../../config.js";
import { buildDefaultConfigFile, runConfigInitCommand, runConfigShowCommand } from "../config.js";

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

function makeStdout(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-config-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("buildDefaultConfigFile", () => {
  it("returns every user-settable key at its loader default", () => {
    const defaults = buildDefaultConfigFile();
    expect(defaults).toMatchObject({
      defaultEligible: false,
      alertsEligible: true,
      alwaysFixLabel: "autofix",
      tryFixLabel: "tryFix",
      neverFixLabel: "manual",
      possiblyDangerousLabel: "possiblyDangerous",
      manuallyApprovedLabel: "manuallyReviewed",
      failedLabel: "minesweeperFailed",
      subtaskLabel: "subtask",
      maxPlanningIterations: 5,
      maxReviewRounds: 3,
      worktreePath: "/tmp/minesweeper",
      prBaseBranch: "main",
      pollIntervalSeconds: 300,
      pollCooldownSeconds: 120,
      maxConcurrency: 1,
      schedule: [],
    });
  });

  it("strips loader-derived fields the on-disk schema does not accept", () => {
    const defaults = buildDefaultConfigFile();
    expect(defaults).not.toHaveProperty("pollIntervalMs");
    expect(defaults).not.toHaveProperty("pollCooldownMs");
    expect(defaults).not.toHaveProperty("sources");
  });

  it("produces a body that ConfigFileSchema accepts", () => {
    expect(() => ConfigFileSchema.parse(buildDefaultConfigFile())).not.toThrow();
  });
});

describe("runConfigInitCommand", () => {
  it("writes a populated config file at <cwd>/.minesweeper/config.json", () => {
    const { stream, text } = makeStdout();
    const result = runConfigInitCommand({ cwd: tmp, stdout: stream });
    expect(result.path).toBe(join(tmp, ".minesweeper", "config.json"));
    expect(result.skipped).toBeUndefined();

    const written = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, unknown>;
    expect(written.alwaysFixLabel).toBe("autofix");
    expect(written.pollIntervalSeconds).toBe(300);
    expect(written.schedule).toEqual([]);
    expect(strip(text())).toMatch(/wrote default config/);
  });

  it("creates the .minesweeper directory if missing", () => {
    const { stream } = makeStdout();
    runConfigInitCommand({ cwd: tmp, stdout: stream });
    expect(readFileSync(join(tmp, ".minesweeper", "config.json"), "utf8")).toContain("alwaysFixLabel");
  });

  it("refuses to overwrite an existing file without --force", () => {
    mkdirSync(join(tmp, ".minesweeper"), { recursive: true });
    const path = join(tmp, ".minesweeper", "config.json");
    writeFileSync(path, '{"alwaysFixLabel":"keepme"}\n');

    const { stream, text } = makeStdout();
    const result = runConfigInitCommand({ cwd: tmp, stdout: stream });
    expect(result.skipped).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"alwaysFixLabel":"keepme"}\n');
    expect(strip(text())).toMatch(/already exists/);
  });

  it("overwrites with --force", () => {
    mkdirSync(join(tmp, ".minesweeper"), { recursive: true });
    const path = join(tmp, ".minesweeper", "config.json");
    writeFileSync(path, '{"alwaysFixLabel":"keepme"}\n');

    const { stream } = makeStdout();
    runConfigInitCommand({ cwd: tmp, force: true, stdout: stream });
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.alwaysFixLabel).toBe("autofix");
  });
});

describe("runConfigShowCommand", () => {
  it("prints the file contents when present", () => {
    mkdirSync(join(tmp, ".minesweeper"), { recursive: true });
    const path = join(tmp, ".minesweeper", "config.json");
    const body = '{"alwaysFixLabel":"autofix"}\n';
    writeFileSync(path, body);

    const { stream, text } = makeStdout();
    const result = runConfigShowCommand({ cwd: tmp, stdout: stream });
    expect(result.missing).toBeUndefined();
    expect(strip(text())).toContain(body);
    expect(strip(text())).toContain(path);
  });

  it("reports a friendly message when the file is missing", () => {
    const { stream, text } = makeStdout();
    const result = runConfigShowCommand({ cwd: tmp, stdout: stream });
    expect(result.missing).toBe(true);
    expect(strip(text())).toMatch(/no config file/);
    expect(strip(text())).toMatch(/config init/);
  });
});
