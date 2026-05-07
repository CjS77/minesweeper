import type { Config } from "../config.js";

export const ROLE_NAMES = [
  "planner",
  "critic",
  "assessor",
  "refiner",
  "executor",
  "reviewer",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * The subset of `PermissionMode` we expose to roles. The full SDK type also
 * includes `bypassPermissions`, `dontAsk`, `auto`; we deliberately avoid those
 * — see plans/05_claude_sdk_wrapper.md for the rationale.
 */
export type RolePermissionMode = "default" | "plan" | "acceptEdits";

/**
 * Which Config field holds the model name for each role. Constrained to the
 * agent fields so that a typo in role configuration is a type error.
 */
export type ModelEnvVar = "planningAgent" | "reviewAgent" | "executionAgent" | "eligibilityAgent";

export interface Role {
  readonly name: RoleName;
  readonly modelEnvVar: ModelEnvVar;
  readonly systemPromptPath: string;
  readonly allowedTools: readonly string[];
  readonly permissionMode: RolePermissionMode;
}

export const ROLES: Record<RoleName, Role> = {
  planner: {
    name: "planner",
    modelEnvVar: "planningAgent",
    systemPromptPath: "prompts/planner.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash", "WebFetch"],
    permissionMode: "plan",
  },
  critic: {
    name: "critic",
    modelEnvVar: "reviewAgent",
    systemPromptPath: "prompts/critic.md",
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "plan",
  },
  assessor: {
    name: "assessor",
    modelEnvVar: "reviewAgent",
    systemPromptPath: "prompts/assessor.md",
    allowedTools: ["Read", "Grep"],
    permissionMode: "plan",
  },
  refiner: {
    name: "refiner",
    modelEnvVar: "planningAgent",
    systemPromptPath: "prompts/refiner.md",
    allowedTools: ["Read", "Grep"],
    permissionMode: "plan",
  },
  executor: {
    name: "executor",
    modelEnvVar: "executionAgent",
    systemPromptPath: "prompts/executor.md",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    permissionMode: "acceptEdits",
  },
  reviewer: {
    name: "reviewer",
    modelEnvVar: "reviewAgent",
    systemPromptPath: "prompts/reviewer.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "plan",
  },
};

export function getRole(name: RoleName): Role {
  return ROLES[name];
}

export function modelFor(role: Role, config: Config): string {
  return config[role.modelEnvVar];
}
