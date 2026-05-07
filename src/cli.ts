#!/usr/bin/env node
import { Command } from "commander";
import { createLogger, event } from "./logging.js";

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
  .action(() => {
    event("daemon", "INFO", null, "minesweeper run — daemon not yet implemented");
  });

program
  .command("handle")
  .argument("<issue>", "issue number to handle (cwd must be the issue's worktree)")
  .description("Child worker entry: drive the state machine for a single issue from the worktree.")
  .action((issue: string) => {
    event("daemon", "INFO", Number(issue), `minesweeper handle — child handler not yet implemented`);
  });

program
  .command("once")
  .argument("<issue>", "issue number to process once")
  .description("Debug helper: run a single issue end-to-end without the daemon loop.")
  .action((issue: string) => {
    event("daemon", "INFO", Number(issue), `minesweeper once — one-shot driver not yet implemented`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
