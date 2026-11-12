/** Server-side access to the Zeros tables (service key). Used for permissions, plans and usage. */
type Env = Record<string, string | undefined>;
export class AdminStoreError extends Error {}

export async function adminRest(e: Env, f: typeof fetch, path: string, init: RequestInit = {}): Promise<Response> {
  const url = e["SUPABASE_URL"] ?? e["VITE_SUPABASE_URL"] ?? "";
  const key = e["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new AdminStoreError("Storage is not configured on the server: add SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL).");
  return f(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(10000),
  });
}
