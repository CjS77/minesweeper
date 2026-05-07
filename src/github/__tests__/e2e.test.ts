import { describe, expect, it } from "vitest";
import { listIssues } from "../index.js";

const e2e = process.env.MINESWEEPER_E2E === "1";
const describeIfE2E = e2e ? describe : describe.skip;

describeIfE2E("github wrapper — live `gh`", () => {
  it("lists issues from the current repo without crashing", async () => {
    const issues = await listIssues({ limit: 3 });
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(typeof issue.number).toBe("number");
      expect(typeof issue.title).toBe("string");
    }
  }, 30_000);
});
