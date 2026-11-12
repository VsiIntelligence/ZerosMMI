import { createFileRoute } from "@tanstack/react-router";
import { authenticate } from "@/lib/firebase-user.server";
import { BillingConfigError, PLANS, readBilling } from "@/lib/billing.server";
import { PayPalError, getSubscription, paypalConfigured, verifyNewSubscription } from "@/lib/paypal.server";
import { applySubscription } from "@/lib/subscriptions.server";

const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const fail = (error: string, status: number, extra: object = {}) => Response.json({ error, ...extra }, { status });

/**
 * Finishes a subscription when the person comes back from PayPal. PayPal is asked directly; the plan unlocks only if the
 * subscription is this account's, is active, and the first monthly payment (the exact plan price, in USD) has been taken.
 * Safe to call again for the same subscription.
 */
export const Route = createFileRoute("/api/billing/confirm")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;
        const body = (await request.json().catch(() => null)) as { subscriptionId?: unknown } | null;
        const subscriptionId = typeof body?.subscriptionId === "string" ? body.subscriptionId.trim() : "";
        if (!SUBSCRIPTION_ID.test(subscriptionId)) return fail("That checkout link is not valid. Start the purchase again.", 400);
        if (!paypalConfigured()) {
          console.error("[Zeros] A checkout came back but PayPal is not fully configured.");
          return fail("Payments are temporarily unavailable. Please try again soon.", 503);
        }
        const uid = auth.user.uid;
        try {
          const verdict = verifyNewSubscription(await getSubscription(subscriptionId), uid);
          if (!verdict.ok) return fail(verdict.message, verdict.status, { code: verdict.code });
          const { facts } = verdict;
          const { row } = await readBilling(uid);
          const outcome = await applySubscription(uid, facts, row);
          if (outcome === "owned_by_other") return fail("That subscription is already linked to another Zeros account.", 409, { code: "WRONG_ACCOUNT" });
          return Response.json({ plan: facts.plan, planLabel: PLANS[facts.plan].label, renewsAt: facts.paidThrough, alreadyActive: row?.subscription_id === facts.subscriptionId });
        } catch (err) {
          console.error("[Zeros] Confirming a subscription failed:", err);
          if (err instanceof PayPalError) return fail(err.status === 503 ? "Payments are temporarily unavailable. Please try again soon." : err.message, err.status, { code: err.code });
          if (err instanceof BillingConfigError) return fail("Your payment went through, but your account could not be updated yet. Try again in a moment; you will not be charged twice.", 503, { code: "ACCOUNT_STORE" });
          return fail("Your payment went through, but the plan could not be activated yet. Try again in a moment; you will not be charged twice.", 502, { code: "ACCOUNT_STORE" });
        }
      },
    },
  },
});
