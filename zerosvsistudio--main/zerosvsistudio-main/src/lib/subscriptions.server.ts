/**
 * Keeps the stored subscription in step with PayPal, which is the only source of truth for who has paid.
 *   - confirm:   the person comes back from PayPal; the subscription is read from PayPal and, if paid, adopted.
 *   - refresh:   close to the end of a paid month the subscription is read again, so a renewal extends access (or its absence ends it).
 *   - webhook:   PayPal tells us about activations, renewals, cancellations and refunds; each one is re-read from PayPal before use.
 */
import {
  cancelSubscription, getSale, getSubscription, interpretSubscription,
  type SubscriptionFacts, type SubscriptionVerdict,
} from "./paypal.server";
import {
  entitlementOf, findBySubscription, needsRefresh, planRank, readBilling, revokeAccess, saveSubscription, touchChecked,
  type BillingRow, type BillingState,
} from "./billing.server";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
export type SyncOpts = { fetch?: Fetch; env?: Env; now?: number };

const FINISHED = new Set(["CANCELLED", "EXPIRED", "REFUNDED", "LEGACY"]);

/**
 * May this subscription replace what is stored? The same subscription always updates itself. A different one replaces it only when
 * it is active, already paid, and newer than what is stored: so a late message about an old subscription, or about a new one that
 * has not been paid yet, can never take away a plan someone is using.
 */
export function shouldAdopt(row: BillingRow | null, facts: SubscriptionFacts, now: number): boolean {
  if (!row || !row.subscription_id || row.subscription_id === facts.subscriptionId) return true;
  if (facts.status !== "ACTIVE" || !facts.paidThrough) return false;
  const current = entitlementOf(row, now);
  if (!current) return true;
  return Date.parse(facts.paidThrough) > Date.parse(current.endsAt) || planRank(facts.plan) > planRank(current.plan);
}

/** Stores a subscription for an account, and stops billing for the one it replaces (an upgrade must never be charged twice). */
export async function applySubscription(uid: string, facts: SubscriptionFacts, row: BillingRow | null, opts: SyncOpts = {}): Promise<"saved" | "ignored" | "owned_by_other"> {
  const now = opts.now ?? Date.now();
  if (!shouldAdopt(row, facts, now)) return "ignored";
  const saved = await saveSubscription(uid, {
    plan: facts.plan,
    subscriptionId: facts.subscriptionId,
    status: facts.status,
    paidThrough: facts.paidThrough,
    cancelRequested: facts.status === "CANCELLED",
  }, opts);
  if (saved !== "saved") return saved;
  const previous = row?.subscription_id;
  if (previous && previous !== facts.subscriptionId && !FINISHED.has((row?.status ?? "").toUpperCase())) {
    try {
      await cancelSubscription(previous, "Replaced by a new Zeros plan.", opts);
    } catch (err) {
      console.error(`[Zeros] The old PayPal subscription ${previous} could not be cancelled after a plan change. Cancel it in PayPal to avoid a second charge:`, err);
    }
  }
  return "saved";
}

/** Reads one subscription from PayPal and stores what it says for `uid`. */
export async function syncSubscription(uid: string, subscriptionId: string, row: BillingRow | null, opts: SyncOpts = {}): Promise<SubscriptionVerdict> {
  const verdict = interpretSubscription(await getSubscription(subscriptionId, opts), opts.env);
  if (!verdict.ok) return verdict;
  if (verdict.facts.owner !== uid) return { ok: false, status: 403, code: "WRONG_ACCOUNT", message: "That subscription belongs to a different Zeros account." };
  await applySubscription(uid, verdict.facts, row, opts);
  return verdict;
}

/** When a subscription is near the end of its paid month, ask PayPal what happened. Never throws: PayPal being down must not lock anyone out early. */
export async function refreshIfDue(uid: string, state: BillingState, opts: SyncOpts = {}): Promise<boolean> {
  const row = state.row;
  if (!row?.subscription_id || !needsRefresh(row, opts.now ?? Date.now())) return false;
  try {
    const outcome = await syncSubscription(uid, row.subscription_id, row, opts);
    if (!outcome.ok) await touchChecked(uid, opts);
    return outcome.ok;
  } catch (err) {
    console.warn("[Zeros] A subscription could not be refreshed from PayPal:", err);
    await touchChecked(uid, opts);
    return false;
  }
}

/* ------------------------------------------------------------------ PayPal webhooks */
export type WebhookOutcome = { handled: boolean; note: string };
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * One verified PayPal event. The event only says WHICH subscription changed; what changed is always read back from PayPal itself.
 * A transient failure throws, so the route answers 5xx and PayPal sends the event again.
 */
export async function handleWebhookEvent(event: unknown, opts: SyncOpts = {}): Promise<WebhookOutcome> {
  const ev = record(event), resource = record(ev["resource"]);
  const type = text(ev["event_type"]);
  let subscriptionId = "";

  if (type.startsWith("BILLING.SUBSCRIPTION.")) subscriptionId = text(resource["id"]);
  else if (type === "PAYMENT.SALE.COMPLETED") subscriptionId = text(resource["billing_agreement_id"]);
  else if (type === "PAYMENT.SALE.REFUNDED" || type === "PAYMENT.SALE.REVERSED") {
    const saleId = type === "PAYMENT.SALE.REFUNDED" ? text(resource["sale_id"]) : text(resource["id"]);
    if (!saleId) return { handled: false, note: "refund without a sale" };
    const sale = await getSale(saleId, opts);
    if (!sale.billingAgreementId) return { handled: false, note: "sale is not a subscription payment" };
    subscriptionId = sale.billingAgreementId;
    if (sale.state === "refunded" || type === "PAYMENT.SALE.REVERSED") {
      const row = await findBySubscription(subscriptionId, opts);
      if (!row) return { handled: false, note: "refunded subscription is not stored" };
      try { await cancelSubscription(subscriptionId, "Payment refunded.", opts); } catch (err) { console.error("[Zeros] A refunded subscription could not be cancelled in PayPal:", err); }
      await revokeAccess(row.user_id, "REFUNDED", opts);
      return { handled: true, note: "access ended after a full refund" };
    }
  }
  if (!subscriptionId) return { handled: false, note: `ignored ${type || "event"}` };

  const verdict = interpretSubscription(await getSubscription(subscriptionId, opts), opts.env);
  if (!verdict.ok) return { handled: false, note: verdict.code };
  const facts = verdict.facts;
  const stored = await findBySubscription(subscriptionId, opts);
  const uid = stored?.user_id ?? facts.owner;
  if (!uid) return { handled: false, note: "no owner" };
  if (stored && facts.owner && facts.owner !== stored.user_id) return { handled: false, note: "owner mismatch" };

  /* the account's current row, which may hold a different subscription than the one in this event */
  const current = stored ?? (await readBilling(uid, opts)).row;
  const result = await applySubscription(uid, facts, current, opts);
  return { handled: result === "saved", note: result === "saved" ? `${type}: ${facts.status}` : result };
}
