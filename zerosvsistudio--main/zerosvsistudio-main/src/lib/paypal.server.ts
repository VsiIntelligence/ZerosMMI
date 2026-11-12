/**
 * PayPal subscriptions. Bronze ($25) and Gold ($50) are billed every month, automatically, until the person cancels.
 *
 * How it stays safe:
 *  - The server creates the subscription for the signed-in account (the account id travels in `custom_id`) and sends the person
 *    to PayPal's own page. They come back, and the server asks PayPal (server to server) what really happened.
 *  - Nothing unlocks from what the browser says. A plan unlocks only when PayPal reports a payment for exactly the plan's price in USD.
 *  - The PayPal plan itself is checked before every checkout: USD, every 1 month, no end date, no free trial, the right price.
 *    A plan that was created wrongly in the PayPal dashboard can therefore never sell a plan for the wrong money.
 *  - Access lasts for the month that was paid for. When the next monthly payment does not arrive, access ends.
 */
import { appOrigin } from "./app-origin.server";

export type PlanId = "bronze" | "gold";
export const PRICE_USD: Record<PlanId, number> = { bronze: 25, gold: 50 };
export const PLAN_RANK: Record<PlanId, number> = { bronze: 1, gold: 2 };
export const PLAN_NAME: Record<PlanId, string> = { bronze: "Bronze", gold: "Gold" };
export const isPlanId = (v: unknown): v is PlanId => v === "bronze" || v === "gold";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
const env = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});

/** A PayPal problem with a message that is safe to show to the person, an HTTP status for the route, and PayPal's own code. */
export class PayPalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 502, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A setting as PayPal needs it: spaces and quotes removed, and a pasted "NAME=" prefix removed too. */
export function cleanSetting(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  v = v.replace(/^(PAYPAL_[A-Z_]+|[A-Z][A-Z0-9_]*)\s*=\s*/, "").trim();
  v = v.replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").trim();
  return v;
}
const pp = (e: Env, name: string): string => cleanSetting(e[name]);

/* ------------------------------------------------------------------ configuration */
const PLAN_ENV: Record<PlanId, string> = { bronze: "PAYPAL_PLAN_ID_BRONZE", gold: "PAYPAL_PLAN_ID_GOLD" };

/** The PayPal billing plan (P-...) that sells one of our plans. */
export const paypalPlanId = (plan: PlanId, e: Env = env()): string => pp(e, PLAN_ENV[plan]);

export function planFromPayPalId(id: string | undefined, e: Env = env()): PlanId | null {
  if (!id) return null;
  for (const plan of ["gold", "bronze"] as const) if (paypalPlanId(plan, e) === id) return plan;
  return null;
}

/** Payments work only when the PayPal app keys AND both billing plans are configured. */
export function paypalConfigured(e: Env = env()): boolean {
  return !!(pp(e, "PAYPAL_CLIENT_ID") && pp(e, "PAYPAL_CLIENT_SECRET") && paypalPlanId("bronze", e) && paypalPlanId("gold", e));
}

export function paypalBase(e: Env = env()): string {
  return pp(e, "PAYPAL_ENV") === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}

/** Where PayPal sends the person back to: the chat, with a marker the app recognises. PayPal adds `subscription_id` itself. */
export function checkoutReturnUrls(request: Request, e: Env = env()): { returnUrl: string; cancelUrl: string } {
  const origin = appOrigin(request, e);
  return { returnUrl: `${origin}/chat?checkout=return`, cancelUrl: `${origin}/chat?checkout=cancel` };
}

/* ------------------------------------------------------------------ calendar math */
/** One calendar month later, in UTC, keeping the day of the month where it exists (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, months = 1): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) throw new RangeError("Not a date.");
  const day = d.getUTCDate();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, lastDay));
  return r.toISOString();
}

/* ------------------------------------------------------------------ access token (cached until shortly before it expires) */
let tokenCache: { key: string; token: string; expires: number } | null = null;
export function clearPayPalTokenCache(): void { tokenCache = null; }

async function accessToken(e: Env, f: Fetch, now = Date.now()): Promise<string> {
  const id = pp(e, "PAYPAL_CLIENT_ID"), secret = pp(e, "PAYPAL_CLIENT_SECRET");
  const key = `${paypalBase(e)}|${id}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expires > now) return tokenCache.token;
  const res = await f(`${paypalBase(e)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new PayPalError(`PayPal sign-in failed (HTTP ${res.status}). Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV.`, 503, "AUTH");
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!json?.access_token) throw new PayPalError("PayPal did not return an access token.", 502, "AUTH");
  tokenCache = { key, token: json.access_token, expires: now + Math.max(60, (json.expires_in ?? 300) - 60) * 1000 };
  return json.access_token;
}

type Reply = { ok: boolean; status: number; json: unknown };

async function paypal(e: Env, f: Fetch, path: string, init: { method?: string; body?: unknown; requestId?: string } = {}, retry = true): Promise<Reply> {
  const token = await accessToken(e, f);
  const res = await f(`${paypalBase(e)}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && retry) { tokenCache = null; return paypal(e, f, path, init, false); }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON error page: only the status is used */ }
  return { ok: res.ok, status: res.status, json };
}

/** PayPal's own name for what went wrong, e.g. SUBSCRIPTION_STATUS_INVALID. */
function issueOf(json: unknown): string {
  const body = (json && typeof json === "object" ? json : {}) as { name?: string; details?: { issue?: string }[] };
  return body.details?.[0]?.issue ?? body.name ?? "";
}

const isPayPalHost = (href: string): boolean => {
  try { const host = new URL(href).hostname; return host === "paypal.com" || host.endsWith(".paypal.com"); } catch { return false; }
};

/* ------------------------------------------------------------------ the PayPal plan must be exactly what we advertise */
type Money = { currency_code?: string; value?: string };
export type PayPalPlan = {
  id?: string;
  status?: string;
  billing_cycles?: { tenure_type?: string; total_cycles?: number; frequency?: { interval_unit?: string; interval_count?: number }; pricing_scheme?: { fixed_price?: Money } }[];
};

/** Returns what is wrong with a PayPal plan, or null when it sells `plan` at the right price, monthly, with no trial and no end. */
export function planTermsProblem(p: PayPalPlan, plan: PlanId): string | null {
  if (String(p.status ?? "").toUpperCase() !== "ACTIVE") return "the plan is not ACTIVE in PayPal";
  const cycles = p.billing_cycles ?? [];
  if (cycles.some((c) => String(c.tenure_type ?? "").toUpperCase() === "TRIAL")) return "the plan has a free trial";
  const regular = cycles.filter((c) => String(c.tenure_type ?? "").toUpperCase() === "REGULAR");
  if (regular.length !== 1) return "the plan must have exactly one regular billing cycle";
  const c = regular[0]!;
  if (String(c.frequency?.interval_unit ?? "").toUpperCase() !== "MONTH" || (c.frequency?.interval_count ?? 1) !== 1) return "the plan is not billed every 1 month";
  if ((c.total_cycles ?? 0) !== 0) return "the plan ends after a fixed number of payments (total cycles must be 0, meaning until cancelled)";
  const price = c.pricing_scheme?.fixed_price;
  const value = Number(price?.value);
  if (price?.currency_code !== "USD" || !Number.isFinite(value) || Math.abs(value - PRICE_USD[plan]) > 0.005) return `the plan charges ${price?.value ?? "?"} ${price?.currency_code ?? ""}, expected ${PRICE_USD[plan].toFixed(2)} USD`;
  return null;
}

const PLAN_OK_MS = 10 * 60 * 1000;
const planChecked = new Map<string, number>();
export function clearPlanCache(): void { planChecked.clear(); }

async function assertPlanTerms(plan: PlanId, e: Env, f: Fetch, now = Date.now()): Promise<string> {
  const id = paypalPlanId(plan, e);
  if (!id) throw new PayPalError(`Payments are not set up yet (${PLAN_ENV[plan]} is missing).`, 503, "CONFIG");
  if (!/^P-[A-Za-z0-9]+$/.test(id)) throw new PayPalError(`${PLAN_ENV[plan]} is not a PayPal plan ID. It must look like P-XXXXXXXX (paste only the value).`, 503, "CONFIG");
  const key = `${paypalBase(e)}|${id}|${plan}`;
  if ((planChecked.get(key) ?? 0) > now) return id;
  const reply = await paypal(e, f, `/v1/billing/plans/${encodeURIComponent(id)}`);
  if (!reply.ok) throw new PayPalError(`PayPal could not look up the ${PLAN_NAME[plan]} billing plan (HTTP ${reply.status}${issueOf(reply.json) ? `: ${issueOf(reply.json)}` : ""}).`, reply.status === 404 ? 503 : 502, reply.status === 404 ? "CONFIG" : issueOf(reply.json));
  const problem = planTermsProblem(reply.json as PayPalPlan, plan);
  if (problem) throw new PayPalError(`The PayPal plan ${id} cannot sell ${PLAN_NAME[plan]}: ${problem}.`, 503, "CONFIG");
  planChecked.set(key, now + PLAN_OK_MS);
  return id;
}

/* ------------------------------------------------------------------ subscriptions */
export type Subscription = {
  id?: string;
  status?: string;
  plan_id?: string;
  custom_id?: string;
  status_update_time?: string;
  subscriber?: { email_address?: string };
  billing_info?: {
    last_payment?: { amount?: Money; time?: string };
    next_billing_time?: string;
    failed_payments_count?: number;
  };
  links?: { href?: string; rel?: string }[];
};

/** Creates the subscription for one plan, owned by one account, and returns the PayPal page where the person approves it. */
export async function createSubscription(
  p: { plan: PlanId; uid: string; returnUrl: string; cancelUrl: string },
  opts: { fetch?: Fetch; env?: Env } = {},
): Promise<{ subscriptionId: string; approveUrl: string }> {
  const e = opts.env ?? env(), f = opts.fetch ?? fetch;
  if (!paypalConfigured(e)) throw new PayPalError("Payments are not set up on the server yet.", 503, "CONFIG");
  const planId = await assertPlanTerms(p.plan, e, f);
  const reply = await paypal(e, f, "/v1/billing/subscriptions", {
    method: "POST",
    requestId: crypto.randomUUID(),
    body: {
      plan_id: planId,
      custom_id: p.uid,
      application_context: {
        brand_name: "ZerosX2.0",
        locale: "en-US",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
        return_url: p.returnUrl,
        cancel_url: p.cancelUrl,
      },
    },
  });
  if (!reply.ok) throw new PayPalError(`PayPal could not start the checkout (HTTP ${reply.status}${issueOf(reply.json) ? `: ${issueOf(reply.json)}` : ""}). Try again in a moment.`, 502, issueOf(reply.json));
  const sub = reply.json as Subscription;
  const link = (sub.links ?? []).find((l) => l.rel === "approve");
  if (!sub.id || !link?.href || !isPayPalHost(link.href)) throw new PayPalError("PayPal did not return a checkout page. Try again.", 502, "NO_LINK");
  return { subscriptionId: sub.id, approveUrl: link.href };
}

export async function getSubscription(id: string, opts: { fetch?: Fetch; env?: Env } = {}): Promise<Subscription> {
  const reply = await paypal(opts.env ?? env(), opts.fetch ?? fetch, `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  if (reply.status === 404) throw new PayPalError("We could not find that PayPal subscription.", 404, "NOT_FOUND");
  if (!reply.ok) throw new PayPalError(`PayPal could not look up the subscription (HTTP ${reply.status}). Try again in a moment.`, 502, issueOf(reply.json));
  return reply.json as Subscription;
}

/** Stops future monthly payments. PayPal does not refund the month already paid; access stays until that month ends. */
export async function cancelSubscription(id: string, reason: string, opts: { fetch?: Fetch; env?: Env } = {}): Promise<void> {
  const reply = await paypal(opts.env ?? env(), opts.fetch ?? fetch, `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason: reason.slice(0, 128) } });
  if (reply.ok) return;
  if (reply.status === 422 && issueOf(reply.json) === "SUBSCRIPTION_STATUS_INVALID") return;   /* already cancelled or expired */
  if (reply.status === 404) throw new PayPalError("We could not find that PayPal subscription.", 404, "NOT_FOUND");
  throw new PayPalError(`PayPal could not cancel the subscription (HTTP ${reply.status}). Try again in a moment.`, 502, issueOf(reply.json));
}

/** A completed sale, read back to learn which subscription it paid for and whether it was refunded. */
export async function getSale(id: string, opts: { fetch?: Fetch; env?: Env } = {}): Promise<{ billingAgreementId: string | null; state: string }> {
  const reply = await paypal(opts.env ?? env(), opts.fetch ?? fetch, `/v1/payments/sale/${encodeURIComponent(id)}`);
  if (!reply.ok) throw new PayPalError(`PayPal could not look up the payment (HTTP ${reply.status}).`, 502, issueOf(reply.json));
  const sale = (reply.json ?? {}) as { billing_agreement_id?: string; state?: string };
  return { billingAgreementId: sale.billing_agreement_id ?? null, state: String(sale.state ?? "").toLowerCase() };
}

/** Asks PayPal whether a webhook really came from PayPal. Without PAYPAL_WEBHOOK_ID nothing is trusted. */
export async function verifyWebhook(p: { headers: Headers; rawBody: string }, opts: { fetch?: Fetch; env?: Env } = {}): Promise<boolean> {
  const e = opts.env ?? env();
  const webhookId = (pp(e, "PAYPAL_WEBHOOK_ID")).trim();
  if (!webhookId || !paypalConfigured(e)) return false;
  let event: unknown;
  try { event = JSON.parse(p.rawBody); } catch { return false; }
  const h = (name: string): string => p.headers.get(name) ?? "";
  if (!h("paypal-transmission-sig") || !h("paypal-cert-url")) return false;
  const reply = await paypal(e, opts.fetch ?? fetch, "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return reply.ok && (reply.json as { verification_status?: string } | null)?.verification_status === "SUCCESS";
}

/* ------------------------------------------------------------------ what a subscription means for access */
export type SubscriptionFacts = {
  subscriptionId: string;
  plan: PlanId;
  status: string;
  owner: string | null;
  email: string | null;
  lastPaymentAt: string | null;
  /** The end of the month that the last payment covers, or null while no payment has been seen. */
  paidThrough: string | null;
};
export type SubscriptionVerdict = { ok: true; facts: SubscriptionFacts } | { ok: false; status: number; code: string; message: string };
const refuse = (status: number, code: string, message: string): SubscriptionVerdict => ({ ok: false, status, code, message });

/**
 * Pure rule, used by the routes and by tests: reads a PayPal subscription into the few facts access depends on. It refuses a
 * subscription that is not one of our two plans, or whose payment is not exactly the plan's price in USD.
 */
export function interpretSubscription(sub: Subscription, e: Env = env()): SubscriptionVerdict {
  const plan = planFromPayPalId(sub.plan_id, e);
  if (!sub.id || !plan) return refuse(400, "NOT_A_PLAN", "That PayPal subscription is not a Zeros plan.");
  let lastPaymentAt: string | null = null, paidThrough: string | null = null;
  const paid = sub.billing_info?.last_payment;
  if (paid?.time) {
    const amount = Number(paid.amount?.value);
    if (paid.amount?.currency_code !== "USD" || !Number.isFinite(amount) || Math.abs(amount - PRICE_USD[plan]) > 0.005) {
      return refuse(402, "WRONG_AMOUNT", "The payment amount did not match the plan price, so the plan was not unlocked.");
    }
    const at = Date.parse(paid.time);
    if (Number.isFinite(at)) { lastPaymentAt = new Date(at).toISOString(); paidThrough = addMonths(lastPaymentAt, 1); }
  }
  return { ok: true, facts: { subscriptionId: sub.id, plan, status: String(sub.status ?? "").toUpperCase(), owner: sub.custom_id ?? null, email: sub.subscriber?.email_address?.trim().toLowerCase() || null, lastPaymentAt, paidThrough } };
}

/**
 * The checks that decide whether the person who just came back from PayPal gets their plan: the subscription is theirs, it is
 * active, and PayPal has taken the first monthly payment.
 */
export function verifyNewSubscription(sub: Subscription, uid: string, e: Env = env()): SubscriptionVerdict {
  const verdict = interpretSubscription(sub, e);
  if (!verdict.ok) return verdict;
  const f = verdict.facts;
  if (f.owner !== uid) return refuse(403, "WRONG_ACCOUNT", "That subscription belongs to a different Zeros account.");
  if (f.status === "APPROVAL_PENDING" || f.status === "APPROVED") return refuse(409, "NOT_APPROVED", "The subscription was not approved on PayPal, so nothing was charged. Start again to finish the purchase.");
  if (f.status !== "ACTIVE") return refuse(402, "NOT_ACTIVE", "PayPal did not activate that subscription, and you were not charged.");
  if (!f.paidThrough) return refuse(409, "PENDING", "PayPal is still taking your first payment. Your plan unlocks as soon as it clears; check again in a moment.");
  return verdict;
}
