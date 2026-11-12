import { createFileRoute } from "@tanstack/react-router";
import { randomBytes } from "node:crypto";
import { requirePaidUser } from "@/lib/app-guard.server";
import { appOrigin } from "@/lib/app-origin.server";
import { createGitHubAuthorizeUrl, createGitHubStateCookie, isGitHubOAuthConfigured } from "@/lib/github-oauth.server";

export const Route = createFileRoute("/api/github/connect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const env = process.env as Record<string, string | undefined>;
        if (!isGitHubOAuthConfigured(env)) {
          return Response.json({ error: "GitHub OAuth is not ready. Configure GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and GITHUB_TOKEN_ENCRYPTION_KEY on the server." }, { status: 503 });
        }
        try {
          const origin = appOrigin(request);
          const state = randomBytes(32).toString("base64url");
          const cookie = createGitHubStateCookie(guard.uid, state, env);
          const secure = new URL(origin).protocol === "https:" ? "; Secure" : "";
          return Response.json(
            { redirectUrl: createGitHubAuthorizeUrl(origin, state, env) },
            { headers: { "Set-Cookie": `zeros_github_oauth_state=${cookie}; HttpOnly; SameSite=Lax; Path=/api/github/callback; Max-Age=600${secure}`, "Cache-Control": "no-store" } },
          );
        } catch (error) {
          console.error("[Zeros] Starting GitHub OAuth failed:", error);
          return Response.json({ error: "GitHub could not be connected right now. Please retry." }, { status: 503 });
        }
      },
    },
  },
});
