import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { composioApiConfigured } from "@/lib/composio-api.server";
import { getGitHubUserConnection, githubRestRequest, isGitHubOAuthConfigured } from "@/lib/github-oauth.server";
import { listPermissions, savePermission } from "@/lib/app-permissions.server";
import { verifyApps, summarizeCheck, type AppCheck } from "@/lib/app-verify.server";

const SLUG = /^[a-z0-9_-]{2,64}$/;
const fail = (error: string, status: number) => Response.json({ error }, { status });
const lastRun = new Map<string, number>();

/**
 * Proves, with a live read-only test through each app, that the person's connected apps really work, and says what to fix when
 * one does not. `?toolkit=github` checks one app; `?fix=1` also switches on any connected app that is still off for chat.
 */
export const Route = createFileRoute("/api/apps/verify")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        if (!composioApiConfigured() && !isGitHubOAuthConfigured()) return fail("Connected apps are not set up on this deployment.", 503);
        const now = Date.now();
        if (now - (lastRun.get(guard.uid) ?? 0) < 3000) return fail("Give it a moment before checking again.", 429);
        lastRun.set(guard.uid, now);
        const params = new URL(request.url).searchParams;
        const toolkit = (params.get("toolkit") ?? "").trim().toLowerCase();
        if (toolkit && !SLUG.test(toolkit)) return fail("Choose an app.", 400);
        try {
          let results: AppCheck[] = await verifyApps(guard.uid, {
            ...(toolkit ? { toolkit } : {}),
            deps: {
              nativeGitHubProbe: async (uid) => {
                if (!isGitHubOAuthConfigured()) return null;
                const connection = await getGitHubUserConnection(uid);
                if (!connection) return null;
                try {
                  const r = await githubRestRequest(uid, { method: "GET", path: "/user" });
                  return { ok: r.ok, detail: r.ok ? `authenticated as ${connection.login}` : `HTTP ${r.status}`, login: connection.login };
                } catch (err) { return { ok: false, detail: err instanceof Error ? err.message : "GitHub did not answer", login: connection.login }; }
              },
            },
          });
          const fixed: string[] = [];
          if (params.get("fix") === "1") {
            const saved = new Map((await listPermissions(guard.uid).catch(() => [])).map((p) => [p.toolkit, p]));
            for (const r of results) {
              if (r.autoFix !== "enable") continue;
              const had = saved.get(r.toolkit);
              await savePermission(guard.uid, r.toolkit, had ? { enabled: true } : { enabled: true, allowWrites: true });
              fixed.push(r.toolkit);
            }
            if (fixed.length) results = await verifyApps(guard.uid, { ...(toolkit ? { toolkit } : {}), probe: false });
          }
          return Response.json({ checkedAt: new Date().toISOString(), results, summary: results.map(summarizeCheck), fixed });
        } catch (err) {
          console.error("[Zeros] Checking the connected apps failed:", err);
          return fail("The apps could not be checked right now. Please try again.", 502);
        }
      },
    },
  },
});
