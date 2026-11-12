import { createFileRoute } from "@tanstack/react-router";
import { authenticate } from "@/lib/firebase-user.server";
import { BillingConfigError, planRank, readBilling } from "@/lib/billing.server";
import { PayPalError, checkoutReturnUrls, createSubscription, isPlanId, paypalConfigured } from "@/lib/paypal.server";

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Starts a monthly subscription: creates it for this account and returns the PayPal page to send the person to. */
export const Route = createFileRoute("/api/billing/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;
        const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
        const plan = body?.plan;
        if (!isPlanId(plan)) return fail("Choose the Bronze or Gold plan.", 400);
        if (!paypalConfigured()) {
          console.error("[Zeros] Checkout requested but PayPal is not fully configured (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PLAN_ID_BRONZE, PAYPAL_PLAN_ID_GOLD).");
          return fail("Payments are temporarily unavailable. Please try again soon.", 503);
        }
        try {
          const { plan: current, unlimited, entitlement } = await readBilling(auth.user.uid);
          if (unlimited) return fail("You already have unlimited access, so there is nothing to buy.", 409);
          /* Same or lower plan while one is running: no second charge. A cancelled plan that is still inside its paid month may be replaced. */
          if (entitlement && !entitlement.cancelling && planRank(current) >= planRank(plan)) {
            return fail(current === "gold" ? "You already have the Gold plan. To switch to Bronze, cancel Gold first and subscribe again when it ends." : "You already have this plan.", 409);
          }
          const { returnUrl, cancelUrl } = checkoutReturnUrls(request);
          return Response.json(await createSubscription({ plan, uid: auth.user.uid, returnUrl, cancelUrl }));
        } catch (err) {
          console.error("[Zeros] Checkout failed:", err);
          if (err instanceof PayPalError) return fail(err.status === 503 || err.code === "CONFIG" ? "Payments are temporarily unavailable. Please try again soon." : err.message, err.status === 503 ? 503 : err.status);
          if (err instanceof BillingConfigError) return fail("Your account is temporarily unavailable. Please try again soon.", 503);
          return fail("The checkout could not be started. Please try again.", 502);
        }
      },
    },
  },
});
