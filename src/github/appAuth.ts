/**
 * GitHub App authentication.
 *
 * Mints short-lived **installation access tokens** for a GitHub App so that
 * Minesweeper can act as the App's bot user (`<slug>[bot]`) rather than the
 * operator's personal `gh` login. The flow is the standard App handshake:
 *
 *   1. Sign a short-lived RS256 **JWT** with the App's private key (app-level
 *      auth — only valid for `/app*` endpoints).
 *   2. Resolve the installation id for the target repo (or use the configured
 *      one).
 *   3. Exchange the JWT for an installation token via
 *      `POST /app/installations/{id}/access_tokens` (repo-level auth, ~1h life).
 *
 * The manager caches the installation token and refreshes it a margin before
 * expiry, and de-duplicates concurrent refreshes (single-flight). It is
 * dependency-free — JWT signing uses `node:crypto`, HTTP uses the global
 * `fetch` (Node ≥20). Both `fetch` and `now` are injectable so tests exercise
 * the logic against a fake boundary with no network and a real ephemeral key.
 *
 * Secrets discipline: the private key, JWT, and installation token are never
 * logged or embedded in thrown error messages.
 */

import { createSign } from "node:crypto";
import { z } from "zod";

const GITHUB_API = "https://api.github.com";

/** Refresh the installation token once it is within this margin of expiry. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** JWT lifetime: GitHub caps App JWTs at 10 minutes; we use 9 to stay safe. */
const JWT_LIFETIME_SEC = 9 * 60;

/** Backdate `iat` to absorb minor clock skew vs GitHub (avoids `iat in the future` 401s). */
const JWT_BACKDATE_SEC = 60;

/** Resolved GitHub App credentials. Exactly one of the key fields is set upstream (see config validation). */
export interface AppAuth {
  /** Numeric App id (as a string — it is opaque to us). */
  appId: string;
  /** PEM-encoded RSA private key. */
  privateKey: string;
  /** Installation id; resolved from the repo on first use when omitted. */
  installationId?: number;
}

/** `owner`/`name` of the repository the App is installed on. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** The bot's git/commit identity. The email links commits to the bot's GitHub profile. */
export interface BotIdentity {
  login: string;
  email: string;
}

export interface TokenManager {
  /** A current installation access token (`ghs_…`), minting/refreshing as needed. */
  getToken(): Promise<string>;
  /** The bot user's commit identity (`<slug>[bot]` + noreply email). Cached after first lookup. */
  getBotIdentity(): Promise<BotIdentity>;
}

export class AppAuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(status !== undefined ? `${message} (HTTP ${status})` : message);
    this.name = "AppAuthError";
    this.status = status;
  }
}

const AppMetadataSchema = z.object({ id: z.number(), slug: z.string() }).loose();
const InstallationSchema = z.object({ id: z.number() }).loose();
const AccessTokenSchema = z.object({ token: z.string(), expires_at: z.iso.datetime() }).loose();
const BotUserSchema = z.object({ id: z.number(), login: z.string() }).loose();

export interface CreateAppTokenManagerOptions {
  auth: AppAuth;
  repo: RepoRef;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Build a {@link TokenManager} for one App installation. No network call is
 * made until `getToken`/`getBotIdentity` is invoked.
 */
export function createAppTokenManager(opts: CreateAppTokenManagerOptions): TokenManager {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const { auth, repo } = opts;

  let cached: CachedToken | null = null;
  let pending: Promise<string> | null = null;
  let installationId: number | undefined = auth.installationId;
  let botIdentity: BotIdentity | null = null;

  function mintJwt(): string {
    const nowSec = Math.floor(now() / 1000);
    const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = toBase64Url(
      JSON.stringify({ iat: nowSec - JWT_BACKDATE_SEC, exp: nowSec + JWT_LIFETIME_SEC, iss: auth.appId }),
    );
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(auth.privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  async function githubJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${GITHUB_API}${path}`, {
        ...init,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init?.headers },
      });
    } catch (err) {
      // Network-level failure — surface without any credential material.
      throw new AppAuthError(`request to ${path} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new AppAuthError(`GitHub App request to ${path} was rejected`, res.status);
    }
    const body: unknown = await res.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new AppAuthError(`GitHub App response for ${path} did not match the expected shape`);
    }
    return parsed.data;
  }

  function jwtAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${mintJwt()}` };
  }

  async function resolveInstallationId(): Promise<number> {
    if (installationId !== undefined) return installationId;
    const installation = await githubJson(`/repos/${repo.owner}/${repo.name}/installation`, InstallationSchema, {
      headers: jwtAuthHeaders(),
    });
    installationId = installation.id;
    return installationId;
  }

  async function mintInstallationToken(): Promise<string> {
    const id = await resolveInstallationId();
    const result = await githubJson(`/app/installations/${id}/access_tokens`, AccessTokenSchema, {
      method: "POST",
      headers: jwtAuthHeaders(),
    });
    cached = { token: result.token, expiresAtMs: Date.parse(result.expires_at) };
    return result.token;
  }

  function fresh(token: CachedToken | null): token is CachedToken {
    return token !== null && now() < token.expiresAtMs - REFRESH_MARGIN_MS;
  }

  async function getToken(): Promise<string> {
    if (fresh(cached)) return cached.token;
    if (pending) return pending;
    pending = mintInstallationToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function getBotIdentity(): Promise<BotIdentity> {
    if (botIdentity) return botIdentity;
    const app = await githubJson(`/app`, AppMetadataSchema, { headers: jwtAuthHeaders() });
    const login = `${app.slug}[bot]`;
    const user = await githubJson(`/users/${encodeURIComponent(login)}`, BotUserSchema, {
      headers: jwtAuthHeaders(),
    });
    botIdentity = { login: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
    return botIdentity;
  }

  return { getToken, getBotIdentity };
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
