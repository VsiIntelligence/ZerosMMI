import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { savePermission } from "@/lib/app-permissions.server";
import { disconnectGitHubUser } from "@/lib/github-oauth.server";

export const Route = createFileRoute("/api/github/disconnect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        try {
          await disconnectGitHubUser(guard.uid);
          await savePermission(guard.uid, "github", { enabled: false, allowWrites: false });
          return Response.json({ ok: true });
        } catch (error) {
          console.error("[Zeros] GitHub disconnect failed:", error);
          return Response.json({ error: "GitHub could not be disconnected right now. Please retry." }, { status: 502 });
        }
      },
    },
  },
});
