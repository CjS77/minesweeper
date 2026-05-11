import { describe, expect, it, vi } from "vitest";
import { type Config, loadConfig } from "../../config.js";
import type { Issue, IssueState } from "../../github/index.js";
import { decideEligibility, isEligible, type ScreenIssueFn } from "../eligibility.js";
import type { ScreenResult, ScreenVerdict } from "../screen.js";

const config = loadConfig({}, { configFile: null });

interface IssueOverrides {
  number?: number;
  labels?: readonly string[];
  state?: IssueState;
}

function makeIssue({ number = 1, labels = [], state = "OPEN" }: IssueOverrides = {}): Issue {
  return {
    number,
    title: "t",
    body: "b",
    labels: labels.map((name) => ({ name })),
    author: { login: "u" },
    state,
    url: `https://github.com/example/repo/issues/${number}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("isEligible — label hierarchy", () => {
  it.each<[string, readonly string[], boolean]>([
    ["never-fix beats always-fix", [config.neverFixLabel, config.alwaysFixLabel], false],
    ["never-fix beats manually-approved", [config.neverFixLabel, config.manuallyApprovedLabel], false],
    ["never-fix beats try-fix", [config.neverFixLabel, config.tryFixLabel], false],
    ["manually-approved beats failed", [config.manuallyApprovedLabel, config.failedLabel], true],
    ["manually-approved beats possibly-dangerous", [config.manuallyApprovedLabel, config.possiblyDangerousLabel], true],
    ["failed beats always-fix", [config.failedLabel, config.alwaysFixLabel], false],
    ["failed beats try-fix", [config.failedLabel, config.tryFixLabel], false],
    ["possibly-dangerous beats always-fix", [config.possiblyDangerousLabel, config.alwaysFixLabel], false],
    ["possibly-dangerous beats try-fix", [config.possiblyDangerousLabel, config.tryFixLabel], false],
    ["always-fix alone is eligible", [config.alwaysFixLabel], true],
    // tryFix is *potentially* eligible — `decideEligibility` resolves it via the screener.
    ["try-fix alone is potentially eligible (sync true)", [config.tryFixLabel], true],
    ["unrelated labels fall back to default (false)", ["bug", "p1"], false],
    ["no labels falls back to default (false)", [], false],
  ])("%s", (_name, labels, expected) => {
    expect(isEligible(makeIssue({ labels }), config)).toBe(expected);
  });

  it("respects MINESWEEPER_DEFAULT_ELIGIBLE=true as the catch-all", () => {
    const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" }, { configFile: null });
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
    const custom: Config = loadConfig(
      {
        MINESWEEPER_ALWAYS_FIX_LABEL: "fix-me",
        MINESWEEPER_NEVER_FIX_LABEL: "do-not-touch",
      },
      { configFile: null },
    );
    expect(isEligible(makeIssue({ labels: ["fix-me"] }), custom)).toBe(true);
    expect(isEligible(makeIssue({ labels: ["autofix"] }), custom)).toBe(false);
    expect(isEligible(makeIssue({ labels: ["fix-me", "do-not-touch"] }), custom)).toBe(false);
  });
});

const permissive = loadConfig({ MINESWEEPER_DEFAULT_ELIGIBLE: "true" }, { configFile: null });

function fakeScreen(verdict: ScreenVerdict): ScreenIssueFn {
  return vi.fn(async (issue) => ({
    verdict,
    reason: `screener said ${verdict}`,
    issueUpdatedAt: issue.updatedAt,
    screenedAt: "2026-05-08T12:00:00.000Z",
  })) as unknown as ScreenIssueFn;
}

function makeGhStub(): {
  addLabel: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
} {
  return {
    addLabel: vi.fn(async () => undefined),
    comment: vi.fn(async () => undefined),
  };
}

describe("decideEligibility", () => {
  it("short-circuits closed issues without calling the screener", async () => {
    const screen = fakeScreen("safe");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ state: "CLOSED" }), {
      config: permissive,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("closed");
    expect(screen).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("alwaysFix label skips the screener and returns eligible", async () => {
    const screen = fakeScreen("dangerous");
    const result = await decideEligibility(makeIssue({ labels: [permissive.alwaysFixLabel] }), {
      config: permissive,
      cwd: "/tmp",
      github: makeGhStub(),
      screenIssue: screen,
    });
    expect(result.eligible).toBe(true);
    expect(screen).not.toHaveBeenCalled();
  });

  it("manuallyApproved label skips the screener and returns eligible", async () => {
    const screen = fakeScreen("dangerous");
    const result = await decideEligibility(makeIssue({ labels: [permissive.manuallyApprovedLabel] }), {
      config: permissive,
      cwd: "/tmp",
      github: makeGhStub(),
      screenIssue: screen,
    });
    expect(result.eligible).toBe(true);
    expect(screen).not.toHaveBeenCalled();
  });

  it("possiblyDangerous label is ineligible without invoking the screener again", async () => {
    const screen = fakeScreen("safe");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [permissive.possiblyDangerousLabel] }), {
      config: permissive,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(screen).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.comment).not.toHaveBeenCalled();
  });

  it("default-ineligible config does not invoke the screener for unlabelled issues", async () => {
    const screen = fakeScreen("safe");
    const result = await decideEligibility(makeIssue({ labels: [] }), {
      config,
      cwd: "/tmp",
      github: makeGhStub(),
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(screen).not.toHaveBeenCalled();
  });

  it("default-eligible + safe verdict → eligible, no labelling", async () => {
    const screen = fakeScreen("safe");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [] }), {
      config: permissive,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(true);
    expect(result.screen?.verdict).toBe("safe");
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.comment).not.toHaveBeenCalled();
  });

  it("default-eligible + dangerous verdict → labels, comments, ineligible", async () => {
    const screen = fakeScreen("dangerous");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [], number: 42 }), {
      config: permissive,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(result.screen?.verdict).toBe("dangerous");
    expect(gh.addLabel).toHaveBeenCalledWith(42, permissive.possiblyDangerousLabel, {
      cwd: "/tmp",
    });
    expect(gh.comment).toHaveBeenCalledTimes(1);
    const commentArgs = gh.comment.mock.calls[0]!;
    expect(commentArgs[0]).toBe(42);
    expect(String(commentArgs[1])).toContain(permissive.possiblyDangerousLabel);
    expect(String(commentArgs[1])).toContain(permissive.manuallyApprovedLabel);
    expect(String(commentArgs[1])).toContain("dangerous");
  });

  it("default-eligible + uncertain verdict → labels, no comment, ineligible", async () => {
    const screen = fakeScreen("uncertain");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [], number: 13 }), {
      config: permissive,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(result.screen?.verdict).toBe("uncertain");
    expect(gh.addLabel).toHaveBeenCalledWith(13, permissive.possiblyDangerousLabel, {
      cwd: "/tmp",
    });
    expect(gh.comment).not.toHaveBeenCalled();
  });

  it("does not abort eligibility when applying the dangerous label fails", async () => {
    const screen = fakeScreen("uncertain");
    const gh = {
      addLabel: vi.fn(async () => {
        throw new Error("gh: rate limited");
      }),
      comment: vi.fn(async () => undefined),
    };
    const emit = vi.fn();
    const result = await decideEligibility(makeIssue({ labels: [], number: 9 }), {
      config: permissive,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
      emit,
    });
    expect(result.eligible).toBe(false);
    expect(emit.mock.calls.some((c) => c[1] === "WARN")).toBe(true);
  });

  it("tryFix label runs the screener even when defaultEligible=false", async () => {
    const screen = fakeScreen("safe");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [config.tryFixLabel] }), {
      config, // defaultEligible=false
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(true);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(result.screen?.verdict).toBe("safe");
    expect(result.reason).toContain(config.tryFixLabel);
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it("tryFix + dangerous verdict → labels possiblyDangerous, posts comment, ineligible", async () => {
    const screen = fakeScreen("dangerous");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [config.tryFixLabel], number: 77 }), {
      config,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(result.screen?.verdict).toBe("dangerous");
    expect(result.reason).toContain(config.tryFixLabel);
    expect(result.reason).toContain("dangerous");
    expect(gh.addLabel).toHaveBeenCalledWith(77, config.possiblyDangerousLabel, { cwd: "/tmp" });
    expect(gh.comment).toHaveBeenCalledTimes(1);
  });

  it("tryFix + uncertain verdict → labels possiblyDangerous, no comment, ineligible", async () => {
    const screen = fakeScreen("uncertain");
    const gh = makeGhStub();
    const result = await decideEligibility(makeIssue({ labels: [config.tryFixLabel], number: 88 }), {
      config,
      cwd: "/tmp",
      github: gh,
      screenIssue: screen,
    });
    expect(result.eligible).toBe(false);
    expect(result.screen?.verdict).toBe("uncertain");
    expect(gh.addLabel).toHaveBeenCalledWith(88, config.possiblyDangerousLabel, { cwd: "/tmp" });
    expect(gh.comment).not.toHaveBeenCalled();
  });

  it("manuallyApproved beats tryFix — screener is not invoked", async () => {
    const screen = fakeScreen("dangerous");
    const result = await decideEligibility(makeIssue({ labels: [config.manuallyApprovedLabel, config.tryFixLabel] }), {
      config,
      cwd: "/tmp",
      github: makeGhStub(),
      screenIssue: screen,
    });
    expect(result.eligible).toBe(true);
    expect(screen).not.toHaveBeenCalled();
  });

  it("alwaysFix beats tryFix — screener is not invoked", async () => {
    const screen = fakeScreen("dangerous");
    const result = await decideEligibility(makeIssue({ labels: [config.alwaysFixLabel, config.tryFixLabel] }), {
      config,
      cwd: "/tmp",
      github: makeGhStub(),
      screenIssue: screen,
    });
    expect(result.eligible).toBe(true);
    expect(screen).not.toHaveBeenCalled();
  });

  it("propagates the screen result so the caller can log/inspect it", async () => {
    const sample: ScreenResult = {
      verdict: "safe",
      reason: "looks like a normal bug",
      issueUpdatedAt: "2026-05-01T00:00:00Z",
      screenedAt: "2026-05-08T12:00:00.000Z",
    };
    const screen = vi.fn(async () => sample) as unknown as ScreenIssueFn;
    const result = await decideEligibility(makeIssue({ labels: [] }), {
      config: permissive,
      cwd: "/tmp",
      github: makeGhStub(),
      screenIssue: screen,
    });
    expect(result.screen).toBe(sample);
  });
});
