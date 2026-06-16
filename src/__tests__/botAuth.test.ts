import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activateBotAuth, type BotAuthDeps } from "../botAuth.js";
import { type Config } from "../config.js";
import { type BotIdentity, type TokenManager } from "../github/appAuth.js";

/** Minimal Config with the app fields filled in; the rest is irrelevant here. */
function appConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubAppId: "123",
    githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    sources: {},
    ...overrides,
  } as unknown as Config;
}

const IDENTITY: BotIdentity = {
  login: "minesweeper-ai-bot[bot]",
  email: "5+minesweeper-ai-bot[bot]@users.noreply.github.com",
};

function fakeManager(token = "ghs_tok"): TokenManager {
  return {
    getToken: vi.fn(async () => token),
    getBotIdentity: vi.fn(async () => IDENTITY),
  };
}

/** A scheduler that records the timer and exposes unref/clear spies. */
function fakeScheduler() {
  const unref = vi.fn();
  const clear = vi.fn();
  const handle = { unref };
  const deps: Pick<BotAuthDeps, "setIntervalFn" | "clearIntervalFn"> = {
    setIntervalFn: vi.fn(() => handle),
    clearIntervalFn: clear,
  };
  return { deps, unref, clear, handle };
}

const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("activateBotAuth", () => {
  it("returns null when no GitHub App is configured", async () => {
    const handle = await activateBotAuth({ sources: {} } as unknown as Config);
    expect(handle).toBeNull();
    expect(process.env["GH_TOKEN"]).toBeUndefined();
  });

  it("primes GH_TOKEN and GITHUB_TOKEN from a freshly minted token", async () => {
    const sched = fakeScheduler();
    const handle = await activateBotAuth(appConfig(), {
      createManager: () => fakeManager("ghs_primed"),
      getRepo: async () => ({ owner: "acme", name: "widgets" }),
      ...sched.deps,
    });
    expect(handle).not.toBeNull();
    expect(process.env["GH_TOKEN"]).toBe("ghs_primed");
    expect(process.env["GITHUB_TOKEN"]).toBe("ghs_primed");
  });

  it("unrefs the refresh timer and clears it on stop()", async () => {
    const sched = fakeScheduler();
    const handle = await activateBotAuth(appConfig(), {
      createManager: () => fakeManager(),
      getRepo: async () => ({ owner: "acme", name: "widgets" }),
      ...sched.deps,
    });
    expect(sched.unref).toHaveBeenCalledOnce();
    expect(sched.clear).not.toHaveBeenCalled();
    handle!.stop();
    expect(sched.clear).toHaveBeenCalledWith(sched.handle);
    // idempotent
    handle!.stop();
    expect(sched.clear).toHaveBeenCalledOnce();
  });

  it("builds a tokenized https push URL and basic-auth extra header", async () => {
    const sched = fakeScheduler();
    const handle = await activateBotAuth(appConfig(), {
      createManager: () => fakeManager("ghs_push"),
      getRepo: async () => ({ owner: "acme", name: "widgets" }),
      ...sched.deps,
    });
    expect(handle!.pushAuth.remoteUrl).toBe("https://github.com/acme/widgets.git");
    const header = await handle!.pushAuth.extraHeaderValue();
    const expected = Buffer.from("x-access-token:ghs_push", "utf8").toString("base64");
    expect(header).toBe(`AUTHORIZATION: basic ${expected}`);
    expect(header).not.toContain("ghs_push");
  });

  it("propagates a failed initial mint (fail fast)", async () => {
    const sched = fakeScheduler();
    const failing: TokenManager = {
      getToken: vi.fn(async () => {
        throw new Error("Bad credentials");
      }),
      getBotIdentity: vi.fn(async () => IDENTITY),
    };
    await expect(
      activateBotAuth(appConfig(), {
        createManager: () => failing,
        getRepo: async () => ({ owner: "acme", name: "widgets" }),
        ...sched.deps,
      }),
    ).rejects.toThrow(/Bad credentials/);
  });
});
