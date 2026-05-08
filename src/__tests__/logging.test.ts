import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEVEL_EMOJI, ROLES, createLogger, resetLoggerForTest, type Logger } from "../logging.js";

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");

let tmp: string;
let stdout: PassThrough;
let stdoutChunks: string[];
let logger: Logger;

const FIXED_NOW = new Date("2026-05-07T13:24:08.000Z");
// HH:MM:SS in local time of the test runner.
const FIXED_TIME = `${String(FIXED_NOW.getHours()).padStart(2, "0")}:${String(FIXED_NOW.getMinutes()).padStart(
  2,
  "0",
)}:${String(FIXED_NOW.getSeconds()).padStart(2, "0")}`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "minesweeper-logging-"));
  stdoutChunks = [];
  stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
});

afterEach(async () => {
  resetLoggerForTest();
  await rm(tmp, { recursive: true, force: true });
});

function makeLogger(opts: { quiet?: boolean; filePath?: string } = {}): Logger {
  logger = createLogger({
    filePath: opts.filePath ?? join(tmp, "logs", "daemon.log"),
    stdout,
    now: () => FIXED_NOW,
    sync: true,
    quiet: opts.quiet ?? false,
  });
  return logger;
}

function readLogFile(): unknown[] {
  const raw = readFileSync(logger.filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("formatLine", () => {
  it("matches the documented contract", () => {
    makeLogger();
    const line = strip(logger.formatLine("daemon", "INFO", null, "hello"));
    expect(line).toBe(`${FIXED_TIME} 🔍 DAEMON — hello`);
  });

  it("includes the issue number when provided", () => {
    makeLogger();
    const line = strip(logger.formatLine("planner", "OK", 42, "plan ready"));
    expect(line).toBe(`${FIXED_TIME} ✅ PLANNER #42 — plan ready`);
  });

  it("uses the documented emoji per level", () => {
    makeLogger();
    expect(strip(logger.formatLine("daemon", "WARN", 1, "x")).startsWith(`${FIXED_TIME} ⚠️`)).toBe(true);
    expect(strip(logger.formatLine("daemon", "ERROR", 1, "x")).startsWith(`${FIXED_TIME} ❌`)).toBe(true);
    expect(strip(logger.formatLine("daemon", "WORK", 1, "x")).startsWith(`${FIXED_TIME} 🚧`)).toBe(true);
    expect(strip(logger.formatLine("daemon", "SHIP", 1, "x")).startsWith(`${FIXED_TIME} 🚀`)).toBe(true);
  });

  it("supports every role in the role registry", () => {
    makeLogger();
    for (const role of ROLES) {
      const line = strip(logger.formatLine(role, "INFO", null, "x"));
      expect(line).toContain(role.toUpperCase());
    }
  });
});

describe("event()", () => {
  it("writes a pretty line to stdout and a JSON record to the file", () => {
    makeLogger();
    logger.event("daemon", "INFO", null, "hello");
    const stdoutLine = strip(stdoutChunks.join(""));
    expect(stdoutLine).toBe(`${FIXED_TIME} 🔍 DAEMON — hello\n`);

    const records = readLogFile();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: "daemon",
      tag: "INFO",
      issueNumber: null,
      msg: "hello",
    });
  });

  it("includes meta fields in the JSON record but not on stdout", () => {
    makeLogger();
    logger.event("planner", "OK", 7, "approved", { iteration: 3 });
    const stdoutLine = strip(stdoutChunks.join(""));
    expect(stdoutLine).toContain("approved");
    expect(stdoutLine).not.toContain("iteration");

    const [record] = readLogFile() as [Record<string, unknown>];
    expect(record).toMatchObject({
      role: "planner",
      tag: "OK",
      issueNumber: 7,
      iteration: 3,
      msg: "approved",
    });
  });

  it("creates the parent log directory if missing", () => {
    const filePath = join(tmp, "deep", "nested", "logs", "daemon.log");
    makeLogger({ filePath });
    logger.event("daemon", "INFO", null, "ping");
    const records = readLogFile();
    expect(records).toHaveLength(1);
  });
});

describe("--quiet behaviour", () => {
  it("suppresses INFO on stdout but still writes them to the file", () => {
    makeLogger({ quiet: true });
    logger.event("daemon", "INFO", null, "muted");
    expect(stdoutChunks.join("")).toBe("");

    const [record] = readLogFile() as [Record<string, unknown>];
    expect(record).toMatchObject({ tag: "INFO", msg: "muted" });
  });

  it.each(["WARN", "ERROR", "OK", "SHIP", "WORK"] as const)("still emits %s lines to stdout when quiet", (level) => {
    makeLogger({ quiet: true });
    logger.event("daemon", level, null, "loud");
    const stdoutLine = strip(stdoutChunks.join(""));
    expect(stdoutLine).toContain(LEVEL_EMOJI[level]);
    expect(stdoutLine).toContain("loud");
  });
});

describe("ANSI handling", () => {
  it("emits colour codes for known roles when chalk supports them", () => {
    makeLogger();
    const line = logger.formatLine("planner", "INFO", null, "x");
    // Either the runner has colour support (line contains ANSI) or it does
    // not (stripped == raw). Both outcomes are valid; what matters is that
    // the stripped form is exactly the documented contract.
    expect(strip(line)).toBe(`${FIXED_TIME} 🔍 PLANNER — x`);
  });
});
