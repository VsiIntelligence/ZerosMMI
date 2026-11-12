import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { composioApiConfigured, isLive, isPending, listConnections, pickConnection, waitForConnection } from "@/lib/composio-api.server";
import { getGitHubUserConnection, isGitHubOAuthConfigured } from "@/lib/github-oauth.server";
import { savePermission } from "@/lib/app-permissions.server";

const SLUG = /^[a-z0-9_-]{2,64}$/;
const fail = (error: string, status: number) => Response.json({ error }, { status });

/**
 * Is this app really connected for this person? A sign-in finishes a moment after the person is sent back to Zeros, so an app whose
 * connection is still being set up gets a few seconds to turn ACTIVE instead of an instant (and wrong) "connect it first".
 * GitHub authorized directly (the person's own token) counts as connected too.
 */
async function isConnected(uid: string, toolkit: string): Promise<boolean> {
  if (composioApiConfigured()) {
    const list = await listConnections(uid);
    if (list.some((c) => c.toolkit === toolkit && isLive(c))) return true;
    if (list.some((c) => c.toolkit === toolkit && isPending(c)) && (await waitForConnection(uid, toolkit, { timeoutMs: 9000 })) && pickConnection(await listConnections(uid), toolkit)) return true;
  }
  if (toolkit === "github" && isGitHubOAuthConfigured()) {
    try { return !!(await getGitHubUserConnection(uid)); } catch { return false; }
  }
  return false;
}

/** "Use in chat" and "Allow changes" for one of this person's apps. Turning an app off also turns changes off. */
export const Route = createFileRoute("/api/apps/permissions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const body = (await request.json().catch(() => null)) as { toolkit?: unknown; enabled?: unknown; allowWrites?: unknown } | null;
        const toolkit = typeof body?.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
        if (!SLUG.test(toolkit)) return fail("Choose an app.", 400);
        const patch: { enabled?: boolean; allowWrites?: boolean } = {};
        if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body?.allowWrites === "boolean") patch.allowWrites = body.allowWrites;
        try {
          if (patch.enabled === true || patch.allowWrites === true) {
            if (!(await isConnected(guard.uid, toolkit))) return fail("Connect this app first, then turn it on.", 409);
          }
          return Response.json(await savePermission(guard.uid, toolkit, patch));
        } catch (err) {
          console.error(`[Zeros] Saving the permission for ${toolkit} failed:`, err);
          return fail("The setting could not be saved right now. Please try again.", 502);
        }
      },
    },
  },
});
