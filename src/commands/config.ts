/**
 * `minesweeper config` — bootstrap and inspect Minesweeper's per-repo
 * JSON config file at `<cwd>/.minesweeper/config.json`.
 *
 * - `init` writes the file populated with every user-settable key at its
 *   built-in default. Defaults are read by calling `loadConfig` with an
 *   empty env and the file-skip sentinels, then dropping the
 *   loader-populated fields (`pollIntervalMs`, `pollCooldownMs`,
 *   `sources`). That way init tracks any future default change in
 *   `src/config.ts` without a parallel list. Refuses to overwrite an
 *   existing file unless `force: true` is set.
 * - `show` reads and prints that same file as-is. Read-only.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import chalk from "chalk";

import { loadConfig } from "../config.js";

/** Fields populated by the loader; not valid keys in the on-disk file. */
const DERIVED_KEYS: ReadonlySet<string> = new Set(["pollIntervalMs", "pollCooldownMs", "sources"]);

export interface RunConfigInitOptions {
  cwd?: string;
  /** Overwrite the file if it already exists. */
  force?: boolean;
  stdout?: NodeJS.WritableStream;
}

export interface RunConfigInitResult {
  /** Absolute path of the target config file. */
  path: string;
  /** True when the file already existed and `force` was not set. */
  skipped?: boolean;
}

export interface RunConfigShowOptions {
  cwd?: string;
  stdout?: NodeJS.WritableStream;
}

export interface RunConfigShowResult {
  /** Absolute path of the file consulted. */
  path: string;
  /** True when the file does not exist. */
  missing?: boolean;
}

function repoConfigPath(cwd: string): string {
  return join(cwd, ".minesweeper", "config.json");
}

/**
 * Build the JSON body for `config init` — every user-settable key at its
 * loader-default. Derived by calling `loadConfig` with empty env and the
 * file-skip sentinels, then filtering out fields the loader populates
 * itself (which `ConfigFileSchema` would reject on round-trip).
 */
export function buildDefaultConfigFile(): Record<string, unknown> {
  const defaults = loadConfig({}, { configFile: null, repoConfigFile: null });
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => !DERIVED_KEYS.has(key)));
}

/** Write the default per-repo config file. Pure I/O — no logger, no network. */
export function runConfigInitCommand(opts: RunConfigInitOptions = {}): RunConfigInitResult {
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;
  const path = repoConfigPath(cwd);

  if (!opts.force && pathExists(path)) {
    stdout.write(`${chalk.yellow("config init:")} ${path} already exists — pass --force to overwrite\n`);
    return { path, skipped: true };
  }

  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(buildDefaultConfigFile(), null, 2)}\n`;
  writeFileSync(path, body, "utf8");
  stdout.write(`${chalk.green("config init:")} wrote default config to ${path}\n`);
  return { path };
}

/** Print the per-repo config file as-is. */
export function runConfigShowCommand(opts: RunConfigShowOptions = {}): RunConfigShowResult {
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;
  const path = repoConfigPath(cwd);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      stdout.write(
        `${chalk.yellow("config show:")} no config file at ${path} — run 'minesweeper config init' to create one\n`,
      );
      return { path, missing: true };
    }
    throw err;
  }

  stdout.write(`${chalk.dim(`# ${path}`)}\n`);
  stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
  return { path };
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
