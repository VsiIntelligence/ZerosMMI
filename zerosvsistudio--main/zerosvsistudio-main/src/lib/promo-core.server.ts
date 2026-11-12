/**
 * The promo code, server side only. PROMO_CODE is a secret environment variable: it is never sent to the browser. A person who
 * types the right value gets free, unlimited access on their own account.
 *
 *  - The typed value is compared in constant time (both sides are hashed first), so response timing reveals nothing.
 *  - Redeeming stores a short fingerprint of the code, never the code. Access is honoured only while that fingerprint still
 *    matches the current PROMO_CODE, so changing or removing the variable ends every redemption made with the old code.
 */
type Env = Record<string, string | undefined>;

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What was typed, tidied: Unicode-normalised, invisible characters removed, trimmed, and capped so nobody posts a megabyte. */
export function cleanCodeInput(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim().slice(0, 200);
}

/** The configured promo code (tidied the same way as the typed one), or "" when the feature is switched off. */
export function configuredPromoCode(e: Env = typeof process !== "undefined" ? (process.env as Env) : {}): string {
  return cleanCodeInput(e["PROMO_CODE"] ?? "");
}

/** A fingerprint of a code: enough to notice that the code changed, useless for recovering it. */
export async function promoTag(code: string): Promise<string> {
  return hex(await sha256(`zeros-promo:v1:${code}`)).slice(0, 32);
}

/** Constant-time equality for two codes of any length. */
export async function codesMatch(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(`compare:${a}`), sha256(`compare:${b}`)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** A short, stable, non-reversible label for an IP address, used only to rate-limit guessing. */
export async function bucketForIp(ip: string): Promise<string> {
  return `ip:${hex(await sha256(`zeros-ip:${ip}`)).slice(0, 24)}`;
}
