/**
 * A pretend backend for the tests: a tiny PostgREST-style database, a PayPal that can approve / renew / cancel subscriptions,
 * Firebase sign-in, and two text engines (plus image and voice). No network, no keys, and a clock the tests can move.
 *
 * Every name here is invented: the real deployment's names live only in server-side secrets.
 */
import { applyUsage } from "../../src/lib/billing.server.ts";

type Row = Record<string, any>;
export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | null;

export const TEST_ENV: Record<string, string> = {
  ZEROS_A_URL: "https://engine-a.test/v1",
  ZEROS_A_KEYS: "key-a1,key-a2",
  ZEROS_A_KEY_HEADER: "x-test-key",
  ZEROS_A_MODELS: "a-strong,a-mid",
  ZEROS_A_FAST_MODELS: "a-fast,a-mid",
  ZEROS_A_IMAGE_MODELS: "a-img",
  ZEROS_A_VOICE_MODELS: "a-voice",
  ZEROS_A_VOICE_MALE: "voice-m",
  ZEROS_A_VOICE_FEMALE: "voice-f",
  ZEROS_B_URL: "https://engine-b.test/v1",
  ZEROS_B_KEYS: "key-b1",
  ZEROS_B_MODELS: "b-strong",
  ZEROS_B_FAST_MODELS: "b-fast",
  ZEROS_HIDE_TERMS: "Alphacorp,Betaworks AI",
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  PAYPAL_CLIENT_ID: "pp-id",
  PAYPAL_CLIENT_SECRET: "pp-secret",
  PAYPAL_PLAN_ID_BRONZE: "P-BRONZE",
  PAYPAL_PLAN_ID_GOLD: "P-GOLD",
  PAYPAL_WEBHOOK_ID: "WH-TEST",
  PROMO_CODE: "Open-Sesame-4821",
  PUBLIC_APP_URL: "https://zeros.test",
};

export const PEOPLE: Record<string, { uid: string; email: string }> = {
  "tok-ann": { uid: "uid-ann", email: "ann@example.com" },
  "tok-bob": { uid: "uid-bob", email: "bob@example.com" },
  "tok-cy": { uid: "uid-cy", email: "cy@example.com" },
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sse = (chunks: string[]) => new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const aStream = (text: string) =>
  sse([
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }] })}\n\n`,
  ]);
const bStream = (text: string) => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`, "data: [DONE]\n\n"]);

const iso = (ms: number) => new Date(ms).toISOString();

export class World {
  /** The clock. Date.now() returns this while the world is installed. */
  now = Date.parse("2026-10-19T12:00:00Z");
  tables: Record<string, Map<string, Row>> = {
    zeros_billing: new Map(), zeros_usage: new Map(), zeros_promo: new Map(), zeros_promo_attempts: new Map(),
    zeros_app_permissions: new Map(),
  };
  /** Which tables, by name, to fail with HTTP 500 (to test fail-closed behaviour). */
  brokenTables = new Set<string>();

  paypal = {
    plans: new Map<string, Row>(),
    subs: new Map<string, Row>(),
    sales: new Map<string, Row>(),
    counter: 0,
    webhookValid: true,
    down: false,
    cancelled: [] as string[],
  };

  engines = { a: "ok" as "ok" | "down", b: "ok" as "ok" | "down", jsonReply: {} as unknown, textFor: (engine: string, model: string) => `${engine}:${model} says hi` };

  /** Every request that left the app, in order. */
  log: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  extra: Handler[] = [];

  constructor() {
    this.paypal.plans.set("P-BRONZE", this.planBody(25));
    this.paypal.plans.set("P-GOLD", this.planBody(50));
  }

  planBody(price: number, over: Row = {}): Row {
    return {
      id: "P", status: "ACTIVE",
      billing_cycles: [{ tenure_type: "REGULAR", sequence: 1, total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { value: price.toFixed(2), currency_code: "USD" } } }],
      ...over,
    };
  }

  /* ------------------------------------------------------------------ helpers the tests call */
  advanceDays(days: number): void { this.now += days * 86_400_000; }
  advanceMinutes(min: number): void { this.now += min * 60_000; }

  /** The person approved the subscription on PayPal's page; `paid` means the first payment cleared. */
  approve(subId: string, o: { paid?: boolean; amount?: string; currency?: string } = {}): void {
    const s = this.paypal.subs.get(subId)!;
    s.status = "ACTIVE";
    s.subscriber = { email_address: "payer@example.com" };
    if (o.paid !== false) {
      const price = s.plan_id === "P-GOLD" ? "50.00" : "25.00";
      s.billing_info = { last_payment: { amount: { value: o.amount ?? price, currency_code: o.currency ?? "USD" }, time: iso(this.now) }, next_billing_time: iso(this.now + 30 * 86_400_000), failed_payments_count: 0 };
    }
  }
  /** PayPal took the next monthly payment. */
  renew(subId: string): void {
    const s = this.paypal.subs.get(subId)!;
    const price = s.plan_id === "P-GOLD" ? "50.00" : "25.00";
    s.billing_info = { last_payment: { amount: { value: price, currency_code: "USD" }, time: iso(this.now) }, next_billing_time: iso(this.now + 30 * 86_400_000), failed_payments_count: 0 };
  }

  billingRow(uid: string): Row | undefined { return this.tables["zeros_billing"]!.get(uid); }
  usageRow(uid: string): Row | undefined { return this.tables["zeros_usage"]!.get(uid); }
  calls(match: string | RegExp): number { return this.log.filter((l) => (typeof match === "string" ? l.url.includes(match) : match.test(l.url))).length; }

  /* ------------------------------------------------------------------ the pretend network */
  readonly fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : "";
    const headers: Record<string, string> = {};
    new Headers((init.headers as HeadersInit) ?? {}).forEach((v, k) => { headers[k] = v; });
    this.log.push({ url: url.href, method, body, headers });
    for (const h of this.extra) { const r = h(url, init); if (r) return r; }
    if (url.hostname === "identitytoolkit.googleapis.com") return this.identity(body);
    if (url.hostname === "db.test") return this.database(url, method, body);
    if (url.hostname.endsWith("paypal.com")) return this.paypalApi(url, method, body, headers);
    if (url.hostname === "engine-a.test") return this.engineA(url, body);
    if (url.hostname === "engine-b.test") return this.engineB(body);
    throw new Error(`unexpected network call to ${url.href}`);
  }) as typeof fetch;

  private identity(body: string): Response {
    const p = PEOPLE[JSON.parse(body || "{}").idToken as string];
    return p ? json({ users: [{ localId: p.uid, email: p.email }] }) : json({ error: { message: "INVALID_ID_TOKEN" } }, 400);
  }

  private filter(table: string, url: URL): Row[] {
    let list = [...this.tables[table]!.values()];
    for (const [k, v] of url.searchParams) {
      if (["select", "on_conflict", "order", "limit"].includes(k)) continue;
      const m = /^eq\.(.*)$/.exec(v);
      if (m) list = list.filter((r) => String(r[k]) === m[1]);
    }
    return list;
  }

  private database(url: URL, method: string, body: string): Response {
    const path = url.pathname.replace("/rest/v1/", "");
    if (path === "rpc/zeros_consume_usage") {
      const p = JSON.parse(body) as { p_user: string; p_units: number; p_limit: number; p_now: string };
      const t = this.tables["zeros_usage"]!;
      const row = t.get(p.p_user);
      const out = applyUsage(row ? { window_start: row.window_start, used_units: row.used_units } : null, p.p_units, p.p_limit, Date.parse(p.p_now));
      if (out.allowed && out.next) t.set(p.p_user, { user_id: p.p_user, ...out.next });
      return json({ allowed: out.allowed, used_units: out.state.usedUnits, window_start: new Date(out.state.windowStart).toISOString() });
    }
    const table = path;
    if (this.brokenTables.has(table)) return json({ message: "boom" }, 500);
    const key = table === "zeros_promo_attempts" ? "bucket" : "user_id";
    const store = this.tables[table];
    if (!store) return json({ message: `unknown table ${table}` }, 404);
    if (method === "GET") return json(this.filter(table, url));
    if (method === "POST") {
      const row = JSON.parse(body) as Row;
      const conflict = url.searchParams.get("on_conflict") ?? key;
      const id = String(row[conflict]);
      if (table === "zeros_billing" && row["subscription_id"]) {
        for (const [k, r] of store) if (k !== id && r["subscription_id"] === row["subscription_id"]) return json({ code: "23505" }, 409);
      }
      store.set(id, { ...(store.get(id) ?? {}), ...row });
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      for (const r of this.filter(table, url)) Object.assign(r, JSON.parse(body));
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      for (const r of this.filter(table, url)) store.delete(String(r[key]));
      return new Response(null, { status: 204 });
    }
    return json({}, 405);
  }

  private paypalApi(url: URL, method: string, body: string, headers: Record<string, string>): Response {
    const pp = this.paypal;
    if (pp.down) return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    const p = url.pathname;
    if (p === "/v1/oauth2/token") return json({ access_token: "pp-token", expires_in: 3600 });
    if (!/^Bearer /.test(headers["authorization"] ?? "")) return json({ name: "AUTHENTICATION_FAILURE" }, 401);
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/billing\/plans\/([^/]+)$/.exec(p))) { const plan = pp.plans.get(m[1]!); return plan ? json({ ...plan, id: m[1] }) : json({ name: "RESOURCE_NOT_FOUND" }, 404); }
    if (p === "/v1/billing/subscriptions" && method === "POST") {
      const req = JSON.parse(body) as { plan_id: string; custom_id: string; application_context: Row };
      const id = `I-TEST${String(++pp.counter).padStart(6, "0")}`;
      pp.subs.set(id, { id, status: "APPROVAL_PENDING", plan_id: req.plan_id, custom_id: req.custom_id, ctx: req.application_context, links: [{ rel: "approve", href: `https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }] });
      return json(pp.subs.get(id), 201);
    }
    if ((m = /^\/v1\/billing\/subscriptions\/([^/]+)\/cancel$/.exec(p))) {
      const s = pp.subs.get(m[1]!);
      if (!s) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
      if (s.status === "CANCELLED") return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] }, 422);
      s.status = "CANCELLED"; pp.cancelled.push(m[1]!);
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/v1\/billing\/subscriptions\/([^/]+)$/.exec(p))) { const s = pp.subs.get(m[1]!); return s ? json(s) : json({ name: "RESOURCE_NOT_FOUND" }, 404); }
    if (p === "/v1/notifications/verify-webhook-signature") return json({ verification_status: pp.webhookValid ? "SUCCESS" : "FAILURE" });
    if ((m = /^\/v1\/payments\/sale\/([^/]+)$/.exec(p))) { const s = pp.sales.get(m[1]!); return s ? json(s) : json({ name: "RESOURCE_NOT_FOUND" }, 404); }
    return json({ name: "NOT_FOUND" }, 404);
  }

  private engineA(url: URL, body: string): Response {
    const model = /\/models\/([^:]+):/.exec(url.pathname)?.[1] ?? "?";
    if (this.engines.a === "down") return json({ error: "down" }, 500);
    if (url.pathname.endsWith(":streamGenerateContent")) return aStream(this.engines.textFor("a", model));
    const req = JSON.parse(body || "{}") as { generationConfig?: { responseModalities?: string[]; responseMimeType?: string } };
    const mod = req.generationConfig?.responseModalities?.[0];
    if (mod === "IMAGE") return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo".padEnd(200, "A") } }] } }] });
    if (mod === "AUDIO") return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "A".repeat(2400) } }] } }] });
    const text = req.generationConfig?.responseMimeType ? JSON.stringify(this.engines.jsonReply) : this.engines.textFor("a", model);
    return json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
  }

  private engineB(body: string): Response {
    if (this.engines.b === "down") return json({ error: "down" }, 500);
    const req = JSON.parse(body) as { model: string; stream?: boolean };
    const text = this.engines.textFor("b", req.model);
    return req.stream ? bStream(text) : json({ choices: [{ message: { content: text } }] });
  }

  /* ------------------------------------------------------------------ install / uninstall */
  private realFetch = globalThis.fetch;
  private realNow = Date.now;
  private savedEnv: Record<string, string | undefined> = {};

  install(): this {
    for (const [k, v] of Object.entries(TEST_ENV)) { this.savedEnv[k] = process.env[k]; process.env[k] = v; }
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname;
      if (host === "127.0.0.1" || host === "localhost") return this.realFetch(input as never, init);
      return this.fetch(input, init);
    }) as typeof fetch;
    Date.now = () => this.now;
    return this;
  }
  uninstall(): void {
    globalThis.fetch = this.realFetch;
    Date.now = this.realNow;
    for (const [k, v] of Object.entries(this.savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A request a signed-in person would make. */
export function call(handler: (a: { request: Request }) => Promise<Response>, o: { token?: string; method?: string; body?: unknown; headers?: Record<string, string>; url?: string } = {}): Promise<Response> {
  const method = o.method ?? "POST";
  return handler({
    request: new Request(o.url ?? "https://zeros.test/api/x", {
      method,
      headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
      ...(method === "GET" ? {} : { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? {}) }),
    }),
  });
}

export async function readAll(res: Response): Promise<string> {
  return await res.text();
}

/** The text carried by a chat-style SSE reply. */
export function sseText(raw: string): string {
  let out = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { out += (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? ""; } catch { /* skip */ }
  }
  return out;
}
