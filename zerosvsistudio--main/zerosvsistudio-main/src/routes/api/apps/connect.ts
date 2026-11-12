import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { ComposioError, composioApiConfigured, startConnection } from "@/lib/composio-api.server";
import { appOrigin } from "@/lib/app-origin.server";

const SLUG = /^[a-z0-9_-]{2,64}$/;
const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Starts connecting one app for this person and returns the app's own sign-in page. It sends them back to the chat afterwards. */
export const Route = createFileRoute("/api/apps/connect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const body = (await request.json().catch(() => null)) as { toolkit?: unknown } | null;
        const toolkit = typeof body?.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
        if (!SLUG.test(toolkit)) return fail("Choose an app to connect.", 400);
        if (!composioApiConfigured()) {
          console.error("[Zeros] An app connection was requested but COMPOSIO_CONNECTOR_KEY (or legacy COMPOSIO_API_KEY) is not set.");
          return fail("Apps are not available right now. Please try again soon.", 503);
        }
        try {
          const link = await startConnection(guard.uid, toolkit, { callbackUrl: `${appOrigin(request)}/chat?connected=${encodeURIComponent(toolkit)}` });
          return Response.json({ redirectUrl: link.redirectUrl, toolkit });
        } catch (err) {
          console.error(`[Zeros] Connecting ${toolkit} failed:`, err);
          return fail(err instanceof ComposioError ? err.message : "The app could not be connected right now. Please try again.", 502);
        }
      },
    },
  },
});
