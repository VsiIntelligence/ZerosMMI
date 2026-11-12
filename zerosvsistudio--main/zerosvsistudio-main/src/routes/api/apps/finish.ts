import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { composioApiConfigured, isLive, listConnections, pickConnection, waitForConnection } from "@/lib/composio-api.server";
import { getGitHubUserConnection, isGitHubOAuthConfigured } from "@/lib/github-oauth.server";
import { listPermissions, savePermission } from "@/lib/app-permissions.server";

const SLUG = /^[a-z0-9_-]{2,64}$/;
const fail = (error: string, status: number) => Response.json({ error }, { status });

/**
 * Called when the person comes back from signing in to an app. Waits (a few seconds, politely) for Composio to finish the
 * connection, then switches the app on for chat so "connected" really means "working". If the person had already chosen
 * read-only for this app, that choice is kept; a brand-new app starts with chat use and changes both ON.
 */
export const Route = createFileRoute("/api/apps/finish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const body = (await request.json().catch(() => null)) as { toolkit?: unknown } | null;
        const toolkit = typeof body?.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
        if (!SLUG.test(toolkit)) return fail("Choose an app.", 400);
        try {
          let connection: { id: string; status: string } | null = null;
          if (composioApiConfigured()) {
            let found = pickConnection(await listConnections(guard.uid), toolkit) ?? null;
            if (!found) found = await waitForConnection(guard.uid, toolkit, { timeoutMs: 12_000 });
            if (found && isLive(found)) connection = { id: found.id, status: found.status || "ACTIVE" };
          }
          if (!connection && toolkit === "github" && isGitHubOAuthConfigured()) {
            const direct = await getGitHubUserConnection(guard.uid).catch(() => null);
            if (direct) connection = { id: "github-oauth", status: "ACTIVE" };
          }
          if (!connection) return Response.json({ ok: false, pending: true, error: "The app is still finishing its sign-in. Open Settings → Apps in a moment." }, { status: 202 });
          const existing = (await listPermissions(guard.uid)).find((permission) => permission.toolkit === toolkit);
          const permission = await savePermission(guard.uid, toolkit, existing ? { enabled: true } : { enabled: true, allowWrites: true });
          return Response.json({ ok: true, connection, permission, keptReadOnly: !!existing && !existing.allowWrites });
        } catch (err) {
          console.error(`[Zeros] Finishing the ${toolkit} connection failed:`, err);
          return fail("The app is connected, but Zeros could not switch it on just now. Open Settings → Apps and turn it on.", 502);
        }
      },
    },
  },
});
