/**
 * The browser's view of the plan: who is signed in, what they have (a monthly plan or unlimited promo access), today's usage,
 * the monthly purchase and the promo code. Everything is kept per account: when the signed-in person changes, nothing from the
 * previous account is shown or reused.
 */
import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { authHeaders, setAuthHeaderProvider } from "@/lib/auth-token";

export type PlanId = "bronze" | "gold";
export type PlanOffer = { id: PlanId; label: string; priceUsd: number; interval: "month"; dailyRequests: number; tagline: string; features: string[] };
export type SubscriptionInfo = { status: string; cancelling: boolean; renewsAt: string | null; endsAt: string | null };
export type BillingStatus = {
  signedIn: boolean;
  email: string | null;
  plan: PlanId | null;
  planLabel: string | null;
  /** Free, unlimited access from a promo code. */
  unlimited: boolean;
  dailyRequests: number;
  usedRequests: number;
  remainingRequests: number;
  resetsAt: string | null;
  complexAllowed: boolean;
  connectorsAvailable: boolean;
  paypalConfigured: boolean;
  subscription: SubscriptionInfo | null;
  plans: PlanOffer[];
};

/** Can this person use Zeros right now? A plan or a promo redemption, nothing else. */
export const hasAccess = (status: BillingStatus | null | undefined): boolean => !!status && (status.unlimited || !!status.plan);

type Listener = () => void;
const listeners = new Set<Listener>();
type Cached = { uid: string | null; status: BillingStatus | null; error: string | null; at: number };
let cached: Cached | null = null;
let inflight: Promise<void> | null = null;
const FRESH_MS = 30_000;

const currentUid = (): string | null => firebaseAuth.currentUser?.uid ?? null;

/** The signed-in person's token. Waits for Firebase to restore the session first, so a fresh page load never sends a request as a stranger. */
async function firebaseHeaders(): Promise<Record<string, string>> {
  await firebaseAuth.authStateReady();
  const user = firebaseAuth.currentUser;
  return user ? { Authorization: `Bearer ${await user.getIdToken(false)}` } : {};
}
if (typeof window !== "undefined") setAuthHeaderProvider(firebaseHeaders);

function emit(): void {
  listeners.forEach((listener) => listener());
}

async function load(): Promise<void> {
  await firebaseAuth.authStateReady().catch(() => undefined);
  const uid = currentUid();
  const res = await fetch("/api/billing/status", { headers: await authHeaders() }).catch(() => null);
  /* the person changed while this was loading: whatever came back belongs to someone else, so it is dropped */
  if (uid !== currentUid()) return;
  if (!res) {
    cached = { uid, status: null, error: "ZerosX2.0 could not be reached. Check your connection.", at: Date.now() };
  } else {
    const body = (await res.json().catch(() => null)) as (BillingStatus & { error?: string }) | null;
    cached = res.ok && body ? { uid, status: body, error: null, at: Date.now() } : { uid, status: null, error: body?.error ?? `Billing status unavailable (HTTP ${res.status}).`, at: Date.now() };
  }
  emit();
}

/** Loads the status once, shares it between components, and refreshes it when it is stale, invalidated or someone else's. */
export function refreshBilling(force = false): Promise<void> {
  const mine = cached && cached.uid === currentUid();
  if (!force && mine && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve();
  if (!inflight) inflight = load().finally(() => { inflight = null; });
  return inflight;
}

/** Forgets everything about the previous account. Called whenever the signed-in person changes. */
function resetForNewAccount(): void {
  cached = null;
  inflight = null;
  forgetSubscription();
  emit();
  window.dispatchEvent(new Event("zeros-account-changed"));
}

if (typeof window !== "undefined") {
  let last: string | null | undefined;
  onAuthStateChanged(firebaseAuth, (user) => {
    const uid = user?.uid ?? null;
    if (last !== undefined && uid !== last) resetForNewAccount();
    last = uid;
  });
}

export function useBillingStatus(): { status: BillingStatus | null; error: string | null; loading: boolean; refresh: () => Promise<void> } {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    void refreshBilling();
    const onUsage = () => void refreshBilling(true);
    window.addEventListener("zeros-usage-changed", onUsage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("zeros-usage-changed", onUsage);
    };
  }, []);
  const mine = cached && cached.uid === currentUid() ? cached : null;
  return {
    status: mine?.status ?? null,
    error: mine?.error ?? null,
    loading: !mine,
    refresh: () => refreshBilling(true),
  };
}

/* ------------------------------------------------------------------ the monthly purchase */
const PENDING_KEY = "zeros-checkout-subscription";
const CHECKOUT_PARAMS = ["checkout", "subscription_id", "ba_token", "token", "PayerID"];

function rememberSubscription(id: string | undefined): void {
  try { if (id) window.sessionStorage.setItem(PENDING_KEY, id); } catch { /* private mode: the link PayPal returns to still carries the id */ }
}
function forgetSubscription(): void {
  try { window.sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing to forget */ }
}
function pendingSubscription(): string {
  try { return window.sessionStorage.getItem(PENDING_KEY) ?? ""; } catch { return ""; }
}

/** Opens PayPal for one monthly plan. The person approves there and PayPal sends them straight back to the chat. */
export async function startCheckout(plan: PlanId): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ plan }),
  }).catch(() => null);
  if (!res) return { ok: false, message: "ZerosX2.0 could not be reached. Check your connection and try again." };
  const body = (await res.json().catch(() => null)) as { error?: string; subscriptionId?: string; approveUrl?: string } | null;
  if (!res.ok || !body?.approveUrl) return { ok: false, message: body?.error ?? "The checkout could not be started. Please try again." };
  rememberSubscription(body.subscriptionId);
  window.location.assign(body.approveUrl);
  return { ok: true };
}

export type CheckoutResult = { ok: true; planLabel: string } | { ok: false; message: string; retry: boolean };

/** Finishes the purchase after PayPal: the server checks the subscription and its first payment with PayPal, then unlocks the plan. Safe to repeat. */
export async function completeCheckout(subscriptionId: string): Promise<CheckoutResult> {
  const res = await fetch("/api/billing/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ subscriptionId }),
  }).catch(() => null);
  if (!res) return { ok: false, retry: true, message: "ZerosX2.0 could not be reached. Check your connection; your payment is safe and you will not be charged twice." };
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string; planLabel?: string } | null;
  if (!res.ok) return { ok: false, retry: res.status >= 500 || body?.code === "PENDING", message: body?.error ?? "The payment could not be completed. Please try again." };
  forgetSubscription();
  await refreshBilling(true);
  return { ok: true, planLabel: body?.planLabel ?? "Your" };
}

export type CheckoutReturn = { kind: "return"; subscriptionId: string } | { kind: "cancel" } | null;

/** Recognises the address PayPal sends the person back to. */
export function readCheckoutReturn(search: string): CheckoutReturn {
  const q = new URLSearchParams(search);
  const flag = q.get("checkout");
  if (flag === "cancel") return { kind: "cancel" };
  if (flag !== "return") return null;
  const subscriptionId = (q.get("subscription_id") ?? "").trim() || pendingSubscription();
  return subscriptionId ? { kind: "return", subscriptionId } : null;
}

/** Removes PayPal's parameters from the address bar, so a refresh never repeats the purchase step. */
export function clearCheckoutParams(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of CHECKOUT_PARAMS) url.searchParams.delete(key);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch { /* the address bar keeps its parameters: harmless */ }
}

/* ------------------------------------------------------------------ cancelling and the promo code */
export type CancelResult = { ok: true; endsAt: string | null } | { ok: false; message: string };

/** Stops the monthly payments. The month that was paid for stays usable. */
export async function cancelSubscription(): Promise<CancelResult> {
  const res = await fetch("/api/billing/cancel", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: "{}" }).catch(() => null);
  if (!res) return { ok: false, message: "ZerosX2.0 could not be reached. Check your connection and try again." };
  const body = (await res.json().catch(() => null)) as { error?: string; endsAt?: string | null } | null;
  if (!res.ok) return { ok: false, message: body?.error ?? "The subscription could not be cancelled. Please try again." };
  await refreshBilling(true);
  return { ok: true, endsAt: body?.endsAt ?? null };
}

export type PromoResult = { ok: true } | { ok: false; message: string };

/** Sends the typed promo code to the server, which checks it. A right code unlocks free, unlimited access for this account. */
export async function redeemPromoCode(code: string): Promise<PromoResult> {
  const res = await fetch("/api/billing/promo", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ code }) }).catch(() => null);
  if (!res) return { ok: false, message: "ZerosX2.0 could not be reached. Check your connection and try again." };
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) return { ok: false, message: body?.error ?? "That code couldn't be checked. Please try again." };
  await refreshBilling(true);
  return { ok: true };
}

/** "November 19, 2026" in the person's own language and time zone. */
export function formatDate(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(new Date(t)) : "";
}
