#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import { Command, Option } from "commander";

import { loadConfig } from "./config.js";
import { createLogger, event, getActiveLogger } from "./logging.js";
import { createSupervisor, defaultSpawnChild, runPollLoop, type Supervisor } from "./daemon/index.js";
import { handleChild } from "./child/handler.js";
import { runIssueListCommand, runIssueNewCommand } from "./commands/issues.js";
import { runLabelsCommand } from "./commands/labels.js";
import { runLogViewCommand } from "./commands/log.js";
import { runModelsCommand } from "./commands/models.js";
import { listOrphans } from "./worktree.js";

const program = new Command();

program
  .name("minesweeper")
  .description("An agentic bughunter that drives Claude Code to triage and fix GitHub issues.")
  .version("0.0.0")
  .option("-q, --quiet", "suppress INFO output on stdout (file logs are unaffected)")
  .hook("preAction", (thisCommand, actionCommand) => {
    // Read-only utilities write their own output; spinning up pino's file
    // destination just to tear it down would also create `.minesweeper/logs/`
    // in whatever cwd the user happens to be in.
    if (LOGGER_FREE_COMMANDS.has(commandPath(actionCommand))) return;
    const opts = thisCommand.optsWithGlobals();
    createLogger({ quiet: Boolean(opts.quiet) });
  });

const LOGGER_FREE_COMMANDS = new Set(["models", "log view", "issue list", "issue new"]);

function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let cursor: Command | null = cmd;
  while (cursor && cursor.parent) {
    parts.unshift(cursor.name());
    cursor = cursor.parent;
  }
  return parts.join(" ");
}

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
    event("daemon", "INFO", Number(issue), `minesweeper once — one-shot driver not yet implemented`);
  });

program
  .command("labels")
  .description("Create or update the GitHub labels Minesweeper uses on the current repository.")
  .option("-l, --list", "print the canonical Minesweeper labels and exit (no changes made)")
  .addOption(new Option("--ls").hideHelp())
  .option("-f, --force", "skip the confirmation prompt and apply changes immediately")
  .action(async (opts: { list?: boolean; ls?: boolean; force?: boolean }) => {
    const config = loadConfig();
    await runLabelsCommand({
      config,
      cwd: process.cwd(),
      list: Boolean(opts.list || opts.ls),
      force: Boolean(opts.force),
    });
  });

program
  .command("models")
  .description("List Claude models available to your ANTHROPIC_API_KEY.")
  .option("-v, --verbose", "show all model info (capabilities, limits, dates)")
  .option("-f, --format <format>", "output format: text (default) or json", "text")
  .action(async (opts: { verbose?: boolean; format?: string }) => {
    const format = parseFormatArg(opts.format);
    await runModelsCommand({ verbose: Boolean(opts.verbose), format });
  });

const log = program.command("log").description("Inspect Minesweeper log and transcript files.");

log
  .command("view")
  .argument("[name]", "transcript name (e.g. planner-01), .jsonl path, or — with --issue — a basename regex filter")
  .description("Pretty-print a JSONL transcript captured during a planning or execution run.")
  .option("--issue <n>", "issue number; finds matching transcripts under MINESWEEPER_WORKTREE_PATH")
  .option("--no-color", "disable ANSI colour escapes")
  .option("--max-lines <n>", "max body lines per message (0 = unlimited)", "40")
  .action((name: string | undefined, opts: { issue?: string; color?: boolean; maxLines?: string }) => {
    const issueNumber = opts.issue !== undefined ? parseIssueArg(opts.issue) : undefined;
    const worktreePath = issueNumber !== undefined ? loadConfig().worktreePath : undefined;
    runLogViewCommand({
      name,
      issueNumber,
      worktreePath,
      cwd: process.cwd(),
      color: opts.color !== false,
      maxLines: parseMaxLines(opts.maxLines),
    });
  });

const issue = program.command("issue").description("Inspect or create issues that Minesweeper can act on.");

issue
  .command("list")
  .description("List the repository's open issues, marking eligible and in-progress ones.")
  .action(async () => {
    const config = loadConfig();
    await runIssueListCommand({ config, cwd: process.cwd() });
  });

issue
  .command("new")
  .description("Create a new issue from the CLI (not yet implemented).")
  .action(() => {
    runIssueNewCommand();
  });

program.parseAsync(process.argv).catch(handleFatal);

async function handleFatal(err: unknown): Promise<never> {
  if (err instanceof Error) {
    process.stderr.write(`${chalk.red("error:")} ${err.message}\n`);
    if (process.env["MINESWEEPER_DEBUG"] && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  } else {
    process.stderr.write(`${chalk.red("error:")} ${String(err)}\n`);
  }
  // Drain pino's async file destination if any command opened one, otherwise
  // sonic-boom throws "not ready yet" when the event loop tears down.
  await getActiveLogger()
    ?.flush()
    .catch(() => undefined);
  process.exit(1);
}

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
    onTickEnd: async () => {
      await supervisor.sweepClosedIssues();
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
    if (orphan.state.status === "Complete") {
      event(
        "daemon",
        "INFO",
        orphan.state.issueNumber,
        `orphan worktree ${orphan.path} already Complete; closed-issue sweep will reap it`,
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

function parseFormatArg(raw: string | undefined): "text" | "json" {
  if (raw === undefined || raw === "text") return "text";
  if (raw === "json") return "json";
  throw new Error(`invalid --format: ${JSON.stringify(raw)} (expected "text" or "json")`);
}

function parseMaxLines(raw: string | undefined): number {
  if (raw === undefined) return 40;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid --max-lines: ${JSON.stringify(raw)} (expected a non-negative integer)`);
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
