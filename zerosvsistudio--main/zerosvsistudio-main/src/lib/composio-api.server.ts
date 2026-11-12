/**
 * Composio, per person. Every Zeros account is a Composio user (its user_id is the account's id). Connections, permissions and
 * actions all belong to that one user, so an action can never run through somebody else's connected account. Built on Composio's
 * v3 REST API; response fields are read defensively and every failure comes back as a readable message.
 *
 * What makes every app work the same way (GitHub included):
 *  - one connection per app is chosen deliberately (the NEWEST active one), never "whichever came last in a list";
 *  - actions are classified as reads or changes by their leading verb (GET_A_COMMIT is a read, CREATE_A_COMMIT a change);
 *  - a request is matched to actions with IDF-weighted, synonym-aware retrieval over the app's whole catalogue;
 *  - arguments are coerced to the action's own schema (the model says "5", the app wants 5) before they are sent;
 *  - big results are compacted so the answer sees real data instead of kilobytes of API links;
 *  - connecting, refreshing and running an action retry the way a careful person would, and always end in a readable message.
 */
type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export class ComposioError extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}

export type Category = { slug: string; name: string };
export type Toolkit = { slug: string; name: string; logo: string; description: string; categories: Category[] };
export type Connection = { id: string; toolkit: string; status: string; createdAt?: number };
export type ToolParameter = { name: string; type: string; description: string; required: boolean; enum?: string[]; itemType?: string };
export type ToolInfo = { name: string; description: string; toolkit: string; write: boolean; parameters: string[]; parameterDetails?: ToolParameter[]; allParameters?: string[] };

const DEFAULT_BASE = "https://backend.composio.dev/api/v3";
const SLUG_RE = /^[a-z0-9_-]{2,64}$/;
const CATALOG_TTL = 30 * 60 * 1000;
/** Apps people reach for first. They lead the directory, in this order, whatever order the catalogue arrives in. */
const FEATURED = ["gmail", "googlecalendar", "googledrive", "googlesheets", "googledocs", "slack", "notion", "github", "linear", "jira", "asana", "trello", "outlook", "microsoft_teams", "hubspot", "salesforce", "stripe", "airtable", "dropbox", "zoom", "discord", "figma", "shopify", "calendly", "canva", "youtube", "twitter", "linkedin", "reddit", "spotify"];
const TOOLS_TTL = 10 * 60 * 1000;
const MAX_PARAMS_KEPT = 24;

/** Verbs that only look at data. The FIRST verb in an action's name decides: GITHUB_GET_A_COMMIT reads, GITHUB_CREATE_A_COMMIT changes. */
const READ_VERBS = new Set(["get", "list", "fetch", "search", "find", "read", "retrieve", "check", "view", "describe", "count", "lookup", "look", "query", "show", "download", "preview", "inspect", "verify", "validate", "resolve", "calculate", "compare", "analyze", "analyse", "parse", "extract", "summarize", "summarise", "translate", "suggest", "recommend", "autocomplete", "browse", "scan", "poll", "test", "ping", "whoami", "me"]);
const WRITE_WORDS = new Set(["create", "send", "delete", "remove", "update", "edit", "post", "merge", "push", "commit", "comment", "reply", "upload", "archive", "close", "assign", "invite", "share", "move", "add", "set", "write", "insert", "cancel", "pay", "transfer", "publish", "deploy", "modify", "patch", "fork", "star", "unstar", "follow", "unfollow", "label", "approve", "reject", "book", "order", "buy", "sell", "execute", "run", "trigger", "start", "stop", "install", "enable", "disable", "revoke", "grant", "put", "replace", "rename", "clear", "reset", "sync", "import", "export", "mark", "schedule", "unsubscribe", "subscribe", "forward", "draft", "save", "attach", "detach", "block", "unblock", "ban", "kick", "mute", "unmute", "pin", "unpin", "like", "unlike", "react", "refund", "capture", "void", "charge", "reopen", "resolve_thread", "dismiss", "request", "restore", "trash", "untrash", "copy", "duplicate", "clone", "link", "unlink", "transition", "complete", "uncomplete", "snooze", "unsnooze", "leave", "join", "submit", "cancel_subscription", "rotate", "regenerate", "register", "unregister", "authorize", "deauthorize", "lock", "unlock", "batch_update", "append", "prepend", "swap", "tag", "untag", "bulk"]);
/** Verbs whose effect is hard to undo. Zeros only runs these when the person's own message asks for them. */
export const DESTRUCTIVE_VERBS = new Set(["delete", "remove", "revoke", "cancel", "refund", "void", "ban", "kick", "purge", "destroy", "erase", "wipe", "deauthorize", "unregister", "unsubscribe", "clear", "reset", "transfer", "pay", "charge", "merge", "deploy", "publish", "terminate", "drop", "truncate", "overwrite"]);

const STOP = new Set(["the", "and", "for", "with", "what", "show", "find", "please", "from", "about", "this", "that", "have", "you", "can", "tell", "want", "need", "some", "any", "all", "my", "me", "your", "our", "into", "onto", "then", "there", "here", "when", "where", "which", "who", "how", "one", "give", "get", "are", "was", "were", "has", "had", "does", "did", "would", "could", "should", "will", "just", "its", "their", "them", "they", "his", "her", "him", "she", "not", "but", "also", "very", "make", "name", "named", "called", "account", "connected", "connect", "using", "use", "via", "see", "look"]);
const toolCache = new Map<string, { at: number; tools: ToolInfo[] }>();

const defaultEnv = (): Env => (typeof process !== "undefined" ? (process.env as Env) : {});
/** Preferred deployment secret, with backward compatibility for existing installs. */
const composioApiKey = (e: Env): string => e["COMPOSIO_CONNECTOR_KEY"]?.trim() || e["COMPOSIO_API_KEY"]?.trim() || "";
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function composioApiConfigured(e: Env = defaultEnv()): boolean {
  return !!composioApiKey(e);
}

/** Any of the list shapes Composio uses: a bare array, { items } or { data }. */
function rows(json: unknown): Record<string, unknown>[] {
  const list = Array.isArray(json) ? json : Array.isArray(obj(json)["items"]) ? (obj(json)["items"] as unknown[]) : Array.isArray(obj(json)["data"]) ? (obj(json)["data"] as unknown[]) : [];
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

const tokensOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Is this action a change? The first verb in its name decides (GITHUB_GET_A_COMMIT reads; GITHUB_CREATE_A_COMMIT changes).
 * Pass the app's slug when you have it so an app that is itself named like a verb (Close, Make) is not mistaken for one.
 */
export function isWriteTool(slug: string, toolkit = ""): boolean {
  let tokens = tokensOf(slug);
  const prefix = tokensOf(toolkit);
  if (prefix.length && prefix.every((t, i) => tokens[i] === t)) tokens = tokens.slice(prefix.length);
  for (const t of tokens) {
    if (READ_VERBS.has(t)) return false;
    if (WRITE_WORDS.has(t)) return true;
  }
  return false;
}

/** The first verb of an action name (its intent), or "" when it has none. */
export function toolVerb(slug: string, toolkit = ""): string {
  let tokens = tokensOf(slug);
  const prefix = tokensOf(toolkit);
  if (prefix.length && prefix.every((t, i) => tokens[i] === t)) tokens = tokens.slice(prefix.length);
  return tokens.find((t) => READ_VERBS.has(t) || WRITE_WORDS.has(t)) ?? "";
}

const IRREVERSIBLE_WORDS = new Set(["delete", "remove", "revoke", "refund", "destroy", "purge", "erase", "wipe", "terminate", "cancel", "ban", "kick", "void", "payout", "unsubscribe", "deauthorize"]);
/** True when the action is hard to undo (delete, revoke, refund, merge, ...). A lookup never is. */
export function isDestructiveTool(slug: string, toolkit = ""): boolean {
  const verb = toolVerb(slug, toolkit);
  if (READ_VERBS.has(verb)) return false;
  if (DESTRUCTIVE_VERBS.has(verb)) return true;
  // CREATE_REFUND, SEND_PAYOUT ...: the first verb is gentle but the thing it does is not
  let tokens = tokensOf(slug);
  const prefix = tokensOf(toolkit);
  if (prefix.length && prefix.every((t, i) => tokens[i] === t)) tokens = tokens.slice(prefix.length);
  return tokens.some((t) => IRREVERSIBLE_WORDS.has(t));
}

/** Does an action belong to an app? (GITHUB_CREATE_ISSUE belongs to github.) */
export function toolBelongsTo(tool: string, toolkit: string): boolean {
  return tool.toUpperCase().startsWith(`${toolkit.toUpperCase().replace(/-/g, "_")}_`);
}

/* ------------------------------------------------------------------ HTTP */
/** A short, human line from Composio's error body (it nests the message under `error`). */
function describeApiError(status: number, text: string): string {
  let detail = "";
  try {
    const j = obj(JSON.parse(text));
    const e = obj(j["error"]);
    detail = str(e["message"]) || str(j["error"]) || str(j["message"]) || str(j["detail"]);
    const fix = str(e["suggested_fix"]) || str(j["suggested_fix"]);
    if (fix) detail = `${detail} ${fix}`.trim();
  } catch { detail = text.trim(); }
  return `Composio answered HTTP ${status}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 240)}` : ""}`;
}

type ApiInit = { method?: string; body?: unknown; timeoutMs?: number; retry?: boolean; version?: "3" | "3.1" };

/** Composio serves v3.1 as the current API and keeps v3 running; some endpoints (the raw proxy) are retired on v3 for most organizations. */
function baseFor(e: Env, version: "3" | "3.1"): string {
  const raw = (e["COMPOSIO_API_BASE"] || DEFAULT_BASE).replace(/\/$/, "");
  return raw.replace(/\/api\/v3(?:\.1)?$/, `/api/v${version}`);
}

async function api(e: Env, f: Fetch, path: string, init: ApiInit = {}): Promise<unknown> {
  const key = composioApiKey(e);
  if (!key) throw new ComposioError("Composio is not configured (COMPOSIO_CONNECTOR_KEY is missing).");
  const base = baseFor(e, init.version ?? "3");
  const method = init.method ?? "GET";
  // Reads and rate-limit answers are always safe to repeat; a change is repeated only when the service said it did nothing (429).
  const attempts = init.retry === false ? 1 : 3;
  let last: ComposioError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(attempt === 1 ? 350 : 1100);
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init.timeoutMs ?? 15000),
      });
    } catch (err) {
      last = new ComposioError(err instanceof Error && /timeout|abort/i.test(`${err.name} ${err.message}`) ? "Composio did not answer in time." : "Composio could not be reached.");
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (res.ok) {
      try { return text ? (JSON.parse(text) as unknown) : null; }
      catch { throw new ComposioError("Composio sent an unreadable answer.", res.status); }
    }
    last = new ComposioError(describeApiError(res.status, text), res.status);
    const transient = res.status === 429 || (res.status >= 500 && method === "GET");
    if (!transient) throw last;
  }
  throw last ?? new ComposioError("Composio could not be reached.");
}

/** Composio serves every app's logo from one address, so an app whose listing leaves it out still gets its own. */
export const logoFor = (slug: string): string => `https://logos.composio.dev/api/${slug}`;
export const titleCase = (slug: string): string => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const slugify = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const httpsUrl = (v: unknown): string => (typeof v === "string" && /^https:\/\/[^\s"'<>]+$/.test(v) ? v : "");

function parseCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return [];
  const out: Category[] = [];
  for (const c of raw) {
    const name = (typeof c === "string" ? c : str(obj(c)["name"] ?? obj(c)["slug"] ?? obj(c)["id"])).trim();
    const slug = slugify(typeof c === "string" ? c : str(obj(c)["slug"] ?? obj(c)["id"]) || name);
    if (name && slug && !out.some((x) => x.slug === slug)) out.push({ slug, name: name.charAt(0).toUpperCase() + name.slice(1) });
  }
  return out.slice(0, 6);
}

/** One catalogue row. Composio keeps the logo, description and categories under `meta`; older shapes keep them at the top. */
export function parseToolkit(r: Record<string, unknown>): Toolkit | null {
  const meta = obj(r["meta"]);
  const slug = str(r["slug"] ?? r["name"]).toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  return {
    slug,
    name: str(r["name"]).trim() || titleCase(slug),
    logo: httpsUrl(meta["logo"]) || httpsUrl(r["logo"]) || logoFor(slug),
    description: str(meta["description"] ?? r["description"]).replace(/\s+/g, " ").trim().slice(0, 220),
    categories: parseCategories(meta["categories"] ?? r["categories"]),
  };
}

type Variant = { limit: string; sort: string };
/** Tried in order on the first page, so a stricter API still answers. The one that works is used for every later page. */
const VARIANTS: Variant[] = [{ limit: "200", sort: "usage" }, { limit: "100", sort: "" }, { limit: "", sort: "" }];
const toolkitPath = (v: Variant, cursor: string): string => {
  const qs = new URLSearchParams();
  if (v.limit) qs.set("limit", v.limit);
  if (v.sort) qs.set("sort_by", v.sort);
  if (cursor) qs.set("cursor", cursor);
  const q = qs.toString();
  return `/toolkits${q ? `?${q}` : ""}`;
};

async function fetchCatalog(e: Env, f: Fetch): Promise<Toolkit[]> {
  const items: Toolkit[] = [], seen = new Set<string>();
  let variant: Variant | null = null, cursor = "";
  for (let page = 0; page < 12; page++) {
    let json: unknown = null;
    if (variant) json = await api(e, f, toolkitPath(variant, cursor));
    else {
      let last: unknown = null;
      for (const v of VARIANTS) {
        try { json = await api(e, f, toolkitPath(v, cursor)); variant = v; break; }
        catch (err) { last = err; if (!(err instanceof ComposioError) || !/HTTP (400|404|422)\b/.test(err.message)) throw err; }
      }
      if (!variant) throw last;
    }
    let fresh = 0;
    for (const row of rows(json)) {
      const t = parseToolkit(row);
      if (t && !seen.has(t.slug)) { seen.add(t.slug); items.push(t); fresh++; }
    }
    const next = str(obj(json)["next_cursor"] ?? obj(json)["nextCursor"]);
    if (!next || fresh === 0) break;
    cursor = next;
  }
  return items;
}

let catalogCache: { key: string; at: number; items: Toolkit[] } | null = null;
export function clearCatalogCache(): void { catalogCache = null; }

/** Every app Composio offers, most-used first. Kept for half an hour; if Composio is briefly unreachable the last copy is served. */
export async function listToolkits(opts: { env?: Env; fetch?: Fetch } = {}): Promise<Toolkit[]> {
  const e = opts.env ?? defaultEnv(), f = opts.fetch ?? fetch;
  const key = `${e["COMPOSIO_API_BASE"] ?? ""}|${composioApiKey(e).slice(-8)}`;
  if (catalogCache && catalogCache.key === key && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.items;
  try {
    const items = await fetchCatalog(e, f);
    catalogCache = { key, at: Date.now(), items };
    return items;
  } catch (err) {
    if (catalogCache && catalogCache.key === key) return catalogCache.items;
    throw err;
  }
}

/** The directory view: optional search words and one category. With neither, the well-known apps come first. */
export function filterCatalog(items: Toolkit[], opts: { q?: string; category?: string } = {}): Toolkit[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const category = (opts.category ?? "").trim().toLowerCase();
  const list = category ? items.filter((t) => t.categories.some((c) => c.slug === category)) : items;
  if (!q) {
    if (category) return list;
    const rank = (t: Toolkit): number => { const i = FEATURED.indexOf(t.slug); return i === -1 ? FEATURED.length : i; };
    return list.map((t, index) => ({ t, index })).sort((a, b) => rank(a.t) - rank(b.t) || a.index - b.index).map((x) => x.t);
  }
  const words = q.split(/\s+/).filter(Boolean);
  const scored: { t: Toolkit; score: number; index: number }[] = [];
  list.forEach((t, index) => {
    const name = t.name.toLowerCase(), slug = t.slug, text = `${name} ${slug} ${t.description.toLowerCase()}`;
    if (!words.every((w) => text.includes(w))) return;
    let score = name === q || slug === q ? 100 : name.startsWith(q) || slug.startsWith(q) ? 60 : name.includes(q) || slug.includes(q) ? 40 : 0;
    for (const w of words) score += name.includes(w) || slug.includes(w) ? 10 : 1;
    scored.push({ t, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((x) => x.t);
}

/** The categories to browse by, biggest first. */
export function categoriesOf(items: Toolkit[], limit = 14): (Category & { count: number })[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const t of items) for (const c of t.categories) { const cur = counts.get(c.slug); if (cur) cur.count++; else counts.set(c.slug, { name: c.name, count: 1 }); }
  return [...counts.entries()].map(([slug, v]) => ({ slug, name: v.name, count: v.count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}

/* ------------------------------------------------------------------ actions (tools) */
function parameterOf(parameterName: string, raw: unknown, required: Set<string>): ToolParameter {
  const definition = obj(raw);
  const rawType = definition["type"];
  const type = Array.isArray(rawType) ? rawType.filter((x): x is string => typeof x === "string" && x !== "null").join("|") : str(rawType) || (Array.isArray(definition["enum"]) ? "string" : "any");
  const options = Array.isArray(definition["enum"]) ? definition["enum"].filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  const itemsType = str(obj(definition["items"])["type"]);
  return {
    name: parameterName,
    type: type || "any",
    description: str(definition["description"]).replace(/\s+/g, " ").slice(0, 160),
    required: required.has(parameterName),
    ...(options.length ? { enum: options } : {}),
    ...(itemsType ? { itemType: itemsType } : {}),
  };
}

export async function listTools(toolkit: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<ToolInfo[]> {
  const slug = toolkit.toLowerCase();
  const e = opts.env ?? defaultEnv();
  const f = opts.fetch ?? fetch;
  const cacheKey = `${e["COMPOSIO_API_BASE"] ?? ""}|${composioApiKey(e).slice(-8)}|${slug}`;
  const hit = toolCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TOOLS_TTL) return hit.tools;

  const tools: ToolInfo[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ toolkit_slug: slug, limit: "200", toolkit_versions: "latest" });
    if (cursor) qs.set("cursor", cursor);
    const json = await api(e, f, `/tools?${qs.toString()}`, { timeoutMs: 25000 });
    let fresh = 0;
    for (const r of rows(json)) {
      const name = str(r["slug"] ?? r["name"]);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      fresh++;
      // Composio v3 returns input_parameters as a direct map of parameter names to
      // definitions (each definition has its own required boolean). Older responses
      // wrap the same data in JSON Schema's { properties, required } shape. Accept both.
      const schema = obj(r["input_parameters"] ?? r["parameters"]);
      const nestedProperties = obj(schema["properties"]);
      const looksLikeDefinitions = Object.keys(nestedProperties).length > 0 && Object.values(nestedProperties).every((v) => !!v && typeof v === "object" && !Array.isArray(v)) && typeof nestedProperties["type"] !== "string";
      const hasNestedSchema = Array.isArray(schema["required"]) || (typeof schema["type"] === "string" && Object.prototype.hasOwnProperty.call(schema, "properties")) || (Object.prototype.hasOwnProperty.call(schema, "properties") && looksLikeDefinitions);
      const properties = hasNestedSchema ? nestedProperties : schema;
      const rawRequired = Array.isArray(schema["required"]) ? schema["required"] : [];
      const required = new Set([
        ...rawRequired.filter((x): x is string => typeof x === "string"),
        ...Object.entries(properties).filter(([, raw]) => obj(raw)["required"] === true).map(([parameterName]) => parameterName),
      ]);
      const entries = Object.entries(properties);
      // Required parameters always make the cut, so the planner never has to guess at one that was left out.
      const ordered = [...entries.filter(([n]) => required.has(n)), ...entries.filter(([n]) => !required.has(n))].slice(0, MAX_PARAMS_KEPT);
      const parameterDetails = ordered.map(([parameterName, raw]) => parameterOf(parameterName, raw, required));
      tools.push({
        name,
        description: str(r["description"] ?? r["human_description"]).replace(/\s+/g, " ").slice(0, 280),
        toolkit: slug,
        write: isWriteTool(name, slug),
        parameters: parameterDetails.map((parameter) => parameter.name),
        parameterDetails,
        allParameters: entries.map(([n]) => n),
      });
    }
    const next = str(obj(json)["next_cursor"] ?? obj(json)["nextCursor"] ?? obj(obj(json)["pagination"])["next_cursor"]);
    if (!next || next === cursor || fresh === 0) break;
    cursor = next;
  }

  if (tools.length) {
    toolCache.set(cacheKey, { at: Date.now(), tools });
    return tools;
  }
  if (hit) return hit.tools;
  return tools;
}
export function clearToolCache(): void { toolCache.clear(); }

/** How an app signs in, as Composio describes it: whether one click works (Composio-managed) or the owner must supply credentials. */
export type ToolkitAuth = { slug: string; name: string; noAuth: boolean; managedSchemes: string[]; authModes: string[] };
export async function describeToolkit(toolkit: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<ToolkitAuth> {
  const slug = toolkit.toLowerCase();
  const json = obj(await api(opts.env ?? defaultEnv(), opts.fetch ?? fetch, `/toolkits/${encodeURIComponent(slug)}`));
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()) : []);
  const details = Array.isArray(json["auth_config_details"]) ? (json["auth_config_details"] as unknown[]).map((d) => str(obj(d)["mode"]).toUpperCase()).filter(Boolean) : [];
  return {
    slug,
    name: str(json["name"]).trim() || titleCase(slug),
    noAuth: json["no_auth"] === true,
    managedSchemes: strings(json["composio_managed_auth_schemes"]),
    authModes: [...new Set(details)],
  };
}

/* ------------------------------------------------------------------ connections */
const timeOf = (v: unknown): number => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };

export async function listConnections(uid: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<Connection[]> {
  const e = opts.env ?? defaultEnv(), f = opts.fetch ?? fetch;
  const out: Connection[] = [];
  let cursor = "";
  for (let page = 0; page < 6; page++) {
    const json = await api(e, f, `/connected_accounts?user_ids=${encodeURIComponent(uid)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const batch = rows(json).map((r): Connection => {
      const created = timeOf(r["created_at"] ?? r["createdAt"] ?? r["updated_at"] ?? r["updatedAt"]);
      return { id: str(r["id"]), toolkit: str(obj(r["toolkit"])["slug"] ?? r["toolkit_slug"]).toLowerCase(), status: str(r["status"]).toUpperCase(), ...(created ? { createdAt: created } : {}) };
    }).filter((c) => c.id && c.toolkit);
    out.push(...batch);
    const next = str(obj(json)["next_cursor"] ?? obj(json)["nextCursor"]);
    if (!next || next === cursor || !batch.length) break;
    cursor = next;
  }
  return out;
}

/** A live connection: ACTIVE, or a listing that omits the status. */
export const isLive = (c: Connection): boolean => c.status === "ACTIVE" || c.status === "";
/** Still being set up (the person is signing in, or Composio has not finished). */
export const isPending = (c: Connection): boolean => c.status === "INITIALIZING" || c.status === "INITIATED";
/** Was working once but needs the person to sign in again. */
export const isBroken = (c: Connection): boolean => c.status === "EXPIRED" || c.status === "FAILED" || c.status === "INACTIVE";

/** The connection Zeros uses for an app: the NEWEST live one. An old, forgotten sign-in can never shadow the one the person just made. */
export function pickConnection(list: Connection[], toolkit: string): Connection | undefined {
  const mine = list.map((c, index) => ({ c, index })).filter((x) => x.c.toolkit === toolkit.toLowerCase() && isLive(x.c));
  mine.sort((a, b) => (b.c.createdAt ?? 0) - (a.c.createdAt ?? 0) || a.index - b.index);
  return mine[0]?.c;
}

/** app -> the connection id Zeros uses for it. */
export function connectionMap(list: Connection[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const toolkit of new Set(list.map((c) => c.toolkit))) { const c = pickConnection(list, toolkit); if (c) out.set(toolkit, c.id); }
  return out;
}

/** Waits (politely) for a just-made connection to turn ACTIVE: Composio finishes a sign-in a moment after the person is sent back. */
export async function waitForConnection(uid: string, toolkit: string, opts: { env?: Env; fetch?: Fetch; timeoutMs?: number; intervalMs?: number } = {}): Promise<Connection | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 12_000);
  for (;;) {
    const found = pickConnection(await listConnections(uid, opts).catch(() => [] as Connection[]), toolkit);
    if (found) return found;
    if (Date.now() + (opts.intervalMs ?? 1200) > deadline) return null;
    await sleep(opts.intervalMs ?? 1200);
  }
}

/** The auth configurations to try, best first: enabled ones; the owner's own before Composio-managed ones. */
function orderAuthConfigs(configs: Record<string, unknown>[]): string[] {
  const usable = configs.filter((c) => str(c["status"]).toUpperCase() !== "DISABLED" && str(c["id"]));
  const own = usable.filter((c) => c["is_composio_managed"] !== true);
  const managed = usable.filter((c) => c["is_composio_managed"] === true);
  return [...own, ...managed].map((c) => str(c["id"]));
}

/** Creates the Composio-managed auth configuration for an app, so one click connects it without any dashboard setup. */
async function createManagedAuthConfig(e: Env, f: Fetch, slug: string): Promise<string> {
  const unavailable = new ComposioError(`${titleCase(slug)} can't be connected yet. If you manage Zeros, create an auth configuration for ${slug} in your Composio dashboard.`);
  let json: unknown;
  try {
    json = await api(e, f, "/auth_configs", { method: "POST", body: { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth", name: `Zeros connection: ${slug}` } }, retry: false });
  } catch (err) {
    console.warn(`[Zeros] A managed auth configuration for ${slug} could not be created:`, err);
    throw unavailable;
  }
  const body = obj(json);
  const id = str(obj(body["auth_config"])["id"] ?? body["id"]);
  if (!id) throw unavailable;
  return id;
}

const redirectOf = (json: Record<string, unknown>): string => {
  const data = obj(json["connectionData"] ?? json["connection_data"]);
  return str(json["redirect_url"] ?? json["redirectUrl"] ?? json["redirect_uri"] ?? obj(data["val"])["redirectUrl"] ?? data["redirect_url"]);
};

/** One attempt to start a sign-in through a specific auth configuration (the hosted link first, the direct form as the fallback). */
async function linkThrough(e: Env, f: Fetch, authConfigId: string, uid: string, callbackUrl?: string): Promise<{ redirectUrl: string; connectionId: string }> {
  let json: Record<string, unknown>;
  try {
    json = obj(await api(e, f, "/connected_accounts/link", { method: "POST", retry: false, body: { auth_config_id: authConfigId, user_id: uid, ...(callbackUrl ? { callback_url: callbackUrl } : {}) } }));
  } catch (err) {
    if (!(err instanceof ComposioError) || (err.status !== 404 && err.status !== 405)) throw err;
    json = obj(await api(e, f, "/connected_accounts", { method: "POST", retry: false, body: { auth_config: { id: authConfigId }, connection: { user_id: uid, ...(callbackUrl ? { callback_url: callbackUrl } : {}) } } }));
  }
  const redirectUrl = redirectOf(json);
  if (!redirectUrl) throw new ComposioError("Composio did not return a sign-in link. Try again.");
  return { redirectUrl, connectionId: str(json["connected_account_id"] ?? json["id"]) };
}

/** Starts a connection for this person and returns the link where they sign in to the app (and come back from, via `callbackUrl`). */
export async function startConnection(uid: string, toolkit: string, opts: { env?: Env; fetch?: Fetch; callbackUrl?: string } = {}): Promise<{ redirectUrl: string; connectionId: string }> {
  const e = opts.env ?? defaultEnv(), f = opts.fetch ?? fetch, slug = toolkit.toLowerCase();
  const configs = rows(await api(e, f, `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=10`));
  const candidates = orderAuthConfigs(configs);
  let lastError: unknown = null;
  // Every configuration that exists is tried in turn, so one misconfigured entry never blocks an app that another could connect.
  for (const id of candidates) {
    try { return await linkThrough(e, f, id, uid, opts.callbackUrl); }
    catch (err) {
      lastError = err;
      if (!(err instanceof ComposioError) || ![400, 403, 404, 409, 422].includes(err.status)) throw err;
      console.warn(`[Zeros] ${slug}: auth configuration ${id} could not start a sign-in (${err.message}); trying the next one.`);
    }
  }
  try {
    return await linkThrough(e, f, await createManagedAuthConfig(e, f, slug), uid, opts.callbackUrl);
  } catch (err) {
    if (lastError instanceof ComposioError && candidates.length && err instanceof ComposioError && /can't be connected yet/.test(err.message)) throw lastError;
    throw err;
  }
}

export async function removeConnection(connectionId: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<void> {
  await api(opts.env ?? defaultEnv(), opts.fetch ?? fetch, `/connected_accounts/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
}

/** Asks Composio to renew an expired sign-in. Returns the new status, plus a link when the person has to sign in again. */
export async function refreshConnection(connectionId: string, opts: { env?: Env; fetch?: Fetch; callbackUrl?: string } = {}): Promise<{ status: string; redirectUrl: string }> {
  const json = obj(await api(opts.env ?? defaultEnv(), opts.fetch ?? fetch, `/connected_accounts/${encodeURIComponent(connectionId)}/refresh`, { version: "3.1", method: "POST", retry: false, body: opts.callbackUrl ? { redirect_url: opts.callbackUrl } : {} }));
  return { status: str(json["status"]).toUpperCase(), redirectUrl: redirectOf(json) };
}

/* ------------------------------------------------------------------ running an action */
/** Makes arguments fit the action's own schema: "5" -> 5, "true" -> true, one value -> a list, a JSON string -> an object. Unknown names are dropped. */
export function coerceArguments(args: Record<string, unknown>, tool: Pick<ToolInfo, "parameterDetails" | "allParameters">): Record<string, unknown> {
  const details = new Map((tool.parameterDetails ?? []).map((p) => [p.name, p]));
  const known = new Set([...(tool.allParameters ?? []), ...details.keys()]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (known.size && !known.has(key)) continue;
    const p = details.get(key);
    out[key] = p ? coerceValue(value, p) : value;
  }
  return out;
}

function coerceValue(value: unknown, p: ToolParameter): unknown {
  const types = p.type.split("|");
  const has = (t: string): boolean => types.includes(t);
  if (typeof value === "string") {
    const s = value.trim();
    if ((has("integer") || has("number")) && !has("string") && /^-?\d+(\.\d+)?$/.test(s)) return has("integer") ? Math.trunc(Number(s)) : Number(s);
    if (has("boolean") && !has("string") && /^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    if (has("array") && !has("string")) {
      if (/^\[[\s\S]*\]$/.test(s)) { try { return JSON.parse(s) as unknown; } catch { /* fall through */ } }
      return s ? s.split(/\s*,\s*/).filter(Boolean) : [];
    }
    if (has("object") && !has("string") && /^\{[\s\S]*\}$/.test(s)) { try { return JSON.parse(s) as unknown; } catch { /* keep */ } }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (has("string") && !has("number") && !has("integer") && !has("boolean")) return String(value);
    if (has("array") && !has("number") && !has("integer") && !has("boolean")) return [value];
    return value;
  }
  if (Array.isArray(value)) {
    if (has("string") && !has("array")) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
    return value;
  }
  if (value && typeof value === "object" && has("array") && !has("object")) return [value];
  return value;
}

/* result compaction: the answer sees names, ids and links, not pages of API plumbing */
const NOISE_KEYS = /^(node_id|gravatar_id|etag|x-ratelimit.*|.*_template|.*_count_url|score_url|avatar_url|site_admin|permissions|has_(?:issues|projects|wiki|pages|downloads|discussions)|web_commit_signoff_required|allow_(?:forking|merge_commit|squash_merge|rebase_merge|auto_merge|update_branch)|use_squash_pr_title_as_default|squash_merge_commit_\w+|merge_commit_\w+|delete_branch_on_merge|is_template|network_count|subscribers_count|mirror_url|security_and_analysis)$/i;
/** Objects that describe a person: only who they are is worth reading. */
const PERSON_KEYS = /^(owner|user|author|assignee|assignees|creator|sender|actor|committer|merged_by|closed_by|requested_by|requested_reviewers|reviewer|reviewers|organization|org|account|member|from|to|editor|submitter|requester|lastModifyingUser|owners|sharingUser)$/i;
const PERSON_FIELDS = /^(login|name|username|email|id|type|display_name|displayName|full_name|emailAddress|handle|real_name)$/i;
const KEEP_URL_KEYS = /^(html_url|web_url|webviewlink|weblink|htmllink|permalink|permalink_url|link|share_url|public_url|download_url|clone_url|homepage|website|url)$/i;
const isApiPlumbingUrl = (key: string, value: string): boolean => /_url$/i.test(key) && !KEEP_URL_KEYS.test(key) && (/\{[^}]*\}/.test(value) || /\bapi\./i.test(value) || /\/api\/v\d/i.test(value));

function prune(value: unknown, depth = 0, key = ""): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) {
    const items = value.map((v) => prune(v, depth + 1, key)).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // a nested person (the owner of a repository, the author of a commit) is reduced to who they are
    const slim = depth > 0 && PERSON_KEYS.test(key);
    const human = ["html_url", "web_url", "permalink", "permalink_url", "webViewLink", "htmlLink"].some((k) => typeof record[k] === "string");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (slim && !PERSON_FIELDS.test(k)) continue;
      if (NOISE_KEYS.test(k)) continue;
      if (typeof v === "string" && isApiPlumbingUrl(k, v)) continue;
      // GitHub-style "url" is the API address of the thing; the person wants the link they can open
      if (k === "url" && human && typeof v === "string" && (/\bapi\./i.test(v) || /\/api\/v\d/i.test(v))) continue;
      const p = prune(v, depth + 1, k);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof value === "string" && value.length > 600) return `${value.slice(0, 600)}…`;
  return value;
}

/** Where the largest array in a JSON value lives (as a key path), so it can be shortened without breaking the rest. */
function biggestArrayPath(value: unknown, path: (string | number)[] = [], depth = 0): { path: (string | number)[]; size: number } | null {
  if (depth > 4) return null;
  let best: { path: (string | number)[]; size: number } | null = null;
  if (Array.isArray(value)) {
    best = { path, size: JSON.stringify(value).length };
    return best;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const found = biggestArrayPath(v, [...path, k], depth + 1);
      if (found && (!best || found.size > best.size)) best = found;
    }
  }
  return best;
}

function withArrayAt(value: unknown, path: (string | number)[], make: (arr: unknown[]) => unknown[]): unknown {
  if (!path.length) return Array.isArray(value) ? make(value) : value;
  const [head, ...rest] = path;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return { ...o, [head as string]: withArrayAt(o[head as string], rest, make) };
  }
  return value;
}

/**
 * Shrinks an app's answer to what fits, keeping whole items (never half of one): empty fields and API plumbing links go first,
 * then the tail of the longest list, with a note of how many items were left out.
 */
export function compactResult(text: string, maxChars: number): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text; }
  const value = prune(parsed);
  if (value === undefined) return text.length > maxChars ? text.slice(0, maxChars) : text;
  const whole = JSON.stringify(value);
  if (whole.length <= maxChars) return whole;
  const big = biggestArrayPath(value);
  if (!big) return `${whole.slice(0, maxChars)}…`;
  const total = (withArrayAt(value, big.path, (a) => a) as unknown);
  const length = (() => { let n = 0; withArrayAt(total, big.path, (a) => { n = a.length; return a; }); return n; })();
  const build = (keep: number): string => JSON.stringify(withArrayAt(value, big.path, (a) => (keep >= a.length ? a : [...a.slice(0, keep), { _omitted_items: a.length - keep }])));
  let lo = 1, hi = length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).length <= maxChars) lo = mid; else hi = mid - 1;
  }
  const out = build(lo);
  return out.length > maxChars * 1.25 ? `${out.slice(0, maxChars)}…` : out;
}

/** Runs one action with this person's connected account. */
export async function executeTool(uid: string, tool: string, args: Record<string, unknown>, connectionId: string, opts: { env?: Env; fetch?: Fetch; write?: boolean } = {}): Promise<{ ok: boolean; text: string }> {
  const e = opts.env ?? defaultEnv(), f = opts.fetch ?? fetch;
  const send = (version: string | null): Promise<unknown> => api(e, f, `/tools/execute/${encodeURIComponent(tool)}`, {
    version: "3.1",
    method: "POST",
    timeoutMs: 40_000,
    // A change is never sent twice because an answer got lost; reads and "slow down" answers are simply repeated.
    retry: !(opts.write ?? isWriteTool(tool)),
    body: { user_id: uid, arguments: args, connected_account_id: connectionId, ...(version ? { version } : {}) },
  });
  let raw: unknown;
  try { raw = await send("latest"); }
  catch (err) {
    // An API that does not know the version word still answers when asked without it.
    if (err instanceof ComposioError && (err.status === 400 || err.status === 422) && /\bversion\b/i.test(err.message)) raw = await send(null);
    else throw err;
  }
  const json = obj(raw);
  const ok = json["successful"] !== false && !json["error"];
  const payload = json["data"] ?? json;
  const failure = str(json["error"]) || str(obj(json["error"])["message"]) || str(obj(payload)["message"]) || JSON.stringify(payload ?? "");
  const text = (ok ? (typeof payload === "string" ? payload : JSON.stringify(payload ?? "")) : failure).slice(0, 200_000);
  return { ok, text: text || "(the app returned no data)" };
}

/**
 * Calls the app's own web API through the person's connection, for anything the action catalogue does not cover (the safety net
 * that lets Zeros do anything the person's account can do). Methods other than GET/HEAD are changes.
 */
export async function proxyExecute(connectionId: string, req: { method: string; endpoint: string; body?: unknown }, opts: { env?: Env; fetch?: Fetch } = {}): Promise<{ ok: boolean; text: string }> {
  const method = req.method.toUpperCase();
  const json = obj(await api(opts.env ?? defaultEnv(), opts.fetch ?? fetch, "/tools/execute/proxy", {
    version: "3.1",
    method: "POST",
    timeoutMs: 40_000,
    retry: method === "GET" || method === "HEAD",
    body: { endpoint: req.endpoint, method, connected_account_id: connectionId, ...(req.body === undefined || method === "GET" ? {} : { body: req.body }) },
  }));
  const status = Number(json["status"] ?? json["status_code"] ?? 200);
  const ok = Number.isFinite(status) ? status >= 200 && status < 300 : json["successful"] !== false;
  const payload = json["data"] ?? json["body"] ?? json;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return { ok, text: (ok ? text : `HTTP ${status}: ${text}`).slice(0, 200_000) || "(the app returned no data)" };
}

/* ------------------------------------------------------------------ finding the right actions */
const SYNONYMS: Record<string, string[]> = {
  repo: ["repository", "repositories", "repos"], repos: ["repository", "repositories", "repo"], repository: ["repo", "repos"], repositories: ["repo", "repos"],
  pr: ["pull", "request", "pulls"], prs: ["pull", "request", "pulls"], pull: ["request", "pulls"],
  mail: ["email", "message", "thread"], email: ["mail", "message", "thread", "draft"], emails: ["mail", "message", "thread"], inbox: ["email", "message", "thread"], gmail: ["email", "message", "thread"],
  event: ["calendar", "meeting"], events: ["calendar", "meeting"], meeting: ["event", "calendar"], meetings: ["event", "calendar"], calendar: ["event"], appointment: ["event", "calendar"], schedule: ["event", "calendar"],
  doc: ["document", "file"], docs: ["document", "file"], document: ["doc", "file", "page"], documents: ["doc", "file", "page"], file: ["document", "content", "contents"], files: ["document", "content", "contents"],
  ticket: ["issue", "task"], tickets: ["issue", "task"], bug: ["issue"], bugs: ["issue"], issue: ["ticket", "task"], issues: ["ticket", "task"], task: ["todo", "issue", "ticket", "card"], tasks: ["todo", "issue", "ticket", "card"],
  channel: ["conversation", "chat"], channels: ["conversation", "chat"], dm: ["conversation", "message", "direct"], chat: ["conversation", "message"],
  commit: ["push", "git", "contents", "file"], commits: ["git", "history"], push: ["commit", "contents", "file"],
  branch: ["ref", "reference"], branches: ["ref", "reference"],
  contact: ["person", "people", "lead"], contacts: ["person", "people", "lead"], customer: ["contact", "client"], customers: ["contact", "client"],
  deal: ["opportunity", "lead"], deals: ["opportunity", "lead"], invoice: ["bill", "payment"], invoices: ["bill", "payment"], payment: ["charge", "invoice", "transaction"], payments: ["charge", "invoice", "transaction"],
  page: ["document", "doc", "block"], pages: ["document", "doc", "block"], database: ["table", "data", "query"], row: ["record", "item", "spreadsheet", "sheet"], rows: ["record", "item", "spreadsheet", "sheet"], sheet: ["spreadsheet", "worksheet"], spreadsheet: ["sheet", "worksheet", "cell", "file"],
  video: ["media"], song: ["track", "music"], songs: ["track", "music"], track: ["song", "music"], playlist: ["track", "song"],
  folder: ["directory", "file"], folders: ["directory", "file"], user: ["member", "account", "profile"], member: ["user", "people"], team: ["group", "organization"], org: ["organization"],
  star: ["favorite", "starred"], like: ["favorite", "react", "reaction"], react: ["reaction", "emoji"], emoji: ["reaction"], thumbs: ["reaction", "emoji"], reaction: ["emoji"],
  budget: ["file", "spreadsheet"], server: ["guild"], servers: ["guild"], guild: ["server"], board: ["boards"], boards: ["board"], card: ["cards"], cards: ["card"], tweet: ["post", "status"], post: ["message", "status", "create"], reminder: ["task", "event"],
};
const VERB_FAMILY: Record<string, string[]> = {
  create: ["create", "add", "insert", "new", "make", "open", "append", "post", "draft", "write", "compose"], make: ["create", "add", "insert", "new"], add: ["create", "add", "insert", "append"], new: ["create", "add"], open: ["create", "open"], draft: ["create", "draft"], compose: ["create", "draft", "send"],
  send: ["send", "post", "reply", "forward", "create"], post: ["post", "create", "send"], reply: ["reply", "send", "create"], forward: ["forward", "send"],
  update: ["update", "edit", "patch", "modify", "set", "replace", "rename", "change"], edit: ["update", "edit", "patch", "modify", "replace"], change: ["update", "edit", "patch", "modify"], modify: ["update", "patch", "modify"], rename: ["rename", "update"], fix: ["update", "patch", "edit"], rewrite: ["update", "replace", "edit"],
  delete: ["delete", "remove", "trash", "destroy"], remove: ["delete", "remove", "trash"], trash: ["trash", "delete"], archive: ["archive", "close"],
  list: ["list", "get", "fetch", "search", "find"], show: ["list", "get", "fetch", "find", "view"], find: ["find", "search", "list", "get"], search: ["search", "find", "list", "query"], get: ["get", "fetch", "retrieve", "read", "list"], read: ["get", "fetch", "read", "list", "retrieve"], fetch: ["fetch", "get", "list"], check: ["get", "check", "list", "find"], summarize: ["list", "get", "fetch"], summarise: ["list", "get", "fetch"], view: ["get", "view", "list"],
  commit: ["create", "update", "commit", "push"], push: ["create", "update", "push", "commit"], merge: ["merge"], close: ["close", "update"], assign: ["assign", "update", "add"], invite: ["invite", "add"], share: ["share", "create"], move: ["move", "update"], upload: ["upload", "create"], download: ["download", "get"], star: ["star", "create"], fork: ["fork", "create"], schedule: ["create", "schedule"], book: ["create", "book"], cancel: ["cancel", "delete", "update"],
};
const stemForms = (word: string): string[] => {
  const out = new Set([word]);
  if (word.length > 4 && word.endsWith("ies")) out.add(`${word.slice(0, -3)}y`);
  if (word.length > 3 && word.endsWith("es")) out.add(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) out.add(word.slice(0, -1));
  if (word.length > 3 && word.endsWith("y")) out.add(`${word.slice(0, -1)}ies`);
  else if (word.length > 2 && !word.endsWith("s")) { out.add(`${word}s`); out.add(`${word}es`); }
  if (word.length > 5 && word.endsWith("ing")) { out.add(word.slice(0, -3)); out.add(`${word.slice(0, -3)}e`); }
  if (word.length > 4 && word.endsWith("ed")) { out.add(word.slice(0, -2)); out.add(word.slice(0, -1)); }
  if (word.length > 3 && word.endsWith("e")) { out.add(`${word}d`); out.add(`${word.slice(0, -1)}ing`); }
  // derivations: react <-> reaction, invite <-> invitation, create <-> creation
  if (word.length > 4 && !word.endsWith("s")) { out.add(`${word}ion`); out.add(`${word}ions`); if (word.endsWith("e")) { out.add(`${word.slice(0, -1)}ation`); out.add(`${word.slice(0, -1)}ion`); } }
  if (word.length > 6 && word.endsWith("ation")) { out.add(word.slice(0, -5)); out.add(`${word.slice(0, -5)}e`); }
  else if (word.length > 5 && word.endsWith("ion")) { out.add(word.slice(0, -3)); out.add(`${word.slice(0, -3)}e`); }
  return [...out];
};

/** Words that mean the same thing for finding an action (repo = repos = repository = repositories). */
const CONCEPTS: string[][] = [
  ["repo", "repos", "repository", "repositories"], ["email", "emails", "mail", "mails"], ["doc", "docs", "document", "documents"],
  ["folder", "folders", "directory", "directories"], ["pr", "prs", "pull", "pulls"], ["msg", "message", "messages"],
  ["calendar", "calendars"], ["meeting", "meetings"], ["repo_contents", "contents", "content"],
];
const CANON = new Map<string, string>();
for (const group of CONCEPTS) for (const w of group) CANON.set(w, group[0]!);
const canon = (t: string): string => CANON.get(t) ?? t;
const PREPOSITIONS = new Set(["for", "in", "of", "by", "from", "to", "on", "with", "at", "via", "as", "and", "or", "within", "across", "between", "into", "under", "per", "using"]);
const ARTICLES = new Set(["a", "an", "the", "all", "my", "your", "own", "any", "each", "every"]);

/** An action name split into what it does (verb), what it returns (head noun, the last word before "for/in/of"), and what it is scoped to. */
function nameParts(name: string, toolkit: string): { verb: string; span: string[]; tail: string[]; head: string } {
  let tokens = tokensOf(name);
  const prefix = tokensOf(toolkit);
  if (prefix.length && prefix.every((t, i) => tokens[i] === t)) tokens = tokens.slice(prefix.length);
  const vi = tokens.findIndex((t) => READ_VERBS.has(t) || WRITE_WORDS.has(t));
  const rest = vi >= 0 ? tokens.slice(vi + 1) : tokens;
  const cut = rest.findIndex((t) => PREPOSITIONS.has(t));
  const span = (cut >= 0 ? rest.slice(0, cut) : rest).filter((t) => !ARTICLES.has(t));
  const tail = (cut >= 0 ? rest.slice(cut + 1) : []).filter((t) => !ARTICLES.has(t) && !PREPOSITIONS.has(t));
  return { verb: vi >= 0 ? tokens[vi]! : "", span, tail, head: span[span.length - 1] ?? "" };
}
const formsOf = (word: string): Set<string> => new Set(stemForms(word).map(canon));
const meets = (a: Set<string>, b: Set<string>): boolean => { for (const x of a) if (b.has(x)) return true; return false; };

/**
 * Actions whose names and descriptions best match the request. A word counts most when it is what the action RETURNS
 * (LIST_REPOS returns repos; LIST_ARTIFACTS_FOR_A_REPOSITORY only mentions one), is weighted by how rare it is across the app's
 * actions (so "pull" counts for more than "github"), is expanded with everyday synonyms, and tilts toward the verb the person used.
 */
export function relevantTools(tools: ToolInfo[], query: string, limit = 20): ToolInfo[] {
  const words = tokensOf(query).filter((t) => t.length >= 2 && !STOP.has(t));
  if (!words.length || !tools.length) return [];
  const parts = tools.map((t) => nameParts(t.name, t.toolkit));
  const nameForms = tools.map((t) => new Set(tokensOf(t.name).flatMap((x) => [...formsOf(x)])));
  const descForms = tools.map((t) => new Set(tokensOf(t.description).flatMap((x) => [...formsOf(x)])));
  const df = new Map<string, number>();
  for (const set of nameForms) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (forms: Set<string>): number => { let best = 0; for (const f of forms) best = Math.max(best, Math.log(1 + tools.length / (1 + (df.get(f) ?? 0)))); return best; };

  const allTokens = tokensOf(query);
  const openAsVerb = /\bopen\s+(?:a|an|new|the\s+new)\b/i.test(query);
  const queryVerbs = new Set<string>();
  const explicitWriteFamily = new Set<string>();
  for (const w of allTokens) {
    if (w === "open" && !openAsVerb) continue;
    for (const form of stemForms(w)) if (VERB_FAMILY[form]) for (const v of VERB_FAMILY[form]!) { queryVerbs.add(v); if (!READ_VERBS.has(w) && !["list", "show", "find", "search", "get", "read", "fetch", "check", "summarize", "summarise", "view"].includes(w)) explicitWriteFamily.add(v); }
  }
  const writeWords = allTokens.filter((w) => (w === "open" ? openAsVerb : (WRITE_WORDS.has(w) || (!!VERB_FAMILY[w] && !READ_VERBS.has(w) && !["list", "show", "find", "search", "get", "read", "fetch", "check", "summarize", "summarise", "view"].includes(w)))));
  const wantsWrite = writeWords.length > 0;
  const wantsRead = allTokens.some((w) => READ_VERBS.has(w) || /^(?:what|which|who|when|where|how|any|do|does|is|are)$/.test(w)) && !wantsWrite;
  const wantsList = /\b(?:list|show|all|every|which|what are|what's|what is|check)\b/i.test(query);
  const mine = /\b(?:my|mine|me|own)\b/i.test(query);
  const singular = /(?:#|\bnumber\s*)?\b\d+\b|\b(?:this|that|the latest|the last|the first)\b/i.test(query);
  const whoAmI = /\bwho\s*am\s*i\b|\bwhoami\b|\bmy (?:profile|account)\b|\bcurrent user\b/i.test(query);
  const aliasForms = new Map<string, { forms: Set<string>; weight: number }>();
  for (const w of words) (SYNONYMS[w] ?? []).forEach((a, i) => { if (!words.includes(a)) { const weight = [1, 0.75, 0.55, 0.4][Math.min(i, 3)]!; const cur = aliasForms.get(a); if (!cur || cur.weight < weight) aliasForms.set(a, { forms: formsOf(a), weight }); } });
  if (whoAmI) for (const a of ["authenticated", "user", "profile", "me", "current", "account"]) if (!aliasForms.has(a)) aliasForms.set(a, { forms: formsOf(a), weight: 1 });
  const wordForms = words.map((w) => ({ w, forms: formsOf(w) }));
  const nounWords = wordForms.filter(({ w }) => !VERB_FAMILY[w] || SYNONYMS[w]);

  const scored = tools.map((tool, index) => {
    const part = parts[index]!;
    const head = new Set(part.head ? [...formsOf(part.head)] : []);
    const span = new Set(part.span.flatMap((x) => [...formsOf(x)]));
    const tail = new Set(part.tail.flatMap((x) => [...formsOf(x)]));
    let score = 0, hits = 0, headHits = 0;
    for (const { forms } of wordForms) {
      const weight = idf(forms);
      if (meets(forms, head)) { score += 8 * weight; hits++; headHits++; }
      else if (meets(forms, span)) { score += 5 * weight; hits++; }
      else if (meets(forms, tail)) { score += 2 * weight; hits++; }
      else if (meets(forms, nameForms[index]!)) { score += 3 * weight; hits++; }
      else if (meets(forms, descForms[index]!)) score += 2.4;
    }
    for (const [, alias] of aliasForms) {
      const weight = idf(alias.forms) * alias.weight;
      if (meets(alias.forms, head)) score += 3 * weight;
      else if (meets(alias.forms, span) || meets(alias.forms, nameForms[index]!)) score += 1.6 * weight;
      else if (meets(alias.forms, descForms[index]!)) score += 0.5;
    }
    const verb = part.verb;
    if (verb && queryVerbs.has(verb)) score += 5;
    // a request that names a change ("delete", "send") belongs to the action that does exactly that, more than to one that shares a noun
    if (verb && explicitWriteFamily.has(verb)) score += 5;
    // any lookup action answers a request to look something up, whatever the app calls it (get, list, fetch, search, find ...)
    if (wantsRead && READ_VERBS.has(verb) && !(verb && queryVerbs.has(verb))) score += 4;
    // someone who only wants to look should see lookups first, and someone who wants a change should see changes first
    if (wantsRead && !tool.write) score += 4;
    else if (wantsRead && tool.write) score -= 6;
    else if (wantsWrite && !tool.write) score -= 3;
    if (singular && verb === "get") score += 6;
    if (singular && verb === "list" && /\b\d+\b/.test(query)) score -= 3;
    if (wantsList && verb === "list" && headHits) score += 3;
    if (headHits && nounWords.length && nounWords.every(({ forms }) => meets(forms, head) || meets(forms, span))) score += 4;
    if (mine && /\b(?:authenticated|user|me|own|self)\b/.test(tokensOf(tool.name).join(" "))) score += 2;
    if (hits >= Math.min(words.length, 3) && hits > 1) score += 2;
    if (/deprecated|legacy|\(old\)/i.test(`${tool.name} ${tool.description}`)) score -= 6;
    // endpoints that need an app-installation token, not the person's own sign-in, only ever fail for a person's own account
    if (/\b(?:accessible|installation|installations)\b/.test(tokensOf(tool.name).join(" ")) && !/\b(?:installation|installations)\b/i.test(query)) score -= 12;
    return { tool, score, index };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((x) => x.tool);
}
