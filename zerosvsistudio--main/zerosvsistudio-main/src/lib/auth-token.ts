/**
 * The signed-in person's login token, for requests to ZerosX2.0's own server. This module imports nothing, so pure modules and
 * the test suite can use it. The browser registers the Firebase reader once, when billing-client loads (see that file).
 */
export type TokenHeaders = () => Promise<Record<string, string>>;

let reader: TokenHeaders | null = null;

export function setAuthHeaderProvider(fn: TokenHeaders): void {
  reader = fn;
}

/** `{ Authorization: "Bearer ..." }` for the signed-in person, or nothing (guests and the server side). Never throws. */
export async function authHeaders(): Promise<Record<string, string>> {
  if (!reader) return {};
  try {
    return await reader();
  } catch {
    return {};
  }
}
