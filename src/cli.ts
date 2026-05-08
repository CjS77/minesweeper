#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { loadConfig } from "./config.js";
import { createLogger, event, getActiveLogger } from "./logging.js";
import {
  createSupervisor,
  defaultSpawnChild,
  runPollLoop,
  type Supervisor,
} from "./daemon/index.js";
import { handleChild } from "./child/handler.js";
import { listOrphans } from "./worktree.js";

const program = new Command();

program
  .name("minesweeper")
  .description("An agentic bughunter that drives Claude Code to triage and fix GitHub issues.")
  .version("0.0.0")
  .option("-q, --quiet", "suppress INFO output on stdout (file logs are unaffected)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    createLogger({ quiet: Boolean(opts.quiet) });
  });

program
  .command("run")
  .description("Start the long-running daemon: poll GitHub and dispatch eligible issues.")
  .action(async () => {
    await runDaemon();
  });

program
  .command("handle")
  .argument("<issue>", "issue number to handle (cwd must be the issue's worktree)")
  .description("Child worker entry: drive the state machine for a single issue from the worktree.")
  .action(async (issue: string) => {
    const issueNumber = parseIssueArg(issue);
    await handleChild({ issueNumber });
  });

program
  .command("once")
  .argument("<issue>", "issue number to process once")
  .description("Debug helper: run a single issue end-to-end without the daemon loop.")
  .action((issue: string) => {
    event(
      "daemon",
      "INFO",
      Number(issue),
      `minesweeper once — one-shot driver not yet implemented`,
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const repoRoot = process.cwd();
  const worktreesRoot = resolve(config.worktreePath, "worktrees");
  const archiveRoot = resolve(config.worktreePath, "archive");
  const childScript = fileURLToPath(import.meta.url);

  const supervisor = createSupervisor({
    config,
    repoRoot,
    worktreesRoot,
    archiveRoot,
    spawnChild: defaultSpawnChild({ childScript }),
  });

  await recoverOrphans(supervisor, worktreesRoot);

  const loop = runPollLoop({ config, cwd: repoRoot }, [config.pollIntervalMs], {
    onIssue: async (issue) => {
      await supervisor.dispatch(issue);
    },
  });

  event(
    "daemon",
    "INFO",
    null,
    `minesweeper run started (poll=${config.pollIntervalSeconds}s, concurrency=${config.maxConcurrency})`,
  );

  await waitForShutdown();
  event("daemon", "INFO", null, "shutdown signal received; draining in-flight children");
  loop.stop();
  await supervisor.drain();
  event("daemon", "OK", null, "daemon stopped cleanly");
  await getActiveLogger()?.flush();
}

async function recoverOrphans(supervisor: Supervisor, worktreesRoot: string): Promise<void> {
  const orphans = await listOrphans(worktreesRoot);
  for (const orphan of orphans) {
    if (!orphan.state) continue;
    if (orphan.state.status === "Failed") {
      event(
        "daemon",
        "WARN",
        orphan.state.issueNumber,
        `orphan worktree ${orphan.path} is in Failed state; leaving for inspection`,
      );
      continue;
    }
    await supervisor.resume({ path: orphan.path, state: orphan.state });
  }
}

function parseIssueArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid issue number: ${JSON.stringify(raw)}`);
  }
  return n;
}

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolveShutdown) => {
    const onSignal = (sig: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      event("daemon", "INFO", null, `caught ${sig}`);
      resolveShutdown();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
