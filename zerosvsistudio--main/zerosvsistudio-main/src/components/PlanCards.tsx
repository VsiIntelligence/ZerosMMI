import { useEffect, useState } from "react";
import { Check, Crown, XCircle } from "lucide-react";
import { Spinner } from "@/components/zx";
import { startCheckout, type PlanId, type PlanOffer } from "@/lib/billing-client";

/**
 * The monthly plans, each with one button. The button creates the PayPal subscription and takes the person there; PayPal sends them
 * straight back to the chat and the plan activates by itself. It renews every month until they cancel. Nothing to type, nothing to copy.
 */
export function PlanCards({ plans, current }: { plans: PlanOffer[]; current: PlanId | null }) {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Coming back with the browser's Back button restores this page as it was: the buttons must not stay stuck on "Opening PayPal".
    const reset = (e: PageTransitionEvent) => { if (e.persisted) setBusy(null); };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const buy = async (plan: PlanId) => {
    if (busy) return;
    setBusy(plan);
    setError(null);
    const result = await startCheckout(plan);
    if (!result.ok) { setBusy(null); setError(result.message); }
  };

  return (
    <>
      <div className={`zx-plans${plans.length === 1 ? " zx-plans--single" : ""}`}>
        {plans.map((plan) => {
          const featured = plan.id === "gold";
          const label = current ? `Upgrade to ${plan.label}` : `Subscribe to ${plan.label}`;
          return (
            <section key={plan.id} className={`zx-plan${featured ? " zx-plan--featured" : ""}`} aria-label={`${plan.label} plan`}>
              <div className="zx-plan__head">
                <h3 className="zx-plan__name">{plan.label}</h3>
                {featured ? <span className="zx-badge zx-badge--accent"><Crown aria-hidden="true" /> Most capable</span> : null}
              </div>
              <p className="zx-plan__tag">{plan.tagline}</p>
              <div className="zx-plan__price"><b>${plan.priceUsd}</b><span>USD / month</span></div>
              <ul className="zx-checklist">
                {plan.features.map((feature) => <li key={feature}><Check aria-hidden="true" /><span>{feature}</span></li>)}
              </ul>
              <button type="button" className={`zx-btn zx-btn--lg zx-btn--block ${featured ? "zx-btn--primary" : "zx-btn--secondary"}`} disabled={busy !== null} aria-busy={busy === plan.id} onClick={() => void buy(plan.id)}>
                {busy === plan.id ? <><Spinner /> Opening PayPal…</> : label}
              </button>
            </section>
          );
        })}
      </div>
      <p className="zx-plans__note">Billed monthly through PayPal and renewed automatically until you cancel. Cancel any time in Settings; you keep the month you paid for.</p>
      {error ? <div role="alert" className="zx-notice zx-notice--error"><XCircle aria-hidden="true" /><div>{error}</div></div> : null}
    </>
  );
}
