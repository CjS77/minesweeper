#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("minesweeper")
  .description("An agentic bughunter that drives Claude Code to triage and fix GitHub issues.")
  .version("0.0.0");

program
  .command("run")
  .description("Start the long-running daemon: poll GitHub and dispatch eligible issues.")
  .action(() => {
    console.log("TODO: `run` is not yet implemented.");
  });

program
  .command("handle")
  .argument("<issue>", "issue number to handle (cwd must be the issue's worktree)")
  .description("Child worker entry: drive the state machine for a single issue from the worktree.")
  .action((issue: string) => {
    console.log(`TODO: \`handle ${issue}\` is not yet implemented.`);
  });

program
  .command("once")
  .argument("<issue>", "issue number to process once")
  .description("Debug helper: run a single issue end-to-end without the daemon loop.")
  .action((issue: string) => {
    console.log(`TODO: \`once ${issue}\` is not yet implemented.`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
