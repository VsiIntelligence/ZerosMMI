import { createFileRoute } from "@tanstack/react-router";
import { verifyWebhook } from "@/lib/paypal.server";
import { handleWebhookEvent } from "@/lib/subscriptions.server";

/**
 * PayPal's own notifications (renewals, cancellations, refunds). Every call is verified with PayPal first; without
 * PAYPAL_WEBHOOK_ID nothing is trusted. A failure on our side answers 5xx so PayPal sends the notification again.
 */
export const Route = createFileRoute("/api/billing/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        if (rawBody.length > 200_000) return new Response("Too large", { status: 413 });
        let verified = false;
        try {
          verified = await verifyWebhook({ headers: request.headers, rawBody });
        } catch (err) {
          console.error("[Zeros] A PayPal webhook could not be verified:", err);
          return new Response("Try again", { status: 503 });
        }
        if (!verified) return new Response("Not verified", { status: 400 });
        try {
          const outcome = await handleWebhookEvent(JSON.parse(rawBody));
          return Response.json({ ok: true, ...outcome });
        } catch (err) {
          console.error("[Zeros] A PayPal webhook could not be processed:", err);
          return new Response("Try again", { status: 500 });
        }
      },
    },
  },
});
