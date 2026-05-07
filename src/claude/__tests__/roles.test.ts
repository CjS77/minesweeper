import { describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { ROLE_NAMES, ROLES, getRole, modelFor } from "../roles.js";

const FAKE_CONFIG: Config = {
  defaultEligible: false,
  alwaysFixLabel: "autofix",
  neverFixLabel: "manual",
  possiblyDangerousLabel: "danger",
  manuallyApprovedLabel: "ok",
  failedLabel: "failed",
  subtaskLabel: "subtask",
  maxPlanningIterations: 3,
  maxReviewRounds: 2,
  eligibilityAgent: "haiku-eligibility",
  planningAgent: "opus-planning",
  reviewAgent: "sonnet-review",
  executionAgent: "opus-execution",
  worktreePath: "/tmp/wt",
  prBaseBranch: "main",
  pollIntervalSeconds: 60,
  pollIntervalMs: 60_000,
  maxConcurrency: 1,
};

describe("ROLES registry", () => {
  it("contains an entry for every name in ROLE_NAMES", () => {
    for (const name of ROLE_NAMES) {
      const role = ROLES[name];
      expect(role.name).toBe(name);
      expect(role.systemPromptPath).toBe(`prompts/${name}.md`);
      expect(role.allowedTools.length).toBeGreaterThan(0);
    }
  });

  it("uses 'plan' permissionMode for read-only roles and 'acceptEdits' for executor", () => {
    expect(ROLES.planner.permissionMode).toBe("plan");
    expect(ROLES.critic.permissionMode).toBe("plan");
    expect(ROLES.assessor.permissionMode).toBe("plan");
    expect(ROLES.refiner.permissionMode).toBe("plan");
    expect(ROLES.reviewer.permissionMode).toBe("plan");
    expect(ROLES.executor.permissionMode).toBe("acceptEdits");
  });

  it("only the executor is allowed Edit/Write/Bash for mutations", () => {
    expect(ROLES.executor.allowedTools).toContain("Edit");
    expect(ROLES.executor.allowedTools).toContain("Write");
    for (const name of ["planner", "critic", "assessor", "refiner", "reviewer"] as const) {
      expect(ROLES[name].allowedTools).not.toContain("Edit");
      expect(ROLES[name].allowedTools).not.toContain("Write");
    }
  });

  it("modelFor maps each role to the right Config field", () => {
    expect(modelFor(getRole("planner"), FAKE_CONFIG)).toBe("opus-planning");
    expect(modelFor(getRole("refiner"), FAKE_CONFIG)).toBe("opus-planning");
    expect(modelFor(getRole("critic"), FAKE_CONFIG)).toBe("sonnet-review");
    expect(modelFor(getRole("assessor"), FAKE_CONFIG)).toBe("sonnet-review");
    expect(modelFor(getRole("reviewer"), FAKE_CONFIG)).toBe("sonnet-review");
    expect(modelFor(getRole("executor"), FAKE_CONFIG)).toBe("opus-execution");
  });
});
