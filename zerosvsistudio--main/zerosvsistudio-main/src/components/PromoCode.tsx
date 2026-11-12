import { useState, type FormEvent } from "react";
import { Ticket, XCircle } from "lucide-react";
import { Spinner } from "@/components/zx";
import { redeemPromoCode } from "@/lib/billing-client";
import { toast } from "@/lib/toast";

/**
 * "Have a promo code?" A right code gives this account free, unlimited access. The code is typed here and checked on the server;
 * the page never knows what the right code is.
 */
export function PromoCode({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    const result = await redeemPromoCode(code);
    setBusy(false);
    if (result.ok) {
      setCode("");
      toast({ tone: "success", title: "Unlimited access unlocked", text: "Your account is free to use, with no daily limit." });
    } else {
      setError(result.message);
    }
  };

  if (!open) {
    return (
      <button type="button" className="zx-btn zx-btn--ghost zx-btn--sm" onClick={() => setOpen(true)}>
        <Ticket aria-hidden="true" /> Have a promo code?
      </button>
    );
  }
  return (
    <form className="zx-promo" onSubmit={(e) => void submit(e)}>
      <label className="zx-promo__label" htmlFor="zx-promo-input">Promo code</label>
      <div className="zx-promo__row">
        <input
          id="zx-promo-input" className="zx-field" type="text" value={code} onChange={(e) => setCode(e.target.value)}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200} placeholder="Enter your code" autoFocus
          aria-invalid={error ? true : undefined} aria-describedby={error ? "zx-promo-error" : undefined}
        />
        <button type="submit" className="zx-btn zx-btn--primary" disabled={busy || !code.trim()} aria-busy={busy}>
          {busy ? <Spinner /> : "Redeem"}
        </button>
      </div>
      {error ? <div id="zx-promo-error" role="alert" className="zx-notice zx-notice--error"><XCircle aria-hidden="true" /><div>{error}</div></div> : null}
    </form>
  );
}
