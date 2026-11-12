import { createFileRoute } from "@tanstack/react-router";
import { appOrigin } from "@/lib/app-origin.server";
import { savePermission } from "@/lib/app-permissions.server";
import { finishGitHubOAuth, verifyGitHubStateCookie } from "@/lib/github-oauth.server";

function cookieValue(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const split = part.trim().indexOf("=");
    if (split < 0) continue;
    if (part.slice(0, split).trim() === name) return part.slice(split + 1).trim();
  }
  return "";
}
function redirect(origin: string, query: string, clearCookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(`/chat?${query}`, origin).toString(),
      "Set-Cookie": clearCookie,
      "Cache-Control": "no-store",
    },
  });
}
export const Route = createFileRoute("/api/github/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = appOrigin(request);
        const secure = new URL(origin).protocol === "https:" ? "; Secure" : "";
        const clearCookie = `zeros_github_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/github/callback; Max-Age=0${secure}`;
        const url = new URL(request.url);
        if (url.searchParams.has("error")) return redirect(origin, "github_error=denied", clearCookie);
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const cookie = cookieValue(request, "zeros_github_oauth_state");
        const uid = cookie ? verifyGitHubStateCookie(cookie, state) : null;
        if (!uid || !code) return redirect(origin, "github_error=state", clearCookie);
        try {
          const result = await finishGitHubOAuth(uid, code, origin);
          await savePermission(uid, "github", { enabled: true, allowWrites: false });
          return redirect(origin, `connected=github&github_account=${encodeURIComponent(result.login)}`, clearCookie);
        } catch (error) {
          console.error("[Zeros] GitHub OAuth callback failed:", error);
          return redirect(origin, "github_error=connect", clearCookie);
        }
      },
    },
  },
});
