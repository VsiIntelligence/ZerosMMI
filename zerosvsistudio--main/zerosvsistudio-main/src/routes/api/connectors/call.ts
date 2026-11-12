import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { executeTool, isLive, isWriteTool, listConnections, listTools, type Connection, type ToolInfo } from "@/lib/composio-api.server";
import type { Permission } from "@/lib/app-permissions.server";
import { listPermissions } from "@/lib/app-permissions.server";
import { WEIGHTS } from "@/lib/billing.server";
import { charge } from "@/lib/access.server";

const SLUG = /^[a-z0-9_-]{2,64}$/;
const fail = (error: string, status: number, extra: object = {}) => Response.json({ error, ...extra }, { status });

/** Runs one action in one of this person's apps. Reads need the app turned on; changes also need "Allow changes" and a confirmation. */
export const Route = createFileRoute("/api/connectors/call")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const body = (await request.json().catch(() => null)) as { toolkit?: unknown; tool?: unknown; arguments?: unknown; confirm?: unknown } | null;
        const toolkit = typeof body?.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
        const tool = typeof body?.tool === "string" ? body.tool.trim() : "";
        if (!SLUG.test(toolkit) || !/^[A-Za-z0-9_.-]{2,120}$/.test(tool)) return fail("That action is not valid.", 400);
        let perm: Permission | undefined;
        try {
          perm = (await listPermissions(guard.uid)).find((p) => p.toolkit === toolkit);
        } catch (err) {
          console.error(`[Zeros] Permissions for ${toolkit} could not be verified:`, err);
          return fail("The app's permissions could not be verified. Please retry.", 502);
        }
        if (!perm?.enabled) return fail("Turn this app on in Settings, then try again.", 403);
        let connection: Connection | undefined;
        try {
          connection = (await listConnections(guard.uid)).find((c) => c.toolkit === toolkit && isLive(c));
        } catch (err) {
          console.error(`[Zeros] The connection for ${toolkit} could not be verified:`, err);
          return fail("The app connection could not be verified. Please retry.", 502);
        }
        if (!connection) return fail("Connect this app in Settings first.", 403);
        // Validate against the selected toolkit's actual Composio catalogue instead of inferring ownership from tool-name prefixes.
        let action: ToolInfo | undefined;
        try {
          action = (await listTools(toolkit)).find((item) => item.name === tool);
        } catch (err) {
          console.error(`[Zeros] The action catalogue for ${toolkit} could not be verified:`, err);
          return fail("The app's available actions could not be verified. Please retry.", 502);
        }
        if (!action) return fail("That action is not available for the selected app.", 400);
        if (action.write || isWriteTool(tool)) {
          if (!perm.allowWrites) return fail("Changes are off for this app. Turn on Allow changes in Settings, then try again.", 403);
          if (body?.confirm !== true) return fail("This changes something in your app. Confirm it to continue.", 409, { needsConfirm: true });
        }
        const args = typeof body?.arguments === "object" && body?.arguments !== null && !Array.isArray(body.arguments) ? (body.arguments as Record<string, unknown>) : {};
        if (!action.parameterDetails && action.parameters.length > 0) {
          return fail("The app's argument requirements could not be verified, so no action was run. Refresh the app catalogue and retry.", 502);
        }
        const missingRequired = (action.parameterDetails ?? []).filter((parameter) => {
          if (!parameter.required) return false;
          const value = args[parameter.name];
          return value === undefined || value === null || (typeof value === "string" && !value.trim());
        });
        if (missingRequired.length) {
          return fail(
            `Missing required parameter(s): ${missingRequired.map((parameter) => parameter.name).join(", ")}. No app action was run.`,
            400,
            { missingParameters: missingRequired.map((parameter) => parameter.name) },
          );
        }
        const paid = await charge(guard.access, WEIGHTS.connector);
        if (!paid.ok) return paid.response;
        try {
          const result = await executeTool(guard.uid, tool, args, connection.id);
          if (!result.ok) await paid.refund();
          return Response.json({ ok: result.ok, text: result.text, toolkit, usage: paid.usage }, { status: result.ok ? 200 : 502 });
        } catch (err) {
          console.error("[Zeros] An app action failed:", err);
          await paid.refund();
          return fail("The app did not answer. Your request was not charged.", 502);
        }
      },
    },
  },
});
