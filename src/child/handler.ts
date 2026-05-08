/**
 * Child-process entry point for `minesweeper handle <issue#>`.
 *
 * The child runs with `cwd` set to the issue's worktree (set by the
 * supervisor's `execaNode` call, see `src/daemon/supervisor.ts`). It
 * loads `state.json`, sanity-checks that the on-disk issue number
 * matches the CLI argument, and dispatches to the mode-specific
 * handler.
 *
 * As of plan 09 the `Planning` and `Execution` modes are wired up.
 * `Delegated` is still a no-op and throws — that is the assess+refine
 * exit path which lands in plan 12.
 *
 * Each mode runs to completion (or a clean state-machine boundary) and
 * then returns. The CLI exits 0 on return, which signals the supervisor
 * to archive `.minesweeper/` and remove the worktree on the success
 * path. For multi-mode flows (Planning → Execution) we deliberately
 * exit between modes — the supervisor's next dispatch will re-spawn
 * the child against the same worktree, and the new mode handler picks
 * up from the just-written state. This keeps each mode a process
 * boundary and enforces the "state on disk" discipline from
 * `plans/00_index.md`.
 */

import { loadConfig as defaultLoadConfig, type Config } from "../config.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { readState as defaultReadState } from "./state.js";
import type { Mode, State } from "./state.js";
import { runPlanning as defaultRunPlanning, type PlanningDeps } from "./modes/planning.js";
import { runExecution as defaultRunExecution, type ExecutionDeps } from "./modes/execution.js";

/** Test seam: the planning mode runner. Default delegates to `runPlanning`. */
export type RunPlanningFn = (deps: PlanningDeps) => Promise<State>;

/** Test seam: the execution mode runner. Default delegates to `runExecution`. */
export type RunExecutionFn = (deps: ExecutionDeps) => Promise<State>;

export interface HandleChildOptions {
  /** The issue number passed on the CLI. Cross-checked against state.json. */
  issueNumber: number;
  /** Worktree root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override config loader (tests). */
  loadConfig?: () => Config;
  /** Override `readState` (tests). */
  readState?: typeof defaultReadState;
  /** Override the planning mode handler (tests). */
  runPlanning?: RunPlanningFn;
  /** Override the execution mode handler (tests). */
  runExecution?: RunExecutionFn;
  /** Override the logger event sink (tests). */
  emit?: Logger["event"];
}

/**
 * Drive the state machine for a single issue. Resolves once the
 * dispatched mode handler returns. Throws if the on-disk issue number
 * does not match the CLI argument, if the mode is not implemented in
 * this build, or if the mode handler itself throws.
 */
export async function handleChild(opts: HandleChildOptions): Promise<State> {
  const cwd = opts.cwd ?? process.cwd();
  const loadConfig = opts.loadConfig ?? defaultLoadConfig;
  const readState = opts.readState ?? defaultReadState;
  const runPlanning = opts.runPlanning ?? defaultRunPlanning;
  const runExecution = opts.runExecution ?? defaultRunExecution;
  const emit = opts.emit ?? defaultEvent;

  const state = await readState(cwd);
  if (state.issueNumber !== opts.issueNumber) {
    throw new Error(
      `state mismatch: cwd state.json describes issue #${state.issueNumber} but child invoked with #${opts.issueNumber}`,
    );
  }

  const config = loadConfig();
  emit(
    "daemon",
    "INFO",
    state.issueNumber,
    `child handle: mode=${state.mode} status=${state.status} iterations=${state.iterations}/${state.maxIterations}`,
  );

  return dispatch(state.mode, { config, cwd, state, runPlanning, runExecution });
}

interface DispatchDeps {
  config: Config;
  cwd: string;
  state: State;
  runPlanning: RunPlanningFn;
  runExecution: RunExecutionFn;
}

async function dispatch(mode: Mode, deps: DispatchDeps): Promise<State> {
  switch (mode) {
    case "Planning":
      return deps.runPlanning({
        config: deps.config,
        cwd: deps.cwd,
        state: deps.state,
      });
    case "Execution":
      return deps.runExecution({
        config: deps.config,
        cwd: deps.cwd,
        state: deps.state,
      });
    case "Delegated":
      throw new Error(
        `child handler: mode=${mode} not implemented in this build (plan 12 will land assess/refine)`,
      );
  }
}
