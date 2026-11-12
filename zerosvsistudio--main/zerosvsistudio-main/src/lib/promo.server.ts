/**
 * Redeeming the promo code. The person must be signed in. Wrong guesses are counted per account and per network address, and
 * after a few misses that account (or address) is locked out for a while, longer each time. A right code stores a fingerprint of
 * the code against the account (see promo-core.server.ts); the code itself is never stored, logged or returned.
 */
import { adminRest } from "./supabase-admin.server";
import { grantPromo } from "./billing.server";
import { bucketForIp, cleanCodeInput, codesMatch, configuredPromoCode, promoTag } from "./promo-core.server";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** Misses allowed per account, and per network address, before a lock-out starts. */
export const USER_LIMIT = 5;
export const IP_LIMIT = 20;
const DECAY_MS = 24 * 60 * 60 * 1000;

/** How long to lock out after `failures` misses: nothing below the limit, then 15 minutes, doubling each further miss, at most a day. */
export function lockSeconds(failures: number, limit: number): number {
  if (failures < limit) return 0;
  return Math.min(15 * 60 * 2 ** Math.min(failures - limit, 7), 24 * 60 * 60);
}

type Attempt = { failures: number; locked_until: string | null; updated_at: string | null };
const NONE: Attempt = { failures: 0, locked_until: null, updated_at: null };
const ms = (iso: string | null): number => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : 0; };

async function readAttempt(bucket: string, e: Env, f: Fetch): Promise<Attempt> {
  const res = await adminRest(e, f, `zeros_promo_attempts?bucket=eq.${encodeURIComponent(bucket)}&select=failures,locked_until,updated_at`);
  if (!res.ok) throw new Error(`Reading promo attempts failed (HTTP ${res.status}).`);
  return ((await res.json()) as Attempt[])[0] ?? NONE;
}

async function writeAttempt(bucket: string, failures: number, lockedUntil: number | null, now: number, e: Env, f: Fetch): Promise<void> {
  await adminRest(e, f, "zeros_promo_attempts?on_conflict=bucket", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ bucket, failures, locked_until: lockedUntil ? new Date(lockedUntil).toISOString() : null, updated_at: new Date(now).toISOString() }),
  });
}

async function clearAttempt(bucket: string, e: Env, f: Fetch): Promise<void> {
  await adminRest(e, f, `zeros_promo_attempts?bucket=eq.${encodeURIComponent(bucket)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => undefined);
}

export type RedeemResult = { ok: true } | { ok: false; status: 400 | 429 | 503; message: string; retryAfterSec?: number };

export async function redeemPromo(
  p: { uid: string; ip: string; input: unknown },
  opts: { env?: Env; fetch?: Fetch; now?: number } = {},
): Promise<RedeemResult> {
  const e = opts.env ?? (process.env as Env), f = opts.fetch ?? fetch, now = opts.now ?? Date.now();
  const typed = cleanCodeInput(p.input);
  if (!typed) return { ok: false, status: 400, message: "Enter your code." };

  const userBucket = `u:${p.uid}`;
  const ipBucket = await bucketForIp(p.ip || "unknown");
  let user = NONE, ip = NONE;
  try {
    [user, ip] = await Promise.all([readAttempt(userBucket, e, f), readAttempt(ipBucket, e, f)]);
  } catch (err) {
    console.error("[Zeros] Promo attempts could not be read:", err);
    return { ok: false, status: 503, message: "Codes can't be checked right now. Please try again soon." };
  }
  const fresh = (a: Attempt): Attempt => (now - ms(a.updated_at) > DECAY_MS && ms(a.locked_until) <= now ? NONE : a);
  user = fresh(user); ip = fresh(ip);

  const lockedUntil = Math.max(ms(user.locked_until), ms(ip.locked_until));
  if (lockedUntil > now) return { ok: false, status: 429, retryAfterSec: Math.ceil((lockedUntil - now) / 1000), message: "Too many tries. Wait a while, then try again." };

  /* The comparison always runs, even when no code is configured, so the response time never reveals whether the feature is on. */
  const configured = configuredPromoCode(e);
  const same = await codesMatch(typed, configured || "\u0000not-configured");
  if (configured && same) {
    try {
      await grantPromo(p.uid, await promoTag(configured), { env: e, fetch: f });
    } catch (err) {
      console.error("[Zeros] A promo redemption could not be saved:", err);
      return { ok: false, status: 503, message: "Your code is right, but it could not be saved yet. Please try again." };
    }
    await clearAttempt(userBucket, e, f);
    return { ok: true };
  }

  const uf = user.failures + 1, wf = ip.failures + 1;
  const lock = (failures: number, limit: number): number | null => { const s = lockSeconds(failures, limit); return s ? now + s * 1000 : null; };
  await Promise.all([writeAttempt(userBucket, uf, lock(uf, USER_LIMIT), now, e, f), writeAttempt(ipBucket, wf, lock(wf, IP_LIMIT), now, e, f)]).catch((err) => console.error("[Zeros] Promo attempts could not be recorded:", err));
  return { ok: false, status: 400, message: "That code isn't valid." };
}
