/**
 * Child-process entry point for `minesweeper handle <issue#>`.
 *
 * The child runs with `cwd` set to the issue's worktree (set by the
 * supervisor's `execaNode` call, see `src/daemon/supervisor.ts`). It
 * loads `state.json`, sanity-checks that the on-disk issue number
 * matches the CLI argument, and drives the issue's state machine
 * to a terminal status inside this single process.
 *
 * As of plan 09 the `Planning` and `Execution` modes are wired up.
 * `Delegated` is still a no-op and throws — that is the assess+refine
 * exit path which lands in plan 12.
 *
 * Multi-mode flows (Planning → Execution, later Planning → Assess →
 * Refine|Execution) run inside one child invocation: each mode handler
 * persists its outgoing state to `.minesweeper/state.json` and
 * returns; the loop dispatches the next mode based on that state.
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
 * Drive the state machine for a single issue to a terminal status.
 * Loops over mode handlers, re-reading state after each one, until
 * `status` is `Complete` or `Failed`. Throws if the on-disk issue
 * number does not match the CLI argument, if the mode is not
 * implemented in this build, if a mode handler itself throws, or if
 * a handler returns without making progress (same mode/status/iterations
 * as on entry) — that would otherwise spin forever.
 */
export async function handleChild(opts: HandleChildOptions): Promise<State> {
  const cwd = opts.cwd ?? process.cwd();
  const loadConfig = opts.loadConfig ?? defaultLoadConfig;
  const readState = opts.readState ?? defaultReadState;
  const runPlanning = opts.runPlanning ?? defaultRunPlanning;
  const runExecution = opts.runExecution ?? defaultRunExecution;
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
    state = await dispatch(state.mode, { config, cwd, state, runPlanning, runExecution });
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
      throw new Error(`child handler: mode=${mode} not implemented in this build (plan 12 will land assess/refine)`);
  }
}
