import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initState, readState, statePath, writeState, type State } from "../child/state.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "minesweeper-state-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("initState", () => {
  it("creates a valid Planning state.json at .minesweeper/state.json", async () => {
    const state = await initState(tmp, "Planning", {
      issueNumber: 42,
      branchName: "fix/foo",
      maxIterations: 5,
    });

    expect(state.mode).toBe("Planning");
    expect(state.status).toBe("InProgress");
    expect(state.iterations).toBe(0);
    expect(state.maxIterations).toBe(5);
    expect(state.issueNumber).toBe(42);
    expect(state.branchName).toBe("fix/foo");
    expect(state.assessment).toBeNull();
    expect(state.version).toBe(1);

    const onDisk = JSON.parse(await readFile(statePath(tmp), "utf8"));
    expect(onDisk).toEqual(state);
  });

  it("uses 'Writing' status for Execution mode", async () => {
    const state = await initState(tmp, "Execution", {
      issueNumber: 7,
      branchName: "exec/bar",
      maxIterations: 3,
    });
    expect(state.status).toBe("Writing");
  });

  it("creates the .minesweeper directory if missing", async () => {
    await initState(tmp, "Planning", { issueNumber: 1, branchName: "x", maxIterations: 1 });
    const dirStat = await fs.stat(join(tmp, ".minesweeper"));
    expect(dirStat.isDirectory()).toBe(true);
  });
});

describe("readState / writeState", () => {
  it("round-trips state through disk", async () => {
    const original = await initState(tmp, "Planning", {
      issueNumber: 11,
      branchName: "x",
      maxIterations: 4,
    });
    const loaded = await readState(tmp);
    expect(loaded).toEqual(original);
  });

  it("refreshes updatedAt on every write", async () => {
    const initial = await initState(tmp, "Planning", {
      issueNumber: 1,
      branchName: "x",
      maxIterations: 2,
    });
    await new Promise((r) => setTimeout(r, 10));
    await writeState(tmp, { ...initial, iterations: 1 });
    const after = await readState(tmp);
    expect(after.iterations).toBe(1);
    expect(after.startedAt).toBe(initial.startedAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(initial.updatedAt));
  });

  it("rejects invalid persisted state on read", async () => {
    await fs.mkdir(join(tmp, ".minesweeper"), { recursive: true });
    await writeFile(statePath(tmp), JSON.stringify({ version: 1, mode: "Bogus" }));
    await expect(readState(tmp)).rejects.toThrow();
  });

  it("rejects malformed JSON on read", async () => {
    await fs.mkdir(join(tmp, ".minesweeper"), { recursive: true });
    await writeFile(statePath(tmp), "{not json");
    await expect(readState(tmp)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects writes that violate the schema", async () => {
    const initial = await initState(tmp, "Planning", {
      issueNumber: 1,
      branchName: "x",
      maxIterations: 2,
    });
    await expect(
      writeState(tmp, { ...initial, iterations: -1 } as State),
    ).rejects.toThrow();
  });
});

describe("atomic writes", () => {
  it("never lets a concurrent reader observe a partial state file", async () => {
    const baseline = await initState(tmp, "Execution", {
      issueNumber: 99,
      branchName: "atomic-test",
      maxIterations: 3,
    });

    // Pad the branchName so each serialization is many KB and a non-atomic
    // write would leave a visible truncated window.
    const filler = "x".repeat(8 * 1024);
    let stop = false;
    const observed: string[] = [];

    const reader = (async () => {
      while (!stop) {
        try {
          const raw = await readFile(statePath(tmp), "utf8");
          observed.push(raw);
        } catch {
          // file may briefly not exist between rename calls on some FS — fine
        }
      }
    })();

    for (let i = 0; i < 50; i++) {
      await writeState(tmp, {
        ...baseline,
        iterations: i % baseline.maxIterations,
        branchName: `atomic-${i}-${filler}`,
      });
    }
    stop = true;
    await reader;

    expect(observed.length).toBeGreaterThan(0);
    let sawLongWrite = false;
    for (const raw of observed) {
      // Each snapshot must be parseable JSON matching the schema, with no
      // torn payload. JSON.parse would throw on a partial write.
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.issueNumber).toBe(99);
      expect(typeof parsed.branchName).toBe("string");
      const branch = parsed.branchName as string;
      if (branch.startsWith("atomic-") && branch.includes(filler)) {
        sawLongWrite = true;
      }
    }
    // Reader must have caught at least one of the multi-KB writes,
    // proving the rename swap is observed atomically.
    expect(sawLongWrite).toBe(true);
  });

  it("does not leave temp files behind after a successful write", async () => {
    await initState(tmp, "Planning", {
      issueNumber: 1,
      branchName: "x",
      maxIterations: 2,
    });
    const entries = await fs.readdir(join(tmp, ".minesweeper"));
    expect(entries).toEqual(["state.json"]);
  });
});
