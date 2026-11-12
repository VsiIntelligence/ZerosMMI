/** The public address of this app. People are sent back here after PayPal's page or an app's sign-in page. */
type Env = Record<string, string | undefined>;

export function appOrigin(request: Request, e: Env = typeof process !== "undefined" ? (process.env as Env) : {}): string {
  const configured = (e["PUBLIC_APP_URL"] ?? "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin;
    } catch { /* an invalid PUBLIC_APP_URL is ignored: the request's own address is used */ }
  }
  return new URL(request.url).origin;
}
