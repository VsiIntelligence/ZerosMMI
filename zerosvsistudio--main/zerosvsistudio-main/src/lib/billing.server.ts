/**
 * ZerosX2.0's plans, monthly subscriptions and daily allowances.
 *
 * Access has exactly three sources, and nothing else ever unlocks Zeros:
 *   1. a paid monthly subscription (Bronze $25 or Gold $50), valid for the month that was paid for;
 *   2. a promo code redemption (free and unlimited), valid while the code is still the current PROMO_CODE;
 *   3. nothing: no plan, no promo, no access. There is no free tier.
 *
 * The usage window is 24 hours from a person's first request in it; when it ends the count goes back to zero. A request that uses
 * app connectors counts 1.2 requests. Storage is Supabase, written with the server's service key.
 */
import { PRICE_USD, type PlanId } from "./paypal.server";
import { configuredPromoCode, promoTag } from "./promo-core.server";

export const PLANS = {
  bronze: {
    id: "bronze" as const, label: "Bronze", priceUsd: PRICE_USD.bronze, dailyRequests: 100,
    tagline: "For everyday work",
    features: ["100 requests every 24 hours", "Fast and Medium reasoning", "Connect your apps: Gmail, GitHub, Notion and more", "Your own wallpaper"],
  },
  gold: {
    id: "gold" as const, label: "Gold", priceUsd: PRICE_USD.gold, dailyRequests: 500,
    tagline: "For the most demanding work",
    features: ["500 requests every 24 hours", "Everything in Bronze", "Complex reasoning, with a planning pass and a quality review on every answer"],
  },
};

export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** What each kind of call costs against the 24-hour allowance. Anything that spends money upstream is counted. */
export const WEIGHTS = { chat: 1, connector: 1.2, image: 1, voice: 0.3, review: 0.5, memory: 0.1 } as const;
export const CONNECTOR_WEIGHT = WEIGHTS.connector;

/** After a month's payment is due, a still-ACTIVE subscription keeps working this long, so a payment that PayPal is still processing never cuts a customer off. */
export const GRACE_MS = 2 * 24 * 60 * 60 * 1000;
/** How often a subscription close to its renewal is re-read from PayPal. */
export const REFRESH_EVERY_MS = 5 * 60 * 1000;

export class BillingConfigError extends Error {}

export type UsageRow = { window_start: string | null; used_units: number } | null;

/** Requests are counted in tenths so a connector request (1.2) is exact. */
export const unitsFor = (weight: number): number => Math.round(weight * 10);

export function usageState(row: UsageRow, limitRequests: number, now: number) {
  const start = row?.window_start ? Date.parse(row.window_start) : NaN;
  const expired = !Number.isFinite(start) || now - start >= WINDOW_MS;
  const used = expired ? 0 : Math.max(0, row?.used_units ?? 0);
  const windowStart = expired ? now : start;
  const limitUnits = limitRequests * 10;
  return {
    windowStart,
    usedUnits: used,
    usedRequests: used / 10,
    remainingRequests: Math.max(0, limitUnits - used) / 10,
    limitRequests,
    resetsAt: new Date(windowStart + WINDOW_MS).toISOString(),
  };
}

/** The pure rule the database function also implements: charge, or refuse when the window is full. Negative units refund. */
export function applyUsage(row: UsageRow, units: number, limitRequests: number, now: number) {
  const state = usageState(row, limitRequests, now);
  if (units < 0) {
    const used = Math.max(0, state.usedUnits + units);
    return { allowed: true, next: { window_start: new Date(state.windowStart).toISOString(), used_units: used }, state: usageState({ window_start: new Date(state.windowStart).toISOString(), used_units: used }, limitRequests, now) };
  }
  if (state.usedUnits + units > limitRequests * 10) return { allowed: false, next: null, state };
  const used = state.usedUnits + units;
  const next = { window_start: new Date(state.windowStart).toISOString(), used_units: used };
  return { allowed: true, next, state: usageState(next, limitRequests, now) };
}

export const planRank = (plan: PlanId | null): number => (plan === "gold" ? 2 : plan === "bronze" ? 1 : 0);
export const higherPlan = (a: PlanId | null, b: PlanId | null): PlanId | null => (planRank(a) >= planRank(b) ? a : b);
/** Complex reasoning is a Gold feature. Promo access is unlimited, so it includes it. */
export const canUseComplex = (plan: PlanId | null, unlimited = false): boolean => unlimited || plan === "gold";

/* ------------------------------------------------------------------ what a stored subscription entitles someone to */
export type BillingRow = {
  plan: PlanId;
  subscription_id: string | null;
  status: string | null;
  paid_through: string | null;
  cancel_requested: boolean;
  checked_at: string | null;
};

export type Entitlement = { plan: PlanId; endsAt: string; status: string; cancelling: boolean } | null;

/**
 * Does this stored subscription unlock a plan right now? Yes only inside the month that was paid for. While PayPal reports the
 * subscription ACTIVE there is a short grace for the next payment to land; once it is cancelled, suspended or expired there is none.
 */
export function entitlementOf(row: BillingRow | null, now: number): Entitlement {
  if (!row?.paid_through) return null;
  const end = Date.parse(row.paid_through);
  if (!Number.isFinite(end)) return null;
  const status = (row.status ?? "").toUpperCase();
  const live = status === "ACTIVE" && !row.cancel_requested;
  if (now >= (live ? end + GRACE_MS : end)) return null;
  return { plan: row.plan, endsAt: new Date(end).toISOString(), status, cancelling: !live };
}

/** Should the subscription be re-read from PayPal now? Only near or after the end of the paid month, and not more than every few minutes. */
export function needsRefresh(row: BillingRow | null, now: number): boolean {
  if (!row?.subscription_id) return false;
  const status = (row.status ?? "").toUpperCase();
  if (status === "CANCELLED" || status === "EXPIRED" || status === "REFUNDED" || status === "LEGACY") return false;   /* none of these can renew */
  const checked = Date.parse(row.checked_at ?? "");
  if (Number.isFinite(checked) && now - checked < REFRESH_EVERY_MS) return false;
  const end = Date.parse(row.paid_through ?? "");
  if (!Number.isFinite(end)) return true;
  return now >= end - 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ storage */
type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

function store(e: Env): { url: string; key: string } {
  const url = e["SUPABASE_URL"] ?? e["VITE_SUPABASE_URL"] ?? "";
  const key = e["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new BillingConfigError("Billing storage is not configured on the server: add SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL) to the environment.");
  return { url: url.replace(/\/$/, ""), key };
}

async function rest(e: Env, f: Fetch, path: string, init: RequestInit = {}): Promise<Response> {
  const s = store(e);
  return f(`${s.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10000),
  });
}

const BILLING_COLUMNS = "plan,subscription_id,status,paid_through,cancel_requested,checked_at";
type Opts = { fetch?: Fetch; env?: Env };
const ctx = (opts: Opts): { f: Fetch; e: Env } => ({ f: opts.fetch ?? fetch, e: opts.env ?? (process.env as Env) });

export type BillingState = {
  /** The plan that is unlocked right now (null when there is none). */
  plan: PlanId | null;
  entitlement: Entitlement;
  /** True for a promo redemption that is still valid: free, unlimited, every reasoning level. */
  unlimited: boolean;
  /** The stored subscription row, even when it has run out. */
  row: BillingRow | null;
  usage: UsageRow;
};

export async function readBilling(uid: string, opts: Opts & { now?: number } = {}): Promise<BillingState> {
  const { f, e } = ctx(opts);
  const q = encodeURIComponent(uid);
  const [billRes, usageRes, promoRes] = await Promise.all([
    rest(e, f, `zeros_billing?user_id=eq.${q}&select=${BILLING_COLUMNS}`),
    rest(e, f, `zeros_usage?user_id=eq.${q}&select=window_start,used_units`),
    rest(e, f, `zeros_promo?user_id=eq.${q}&select=code_tag`),
  ]);
  if (!billRes.ok || !usageRes.ok || !promoRes.ok) throw new Error(`Billing read failed (HTTP ${billRes.status}/${usageRes.status}/${promoRes.status}).`);
  const rows = (await billRes.json()) as BillingRow[];
  const usageRows = (await usageRes.json()) as UsageRow[];
  const grants = (await promoRes.json()) as { code_tag?: string }[];
  const row = rows[0] ?? null;
  const entitlement = entitlementOf(row, opts.now ?? Date.now());
  const code = configuredPromoCode(e);
  const unlimited = !!code && !!grants[0]?.code_tag && grants[0].code_tag === (await promoTag(code));
  return { plan: entitlement?.plan ?? null, entitlement, unlimited, row, usage: usageRows[0] ?? null };
}

/** Charges (or refunds, with negative units) through the database function, which locks the row so concurrent requests cannot overspend. */
export async function chargeUsage(uid: string, units: number, limitRequests: number, opts: Opts & { now?: number } = {}) {
  const { f, e } = ctx(opts);
  const res = await rest(e, f, "rpc/zeros_consume_usage", {
    method: "POST",
    body: JSON.stringify({ p_user: uid, p_units: units, p_limit: limitRequests, p_now: new Date(opts.now ?? Date.now()).toISOString() }),
  });
  if (!res.ok) throw new Error(`Usage update failed (HTTP ${res.status}).`);
  const row = (await res.json()) as { allowed: boolean; used_units: number; window_start: string };
  return {
    allowed: row.allowed,
    state: usageState({ window_start: row.window_start, used_units: row.used_units }, limitRequests, opts.now ?? Date.now()),
  };
}

export type SavedSubscription = { plan: PlanId; subscriptionId: string; status: string; paidThrough: string | null; cancelRequested: boolean };

/** Stores what PayPal says about this account's subscription. One PayPal subscription can belong to one account only. */
export async function saveSubscription(uid: string, s: SavedSubscription, opts: Opts & { now?: number } = {}): Promise<"saved" | "owned_by_other"> {
  const { f, e } = ctx(opts);
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const res = await rest(e, f, "zeros_billing?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, plan: s.plan, subscription_id: s.subscriptionId, status: s.status, paid_through: s.paidThrough, cancel_requested: s.cancelRequested, checked_at: at, plan_updated_at: at }),
  });
  if (res.ok) return "saved";
  if (res.status === 409) return "owned_by_other";
  throw new Error(`Saving the subscription failed (HTTP ${res.status}).`);
}

/** Remembers that PayPal was just asked, so the same account is not looked up again for a few minutes. */
export async function touchChecked(uid: string, opts: Opts & { now?: number } = {}): Promise<void> {
  const { f, e } = ctx(opts);
  await rest(e, f, `zeros_billing?user_id=eq.${encodeURIComponent(uid)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ checked_at: new Date(opts.now ?? Date.now()).toISOString() }),
  }).catch(() => undefined);
}

/** Which account holds a PayPal subscription (used when PayPal calls the webhook). */
export async function findBySubscription(subscriptionId: string, opts: Opts = {}): Promise<(BillingRow & { user_id: string }) | null> {
  const { f, e } = ctx(opts);
  const res = await rest(e, f, `zeros_billing?subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id,${BILLING_COLUMNS}`);
  if (!res.ok) throw new Error(`Subscription lookup failed (HTTP ${res.status}).`);
  const rows = (await res.json()) as (BillingRow & { user_id: string })[];
  return rows[0] ?? null;
}

/** Ends access right now (a refunded or reversed payment). */
export async function revokeAccess(uid: string, status: string, opts: Opts & { now?: number } = {}): Promise<void> {
  const { f, e } = ctx(opts);
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const res = await rest(e, f, `zeros_billing?user_id=eq.${encodeURIComponent(uid)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, paid_through: new Date(now - 1000).toISOString(), cancel_requested: true, checked_at: at }),
  });
  if (!res.ok) throw new Error(`Ending access failed (HTTP ${res.status}).`);
}

/** Records a promo redemption. Only the fingerprint of the code is stored. */
export async function grantPromo(uid: string, tag: string, opts: Opts = {}): Promise<void> {
  const { f, e } = ctx(opts);
  const res = await rest(e, f, "zeros_promo?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, code_tag: tag, redeemed_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Saving the promo redemption failed (HTTP ${res.status}).`);
}
