import { fileURLToPath } from "node:url";

import type { Config } from "../config.js";

/**
 * Absolute path of the `prompts/` directory shipped inside the npm package.
 *
 * Resolved from this module's own URL so it works from both source
 * (`src/claude/roles.ts` → `<repo>/prompts/`) and compiled output
 * (`dist/claude/roles.js` → `<package-root>/prompts/`). The `prompts/`
 * directory is listed in `package.json#files`, so it ships alongside `dist/`
 * on `npm publish`. Use this when a caller has no meaningful `cwd` to anchor
 * prompt lookup against — e.g. when the child runs in a foreign repo's
 * worktree.
 */
export const BUNDLED_PROMPTS_ROOT = fileURLToPath(new URL("../../prompts/", import.meta.url));

export const ROLE_NAMES = [
  "planner",
  "critic",
  "assessor",
  "refiner",
  "executor",
  "reviewer",
  "prwriter",
  "screener",
  "issuewriter",
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
export type ModelEnvVar = "planningAgent" | "reviewAgent" | "executionAgent" | "eligibilityAgent" | "issueWriterAgent";

export interface Role {
  readonly name: RoleName;
  readonly modelEnvVar: ModelEnvVar;
  /**
   * Filename of the role's system prompt, relative to the prompts root
   * (either {@link BUNDLED_PROMPTS_ROOT} or `config.customPromptsPath`).
   * No directory component — both roots point at the prompts directory
   * itself.
   */
  readonly systemPromptPath: string;
  readonly allowedTools: readonly string[];
  readonly permissionMode: RolePermissionMode;
}

export const ROLES: Record<RoleName, Role> = {
  planner: {
    name: "planner",
    modelEnvVar: "planningAgent",
    systemPromptPath: "planner.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash", "WebFetch"],
    permissionMode: "plan",
  },
  critic: {
    name: "critic",
    modelEnvVar: "reviewAgent",
    systemPromptPath: "critic.md",
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "plan",
  },
  assessor: {
    name: "assessor",
    modelEnvVar: "planningAgent",
    systemPromptPath: "assessor.md",
    allowedTools: ["Read", "Grep"],
    permissionMode: "plan",
  },
  refiner: {
    name: "refiner",
    modelEnvVar: "planningAgent",
    systemPromptPath: "refiner.md",
    allowedTools: ["Read", "Grep"],
    permissionMode: "plan",
  },
  executor: {
    name: "executor",
    modelEnvVar: "executionAgent",
    systemPromptPath: "executor.md",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    permissionMode: "acceptEdits",
  },
  reviewer: {
    name: "reviewer",
    modelEnvVar: "reviewAgent",
    systemPromptPath: "reviewer.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "plan",
  },
  prwriter: {
    name: "prwriter",
    modelEnvVar: "reviewAgent",
    systemPromptPath: "prwriter.md",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "plan",
  },
  screener: {
    name: "screener",
    modelEnvVar: "eligibilityAgent",
    systemPromptPath: "screener.md",
    allowedTools: ["Read", "Grep"],
    permissionMode: "plan",
  },
  issuewriter: {
    name: "issuewriter",
    modelEnvVar: "issueWriterAgent",
    systemPromptPath: "issuewriter.md",
    allowedTools: ["Read", "Grep", "Glob"],
    // `default`, not `plan`: plan mode injects a plan-workflow system reminder,
    // but this role has no plan file and no `Write`/`ExitPlanMode` tools, so it
    // narrates that confusion instead of emitting the issue document. Its tools
    // are all read-only, so `default` cannot cause mutations. See issue #52.
    permissionMode: "default",
  },
};

export function getRole(name: RoleName): Role {
  return ROLES[name];
}

export function modelFor(role: Role, config: Config): string {
  return config[role.modelEnvVar];
}
