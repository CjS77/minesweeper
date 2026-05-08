export { isEligible } from "./eligibility.js";
export {
  pollOnce,
  runPollLoop,
  type EligibilityFn,
  type PollLoopHandle,
  type PollLoopOptions,
  type PollerDeps,
} from "./poller.js";
export {
  branchNameFor,
  createSupervisor,
  defaultSpawnChild,
  type ChildHandle,
  type DefaultSpawnChildOptions,
  type OrphanedWorktree,
  type SpawnChild,
  type SpawnChildOptions,
  type Supervisor,
  type SupervisorDeps,
} from "./supervisor.js";
