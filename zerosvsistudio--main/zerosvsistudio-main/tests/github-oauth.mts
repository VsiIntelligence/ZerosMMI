import { randomBytes } from "node:crypto";
import { isGitHubOAuthConfigured, createGitHubStateCookie, verifyGitHubStateCookie, finishGitHubOAuth, listGitHubUserRepositories, getGitHubUserToken } from "../src/lib/github-oauth.server.ts";

let passed = 0;
function check(name: string, ok: boolean): void {
  if (!ok) throw new Error("FAIL: " + name);
  passed++;
  console.log("PASS: " + name);
}
const now = Date.now();
const env = {
  GITHUB_CLIENT_ID: "github-client-test",
  GITHUB_CLIENT_SECRET: "github-client-secret-test",
  GITHUB_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};
let stored: Record<string, unknown> | null = null;
let refreshCalls = 0;
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    if (body.grant_type === "refresh_token") {
      refreshCalls++;
      return Response.json({ access_token: "ghu_refreshed_access", refresh_token: "ghr_refreshed_token", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (body.code === "test-code" && body.redirect_uri === "https://zeros-ai.pages.dev/api/github/callback") {
      return Response.json({ access_token: "ghu_initial_access", refresh_token: "ghr_initial_refresh", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    return Response.json({ error: "bad_verification_code" }, { status: 400 });
  }
  if (url.origin === "https://api.github.com" && url.pathname === "/user") {
    return Response.json({ id: 456, login: "sample-user" });
  }
  if (url.origin === "https://api.github.com" && url.pathname === "/user/repos") {
    const authorization = new Headers(init?.headers).get("Authorization");
    if (authorization !== "Bearer ghu_initial_access" && authorization !== "Bearer ghu_refreshed_access") return Response.json({ message: "Bad credentials" }, { status: 401 });
    return Response.json([
      { id: 1, name: "project", full_name: "sample-user/project", html_url: "https://github.com/sample-user/project", private: true, description: "Private test repository", default_branch: "main" },
    ]);
  }
  if (url.origin === "https://supabase.test" && url.pathname === "/rest/v1/zeros_github_user_tokens" && method === "POST") {
    stored = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(null, { status: 201 });
  }
  if (url.origin === "https://supabase.test" && url.pathname === "/rest/v1/zeros_github_user_tokens" && method === "GET") {
    return Response.json(stored ? [stored] : []);
  }
  return Response.json({ message: "unexpected request " + method + " " + url.toString() }, { status: 500 });
};

async function main(): Promise<void> {
  check("OAuth requires client credentials and a valid 32-byte encryption key", isGitHubOAuthConfigured(env) && !isGitHubOAuthConfigured({ ...env, GITHUB_TOKEN_ENCRYPTION_KEY: "invalid" }));
  const state = randomBytes(32).toString("base64url");
  const cookie = createGitHubStateCookie("firebase-user-123", state, env, now);
  check("OAuth state cookie binds the Firebase UID and state", verifyGitHubStateCookie(cookie, state, env, now) === "firebase-user-123");
  check("OAuth state rejects a mismatched state", verifyGitHubStateCookie(cookie, "attacker-state", env, now) === null);
  check("OAuth state rejects a tampered cookie", verifyGitHubStateCookie(cookie + "x", state, env, now) === null);
  check("OAuth state expires after ten minutes", verifyGitHubStateCookie(cookie, state, env, now + 11 * 60_000) === null);

  const result = await finishGitHubOAuth("firebase-user-123", "test-code", "https://zeros-ai.pages.dev", { env, fetch: fetcher, now });
  check("OAuth callback validates and stores the GitHub identity", result.login === "sample-user" && (stored as Record<string, unknown> | null)?.github_user_id === 456);
  check("access and refresh tokens are encrypted before Supabase storage", typeof (stored as Record<string, unknown> | null)?.encrypted_access_token === "string" && !String((stored as Record<string, unknown> | null)?.encrypted_access_token).includes("ghu_initial_access") && !String((stored as Record<string, unknown> | null)?.encrypted_refresh_token).includes("ghr_initial_refresh"));
  const listed = await listGitHubUserRepositories("firebase-user-123", { env, fetch: fetcher, now });
  check("repository listing uses the user's own OAuth token", listed.login === "sample-user" && listed.repositories[0]?.full_name === "sample-user/project" && listed.repositories[0]?.private === true);
  const refreshed = await getGitHubUserToken("firebase-user-123", { env, fetch: fetcher, now: now + 9 * 60 * 60_000 });
  check("expired access tokens refresh server-side and rotate the stored refresh token", refreshed.token === "ghu_refreshed_access" && refreshCalls === 1 && (stored as Record<string, unknown> | null)?.encrypted_access_token !== "ghu_refreshed_access");
  console.log(`GitHub OAuth tests: ${passed} passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
