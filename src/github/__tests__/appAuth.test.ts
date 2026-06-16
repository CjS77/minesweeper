import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppTokenManager, type RepoRef } from "../appAuth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const REPO: RepoRef = { owner: "acme", name: "widgets" };

/** One recorded request the fake `fetch` saw. */
interface RecordedRequest {
  url: string;
  method: string;
  authorization: string;
}

/**
 * Build a fake `fetch` that maps `pathname -> responder`. Each responder
 * returns `{ status?, body }`. Records every request for later assertions.
 */
function fakeFetch(routes: Record<string, () => { status?: number; body: unknown }>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const headers = new Headers(init?.headers);
    requests.push({
      url: u.toString(),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
    });
    const responder = routes[u.pathname];
    if (!responder) return new Response("not found", { status: 404 });
    const { status = 200, body } = responder();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fn, requests };
}

const TOKEN_PATH = "/app/installations/42/access_tokens";

function expiresAt(offsetMs: number, nowMs: number): string {
  return new Date(nowMs + offsetMs).toISOString();
}

describe("createAppTokenManager.getToken", () => {
  let nowMs: number;
  const now = (): number => nowMs;

  beforeEach(() => {
    nowMs = Date.parse("2026-06-16T12:00:00.000Z");
  });

  it("mints an installation token using a valid RS256 JWT", async () => {
    const { fetch, requests } = fakeFetch({
      [TOKEN_PATH]: () => ({ body: { token: "ghs_abc", expires_at: expiresAt(60 * 60 * 1000, nowMs) } }),
    });
    const mgr = createAppTokenManager({
      auth: { appId: "123", privateKey: PEM, installationId: 42 },
      repo: REPO,
      fetch,
      now,
    });

    const token = await mgr.getToken();
    expect(token).toBe("ghs_abc");

    const req = requests.at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe(`https://api.github.com${TOKEN_PATH}`);
    const jwt = req?.authorization.replace(/^Bearer /, "") ?? "";
    assertValidJwt(jwt, "123", nowMs);
  });

  it("returns the cached token while it is still fresh (single mint)", async () => {
    let mints = 0;
    const { fetch } = fakeFetch({
      [TOKEN_PATH]: () => {
        mints += 1;
        return { body: { token: `ghs_${mints}`, expires_at: expiresAt(60 * 60 * 1000, nowMs) } };
      },
    });
    const mgr = createAppTokenManager({
      auth: { appId: "1", privateKey: PEM, installationId: 42 },
      repo: REPO,
      fetch,
      now,
    });

    expect(await mgr.getToken()).toBe("ghs_1");
    expect(await mgr.getToken()).toBe("ghs_1");
    expect(mints).toBe(1);
  });

  it("refreshes once the token is within the expiry margin", async () => {
    let mints = 0;
    const { fetch } = fakeFetch({
      [TOKEN_PATH]: () => {
        mints += 1;
        return { body: { token: `ghs_${mints}`, expires_at: expiresAt(60 * 60 * 1000, nowMs) } };
      },
    });
    const mgr = createAppTokenManager({
      auth: { appId: "1", privateKey: PEM, installationId: 42 },
      repo: REPO,
      fetch,
      now,
    });

    expect(await mgr.getToken()).toBe("ghs_1");
    // Jump to 55 min later: inside the 10-min refresh margin of the 60-min token.
    nowMs += 55 * 60 * 1000;
    expect(await mgr.getToken()).toBe("ghs_2");
    expect(mints).toBe(2);
  });

  it("de-duplicates concurrent mints (single-flight)", async () => {
    let mints = 0;
    const { fetch } = fakeFetch({
      [TOKEN_PATH]: () => {
        mints += 1;
        return { body: { token: `ghs_${mints}`, expires_at: expiresAt(60 * 60 * 1000, nowMs) } };
      },
    });
    const mgr = createAppTokenManager({
      auth: { appId: "1", privateKey: PEM, installationId: 42 },
      repo: REPO,
      fetch,
      now,
    });

    const [a, b] = await Promise.all([mgr.getToken(), mgr.getToken()]);
    expect(a).toBe("ghs_1");
    expect(b).toBe("ghs_1");
    expect(mints).toBe(1);
  });

  it("resolves the installation id from the repo when not configured", async () => {
    const { fetch, requests } = fakeFetch({
      "/repos/acme/widgets/installation": () => ({ body: { id: 42 } }),
      [TOKEN_PATH]: () => ({ body: { token: "ghs_ok", expires_at: expiresAt(60 * 60 * 1000, nowMs) } }),
    });
    const mgr = createAppTokenManager({ auth: { appId: "9", privateKey: PEM }, repo: REPO, fetch, now });

    expect(await mgr.getToken()).toBe("ghs_ok");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/repos/acme/widgets/installation", TOKEN_PATH]);
  });

  it("surfaces a rejected token request as AppAuthError with the status", async () => {
    const { fetch } = fakeFetch({
      [TOKEN_PATH]: () => ({ status: 401, body: { message: "Bad credentials" } }),
    });
    const mgr = createAppTokenManager({
      auth: { appId: "1", privateKey: PEM, installationId: 42 },
      repo: REPO,
      fetch,
      now,
    });

    await expect(mgr.getToken()).rejects.toMatchObject({ name: "AppAuthError", status: 401 });
  });
});

describe("createAppTokenManager.getBotIdentity", () => {
  const nowMs = Date.parse("2026-06-16T12:00:00.000Z");
  const now = (): number => nowMs;

  it("builds the linked-commit identity from the app slug and bot user id", async () => {
    const { fetch, requests } = fakeFetch({
      "/app": () => ({ body: { id: 123, slug: "minesweeper-ai-bot" } }),
      [TOKEN_PATH]: () => ({ body: { token: "ghs_id", expires_at: expiresAt(60 * 60 * 1000, nowMs) } }),
      "/users/minesweeper-ai-bot%5Bbot%5D": () => ({ body: { id: 555, login: "minesweeper-ai-bot[bot]" } }),
    });
    const mgr = createAppTokenManager({
      auth: { appId: "1", privateKey: PEM, installationId: 42 },
      repo: REPO,
      fetch,
      now,
    });

    const identity = await mgr.getBotIdentity();
    expect(identity).toEqual({
      login: "minesweeper-ai-bot[bot]",
      email: "555+minesweeper-ai-bot[bot]@users.noreply.github.com",
    });

    // `/app` is JWT-authed; `/users/...` must use the installation token (a JWT
    // is rejected on general REST endpoints), so it carries the `ghs_` token.
    const appReq = requests.find((r) => new URL(r.url).pathname === "/app");
    const usersReq = requests.find((r) => new URL(r.url).pathname === "/users/minesweeper-ai-bot%5Bbot%5D");
    expect(appReq?.authorization).toMatch(/^Bearer /);
    expect(usersReq?.authorization).toBe("Bearer ghs_id");
  });
});

/** Verify the JWT header/claims and signature against the public key. */
function assertValidJwt(jwt: string, expectedIss: string, nowMs: number): void {
  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  expect(headerB64 && payloadB64 && sigB64).toBeTruthy();

  const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
  expect(header).toEqual({ alg: "RS256", typ: "JWT" });

  const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
  const nowSec = Math.floor(nowMs / 1000);
  expect(payload.iss).toBe(expectedIss);
  expect(payload.iat).toBe(nowSec - 60); // backdated to absorb clock skew
  expect(payload.exp).toBeLessThanOrEqual(nowSec + 10 * 60); // <= 10 min per GitHub's cap
  expect(payload.exp).toBeGreaterThan(payload.iat);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  expect(verifier.verify(publicKey, Buffer.from(sigB64!, "base64url"))).toBe(true);
}
