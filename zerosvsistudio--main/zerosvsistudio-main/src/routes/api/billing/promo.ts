import { createFileRoute } from "@tanstack/react-router";
import { authenticate } from "@/lib/firebase-user.server";
import { redeemPromo } from "@/lib/promo.server";

/** Redeems the promo code for the signed-in account: right code = free, unlimited access. The code is checked on the server only. */
export const Route = createFileRoute("/api/billing/promo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;
        const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
        const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
        const result = await redeemPromo({ uid: auth.user.uid, ip, input: body?.code });
        if (result.ok) return Response.json({ ok: true, unlimited: true });
        return Response.json(
          { error: result.message },
          { status: result.status, ...(result.status === 429 && result.retryAfterSec ? { headers: { "Retry-After": String(result.retryAfterSec) } } : {}) },
        );
      },
    },
  },
});
