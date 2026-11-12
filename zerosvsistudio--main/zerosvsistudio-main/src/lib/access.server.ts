/**
 * The one front door for everything that costs money. A request gets through only if the caller is signed in AND holds either an
 * active monthly plan or a valid promo redemption. Then each call is charged against the plan's 24-hour allowance
 * (Bronze 100, Gold 500); promo access is unlimited and is never charged.
 *
 * No route that talks to a model, a voice, an image engine or an app may skip this.
 */
import { authenticate } from "./firebase-user.server";
import { BillingConfigError, PLANS, chargeUsage, readBilling, unitsFor, type BillingState } from "./billing.server";
import { refreshIfDue } from "./subscriptions.server";
import type { PlanId } from "./paypal.server";

export type Access = {
  uid: string;
  email: string | null;
  /** The paid plan (null for promo access). */
  plan: PlanId | null;
  /** Free, unlimited access from a promo code. */
  unlimited: boolean;
  /** Requests per 24 hours (Infinity when unlimited). */
  limit: number;
  state: BillingState;
};

export const PLAN_REQUIRED_MESSAGE = "Choose a plan to use ZerosX2.0: Bronze ($25 a month) or Gold ($50 a month), or enter a promo code.";

/** A safe answer for a billing failure: the real reason goes to the server log, never to the person. */
export function billingFailure(err: unknown): Response {
  console.error("[Zeros] Billing is unavailable:", err);
  return Response.json({ error: "Your account is temporarily unavailable. Please try again soon." }, { status: err instanceof BillingConfigError ? 503 : 502 });
}

export type AccessResult = { ok: true; access: Access } | { ok: false; response: Response };

/** Signed in, and entitled by a plan or a promo. Anyone else gets 401 or 402 and nothing runs. */
export async function requireAccess(request: Request): Promise<AccessResult> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth;
  const { uid, email } = auth.user;
  let state: BillingState;
  try {
    state = await readBilling(uid);
    if (await refreshIfDue(uid, state)) state = await readBilling(uid);
  } catch (err) {
    return { ok: false, response: billingFailure(err) };
  }
  if (!state.unlimited && !state.plan) return { ok: false, response: Response.json({ error: PLAN_REQUIRED_MESSAGE, code: "PLAN_REQUIRED" }, { status: 402 }) };
  const limit = state.unlimited ? Infinity : PLANS[state.plan!].dailyRequests;
  return { ok: true, access: { uid, email, plan: state.unlimited ? null : state.plan, unlimited: state.unlimited, limit, state } };
}

export type Charge = { ok: true; usage: string; refund: () => Promise<void> } | { ok: false; response: Response };

/** Takes `weight` requests from the 24-hour allowance. The returned `refund` gives them back when the work could not be done. */
export async function charge(access: Access, weight: number): Promise<Charge> {
  if (access.unlimited) return { ok: true, usage: "unlimited", refund: async () => undefined };
  const units = unitsFor(weight);
  const label = access.plan ? PLANS[access.plan].label : "";
  let result: Awaited<ReturnType<typeof chargeUsage>>;
  try {
    result = await chargeUsage(access.uid, units, access.limit);
  } catch (err) {
    console.error("[Zeros] Usage could not be recorded:", err);
    return { ok: false, response: Response.json({ error: "Usage could not be recorded. Try again." }, { status: 503 }) };
  }
  if (!result.allowed) {
    return {
      ok: false,
      response: Response.json(
        { error: `Daily limit reached: ${access.limit} requests every 24 hours on the ${label} plan. Your allowance resets ${new Date(result.state.resetsAt).toUTCString()}.`, resetsAt: result.state.resetsAt },
        { status: 429 },
      ),
    };
  }
  return {
    ok: true,
    usage: `${result.state.usedRequests}/${access.limit}`,
    refund: async () => { await chargeUsage(access.uid, -units, access.limit).catch(() => undefined); },
  };
}
