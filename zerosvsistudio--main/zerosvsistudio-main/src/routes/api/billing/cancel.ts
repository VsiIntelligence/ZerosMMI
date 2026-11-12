import { createFileRoute } from "@tanstack/react-router";
import { authenticate } from "@/lib/firebase-user.server";
import { entitlementOf, readBilling, saveSubscription } from "@/lib/billing.server";
import { PayPalError, cancelSubscription, paypalConfigured } from "@/lib/paypal.server";
import { billingFailure } from "@/lib/access.server";

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Stops the monthly payments. The month that was already paid for stays usable until it ends. */
export const Route = createFileRoute("/api/billing/cancel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;
        if (!paypalConfigured()) return fail("Payments are temporarily unavailable. Please try again soon.", 503);
        const uid = auth.user.uid;
        try {
          const { row } = await readBilling(uid);
          if (!row?.subscription_id) return fail("There is no subscription to cancel.", 404);
          await cancelSubscription(row.subscription_id, "Cancelled by the customer in ZerosX2.0.");
          await saveSubscription(uid, { plan: row.plan, subscriptionId: row.subscription_id, status: "CANCELLED", paidThrough: row.paid_through, cancelRequested: true });
          const ends = entitlementOf({ ...row, status: "CANCELLED", cancel_requested: true }, Date.now());
          return Response.json({ cancelled: true, endsAt: ends?.endsAt ?? row.paid_through });
        } catch (err) {
          if (err instanceof PayPalError && err.code !== "AUTH") { console.error("[Zeros] Cancel failed:", err); return fail(err.message, err.status); }
          return billingFailure(err);
        }
      },
    },
  },
});
