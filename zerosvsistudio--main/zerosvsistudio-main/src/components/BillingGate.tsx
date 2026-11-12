import { useNavigate } from "@tanstack/react-router";
import { LogOut, Lock, XCircle } from "lucide-react";
import { PlanCards } from "@/components/PlanCards";
import { PromoCode } from "@/components/PromoCode";
import LuminousOrb from "@/components/LuminousOrb";
import { Sheet } from "@/components/zx";
import { hasAccess, useBillingStatus, type PlanOffer } from "@/lib/billing-client";
import { signOutFirebase } from "@/lib/firebase";

/** Guests cannot chat: the plan, the chats and the apps all belong to an account. This says so kindly and offers the way in. */
function GuestGate() {
  const navigate = useNavigate();
  const signIn = () => {
    sessionStorage.removeItem("zeros_guest");
    void navigate({ to: "/" });
  };
  return (
    <Sheet label="Sign in to use Zeros" size="sm" centered onClose={signIn}>
      <div className="zx-paystate">
        <LuminousOrb size={52} />
        <h2>Sign in to use Zeros</h2>
        <p>Your plan, your chats and your apps live in your account, so they follow you to every device.</p>
        <button type="button" data-autofocus className="zx-btn zx-btn--primary zx-btn--lg zx-btn--block" onClick={signIn}>Continue to sign in</button>
      </div>
    </Sheet>
  );
}

function Paywall({ plans, ready }: { plans: PlanOffer[]; ready: boolean }) {
  return (
    <div className="zx-paywall" role="dialog" aria-modal="true" aria-labelledby="zx-paywall-title">
      <div className="zx-paywall__tools">
        <button type="button" className="zx-btn zx-btn--ghost zx-btn--sm" onClick={() => void signOutFirebase()}><LogOut aria-hidden="true" /> Sign out</button>
      </div>
      <div className="zx-paywall__inner">
        <LuminousOrb size={56} />
        <h1 id="zx-paywall-title">Choose your plan</h1>
        <p className="zx-lede">Pick the plan that fits how you work. You subscribe securely on PayPal, then come straight back here and start. Plans renew monthly and you can cancel any time.</p>
        {ready ? <PlanCards plans={plans} current={null} /> : <div className="zx-notice zx-notice--warn"><XCircle aria-hidden="true" /><div>Checkout isn't available right now. Please try again soon.</div></div>}
        <div className="zx-paywall__promo"><PromoCode /></div>
        <p className="zx-secure"><Lock aria-hidden="true" /> Secure checkout with PayPal. Zeros never sees your payment details.</p>
      </div>
    </div>
  );
}

/** Shown until the person has a plan or a promo redemption. Everything about subscribing happens here, in one click. */
export default function BillingGate({ isGuest = false }: { isGuest?: boolean }) {
  const { status, error, loading } = useBillingStatus();
  if (isGuest) return <GuestGate />;
  if (loading && !status) return null;
  if (!status) {
    return error ? (
      <div className="zx-toasts" role="alert"><div className="zx-toast zx-toast--error"><XCircle aria-hidden="true" /><div className="zx-toast__text"><div className="zx-toast__title">{error}</div></div></div></div>
    ) : null;
  }
  if (!status.signedIn || hasAccess(status)) return null;
  return <Paywall plans={status.plans} ready={status.paypalConfigured} />;
}
