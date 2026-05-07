import { execa } from "execa";

export class GhError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly args: readonly string[];

  constructor(args: readonly string[], stdout: string, stderr: string, exitCode: number | undefined) {
    const detail = stderr.trim() || stdout.trim() || "(no output)";
    super(`gh ${args.join(" ")} failed (exit ${exitCode}): ${detail}`);
    this.name = "GhError";
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export class GhMissingError extends Error {
  constructor() {
    super("`gh` CLI not found — install from https://cli.github.com");
    this.name = "GhMissingError";
  }
}

export class GhNotARepoError extends Error {
  constructor(detail: string) {
    super(`not in a GitHub repository (${detail})`);
    this.name = "GhNotARepoError";
  }
}

export interface RunGhOptions {
  /** Directory in which to invoke `gh`. Defaults to the current cwd. */
  cwd?: string;
  /** When true, `runGh` returns parsed JSON. Otherwise it returns stdout as a string. */
  json?: boolean;
  /** Optional stdin payload. */
  stdin?: string;
  /** Override the binary used (mainly for tests). Defaults to "gh". */
  bin?: string;
}

const NOT_A_REPO_PATTERNS = [
  /not a git repository/i,
  /could not determine .* repository/i,
  /no such remote/i,
  /no git remotes found/i,
  /failed to run git/i,
];

export async function runGh<T = unknown>(
  args: readonly string[],
  opts: RunGhOptions = {},
): Promise<T> {
  const bin = opts.bin ?? "gh";
  let result;
  try {
    result = await execa(bin, args, {
      cwd: opts.cwd,
      input: opts.stdin,
      reject: false,
      stripFinalNewline: false,
    });
  } catch (err) {
    if (isMissingBinary(err)) throw new GhMissingError();
    throw err;
  }

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";

  if (result.exitCode === 0) {
    if (opts.json) {
      try {
        return JSON.parse(stdout) as T;
      } catch (err) {
        throw new Error(
          `gh ${args.join(" ")} returned non-JSON output: ${(err as Error).message}\n--- stdout ---\n${stdout}`,
        );
      }
    }
    return stdout as T;
  }

  if (NOT_A_REPO_PATTERNS.some((re) => re.test(stderr))) {
    throw new GhNotARepoError(stderr.trim().split("\n")[0] ?? "");
  }
  throw new GhError(args, stdout, stderr, result.exitCode);
}

function isMissingBinary(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT";
}
