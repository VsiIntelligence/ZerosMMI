/**
 * Per-user GitHub App OAuth for Zeros.
 *
 * User access tokens are constrained by both the GitHub user's access and the app's granted permissions.
 * Tokens are encrypted before storage; they never reach the browser.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { adminRest } from "./supabase-admin.server";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
const defaultEnv = (): Env => typeof process !== "undefined" ? process.env as Env : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];

export type GitHubUserRepository = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  description: string | null;
  default_branch: string;
};
type StoredTokens = {
  user_id: string;
  github_user_id: number;
  github_login: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  updated_at: string;
};
export class GitHubOAuthError extends Error {}

export function isGitHubOAuthConfigured(env: Env = defaultEnv()): boolean {
  return !!env["GITHUB_CLIENT_ID"]?.trim() &&
    !!env["GITHUB_CLIENT_SECRET"]?.trim() &&
    encryptionKey(env) !== null;
}
function encryptionKey(env: Env): Buffer | null {
  const raw = env["GITHUB_TOKEN_ENCRYPTION_KEY"]?.trim();
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch { return null; }
}
function keyOrThrow(env: Env): Buffer {
  const key = encryptionKey(env);
  if (!key) throw new GitHubOAuthError("GitHub connection storage is not configured. Add GITHUB_TOKEN_ENCRYPTION_KEY as a 32-byte base64 server secret.");
  return key;
}
function encrypt(value: string, env: Env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOrThrow(env), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decrypt(value: string, env: Env): string {
  try {
    const [ivText, tagText, cipherText] = value.split(".");
    if (!ivText || !tagText || !cipherText) throw new Error("format");
    const decipher = createDecipheriv("aes-256-gcm", keyOrThrow(env), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new GitHubOAuthError("The stored GitHub connection could not be decrypted. Reconnect GitHub in Settings.");
  }
}
function hmac(value: string, env: Env): string {
  const secret = env["GITHUB_CLIENT_SECRET"]?.trim();
  if (!secret) throw new GitHubOAuthError("GitHub OAuth is not configured.");
  return createHmac("sha256", secret).update(value).digest("base64url");
}
function stateCookiePayload(uid: string, state: string, expires: number): string {
  return Buffer.from(JSON.stringify({ uid, state, expires }), "utf8").toString("base64url");
}
export function createGitHubStateCookie(uid: string, state: string, env: Env = defaultEnv(), now = Date.now()): string {
  const payload = stateCookiePayload(uid, state, now + 10 * 60_000);
  return `${payload}.${hmac(payload, env)}`;
}
export function verifyGitHubStateCookie(cookie: string, state: string, env: Env = defaultEnv(), now = Date.now()): string | null {
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0 || !state) return null;
  const payload = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  const expected = hmac(payload, env);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid?: unknown; state?: unknown; expires?: unknown };
    if (typeof value.uid !== "string" || !value.uid || typeof value.state !== "string" || value.state !== state || typeof value.expires !== "number" || value.expires < now) return null;
    return value.uid;
  } catch { return null; }
}
export function githubOAuthCallbackUrl(origin: string): string {
  return new URL("/api/github/callback", origin).toString();
}
export function createGitHubAuthorizeUrl(origin: string, state: string, env: Env = defaultEnv()): string {
  const clientId = env["GITHUB_CLIENT_ID"]?.trim();
  if (!clientId || !env["GITHUB_CLIENT_SECRET"]?.trim()) throw new GitHubOAuthError("GitHub OAuth is not configured. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", githubOAuthCallbackUrl(origin));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}
function expiresAt(seconds: unknown, now: number): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(now + n * 1000).toISOString() : null;
}
async function oauthTokenRequest(body: Record<string, string>, env: Env, fetcher: Fetch): Promise<Record<string, unknown>> {
  const response = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Zeros-GitHub-OAuth" },
    body: JSON.stringify({ client_id: env["GITHUB_CLIENT_ID"], client_secret: env["GITHUB_CLIENT_SECRET"], ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const data = obj(await response.json().catch(() => null));
  if (!response.ok || data["error"] || !str(data["access_token"])) {
    const error = str(data["error"]);
    throw new GitHubOAuthError(error === "bad_verification_code" ? "GitHub authorization code expired or was already used. Please connect again." : "GitHub did not authorize this connection. Please retry.");
  }
  return data;
}
async function githubGet<T>(fetcher: Fetch, path: string, token: string): Promise<T> {
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Zeros-GitHub-OAuth" },
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (response.status === 401) throw new GitHubOAuthError("GitHub authorization expired or was revoked. Reconnect GitHub in Settings.");
    if (response.status === 403) throw new GitHubOAuthError("GitHub refused this request because of account permissions or API rate limits.");
    throw new GitHubOAuthError(`GitHub request failed (HTTP ${response.status}).`);
  }
  return data as T;
}
async function saveTokens(uid: string, githubUserId: number, login: string, accessToken: string, refreshToken: string | null, accessExpiresAt: string | null, refreshExpiresAt: string | null, opts: { env: Env; fetch: Fetch; now: number }): Promise<void> {
  const row = {
    user_id: uid,
    github_user_id: githubUserId,
    github_login: login,
    encrypted_access_token: encrypt(accessToken, opts.env),
    encrypted_refresh_token: refreshToken ? encrypt(refreshToken, opts.env) : null,
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    updated_at: new Date(opts.now).toISOString(),
  };
  const response = await adminRest(opts.env, opts.fetch, "zeros_github_user_tokens?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new GitHubOAuthError(`GitHub connection could not be saved (HTTP ${response.status}).`);
}
export async function finishGitHubOAuth(uid: string, code: string, origin: string, opts: { env?: Env; fetch?: Fetch; now?: number } = {}): Promise<{ login: string }> {
  const env = opts.env ?? defaultEnv(), fetcher = opts.fetch ?? fetch, now = opts.now ?? Date.now();
  if (!isGitHubOAuthConfigured(env)) throw new GitHubOAuthError("GitHub OAuth storage is not configured. Check the GitHub client credentials and GITHUB_TOKEN_ENCRYPTION_KEY secret.");
  const callback = githubOAuthCallbackUrl(origin);
  const data = await oauthTokenRequest({ code, redirect_uri: callback }, env, fetcher);
  const accessToken = str(data["access_token"]);
  const refreshToken = str(data["refresh_token"]) || null;
  const user = obj(await githubGet<unknown>(fetcher, "/user", accessToken));
  const githubUserId = Number(user["id"]);
  const login = str(user["login"]);
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0 || !login) throw new GitHubOAuthError("GitHub did not return a valid account identity.");
  await saveTokens(uid, githubUserId, login, accessToken, refreshToken, expiresAt(data["expires_in"], now), expiresAt(data["refresh_token_expires_in"], now), { env, fetch: fetcher, now });
  return { login };
}
export async function getGitHubUserConnection(uid: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<{ login: string; githubUserId: number } | null> {
  const env = opts.env ?? defaultEnv(), fetcher = opts.fetch ?? fetch;
  if (!isGitHubOAuthConfigured(env)) return null;
  const stored = await readStored(uid, env, fetcher);
  return stored ? { login: stored.github_login, githubUserId: Number(stored.github_user_id) } : null;
}
async function readStored(uid: string, env: Env, fetcher: Fetch): Promise<StoredTokens | null> {
  const response = await adminRest(env, fetcher, `zeros_github_user_tokens?user_id=eq.${encodeURIComponent(uid)}&select=user_id,github_user_id,github_login,encrypted_access_token,encrypted_refresh_token,access_expires_at,refresh_expires_at,updated_at&limit=1`);
  if (!response.ok) throw new GitHubOAuthError(`GitHub connection storage could not be read (HTTP ${response.status}).`);
  return (rows(await response.json())[0] as unknown as StoredTokens | undefined) ?? null;
}
export async function getGitHubUserToken(uid: string, opts: { env?: Env; fetch?: Fetch; now?: number } = {}): Promise<{ token: string; login: string; githubUserId: number }> {
  const env = opts.env ?? defaultEnv(), fetcher = opts.fetch ?? fetch, now = opts.now ?? Date.now();
  if (!isGitHubOAuthConfigured(env)) throw new GitHubOAuthError("GitHub OAuth is not configured.");
  const stored = await readStored(uid, env, fetcher);
  if (!stored) throw new GitHubOAuthError("Connect your GitHub account in Settings before asking Zeros to read your repositories.");
  const accessExpiry = stored.access_expires_at ? Date.parse(stored.access_expires_at) : Infinity;
  if (Number.isFinite(accessExpiry) && accessExpiry > now + 60_000) return { token: decrypt(stored.encrypted_access_token, env), login: stored.github_login, githubUserId: Number(stored.github_user_id) };
  if (accessExpiry === Infinity) return { token: decrypt(stored.encrypted_access_token, env), login: stored.github_login, githubUserId: Number(stored.github_user_id) };
  if (!stored.encrypted_refresh_token || !stored.refresh_expires_at || Date.parse(stored.refresh_expires_at) <= now) throw new GitHubOAuthError("Your GitHub connection expired. Reconnect GitHub in Settings.");
  const refreshToken = decrypt(stored.encrypted_refresh_token, env);
  try {
    const data = await oauthTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, env, fetcher);
    const accessToken = str(data["access_token"]);
    const nextRefresh = str(data["refresh_token"]) || refreshToken;
    await saveTokens(uid, Number(stored.github_user_id), stored.github_login, accessToken, nextRefresh, expiresAt(data["expires_in"], now), expiresAt(data["refresh_token_expires_in"], now) ?? stored.refresh_expires_at, { env, fetch: fetcher, now });
    return { token: accessToken, login: stored.github_login, githubUserId: Number(stored.github_user_id) };
  } catch (error) {
    // Another concurrent request may have refreshed the one-time refresh token first. Re-read and use the newer row if it exists.
    const latest = await readStored(uid, env, fetcher).catch(() => null);
    if (latest && latest.updated_at !== stored.updated_at && (!latest.access_expires_at || Date.parse(latest.access_expires_at) > now + 60_000)) {
      return { token: decrypt(latest.encrypted_access_token, env), login: latest.github_login, githubUserId: Number(latest.github_user_id) };
    }
    throw error;
  }
}
export async function listGitHubUserRepositories(uid: string, opts: { env?: Env; fetch?: Fetch; now?: number; maxPages?: number } = {}): Promise<{ login: string; repositories: GitHubUserRepository[]; truncated: boolean }> {
  const { token, login } = await getGitHubUserToken(uid, opts);
  const fetcher = opts.fetch ?? fetch;
  const repositories: GitHubUserRepository[] = [];
  const maxPages = Math.min(100, Math.max(1, opts.maxPages ?? 10));
  for (let page = 1; page <= maxPages; page++) {
    const response = await githubGet<unknown>(fetcher, `/user/repos?per_page=100&page=${page}&sort=updated&direction=desc`, token);
    const batch = rows(Array.isArray(response) ? response : obj(response)["repositories"]);
    for (const row of batch) {
      const fullName = str(row["full_name"]);
      const id = Number(row["id"]);
      if (!fullName || !Number.isSafeInteger(id)) continue;
      repositories.push({
        id,
        name: str(row["name"]) || fullName.split("/").at(-1) || fullName,
        full_name: fullName,
        html_url: str(row["html_url"]),
        private: row["private"] === true,
        description: typeof row["description"] === "string" ? row["description"] : null,
        default_branch: str(row["default_branch"]),
      });
    }
    if (batch.length < 100) return { login, repositories, truncated: false };
  }
  return { login, repositories, truncated: true };
}
/**
 * Calls GitHub's REST API as this person, with their own authorized token (never a shared one). This is what lets a person who
 * authorized GitHub directly do anything their account can do: issues, pull requests, files, branches, releases, and so on.
 * Only api.github.com can ever be reached, and only through a path (no host tricks, no "..").
 */
export async function githubRestRequest(
  uid: string,
  req: { method: string; path: string; query?: Record<string, unknown> | undefined; body?: unknown },
  opts: { env?: Env; fetch?: Fetch; now?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const method = req.method.trim().toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new GitHubOAuthError("That GitHub request method is not supported.");
  let path = req.path.trim();
  if (/^https?:\/\//i.test(path)) {
    let parsed: URL;
    try { parsed = new URL(path); } catch { throw new GitHubOAuthError("That GitHub address is not valid."); }
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") throw new GitHubOAuthError("Only GitHub's own API can be called.");
    path = parsed.pathname + parsed.search;
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || /[\s\\]/.test(path)) throw new GitHubOAuthError("That GitHub path is not valid.");
  const { token } = await getGitHubUserToken(uid, opts);
  const url = new URL(`https://api.github.com${path}`);
  for (const [key, value] of Object.entries(req.query ?? {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  if (method === "GET" && !url.searchParams.has("per_page") && /\/(?:repos|issues|pulls|commits|branches|releases|user\/repos|orgs|notifications|gists|comments|labels|milestones|contributors|collaborators|teams|members|workflows|runs|artifacts|tags|forks|stargazers|subscribers)\b/.test(url.pathname)) url.searchParams.set("per_page", "50");
  const fetcher = opts.fetch ?? fetch;
  const hasBody = req.body !== undefined && req.body !== null && method !== "GET" && method !== "HEAD";
  const response = await fetcher(url.toString(), {
    method,
    headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Zeros-GitHub-OAuth",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text: text.slice(0, 200_000) || (response.ok ? "(GitHub returned no data)" : `HTTP ${response.status}`) };
}
export async function disconnectGitHubUser(uid: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<void> {
  const env = opts.env ?? defaultEnv(), fetcher = opts.fetch ?? fetch;
  const response = await adminRest(env, fetcher, `zeros_github_user_tokens?user_id=eq.${encodeURIComponent(uid)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!response.ok) throw new GitHubOAuthError(`GitHub connection could not be removed (HTTP ${response.status}).`);
}
