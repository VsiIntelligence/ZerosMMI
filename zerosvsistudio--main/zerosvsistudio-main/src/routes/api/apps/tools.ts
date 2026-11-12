import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { listTools } from "@/lib/composio-api.server";

const SLUG = /^[a-z0-9_-]{2,64}$/;
const fail = (error: string, status: number) => Response.json({ error }, { status });

/** What Zeros can do in one app: its actions, each marked as a read or a change. */
export const Route = createFileRoute("/api/apps/tools")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const toolkit = (new URL(request.url).searchParams.get("toolkit") ?? "").trim().toLowerCase();
        if (!SLUG.test(toolkit)) return fail("Choose an app.", 400);
        try {
          const tools = await listTools(toolkit);
          return Response.json({ toolkit, tools: tools.map((t) => ({ name: t.name, description: t.description, write: t.write })) });
        } catch (err) {
          console.error(`[Zeros] The actions of ${toolkit} could not be listed:`, err);
          return fail("This app's actions could not be listed right now.", 502);
        }
      },
    },
  },
});
