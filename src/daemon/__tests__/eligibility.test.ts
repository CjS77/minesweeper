import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../../config.js";
import type { Issue, IssueState } from "../../github/index.js";
import { isEligible } from "../eligibility.js";

const config = loadConfig({});

interface IssueOverrides {
  labels?: readonly string[];
  state?: IssueState;
}

function makeIssue({ labels = [], state = "OPEN" }: IssueOverrides = {}): Issue {
  return {
    number: 1,
    title: "t",
    body: "b",
    labels: labels.map((name) => ({ name })),
    author: { login: "u" },
    state,
    url: "https://github.com/example/repo/issues/1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("isEligible — label hierarchy", () => {
  it.each<[string, readonly string[], boolean]>([
    ["never-fix beats always-fix", [config.neverFixLabel, config.alwaysFixLabel], false],
    ["never-fix beats manually-approved", [config.neverFixLabel, config.manuallyApprovedLabel], false],
    ["manually-approved beats failed", [config.manuallyApprovedLabel, config.failedLabel], true],
    ["manually-approved beats possibly-dangerous", [config.manuallyApprovedLabel, config.possiblyDangerousLabel], true],
    ["failed beats always-fix", [config.failedLabel, config.alwaysFixLabel], false],
    ["possibly-dangerous beats always-fix", [config.possiblyDangerousLabel, config.alwaysFixLabel], false],
    ["always-fix alone is eligible", [config.alwaysFixLabel], true],
    ["unrelated labels fall back to default (false)", ["bug", "p1"], false],
    ["no labels falls back to default (false)", [], false],
  ])("%s", (_name, labels, expected) => {
    expect(isEligible(makeIssue({ labels }), config)).toBe(expected);
  });

  it("respects MINESWEEPER_DEFAULT_ELIGIBLE=true as the catch-all", () => {
    const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" });
    expect(isEligible(makeIssue({ labels: [] }), permissive)).toBe(true);
    expect(isEligible(makeIssue({ labels: ["bug"] }), permissive)).toBe(true);
    // Hard opt-outs still win over the permissive default.
    expect(isEligible(makeIssue({ labels: [permissive.neverFixLabel] }), permissive)).toBe(false);
    expect(isEligible(makeIssue({ labels: [permissive.failedLabel] }), permissive)).toBe(false);
    expect(isEligible(makeIssue({ labels: [permissive.possiblyDangerousLabel] }), permissive)).toBe(false);
  });

  it("never matches a closed issue regardless of labels", () => {
    expect(isEligible(makeIssue({ labels: [config.alwaysFixLabel], state: "CLOSED" }), config)).toBe(false);
    expect(isEligible(makeIssue({ labels: [config.manuallyApprovedLabel], state: "CLOSED" }), config)).toBe(false);
  });

  it("honours custom label names from env", () => {
    const custom: Config = loadConfig({
      MINESWEEPER_ALWAYS_FIX_LABEL: "fix-me",
      MINESWEEPER_NEVER_FIX_LABEL: "do-not-touch",
    });
    expect(isEligible(makeIssue({ labels: ["fix-me"] }), custom)).toBe(true);
    expect(isEligible(makeIssue({ labels: ["autofix"] }), custom)).toBe(false);
    expect(isEligible(makeIssue({ labels: ["fix-me", "do-not-touch"] }), custom)).toBe(false);
  });
});
