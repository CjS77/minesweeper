import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import type { Issue } from "../../github/index.js";
import { isEligible } from "../eligibility.js";

const config = loadConfig({});

function issueWithLabels(labels: readonly string[]): Issue {
  return {
    number: 1,
    title: "t",
    body: "b",
    labels: labels.map((name) => ({ name })),
    author: { login: "u" },
    state: "OPEN",
    url: "https://github.com/example/repo/issues/1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("isEligible", () => {
  it("returns true when the autofix label is present", () => {
    expect(isEligible(issueWithLabels(["autofix"]), config)).toBe(true);
  });

  it("returns true when autofix is present alongside other labels", () => {
    expect(isEligible(issueWithLabels(["bug", "autofix", "p1"]), config)).toBe(true);
  });

  it("returns false when the autofix label is absent", () => {
    expect(isEligible(issueWithLabels(["bug"]), config)).toBe(false);
    expect(isEligible(issueWithLabels([]), config)).toBe(false);
  });

  it("respects a non-default alwaysFixLabel", () => {
    const custom = loadConfig({ MINESWEEPER_ALWAYS_FIX_LABEL: "fix-me" });
    expect(isEligible(issueWithLabels(["fix-me"]), custom)).toBe(true);
    expect(isEligible(issueWithLabels(["autofix"]), custom)).toBe(false);
  });
});
