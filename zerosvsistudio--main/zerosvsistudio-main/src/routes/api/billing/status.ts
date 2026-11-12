import { createFileRoute } from "@tanstack/react-router";
import { authenticate } from "@/lib/firebase-user.server";
import { PLANS, WINDOW_MS, readBilling, usageState } from "@/lib/billing.server";
import { billingFailure } from "@/lib/access.server";
import { refreshIfDue } from "@/lib/subscriptions.server";
import { composioApiConfigured } from "@/lib/composio-api.server";
import { paypalConfigured } from "@/lib/paypal.server";

/** The signed-in person's plan, subscription, today's usage and what their plan includes. */
export const Route = createFileRoute("/api/billing/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;
        try {
          let state = await readBilling(auth.user.uid);
          if (await refreshIfDue(auth.user.uid, state)) state = await readBilling(auth.user.uid);
          const { plan, usage, unlimited, entitlement } = state;
          const limit = plan ? PLANS[plan].dailyRequests : 0;
          const usageNow = plan && !unlimited ? usageState(usage, limit, Date.now()) : null;
          return Response.json({
            signedIn: true,
            email: auth.user.email,
            plan: unlimited ? null : plan,
            planLabel: unlimited ? "Unlimited" : plan ? PLANS[plan].label : null,
            unlimited,
            dailyRequests: unlimited ? 0 : limit,
            usedRequests: usageNow?.usedRequests ?? 0,
            remainingRequests: usageNow?.remainingRequests ?? 0,
            resetsAt: usageNow?.resetsAt ?? null,
            windowMs: WINDOW_MS,
            complexAllowed: unlimited || plan === "gold",
            connectorsAvailable: composioApiConfigured(),
            paypalConfigured: paypalConfigured(),
            subscription: !unlimited && entitlement
              ? { status: entitlement.status, cancelling: entitlement.cancelling, renewsAt: entitlement.cancelling ? null : entitlement.endsAt, endsAt: entitlement.cancelling ? entitlement.endsAt : null }
              : null,
            plans: Object.values(PLANS).map((p) => ({ id: p.id, label: p.label, priceUsd: p.priceUsd, interval: "month", dailyRequests: p.dailyRequests, tagline: p.tagline, features: p.features })),
          });
        } catch (err) {
          return billingFailure(err);
        }
      },
    },
  },
});
