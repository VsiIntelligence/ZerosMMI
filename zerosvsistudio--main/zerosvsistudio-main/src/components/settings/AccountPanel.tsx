import { useState } from "react";
import type { CSSProperties } from "react";
import { Check, LogOut, User } from "lucide-react";
import { PlanCards } from "@/components/PlanCards";
import { PromoCode } from "@/components/PromoCode";
import { Spinner } from "@/components/zx";
import { cancelSubscription, formatDate, useBillingStatus, type BillingStatus } from "@/lib/billing-client";
import { confirmDialog } from "@/lib/dialogs";
import { signOutFirebase } from "@/lib/firebase";
import { toast } from "@/lib/toast";

function Empty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="zx-empty">
      <div className="zx-empty__icon"><User aria-hidden="true" /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && onAction ? <button type="button" className="zx-btn zx-btn--primary" onClick={onAction}>{action}</button> : null}
    </div>
  );
}

export default function AccountPanel({ isGuest, onClose }: { isGuest: boolean; onClose: () => void }) {
  const { status, error, loading } = useBillingStatus();

  const signIn = () => {
    sessionStorage.removeItem("zeros_guest");
    window.location.assign("/");
  };
  const signOut = async () => {
    await signOutFirebase();
    onClose();
  };

  return (
    <div>
      <h2 className="zx-h2">Account</h2>
      <p className="zx-lede">Your sign-in, your plan, and what is left today.</p>

      {isGuest ? (
        <Empty title="You're using Zeros as a guest" text="Sign in to start a plan and keep your chats." action="Sign in" onAction={signIn} />
      ) : !status ? (
        loading ? (
          <div className="zx-section" aria-busy="true"><div className="zx-skel" style={{ height: "4.5rem" }} /><div className="zx-skel" style={{ height: "9rem", marginTop: "0.75rem" }} /></div>
        ) : (
          <div className="zx-section"><div role="alert" className="zx-notice zx-notice--error"><div>{error ?? "Your account could not be loaded."}</div></div></div>
        )
      ) : (
        <>
          <div className="zx-section">
            <div className="zx-group">
              <div className="zx-row">
                <div className="zx-who">
                  <span className="zx-avatar" aria-hidden="true">{(status.email ?? "Z").charAt(0).toUpperCase()}</span>
                  <div className="zx-who__text"><b>{status.email ?? "Signed in"}</b><span>Signed in with Google</span></div>
                </div>
                <button type="button" className="zx-btn zx-btn--secondary zx-btn--sm" onClick={() => void signOut()}><LogOut aria-hidden="true" /> Sign out</button>
              </div>
            </div>
          </div>

          {status.unlimited ? (
            <div className="zx-section">
              <h3 className="zx-section__title">Your access</h3>
              <div className="zx-plancard">
                <div className="zx-plancard__top">
                  <span className="zx-plancard__name">Unlimited</span>
                  <span className="zx-badge zx-badge--good"><Check aria-hidden="true" /> Active</span>
                </div>
                <p className="zx-plancard__renew">Free, with no daily limit and every reasoning level, unlocked by your promo code.</p>
              </div>
            </div>
          ) : status.plan ? (
            <div className="zx-section">
              <h3 className="zx-section__title">Your plan</h3>
              <PlanSummary status={status} />
            </div>
          ) : null}

          {!status.unlimited && status.plan !== "gold" ? (
            <div className="zx-section">
              <h3 className="zx-section__title">{status.plan ? "Upgrade" : "Choose a plan"}</h3>
              <PlanCards plans={status.plan ? status.plans.filter((p) => p.id === "gold") : status.plans} current={status.plan} />
            </div>
          ) : null}

          {!status.unlimited ? (
            <div className="zx-section">
              <h3 className="zx-section__title">Promo code</h3>
              <PromoCode />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function PlanSummary({ status }: { status: BillingStatus }) {
  const [busy, setBusy] = useState(false);
  const offer = status.plans.find((p) => p.id === status.plan);
  const left = Math.max(0, Math.floor(status.remainingRequests));
  const total = Math.max(1, status.dailyRequests);
  const pct = Math.min(100, Math.round((left / total) * 100));
  const tone = left <= 0 ? " zx-meter--out" : pct <= 10 ? " zx-meter--low" : "";
  const resets = status.resetsAt ? new Date(status.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const sub = status.subscription;

  const cancel = async () => {
    const ok = await confirmDialog({
      title: "Cancel your subscription?",
      message: `You won't be charged again. You keep ${status.planLabel} until ${formatDate(sub?.renewsAt) || "the end of the month you paid for"}, then it ends.`,
      confirmLabel: "Cancel subscription",
      cancelLabel: "Keep my plan",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const result = await cancelSubscription();
    setBusy(false);
    if (result.ok) toast({ tone: "success", title: "Subscription cancelled", text: result.endsAt ? `Your plan stays active until ${formatDate(result.endsAt)}.` : "Your plan stays active until the end of the month you paid for." });
    else toast({ tone: "error", title: "It wasn't cancelled", text: result.message });
  };

  return (
    <div className="zx-plancard">
      <div className="zx-plancard__top">
        <span className="zx-plancard__name">{status.planLabel}</span>
        <span className="zx-badge zx-badge--good"><Check aria-hidden="true" /> {sub?.cancelling ? "Ending" : "Active"}</span>
      </div>
      <div className={`zx-meter${tone}`} role="progressbar" aria-label="Requests left today" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left} style={{ "--zx-pct": `${pct}%` } as CSSProperties}><i /></div>
      <div className="zx-plancard__meta">
        <span>{left} of {status.dailyRequests} requests left</span>
        <span>{resets ? `Resets at ${resets}` : ""}</span>
      </div>
      {sub ? (
        <p className="zx-plancard__renew">
          {sub.cancelling
            ? `Cancelled. Your plan stays active until ${formatDate(sub.endsAt)}, and you won't be charged again.`
            : `Renews every month. Next payment around ${formatDate(sub.renewsAt)}.`}
        </p>
      ) : null}
      {offer ? <ul className="zx-checklist">{offer.features.map((f) => <li key={f}><Check aria-hidden="true" /><span>{f}</span></li>)}</ul> : null}
      {sub && !sub.cancelling ? (
        <div className="zx-plancard__actions">
          <button type="button" className="zx-btn zx-btn--secondary zx-btn--sm" disabled={busy} aria-busy={busy} onClick={() => void cancel()}>{busy ? <><Spinner /> Cancelling…</> : "Cancel subscription"}</button>
        </div>
      ) : null}
    </div>
  );
}
