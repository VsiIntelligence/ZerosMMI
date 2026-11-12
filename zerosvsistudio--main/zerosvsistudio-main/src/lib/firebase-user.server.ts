/**
 * Who is calling? Every paid route identifies the person from their Firebase ID token. The token is checked by Google's own
 * identity service (accounts:lookup), so it cannot be forged, and a verified answer is cached for five minutes.
 */
/** The public web API key that ships in the app bundle (it is not a secret). FIREBASE_WEB_API_KEY overrides it when set. */
const PUBLIC_WEB_API_KEY = "AIzaSyCehxkuBZ-PAgAOuI22jZ6YbG5AeueT-3c";
const TTL_MS = 5 * 60 * 1000;

export type Identity = { uid: string; email: string | null };
type Entry = { at: number; identity: Identity | null };
const cache = new Map<string, Entry>();

export function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1]!.trim() : null;
}

export async function verifyFirebaseToken(
  token: string,
  opts: { fetch?: typeof fetch; now?: number; apiKey?: string } = {},
): Promise<Identity | null> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < TTL_MS) return hit.identity;
  const apiKey = opts.apiKey ?? ((typeof process !== "undefined" && process.env?.["FIREBASE_WEB_API_KEY"]) || PUBLIC_WEB_API_KEY);
  const res = await (opts.fetch ?? fetch)(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(8000) },
  ).catch(() => null);
  let identity: Identity | null = null;
  if (res?.ok) {
    const json = (await res.json().catch(() => null)) as { users?: { localId?: string; email?: string }[] } | null;
    const user = json?.users?.[0];
    if (user?.localId) identity = { uid: user.localId, email: user.email ?? null };
  }
  if (identity || (res && res.status === 400)) {
    if (cache.size > 500) cache.clear();
    cache.set(token, { at: now, identity });
  }
  return identity;
}

/** Resolves the caller, or a ready-made error response (401) to return as is. */
export async function authenticate(
  request: Request,
  opts: { fetch?: typeof fetch; now?: number; apiKey?: string } = {},
): Promise<{ ok: true; user: Identity } | { ok: false; response: Response }> {
  const token = bearerToken(request);
  if (!token) return { ok: false, response: Response.json({ error: "Sign in to use ZerosX2.0." }, { status: 401 }) };
  const user = await verifyFirebaseToken(token, opts);
  if (!user) return { ok: false, response: Response.json({ error: "Your sign-in expired. Refresh the page and sign in again." }, { status: 401 }) };
  return { ok: true, user };
}

export function clearIdentityCache(): void { cache.clear(); }
