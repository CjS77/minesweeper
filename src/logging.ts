import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { destination as pinoDestination, pino, type Logger as PinoLogger } from "pino";

export const ROLES = [
  "daemon",
  "planner",
  "critic",
  "assessor",
  "refiner",
  "executor",
  "reviewer",
  "prwriter",
] as const;
export type Role = (typeof ROLES)[number];

export const LEVELS = ["INFO", "OK", "WARN", "ERROR", "WORK", "SHIP"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_EMOJI: Record<Level, string> = {
  INFO: "🔍",
  OK: "✅",
  WARN: "⚠️",
  ERROR: "❌",
  WORK: "🚧",
  SHIP: "🚀",
};

export const ROLE_COLOUR: Record<Role, (s: string) => string> = {
  daemon: chalk.white,
  planner: chalk.cyan,
  critic: chalk.cyan.dim,
  assessor: chalk.yellow,
  refiner: chalk.yellow,
  executor: chalk.blue,
  reviewer: chalk.magenta,
  prwriter: chalk.green,
};

const LEVEL_TO_PINO: Record<Level, "info" | "warn" | "error"> = {
  INFO: "info",
  OK: "info",
  WORK: "info",
  SHIP: "info",
  WARN: "warn",
  ERROR: "error",
};

export const DEFAULT_LOG_PATH = ".minesweeper/logs/daemon.log";

export interface LoggerOptions {
  /** Path to the structured JSON log file. Default: `.minesweeper/logs/daemon.log`. */
  filePath?: string;
  /** Suppress INFO lines on stdout. Never affects file logs. Default: `false`. */
  quiet?: boolean;
  /** Stream to write the pretty single-line output to. Default: `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Override the clock (used by tests for deterministic timestamps). */
  now?: () => Date;
  /** When true, the file destination flushes synchronously per write (tests). */
  sync?: boolean;
}

export interface SpinnerHandle {
  succeed(message?: string): void;
  fail(message?: string): void;
  warn(message?: string): void;
  info(message?: string): void;
  update(message: string): void;
  stop(): void;
}

export interface Logger {
  event(role: Role, level: Level, issueNumber: number | null, message: string, meta?: Record<string, unknown>): void;
  spinner(role: Role, issueNumber: number | null, message: string): SpinnerHandle;
  formatLine(role: Role, level: Level, issueNumber: number | null, message: string): string;
  filePath: string;
  flush(): Promise<void>;
}

let active: Logger | null = null;

export function createLogger(opts: LoggerOptions = {}): Logger {
  const filePath = opts.filePath ?? DEFAULT_LOG_PATH;
  const quiet = opts.quiet ?? false;
  const stdout = opts.stdout ?? process.stdout;
  const now = opts.now ?? (() => new Date());

  mkdirSync(dirname(filePath), { recursive: true });
  const dest = pinoDestination({ dest: filePath, mkdir: true, sync: opts.sync ?? false });
  const pinoLog = pino({ level: "trace" }, dest);

  const formatLine: Logger["formatLine"] = (role, level, issueNumber, message) => {
    const time = formatTime(now());
    const emoji = LEVEL_EMOJI[level];
    const role_coloured = ROLE_COLOUR[role](role.toUpperCase());
    const issuePart = issueNumber === null ? "" : ` #${issueNumber}`;
    return `${time} ${emoji} ${role_coloured}${issuePart} — ${message}`;
  };

  const writeFileLog = (
    role: Role,
    level: Level,
    issueNumber: number | null,
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    const pinoLevel = LEVEL_TO_PINO[level];
    pinoLog[pinoLevel]({ role, tag: level, issueNumber, ...meta }, message);
  };

  const event: Logger["event"] = (role, level, issueNumber, message, meta) => {
    writeFileLog(role, level, issueNumber, message, meta);
    if (quiet && level === "INFO") return;
    stdout.write(`${formatLine(role, level, issueNumber, message)}\n`);
  };

  const spinner: Logger["spinner"] = (role, issueNumber, message) => {
    const body = (text: string) => formatLineWithoutSymbol(role, issueNumber, text, now());
    const enabled = !quiet && isTty(stdout);
    let sp: Ora | null = null;
    if (enabled) {
      sp = ora({ text: body(message), stream: stdout as NodeJS.WriteStream }).start();
    }
    let lastMessage = message;

    const finish = (level: Level, finalMessage?: string) => {
      const text = finalMessage ?? lastMessage;
      writeFileLog(role, level, issueNumber, text);
      if (quiet && level === "INFO") {
        sp?.stop();
        return;
      }
      if (sp) {
        sp.stopAndPersist({
          symbol: LEVEL_EMOJI[level],
          text: body(text),
        });
      } else {
        stdout.write(`${formatLine(role, level, issueNumber, text)}\n`);
      }
    };

    return {
      succeed: (m) => finish("OK", m),
      fail: (m) => finish("ERROR", m),
      warn: (m) => finish("WARN", m),
      info: (m) => finish("INFO", m),
      update: (m) => {
        lastMessage = m;
        if (sp) sp.text = body(m);
      },
      stop: () => sp?.stop(),
    };
  };

  const flush: Logger["flush"] = () =>
    new Promise<void>((resolve, reject) => {
      pinoLog.flush((err) => (err ? reject(err) : resolve()));
    });

  const logger: Logger = { event, spinner, formatLine, filePath, flush };
  active = logger;
  return logger;
}

export function event(
  role: Role,
  level: Level,
  issueNumber: number | null,
  message: string,
  meta?: Record<string, unknown>,
): void {
  ensureActive().event(role, level, issueNumber, message, meta);
}

export function spinner(role: Role, issueNumber: number | null, message: string): SpinnerHandle {
  return ensureActive().spinner(role, issueNumber, message);
}

export function getActiveLogger(): Logger | null {
  return active;
}

/** Reset the module-level logger. Intended for tests. */
export function resetLoggerForTest(): void {
  active = null;
}

function ensureActive(): Logger {
  if (!active) active = createLogger();
  return active;
}

function isTty(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as Partial<NodeJS.WriteStream>).isTTY);
}

function formatLineWithoutSymbol(role: Role, issueNumber: number | null, message: string, when: Date): string {
  const time = formatTime(when);
  const role_coloured = ROLE_COLOUR[role](role.toUpperCase());
  const issuePart = issueNumber === null ? "" : ` #${issueNumber}`;
  return `${time} ${role_coloured}${issuePart} — ${message}`;
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export type { PinoLogger };
