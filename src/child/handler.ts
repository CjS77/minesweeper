/**
 * Child-process entry point for `minesweeper handle <issue#>`.
 *
 * The child runs with `cwd` set to the issue's worktree (set by the
 * supervisor's `execaNode` call, see `src/daemon/supervisor.ts`). It
 * loads `state.json`, sanity-checks that the on-disk issue number
 * matches the CLI argument, and drives the issue's state machine
 * to a terminal status inside this single process.
 *
 * Modes wired up (post-plan-12): `Planning`, `Assess`, `Execution`,
 * `Refine`. `Delegated` is terminal — it is the post-refine resting
 * state (`mode=Delegated`, `status=Complete`).
 *
 * Multi-mode flows run inside one child invocation: each mode handler
 * persists its outgoing state to `.minesweeper/state.json` and
 * returns; the loop dispatches the next mode based on that state.
 * The full happy-path sequence is:
 *
 *   Planning → Assess → Execution → (terminal Complete)
 *                    └→ Refine    → (terminal Complete via Delegated)
 *
 * The child only exits 0 once `status` reaches a terminal value
 * (`Complete` or `Failed`), at which point the supervisor archives
 * `.minesweeper/` and removes the worktree. State-on-disk discipline
 * is preserved because every mode transition goes through `writeState`
 * before the next handler runs.
 */

import { loadConfig as defaultLoadConfig, type Config } from "../config.js";
import { event as defaultEvent, type Logger } from "../logging.js";
import { readState as defaultReadState } from "./state.js";
import type { Mode, State } from "./state.js";
import { runPlanning as defaultRunPlanning, type PlanningDeps } from "./modes/planning.js";
import { runExecution as defaultRunExecution, type ExecutionDeps } from "./modes/execution.js";
import { runAssess as defaultRunAssess, type AssessDeps } from "./modes/assess.js";
import { runRefine as defaultRunRefine, type RefineDeps } from "./modes/refine.js";

/** Test seam: the planning mode runner. Default delegates to `runPlanning`. */
export type RunPlanningFn = (deps: PlanningDeps) => Promise<State>;

/** Test seam: the execution mode runner. Default delegates to `runExecution`. */
export type RunExecutionFn = (deps: ExecutionDeps) => Promise<State>;

/** Test seam: the assess mode runner. Default delegates to `runAssess`. */
export type RunAssessFn = (deps: AssessDeps) => Promise<State>;

/** Test seam: the refine mode runner. Default delegates to `runRefine`. */
export type RunRefineFn = (deps: RefineDeps) => Promise<State>;

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
  /** Override the assess mode handler (tests). */
  runAssess?: RunAssessFn;
  /** Override the refine mode handler (tests). */
  runRefine?: RunRefineFn;
  /** Override the logger event sink (tests). */
  emit?: Logger["event"];
}

/**
 * Drive the state machine for a single issue to a terminal status.
 * Loops over mode handlers, re-reading state after each one, until
 * `status` is `Complete` or `Failed`. Throws if the on-disk issue
 * number does not match the CLI argument, if a mode handler itself
 * throws, or if a handler returns without making progress (same
 * mode/status/iterations as on entry) — that would otherwise spin
 * forever.
 */
export async function handleChild(opts: HandleChildOptions): Promise<State> {
  const cwd = opts.cwd ?? process.cwd();
  const loadConfig = opts.loadConfig ?? defaultLoadConfig;
  const readState = opts.readState ?? defaultReadState;
  const runPlanning = opts.runPlanning ?? defaultRunPlanning;
  const runExecution = opts.runExecution ?? defaultRunExecution;
  const runAssess = opts.runAssess ?? defaultRunAssess;
  const runRefine = opts.runRefine ?? defaultRunRefine;
  const emit = opts.emit ?? defaultEvent;

  let state = await readState(cwd);
  if (state.issueNumber !== opts.issueNumber) {
    throw new Error(
      `state mismatch: cwd state.json describes issue #${state.issueNumber} but child invoked with #${opts.issueNumber}`,
    );
  }

  const config = loadConfig();

  while (!isTerminal(state)) {
    emit(
      "daemon",
      "INFO",
      state.issueNumber,
      `child handle: mode=${state.mode} status=${state.status} iterations=${state.iterations}/${state.maxIterations}`,
    );
    const before = progressKey(state);
    state = await dispatch(state.mode, { config, cwd, state, runPlanning, runExecution, runAssess, runRefine });
    if (!isTerminal(state) && progressKey(state) === before) {
      throw new Error(
        `child handler: mode=${state.mode} returned without advancing state (status=${state.status}, iterations=${state.iterations}); refusing to loop`,
      );
    }
  }

  return state;
}

function isTerminal(state: State): boolean {
  return state.status === "Complete" || state.status === "Failed";
}

function progressKey(state: State): string {
  return `${state.mode}:${state.status}:${state.iterations}`;
}

interface DispatchDeps {
  config: Config;
  cwd: string;
  state: State;
  runPlanning: RunPlanningFn;
  runExecution: RunExecutionFn;
  runAssess: RunAssessFn;
  runRefine: RunRefineFn;
}

async function dispatch(mode: Mode, deps: DispatchDeps): Promise<State> {
  switch (mode) {
    case "Planning":
      return deps.runPlanning({ config: deps.config, cwd: deps.cwd, state: deps.state });
    case "Assess":
      return deps.runAssess({ config: deps.config, cwd: deps.cwd, state: deps.state });
    case "Execution":
      return deps.runExecution({ config: deps.config, cwd: deps.cwd, state: deps.state });
    case "Refine":
      return deps.runRefine({ config: deps.config, cwd: deps.cwd, state: deps.state });
    case "Delegated":
      throw new Error(
        `child handler: dispatched into terminal mode=${mode} with non-terminal status=${deps.state.status}`,
      );
  }
}
