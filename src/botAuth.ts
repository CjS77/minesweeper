/**
 * GitHub App bot-identity activation.
 *
 * When the operator configures a GitHub App (`githubAppId` + a private key),
 * this module mints an installation access token and primes `GH_TOKEN` /
 * `GITHUB_TOKEN` in the environment so that **every** `gh` subprocess (which
 * inherits `process.env` via execa) acts as the App's bot user, and so do the
 * issue/PR comments, labels, reactions and PR creation that flow through them.
 * It also exposes a {@link CommitPublisher} that creates and pushes commits via
 * the GitHub API (server-side signed, Verified) instead of via `git push`.
 *
 * Activation is called once per process at the CLI entry points — `runDaemon`
 * (`src/cli.ts`) and the child handler (`src/child/handler.ts`). Each process
 * mints and refreshes its **own** token: children are separate processes that
 * can outlive a single token, so they must never rely on an inherited
 * `GH_TOKEN`. When no App is configured, `activateBotAuth` returns `null` and
 * the operator's ambient `gh`/git identity is used unchanged.
 *
 * In app mode, the branch is published via the API (not `git push`). The local
 * worktree is still used by the executor subagent for editing and local commits;
 * only the publish step changes.
 *
 * Secrets discipline: the token is never logged. The refresh timer is
 * `unref()`-ed so it never keeps a finished child process alive.
 */

import { readFileSync } from "node:fs";

import { type Config } from "./config.js";
import {
  createAppTokenManager,
  type BotIdentity,
  type CreateAppTokenManagerOptions,
  type RepoRef,
  type TokenManager,
} from "./github/appAuth.js";
import { createCommitPublisher, type CommitPublisher } from "./github/commit.js";
import { getRepoNameWithOwner } from "./github/index.js";
import { event } from "./logging.js";

/**
 * Liveness check interval for the token refresh. Kept comfortably below the
 * installation token's 10-minute refresh margin so a tick always lands inside
 * the window and re-mints before any `gh` call can see an expired token. Each
 * tick is a cheap cache read except for the ~once-an-hour actual re-mint.
 */
const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface BotAuthHandle {
  getToken(): Promise<string>;
  getBotIdentity(): Promise<BotIdentity>;
  /** Publisher that creates branch refs and commits via the GitHub API (server-side signed). */
  commitPublisher: CommitPublisher;
  /** Stop the refresh timer. Idempotent. */
  stop(): void;
}

/** Loosely-typed timer handle so tests can inject a fake scheduler. */
interface RefreshHandle {
  unref?: () => void;
}

export interface BotAuthDeps {
  /** Override the token-manager factory (tests). */
  createManager?: (opts: CreateAppTokenManagerOptions) => TokenManager;
  /** Override repo resolution (tests). Defaults to `gh repo view`. */
  getRepo?: (opts: { cwd?: string }) => Promise<RepoRef>;
  /** Working directory for the `gh repo view` call. */
  cwd?: string;
  /** Override the logger event sink (tests). */
  emit?: typeof event;
  setIntervalFn?: (fn: () => void, ms: number) => RefreshHandle;
  clearIntervalFn?: (handle: RefreshHandle) => void;
  /** Override the refresh check interval (tests). */
  refreshIntervalMs?: number;
}

/**
 * Activate bot auth for this process. Returns `null` when no GitHub App is
 * configured (app mode off). On success the first token has already been minted
 * and `GH_TOKEN`/`GITHUB_TOKEN` set, so callers can immediately invoke `gh`.
 */
export async function activateBotAuth(config: Config, deps: BotAuthDeps = {}): Promise<BotAuthHandle | null> {
  if (config.githubAppId === undefined) return null;

  const emit = deps.emit ?? event;
  const createManager = deps.createManager ?? createAppTokenManager;
  const getRepo = deps.getRepo ?? ((opts) => getRepoNameWithOwner(opts));
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  const privateKey = readPrivateKey(config);
  const repo = await getRepo({ cwd: deps.cwd });
  const manager = createManager({
    auth: { appId: config.githubAppId, privateKey, installationId: config.githubAppInstallationId },
    repo,
  });

  // Prime the token (throws on bad credentials — fail fast at startup) and
  // confirm the bot user resolves (catches a wrong app id / uninstalled app).
  await applyToken(manager, emit, true);
  const identity = await manager.getBotIdentity();
  const installSource = config.githubAppInstallationId !== undefined ? "configured" : "resolved from repo";
  emit(
    "daemon",
    "INFO",
    null,
    `GitHub auth: GitHub App #${config.githubAppId} acting as ${identity.login} ` +
      `(installation ${installSource}, ${repo.owner}/${repo.name}); installation token primed; ` +
      `commits will be created via API (server-side signed, Verified)`,
  );

  const handle = setIntervalFn(() => {
    void applyToken(manager, emit, false);
  }, deps.refreshIntervalMs ?? REFRESH_CHECK_INTERVAL_MS);
  handle.unref?.();

  let stopped = false;
  const commitPublisher = createCommitPublisher({
    owner: repo.owner,
    name: repo.name,
    getToken: () => manager.getToken(),
  });

  return {
    getToken: () => manager.getToken(),
    getBotIdentity: () => manager.getBotIdentity(),
    commitPublisher,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(handle);
    },
  };
}

/** Resolve the PEM from the inline value or the configured path. */
function readPrivateKey(config: Config): string {
  if (config.githubAppPrivateKey !== undefined) return config.githubAppPrivateKey;
  if (config.githubAppPrivateKeyPath !== undefined) {
    try {
      return readFileSync(config.githubAppPrivateKeyPath, "utf8");
    } catch (err) {
      throw new Error(
        `failed to read GitHub App private key at ${config.githubAppPrivateKeyPath}: ${(err as Error).message}`,
      );
    }
  }
  // Config validation guarantees one of the two is set when an app id is present.
  throw new Error("GitHub App id is set but no private key was resolved");
}

/**
 * Mint/refresh the token and set the env vars. On the initial prime
 * (`throwOnError`) failures propagate so the process fails fast; on a timer
 * refresh they are logged and swallowed so a transient GitHub blip does not
 * crash a long-running daemon (the next tick retries; the still-valid prior
 * token keeps working in the meantime).
 */
async function applyToken(manager: TokenManager, emit: typeof event, throwOnError: boolean): Promise<void> {
  try {
    const token = await manager.getToken();
    process.env["GH_TOKEN"] = token;
    process.env["GITHUB_TOKEN"] = token;
  } catch (err) {
    if (throwOnError) throw err;
    emit("daemon", "WARN", null, `bot auth token refresh failed: ${(err as Error).message}`);
  }
}
