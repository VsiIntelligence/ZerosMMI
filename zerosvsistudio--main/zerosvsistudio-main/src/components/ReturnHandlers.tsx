import { useCallback, useEffect, useRef, useState } from "react";
import { XCircle } from "lucide-react";
import { Sheet, Spinner } from "@/components/zx";
import { appName, clearAppsParams, finishApp, readAppsReturn } from "@/lib/apps-client";
import { clearCheckoutParams, completeCheckout, readCheckoutReturn } from "@/lib/billing-client";
import { toast } from "@/lib/toast";

type PayState = { phase: "working" } | { phase: "done"; planLabel: string } | { phase: "failed"; message: string; retry: boolean; subscriptionId: string };

/**
 * Finishes what the person started somewhere else and came back from: a PayPal subscription (the plan activates by itself) or an
 * app's sign-in page (the app turns on, ready to use). Reads the address once, tidies it, and shows the outcome.
 */
export default function ReturnHandlers() {
  const [pay, setPay] = useState<PayState | null>(null);
  const ran = useRef(false);

  const finish = useCallback(async (subscriptionId: string) => {
    setPay({ phase: "working" });
    const result = await completeCheckout(subscriptionId);
    setPay(result.ok ? { phase: "done", planLabel: result.planLabel } : { phase: "failed", message: result.message, retry: result.retry, subscriptionId });
  }, []);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const search = window.location.search;
    const checkout = readCheckoutReturn(search);
    const apps = readAppsReturn(search);
    if (checkout) {
      clearCheckoutParams();
      if (checkout.kind === "cancel") toast({ tone: "info", title: "Checkout cancelled", text: "You haven't been charged." });
      else void finish(checkout.subscriptionId);
    }
    if (apps) {
      clearAppsParams();
      const name = appName(apps.toolkit);
      if (!apps.ok) toast({ tone: "error", title: `${name} wasn't connected`, text: "The sign-in didn't finish. You can try again any time from Settings → Apps." });
      else {
        // The server waits for the connection to turn live, then switches the app on, so "connected" always means "working".
        void finishApp(apps.toolkit).then((r) => {
          if (!r.ok) toast({ tone: "error", title: `${name} is connected`, text: `${r.error} Turn it on in Settings → Apps.` });
          else if (r.data.pending) toast({ tone: "info", title: `${name} is almost ready`, text: "It's still finishing its sign-in. Open Settings → Apps in a moment to turn it on." });
          else toast({ tone: "success", title: `${name} is connected`, text: r.data.keptReadOnly ? "Zeros can read from it in chat. It stays read-only, as you set it." : "Zeros can now use it in chat: reading, and making changes when you ask. Switch off Allow changes in Settings → Apps for read-only." });
        });
      }
    }
  }, [finish]);

  if (!pay) return null;
  const working = pay.phase === "working";
  const close = () => setPay(null);
  return (
    <Sheet label="Plan activation" size="sm" centered onClose={working ? () => undefined : close}>
      <div className="zx-paystate" role="status" aria-live="polite">
        {pay.phase === "working" && (
          <>
            <span className="zx-seal"><Spinner /></span>
            <h2>Finishing your purchase</h2>
            <p>Confirming your subscription and first payment with PayPal. This takes a few seconds; please keep this page open.</p>
          </>
        )}
        {pay.phase === "done" && (
          <>
            <span className="zx-seal zx-seal--good"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
            <h2>You're all set</h2>
            <p>{pay.planLabel === "Your" ? "Your plan" : `Your ${pay.planLabel} plan`} is active and renews every month until you cancel it in Settings. Thank you for supporting Zeros.</p>
            <button type="button" data-autofocus className="zx-btn zx-btn--primary zx-btn--lg zx-btn--block" onClick={close}>Start using Zeros</button>
          </>
        )}
        {pay.phase === "failed" && (
          <>
            <span className="zx-seal zx-seal--bad"><XCircle aria-hidden="true" /></span>
            <h2>We couldn't finish yet</h2>
            <p>{pay.message}</p>
            <div className="zx-paystate__row">
              {pay.retry ? <button type="button" data-autofocus className="zx-btn zx-btn--primary" onClick={() => void finish(pay.subscriptionId)}>Try again</button> : null}
              <button type="button" className="zx-btn zx-btn--secondary" onClick={close}>Close</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
