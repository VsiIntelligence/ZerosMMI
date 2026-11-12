import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { listConnections, removeConnection } from "@/lib/composio-api.server";
import { savePermission } from "@/lib/app-permissions.server";
import { disconnectGitHubUser } from "@/lib/github-oauth.server";

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Removes one of this person's own connections and turns that app off. Nobody can remove somebody else's. */
export const Route = createFileRoute("/api/apps/disconnect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const body = (await request.json().catch(() => null)) as { toolkit?: unknown; connectionId?: unknown } | null;
        const toolkit = typeof body?.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
        const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
        try {
          if (toolkit === "github" && connectionId === "github-oauth") {
            await disconnectGitHubUser(guard.uid);
            await savePermission(guard.uid, "github", { enabled: false, allowWrites: false });
            return Response.json({ ok: true, toolkit });
          }
          const mine = (await listConnections(guard.uid)).find((c) => c.id === connectionId && c.toolkit === toolkit);
          if (!mine) return fail("That connection is not yours or no longer exists.", 404);
          await removeConnection(connectionId);
          await savePermission(guard.uid, toolkit, { enabled: false });
          return Response.json({ ok: true, toolkit });
        } catch (err) {
          console.error(`[Zeros] Disconnecting ${toolkit} failed:`, err);
          return fail("The app could not be disconnected right now. Please try again.", 502);
        }
      },
    },
  },
});
