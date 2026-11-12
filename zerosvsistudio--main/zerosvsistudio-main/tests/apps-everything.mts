/**
 * Does every connected app really work, GitHub included? A realistic Composio stand-in (21 apps, real-style action names and
 * schemas, strict argument validation, expiring/pending connections, a proxy, a ~460-action GitHub haystack) drives the REAL
 * agent and the REAL route handlers. Covers: finding the right action, running it with schema-correct arguments, multi-step work,
 * "find more actions", the API-request safety net, direct GitHub, expired and duplicate sign-ins, the sign-in finishing race,
 * and the guards that stop a prompt injection or an unrequested delete from changing anything.
 */
import { randomBytes } from "node:crypto";
import { buildCatalog, validateArguments, type Row } from "./helpers/composio-world.mts";
import { CASES } from "./helpers/retrieval-cases.mts";
import { routeUrl } from "./helpers/bundle-routes.mjs";
import { clearIdentityCache } from "../src/lib/firebase-user.server.ts";
import { clearToolCache, coerceArguments, compactResult, connectionMap, isDestructiveTool, isWriteTool, listConnections, listTools, pickConnection, relevantTools, startConnection, waitForConnection, type ToolInfo } from "../src/lib/composio-api.server.ts";
import { runAppAgent } from "../src/lib/app-agent.server.ts";
import { probeCandidates, verifyApps } from "../src/lib/app-verify.server.ts";
import { finishGitHubOAuth } from "../src/lib/github-oauth.server.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail.slice(0, 400)}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

process.env.COMPOSIO_CONNECTOR_KEY = "";
process.env.COMPOSIO_API_KEY = "ck-test";
process.env.COMPOSIO_API_BASE = "https://composio.test/api/v3";
process.env.ZEROS_A_URL = "https://engine-a.test/v1";
process.env.ZEROS_A_KEYS = "key-a1";
process.env.ZEROS_A_KEY_HEADER = "x-test-key";
process.env.ZEROS_A_MODELS = "a-strong";
process.env.ZEROS_A_FAST_MODELS = "a-fast";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";
process.env.GITHUB_CLIENT_ID = "github-client-test";
process.env.GITHUB_CLIENT_SECRET = "github-client-secret-test";
process.env.GITHUB_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Conn = { id: string; toolkit: string; status: string; created_at?: string };
type Perm = { user_id: string; toolkit_slug: string; enabled: boolean; allow_writes: boolean };
type Goal = { want: RegExp; args?: Record<string, unknown>; find?: string; force?: string; api?: { method: string; endpoint: string; query?: Record<string, unknown>; body?: unknown } }[];

const CATALOG = buildCatalog();
const ROWS = new Map<string, { toolkit: string; row: Row }>();
for (const t of CATALOG) for (const r of t.rows) ROWS.set(r.slug, { toolkit: t.slug, row: r });

const world = {
  conns: {} as Record<string, Conn[]>,
  perms: [] as Perm[],
  executed: [] as { tool: string; body: Record<string, unknown> }[],
  proxied: [] as { endpoint: string; method: string; body: unknown; account: string }[],
  refreshes: [] as string[],
  listCalls: 0,
  activateAfter: 0,
  expiredRefreshOk: true,
  failTools: new Set<string>(),
  planner: null as null | ((prompt: string) => Record<string, unknown>),
  prompts: [] as string[],
  githubCalls: [] as { method: string; path: string; auth: string | null; body: unknown }[],
  stored: null as Record<string, unknown> | null,
  /** Every Composio call that used the v3.1 base, as "METHOD /path". */
  v31: [] as string[],
};
const TOKENS: Record<string, string> = { "tok-a": "uid-a", "tok-b": "uid-b", "tok-ro": "uid-ro", "tok-native": "uid-native", "tok-race": "uid-race" };
const billing = (uid: string) => json([{ plan: "bronze", subscription_id: `I-${uid}`, status: "ACTIVE", paid_through: new Date(Date.now() + 20 * 86400000).toISOString(), cancel_requested: false, checked_at: new Date().toISOString() }]);

/** A realistic big answer: 60 repositories, each with the dozens of API-plumbing fields GitHub really returns. */
const bigRepos = () => Array.from({ length: 60 }, (_, i) => ({
  id: 1000 + i, node_id: `R_kg${i}`, name: `project-${i}`, full_name: `octo/project-${i}`, private: i % 7 === 0, html_url: `https://github.com/octo/project-${i}`, description: i % 3 === 0 ? null : `Project number ${i}`, fork: false,
  url: `https://api.github.com/repos/octo/project-${i}`, forks_url: `https://api.github.com/repos/octo/project-${i}/forks`, keys_url: `https://api.github.com/repos/octo/project-${i}/keys{/key_id}`, collaborators_url: `https://api.github.com/repos/octo/project-${i}/collaborators{/collaborator}`,
  teams_url: `https://api.github.com/repos/octo/project-${i}/teams`, hooks_url: `https://api.github.com/repos/octo/project-${i}/hooks`, issue_events_url: `https://api.github.com/repos/octo/project-${i}/issues/events{/number}`, events_url: `https://api.github.com/repos/octo/project-${i}/events`,
  owner: { login: "octo", id: 1, node_id: "U_1", avatar_url: "https://avatars.githubusercontent.com/u/1", gravatar_id: "", url: "https://api.github.com/users/octo", html_url: "https://github.com/octo", followers_url: "https://api.github.com/users/octo/followers" },
  default_branch: "main", open_issues_count: i, language: i % 2 ? "TypeScript" : "Python", topics: [], archived: false, disabled: false, pushed_at: "2026-10-01T10:00:00Z", stargazers_count: i * 3,
}));

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = typeof init?.body === "string" ? init.body : "";
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.href.includes("/api/v3.1/")) world.v31.push(`${method} ${url.pathname}`);
  const h = url.href.replace("/api/v3.1/", "/api/v3/");
  if (h.startsWith("https://identitytoolkit.googleapis.com/")) { const uid = TOKENS[JSON.parse(body || "{}").idToken]; return uid ? json({ users: [{ localId: uid, email: `${uid}@x.co` }] }) : json({}, 400); }
  if (h.startsWith("https://db.test/rest/v1/zeros_billing?")) return billing(/user_id=eq\.([^&]+)/.exec(url.search)?.[1] ?? "");
  if (h.startsWith("https://db.test/rest/v1/zeros_promo?") || h.startsWith("https://db.test/rest/v1/zeros_usage?")) return json([]);
  if (h.startsWith("https://db.test/rest/v1/zeros_app_permissions?user_id=")) { const uid = /user_id=eq\.([^&]+)/.exec(url.search)?.[1] ?? ""; return json(world.perms.filter((p) => p.user_id === uid).map((p) => ({ toolkit_slug: p.toolkit_slug, enabled: p.enabled, allow_writes: p.allow_writes }))); }
  if (h.startsWith("https://db.test/rest/v1/zeros_app_permissions?on_conflict") && method === "POST") {
    const row = JSON.parse(body) as Perm; const i = world.perms.findIndex((p) => p.user_id === row.user_id && p.toolkit_slug === row.toolkit_slug);
    if (i >= 0) world.perms[i] = row; else world.perms.push(row); return new Response(null, { status: 201 });
  }
  if (url.origin === "https://db.test" && url.pathname === "/rest/v1/zeros_github_user_tokens") {
    if (method === "POST") { world.stored = JSON.parse(body) as Record<string, unknown>; return new Response(null, { status: 201 }); }
    return json(world.stored ? [world.stored] : []);
  }
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") return json({ access_token: "ghu_native_access", refresh_token: "ghr_native_refresh", expires_in: 28800, refresh_token_expires_in: 15897600 });
  if (url.origin === "https://api.github.com") {
    const auth = new Headers(init?.headers).get("Authorization");
    const parsed = body ? JSON.parse(body) : undefined;
    world.githubCalls.push({ method, path: url.pathname + url.search, auth, body: parsed });
    if (url.pathname === "/user") return json({ id: 456, login: "native-octo" });
    if (auth !== "Bearer ghu_native_access") return json({ message: "Bad credentials" }, 401);
    if (method === "GET" && url.pathname === "/repos/acme/widget/issues") return json([{ number: 3, title: "Login is slow", state: "open", html_url: "https://github.com/acme/widget/issues/3", url: "https://api.github.com/repos/acme/widget/issues/3" }]);
    if (method === "POST" && url.pathname === "/repos/acme/widget/issues") return json({ number: 8, title: parsed?.title, html_url: "https://github.com/acme/widget/issues/8" }, 201);
    return json({ message: "Not Found" }, 404);
  }
  if (h.startsWith("https://composio.test/api/v3/toolkits/")) { const slug = decodeURIComponent(url.pathname.split("/").pop() ?? ""); return json({ slug, name: slug, no_auth: false, composio_managed_auth_schemes: slug === "salesforce" ? [] : ["OAUTH2"], auth_config_details: [{ mode: "OAUTH2" }] }); }
  if (h.startsWith("https://composio.test/api/v3/toolkits")) return json({ items: CATALOG.map((t) => ({ slug: t.slug, name: t.name, meta: { description: `${t.name} integration`, categories: [] } })) });
  if (h.startsWith("https://composio.test/api/v3/tools?")) {
    const slug = url.searchParams.get("toolkit_slug") ?? ""; const rows = CATALOG.find((t) => t.slug === slug)?.rows ?? []; const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
    const page = rows.slice(cursor, cursor + 200);
    return json({ items: page, ...(cursor + 200 < rows.length ? { next_cursor: String(cursor + 200) } : {}) });
  }
  if (h.startsWith("https://composio.test/api/v3/connected_accounts?")) {
    world.listCalls++;
    const uid = decodeURIComponent(/user_ids=([^&]+)/.exec(url.search)?.[1] ?? "");
    const list = world.conns[uid] ?? [];
    // a sign-in that is still finishing turns ACTIVE after a few polls, as the real service does
    if (world.activateAfter && world.listCalls >= world.activateAfter) for (const c of list) if (c.status === "INITIATED") c.status = "ACTIVE";
    return json({ items: list.map((c) => ({ id: c.id, status: c.status, toolkit: { slug: c.toolkit }, ...(c.created_at ? { created_at: c.created_at } : {}) })) });
  }
  if (h === "https://composio.test/api/v3/connected_accounts/link") return json({ redirect_url: "https://accounts.example/sign-in", connected_account_id: "ca_new", link_token: "lt" });
  if (/\/connected_accounts\/[^/]+\/refresh$/.test(h)) { const id = h.split("/").slice(-2)[0]!; world.refreshes.push(id); if (!world.expiredRefreshOk) return json({ status: "EXPIRED", redirect_url: "https://accounts.example/reauth" }); for (const list of Object.values(world.conns)) for (const c of list) if (c.id === id) c.status = "ACTIVE"; return json({ status: "ACTIVE" }); }
  if (h.startsWith("https://composio.test/api/v3/auth_configs")) return json({ items: [{ id: "ac_x", status: "ENABLED", is_composio_managed: true }] });
  if (h === "https://composio.test/api/v3/tools/execute/proxy") { const b = JSON.parse(body) as { endpoint: string; method: string; body?: unknown; connected_account_id: string }; world.proxied.push({ endpoint: b.endpoint, method: b.method, body: b.body, account: b.connected_account_id }); return json({ status: 200, data: { proxied: true, endpoint: b.endpoint, method: b.method } }); }
  if (h.startsWith("https://composio.test/api/v3/tools/execute/")) {
    const slug = decodeURIComponent(url.pathname.split("/").pop() ?? ""); const b = JSON.parse(body) as { arguments: Record<string, unknown>; connected_account_id: string; user_id: string };
    const entry = ROWS.get(slug);
    if (!entry) return json({ error: { message: `Tool ${slug} not found`, code: 1803 } }, 404);
    const bad = validateArguments(entry.row, b.arguments ?? {});
    if (bad) return json({ error: { message: `Invalid request data provided: ${bad}`, code: 400 } }, 400);
    world.executed.push({ tool: slug, body: b as unknown as Record<string, unknown> });
    if (world.failTools.has(slug)) return json({ successful: false, error: "401 Unauthorized: the token was revoked", data: {} });
    if (slug === "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER") return json({ successful: true, data: { response_data: bigRepos() } });
    if (slug === "GITHUB_GET_THE_AUTHENTICATED_USER") return json({ successful: true, data: { login: "octo", id: 1, name: "Octo Cat" } });
    if (slug === "GITHUB_GET_A_REFERENCE") return json({ successful: true, data: { ref: "refs/heads/main", object: { sha: "abc123def456" } } });
    if (/_(LIST|GET|FETCH|SEARCH|FIND|RETRIEVE)_/.test(slug) || /^[A-Z]+_(LIST|GET|FETCH|SEARCH|FIND)/.test(slug)) return json({ successful: true, data: { items: [{ id: 1, name: "first" }, { id: 2, name: "second" }] } });
    return json({ successful: true, data: { id: 99, created: true, ...b.arguments } });
  }
  if (h.includes(":generateContent")) {
    if (body.includes("TOOLS YOU CAN USE:")) { const prompt = (JSON.parse(body) as { contents: { parts: { text: string }[] }[] }).contents.at(-1)!.parts[0]!.text; world.prompts.push(prompt); const plan = world.planner ? world.planner(prompt) : { done: true }; return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] }); }
    return json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  }
  return json({ error: `unexpected ${method} ${h}` }, 500);
}) as typeof fetch;

/** A planner that works the way a careful model would: it only calls what is listed, searches when it must, and falls back to the API. */
function planner(goal: Goal): (prompt: string) => Record<string, unknown> {
  let idx = 0, asked = false;
  return (prompt) => {
    const listed = [...prompt.matchAll(/^- ([A-Z0-9_]+)\(/gm)].map((m) => m[1]!);
    const step = goal[idx];
    if (!step) return { done: true };
    // "force" plays an injected or confused model: it names a tool whether or not it was offered
    if (step.force) { idx++; return { tool: step.force, arguments: step.args ?? {} }; }
    const tool = listed.find((n) => step.want.test(n));
    if (tool) { idx++; asked = false; return { tool, arguments: step.args ?? {} }; }
    if (step.find && !asked) { asked = true; return { find_tools: step.find }; }
    if (step.api) { idx++; const apiTool = listed.find((n) => /_API_REQUEST$/.test(n)); return apiTool ? { tool: apiTool, arguments: step.api } : { done: true }; }
    return { done: true };
  };
}
const setup = (uid: string, apps: Record<string, string | { status: string; id?: string; created_at?: string }[]>, perms: Record<string, { enabled: boolean; allowWrites: boolean }> = {}) => {
  world.conns[uid] = Object.entries(apps).flatMap(([toolkit, v]) => (typeof v === "string" ? [{ id: `ca_${uid}_${toolkit}`, toolkit, status: v }] : v.map((x, i) => ({ id: x.id ?? `ca_${uid}_${toolkit}_${i}`, toolkit, status: x.status, ...(x.created_at ? { created_at: x.created_at } : {}) }))));
  world.perms = world.perms.filter((p) => p.user_id !== uid);
  for (const toolkit of Object.keys(apps)) { const p = perms[toolkit] ?? { enabled: true, allowWrites: true }; world.perms.push({ user_id: uid, toolkit_slug: toolkit, enabled: p.enabled, allow_writes: p.allowWrites }); }
};
const run = async (uid: string, text: string, goal: Goal, prior: { role: "user" | "assistant"; content: string }[] = []) => {
  world.executed.length = 0; world.proxied.length = 0; world.prompts.length = 0; world.githubCalls.length = 0;
  world.planner = planner(goal);
  return runAppAgent({ uid, messages: [...prior, { role: "user", content: text }] });
};
const executedTools = () => world.executed.map((e) => e.tool);
const ALL = Object.fromEntries(CATALOG.map((t) => [t.slug, "ACTIVE"]));

async function main(): Promise<void> {
  /* ============================================================ the classification of reads and changes */
  section("Reads and changes are told apart by the action's first verb");
  const TRICKY: [string, string, boolean][] = [
    ["GITHUB_GET_A_COMMIT", "github", false], ["GITHUB_CREATE_A_COMMIT", "github", true], ["GITHUB_LIST_COMMITS", "github", false], ["GITHUB_GET_A_WORKFLOW_RUN", "github", false],
    ["GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "github", false], ["GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER", "github", true], ["GITHUB_CHECK_IF_A_PULL_REQUEST_HAS_BEEN_MERGED", "github", false],
    ["GITHUB_MERGE_A_PULL_REQUEST", "github", true], ["GMAIL_FETCH_EMAILS", "gmail", false], ["GMAIL_SEND_EMAIL", "gmail", true], ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "gmail", false],
    ["SLACK_LIST_ALL_CHANNELS", "slack", false], ["SLACK_SEND_MESSAGE", "slack", true], ["NOTION_QUERY_DATABASE", "notion", false], ["NOTION_ADD_PAGE_CONTENT", "notion", true],
    ["GOOGLESHEETS_BATCH_GET", "googlesheets", false], ["GOOGLESHEETS_BATCH_UPDATE", "googlesheets", true], ["GOOGLEDRIVE_DOWNLOAD_FILE", "googledrive", false], ["GOOGLEDRIVE_FIND_FILE", "googledrive", false],
    ["CLOSE_LIST_LEADS", "close", false], ["CLOSE_CREATE_LEAD", "close", true], ["MAKE_LIST_SCENARIOS", "make", false], ["STRIPE_CREATE_REFUND", "stripe", true], ["STRIPE_RETRIEVE_BALANCE", "stripe", false],
    ["JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET", "jira", false], ["JIRA_TRANSITION_ISSUE", "jira", true], ["LINEAR_GET_CURRENT_USER", "linear", false], ["TRELLO_DELETE_CARDS_BY_ID_CARD", "trello", true],
  ];
  for (const [slug, toolkit, write] of TRICKY) check(`${slug} is a ${write ? "change" : "read"}`, isWriteTool(slug, toolkit) === write);
  check("hard-to-undo actions are recognised", isDestructiveTool("GITHUB_DELETE_A_REPOSITORY", "github") && isDestructiveTool("STRIPE_CREATE_REFUND", "stripe") && isDestructiveTool("GITHUB_MERGE_A_PULL_REQUEST", "github") && !isDestructiveTool("GITHUB_CREATE_AN_ISSUE", "github") && !isDestructiveTool("SLACK_SEND_MESSAGE", "slack"));

  /* ============================================================ finding the right action among hundreds */
  section("The right action is found for natural requests, in every app");
  clearToolCache();
  const infoOf = new Map<string, ToolInfo[]>();
  for (const t of CATALOG) infoOf.set(t.slug, await listTools(t.slug));
  check("the whole GitHub catalogue (several pages) is read", (infoOf.get("github")?.length ?? 0) === CATALOG[0]!.rows.length && (infoOf.get("github")?.length ?? 0) > 400, String(infoOf.get("github")?.length));
  check("both schema shapes parse: required inputs are known", infoOf.get("github")!.find((t) => t.name === "GITHUB_CREATE_AN_ISSUE")!.parameterDetails!.filter((p) => p.required).map((p) => p.name).sort().join() === "owner,repo,title" && infoOf.get("gmail")!.find((t) => t.name === "GMAIL_SEND_EMAIL")!.parameterDetails!.filter((p) => p.required).map((p) => p.name).sort().join() === "body,recipient_email");
  let top1 = 0, top3 = 0, top40 = 0; const missed: string[] = [];
  for (const [app, q, want] of CASES) {
    const ranked = relevantTools(infoOf.get(app)!, q, 40).map((t) => t.name); const i = ranked.indexOf(want);
    if (i === 0) top1++; if (i >= 0 && i < 3) top3++; if (i >= 0) top40++; else missed.push(`${app}: ${q}`);
  }
  check(`every expected action is within the ${40} shown to the planner (${top40}/${CASES.length})`, top40 === CASES.length, missed.join(" | "));
  check(`the right action is in the top 3 for at least 94% of requests (${top3}/${CASES.length})`, top3 / CASES.length >= 0.94);
  check(`it is first for at least 80% (${top1}/${CASES.length})`, top1 / CASES.length >= 0.8);

  /* ============================================================ argument and result handling */
  section("Arguments are made to fit the schema; big answers are made readable");
  const issue = infoOf.get("github")!.find((t) => t.name === "GITHUB_CREATE_AN_ISSUE")!;
  const fixed = coerceArguments({ owner: "acme", repo: "widget", title: "Bug", labels: "bug, ui", bogus: 1, assignees: ["me"] }, issue);
  check("a comma list becomes an array, unknown names are dropped, valid values are untouched", JSON.stringify(fixed) === JSON.stringify({ owner: "acme", repo: "widget", title: "Bug", labels: ["bug", "ui"], assignees: ["me"] }), JSON.stringify(fixed));
  const merge = infoOf.get("github")!.find((t) => t.name === "GITHUB_MERGE_A_PULL_REQUEST")!;
  check('"12" becomes 12 for an integer input', coerceArguments({ owner: "a", repo: "b", pull_number: "12" }, merge)["pull_number"] === 12);
  const pr = infoOf.get("github")!.find((t) => t.name === "GITHUB_CREATE_A_PULL_REQUEST")!;
  check('"true" becomes true, and numbers become text where text is wanted', coerceArguments({ owner: 5, repo: "b", title: "t", head: "h", base: "b", draft: "true" }, pr)["draft"] === true && coerceArguments({ owner: 5, repo: "b", title: "t", head: "h", base: "b" }, pr)["owner"] === "5");
  const raw = JSON.stringify(bigRepos());
  const compact = compactResult(raw, 9000);
  const names = (compact.match(/project-\d+/g) ?? []);
  check(`60 repositories (${raw.length.toLocaleString()} characters of API plumbing) shrink to a readable ${compact.length.toLocaleString()}`, compact.length <= 10500 && raw.length > 40000, String(compact.length));
  check("the compact answer keeps whole repositories with their names and links, and no API plumbing", new Set(names).size >= 25 && !/api\.github\.com|node_id|gravatar|avatar_url/.test(compact) && /github\.com\/octo\/project-0/.test(compact), `${new Set(names).size} repos`);
  check("it says how many were left out instead of cutting one in half", /_omitted_items/.test(compact) && (() => { try { JSON.parse(compact); return true; } catch { return false; } })());

  /* ============================================================ connections */
  section("Connections: the newest live one is used, expired ones are renewed, a finishing sign-in is waited for");
  const older = { id: "ca_old", toolkit: "github", status: "ACTIVE", createdAt: Date.parse("2026-01-01") }, newer = { id: "ca_new", toolkit: "github", status: "ACTIVE", createdAt: Date.parse("2026-09-01") };
  check("with two live GitHub connections, the newest wins whatever order they arrive in", pickConnection([older, newer], "github")?.id === "ca_new" && pickConnection([newer, older], "github")?.id === "ca_new");
  check("an expired newer connection never shadows a live older one", pickConnection([{ ...newer, status: "EXPIRED" }, older], "github")?.id === "ca_old");
  check("the connection map holds one connection per app", connectionMap([older, newer, { id: "x", toolkit: "slack", status: "ACTIVE" }]).size === 2);
  world.conns["uid-race"] = [{ id: "ca_race", toolkit: "github", status: "INITIATED" }]; world.listCalls = 0; world.activateAfter = 3;
  const waited = await waitForConnection("uid-race", "github", { timeoutMs: 8000, intervalMs: 50 });
  check("a sign-in that is still finishing is waited for until it is ACTIVE", waited?.id === "ca_race" && waited.status === "ACTIVE");
  world.activateAfter = 0;
  const link = await startConnection("uid-a", "gmail", { callbackUrl: "https://zeros.test/chat?connected=gmail" });
  check("connecting any app returns its sign-in link", link.redirectUrl === "https://accounts.example/sign-in" && link.connectionId === "ca_new");
  check("paged connection lists are read", (await listConnections("uid-race")).length === 1);

  /* ============================================================ the agent, app by app */
  section("The agent, end to end: GitHub");
  setup("uid-a", ALL);
  let r = await run("uid-a", "List my GitHub repositories", [{ want: /LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER$/ }]);
  check("listing repos uses the user's own repository list (not the organisation or installation one)", executedTools().join() === "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", executedTools().join());
  check("the read is verified and the answer context carries real repository names and links", r.readResultVerified && /project-0/.test(r.context ?? "") && /github\.com\/octo\/project-/.test(r.context ?? "") && !/api\.github\.com/.test(r.context ?? ""));
  check("more than a handful of repositories reach the answer (not just the first three)", new Set((r.context ?? "").match(/project-\d+/g) ?? []).size >= 20);

  r = await run("uid-a", "Create an issue in acme/widget titled Login bug with labels bug, ui", [{ want: /CREATE_AN_ISSUE$/, args: { owner: "acme", repo: "widget", title: "Login bug", labels: "bug, ui" } }]);
  check("an issue is created with schema-correct arguments (labels became a list)", executedTools().join() === "GITHUB_CREATE_AN_ISSUE" && JSON.stringify((world.executed[0]!.body["arguments"] as Record<string, unknown>)["labels"]) === '["bug","ui"]', JSON.stringify(world.executed));
  check("the change is recorded as a real change", r.steps.some((s) => s.ok && s.write === true && s.tool === "GITHUB_CREATE_AN_ISSUE"));
  check("the app is called through the person's own connection", world.executed[0]!.body["connected_account_id"] === "ca_uid-a_github" && world.executed[0]!.body["user_id"] === "uid-a");

  r = await run("uid-a", "Merge pull request 12 in acme/widget", [{ want: /MERGE_A_PULL_REQUEST$/, args: { owner: "acme", repo: "widget", pull_number: "12" } }]);
  check('"12" reaches the app as the number 12, and an explicitly requested merge goes through', executedTools().join() === "GITHUB_MERGE_A_PULL_REQUEST" && (world.executed[0]!.body["arguments"] as Record<string, unknown>)["pull_number"] === 12, JSON.stringify(world.executed));

  r = await run("uid-a", "In acme/widget create a branch feature/x from main, commit a README.md file to it, and open a pull request into main", [
    { want: /GET_A_REFERENCE$/, args: { owner: "acme", repo: "widget", ref: "heads/main" } },
    { want: /CREATE_A_REFERENCE$/, args: { owner: "acme", repo: "widget", ref: "refs/heads/feature/x", sha: "abc123def456" } },
    { want: /CREATE_OR_UPDATE_FILE_CONTENTS$/, args: { owner: "acme", repo: "widget", path: "README.md", message: "Add README", content: "SGVsbG8=", branch: "feature/x" } },
    { want: /CREATE_A_PULL_REQUEST$/, args: { owner: "acme", repo: "widget", title: "Add README", head: "feature/x", base: "main" } },
  ]);
  check("a multi-step job (read the base, branch, commit a file, open a PR) runs in order", executedTools().join() === "GITHUB_GET_A_REFERENCE,GITHUB_CREATE_A_REFERENCE,GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS,GITHUB_CREATE_A_PULL_REQUEST", executedTools().join());
  check("every step of it succeeded", r.steps.filter((s) => s.toolkit).every((s) => s.ok));

  r = await run("uid-a", "Check the security situation of acme/widget", [{ want: /LIST_CODE_SCANNING_ALERTS_FOR_A_REPOSITORY$/, args: { owner: "acme", repo: "widget" }, find: "code scanning alerts" }]);
  check("when the right action was not shown, the planner searches for it and then uses it", executedTools().join() === "GITHUB_LIST_CODE_SCANNING_ALERTS_FOR_A_REPOSITORY" && r.steps.some((s) => s.tool === "find_tools" && s.ok), JSON.stringify(r.steps.map((s) => s.tool)));
  check("it was genuinely absent from the first list and present in the next", !/GITHUB_LIST_CODE_SCANNING_ALERTS_FOR_A_REPOSITORY\(/.test(world.prompts[0] ?? "") && /GITHUB_LIST_CODE_SCANNING_ALERTS_FOR_A_REPOSITORY\(/.test(world.prompts[1] ?? ""));

  r = await run("uid-a", "Get the community profile metrics of acme/widget from GitHub", [{ want: /NO_SUCH_ACTION/, api: { method: "GET", endpoint: "/repos/acme/widget/community/profile" } }]);
  check("with no matching action the app's own API is used (a safety net for anything the account can do)", world.proxied.length === 1 && world.proxied[0]!.endpoint === "/repos/acme/widget/community/profile" && world.proxied[0]!.method === "GET" && world.proxied[0]!.account === "ca_uid-a_github", JSON.stringify(world.proxied));
  check("an API read counts as a verified read", r.steps.some((s) => s.ok && s.read === true));
  check("the raw API proxy uses Composio's current v3.1 endpoint (v3 is retired for it)", world.v31.some((c) => c === "POST /api/v3.1/tools/execute/proxy"), world.v31.join(" | "));

  r = await run("uid-a", "Pin issue 5 in acme/widget", [{ want: /NO_SUCH_ACTION/, api: { method: "PUT", endpoint: "/repos/acme/widget/issues/5/pin", body: { x: 1 } } }]);
  check("a change through the API works when the person asked for a change and allowed changes", world.proxied.length === 1 && world.proxied[0]!.method === "PUT" && r.steps.some((s) => s.write === true && s.ok));

  /* ============================================================ safety */
  section("Safety: nothing changes unless the person asked");
  setup("uid-a", ALL);
  r = await run("uid-a", "Summarize my latest emails", [{ want: /x/, force: "GMAIL_SEND_EMAIL", args: { recipient_email: "evil@x.co", body: "forwarded" } }]);
  check("a summary request never sends an email, even if an email's text talks the planner into trying", !executedTools().includes("GMAIL_SEND_EMAIL") && r.steps.some((s) => !s.ok && /did not match an available tool/i.test(s.result)), JSON.stringify([executedTools(), r.steps.map((s) => s.result.slice(0, 60))]));
  check("send actions are not even offered on a read-only request", !/GMAIL_SEND_EMAIL\(/.test(world.prompts[0] ?? ""));
  r = await run("uid-a", "Update the README in acme/widget", [{ want: /DELETE_A_REPOSITORY$/, args: { owner: "acme", repo: "widget" }, find: "delete repository" }]);
  check("an unrequested delete is refused even when changes are allowed (and the search that surfaced it is allowed)", executedTools().length === 0 && r.steps.some((s) => s.tool === "GITHUB_DELETE_A_REPOSITORY" && !s.ok && /delete|confirm/i.test(s.result)), JSON.stringify(r.steps.map((s) => [s.tool, s.ok, s.result.slice(0, 50)])));
  r = await run("uid-a", "Delete the branch old-feature in acme/widget", [{ want: /DELETE_A_REFERENCE$/, args: { owner: "acme", repo: "widget", ref: "heads/old-feature" } }]);
  check("a delete the person asked for goes through", executedTools().join() === "GITHUB_DELETE_A_REFERENCE");
  setup("uid-ro", { github: "ACTIVE" }, { github: { enabled: true, allowWrites: false } });
  r = await run("uid-ro", "Create an issue on GitHub in acme/widget titled Hello", [{ want: /CREATE_AN_ISSUE$/, args: { owner: "acme", repo: "widget", title: "Hello" } }]);
  check("with Allow changes OFF a change is refused, nothing is sent, and the reason is plain", executedTools().length === 0 && !!r.blockedRequestedApp && /read-only/.test(r.blockedReason ?? ""), JSON.stringify([r.blockedReason, executedTools()]));
  r = await run("uid-ro", "Create an issue in acme/widget titled Hello", [{ want: /CREATE_AN_ISSUE$/, args: { owner: "acme", repo: "widget", title: "Hello" } }]);
  check("even without naming the app, the answer is told changes are OFF and where to turn them on", executedTools().length === 0 && /Allow changes.*OFF.*Settings/s.test(r.context ?? ""), r.context?.slice(-300));
  r = await run("uid-ro", "List my GitHub repositories", [{ want: /LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER$/ }]);
  check("a read-only app can still be read", executedTools().length === 1 && r.readResultVerified);

  /* ============================================================ connections in the agent */
  section("Expired, duplicate and renewed sign-ins");
  setup("uid-b", { github: [{ status: "ACTIVE", id: "ca_stale", created_at: "2026-01-01T00:00:00Z" }, { status: "ACTIVE", id: "ca_fresh", created_at: "2026-09-01T00:00:00Z" }], notion: "EXPIRED" });
  r = await run("uid-b", "Search my notion for roadmap", [{ want: /NOTION_SEARCH_NOTION_PAGE$/, args: { query: "roadmap" } }]);
  check("an expired sign-in is renewed automatically and then used", world.refreshes.includes("ca_uid-b_notion") && executedTools().join() === "NOTION_SEARCH_NOTION_PAGE" && r.readResultVerified, JSON.stringify([world.refreshes, executedTools(), r.context]));
  check("the renewal and the action call both use the v3.1 endpoints", world.v31.some((c) => /^POST \/api\/v3\.1\/connected_accounts\/[^/]+\/refresh$/.test(c)) && world.v31.some((c) => /^POST \/api\/v3\.1\/tools\/execute\/NOTION_SEARCH_NOTION_PAGE$/.test(c)), world.v31.join(" | "));
  r = await run("uid-b", "Get my github profile", [{ want: /GET_THE_AUTHENTICATED_USER$/ }]);
  check("with two sign-ins for one app the newest is the one that is used", world.executed[0]?.body["connected_account_id"] === "ca_fresh", JSON.stringify(world.executed[0]?.body));
  setup("uid-b", { slack: "EXPIRED" }); world.expiredRefreshOk = false;
  r = await run("uid-b", "Post hello in the general channel on Slack", [{ want: /SLACK_SEND_MESSAGE$/, args: { channel: "general", text: "hello" } }]);
  world.expiredRefreshOk = true;
  check("a sign-in that cannot be renewed says so and is not used", executedTools().length === 0 && /reconnect|not usable|no verified active connection/i.test(r.context ?? ""));

  /* ============================================================ every app, every kind of request */
  section("Every app: the agent finds and runs the right action for each request");
  setup("uid-a", ALL);
  const fill = (row: Row): Record<string, unknown> => {
    const defs = typeof (row.input_parameters as { type?: unknown }).type === "string" && (row.input_parameters as { properties?: unknown }).properties ? ((): Record<string, { type: string; required?: boolean }> => { const p = row.input_parameters as { properties: Record<string, { type: string }>; required: string[] }; return Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, { type: v.type, required: p.required.includes(k) }])); })() : (row.input_parameters as Record<string, { type: string; required?: boolean }>);
    const out: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(defs)) if (d.required) out[k] = d.type === "integer" ? "7" : d.type === "boolean" ? "true" : d.type === "array" ? "a, b" : `${k}-value`;
    return out;
  };
  let okApps = new Set<string>(), total = 0, good = 0; const bad: string[] = [];
  for (const [app, text, want] of CASES) {
    total++;
    const entry = ROWS.get(want)!;
    const wantsChange = isWriteTool(want, app);
    // changes are only attempted for requests that actually ask for one (they do); delete requests say so
    r = await run("uid-a", text, [{ want: new RegExp(`^${want}$`), args: fill(entry.row), find: text }]);
    const ran = executedTools();
    const ok = ran.length === 1 && ran[0] === want && r.steps.filter((s) => s.toolkit).every((s) => s.ok);
    if (ok) { good++; okApps.add(app); } else bad.push(`[${app}] ${text} -> ${ran.join(",") || "nothing"} ${wantsChange ? "(change)" : ""} ${r.steps.filter((s) => !s.ok).map((s) => s.result.slice(0, 80)).join(" / ")}`);
  }
  check(`${good} of ${total} requests across ${okApps.size} apps ran exactly the right action, with arguments the app accepted`, good === total, bad.slice(0, 6).join(" || "));
  check("every one of the 21 apps worked", okApps.size === CATALOG.length, `${okApps.size}`);

  section("An app named in a message is found even when no verb or noun of ours matches");
  setup("uid-a", ALL);
  r = await run("uid-a", "What's in my Airtable bases?", [{ want: /AIRTABLE_LIST_BASES$/ }]);
  check("naming one of the person's own apps is enough for it to be used", executedTools().join() === "AIRTABLE_LIST_BASES" && r.readResultVerified, executedTools().join());

  /* ============================================================ GitHub authorized directly (no Composio) */
  section("GitHub authorized directly works for everything the account can do");
  const env = process.env as Record<string, string>;
  await finishGitHubOAuth("uid-native", "any-code", "https://zeros-ai.pages.dev", { env, fetch: globalThis.fetch });
  world.conns["uid-native"] = []; world.perms = world.perms.filter((p) => p.user_id !== "uid-native"); world.perms.push({ user_id: "uid-native", toolkit_slug: "github", enabled: true, allow_writes: true });
  r = await run("uid-native", "List the open issues in acme/widget on GitHub", [{ want: /NO_SUCH_ACTION/, api: { method: "GET", endpoint: "/repos/acme/widget/issues", query: { state: "open" } } }]);
  const read = world.githubCalls.find((c) => c.method === "GET" && c.path.startsWith("/repos/acme/widget/issues"));
  check("with only direct GitHub the account is read through GitHub's API with the person's own token", !!read && read.auth === "Bearer ghu_native_access" && /state=open/.test(read.path), JSON.stringify(world.githubCalls));
  check("that read is verified and its real content reaches the answer", r.readResultVerified && /Login is slow/.test(r.context ?? ""));
  r = await run("uid-native", "Create an issue in acme/widget titled Hello from Zeros", [{ want: /NO_SUCH_ACTION/, api: { method: "POST", endpoint: "/repos/acme/widget/issues", body: { title: "Hello from Zeros" } } }]);
  const wrote = world.githubCalls.find((c) => c.method === "POST");
  check("and it can make changes (create an issue) when allowed", !!wrote && (wrote.body as { title?: string })?.title === "Hello from Zeros" && r.steps.some((s) => s.ok && s.write === true), JSON.stringify(world.githubCalls));
  world.perms = world.perms.filter((p) => p.user_id !== "uid-native"); world.perms.push({ user_id: "uid-native", toolkit_slug: "github", enabled: true, allow_writes: false });
  r = await run("uid-native", "Create an issue in acme/widget titled Nope", [{ want: /NO_SUCH_ACTION/, api: { method: "POST", endpoint: "/repos/acme/widget/issues", body: { title: "Nope" } } }]);
  check("direct GitHub respects Allow changes OFF: nothing is sent and the reason is plain", !world.githubCalls.some((c) => c.method === "POST") && r.steps.some((st) => !st.ok && /changes are OFF/.test(st.result)), JSON.stringify(r.steps));

  /* ============================================================ the routes */
  section("Routes: finishing a sign-in, switching apps on, testing every app");
  clearIdentityCache();
  type H = { Route: { server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> } } };
  const finish = (await import(routeUrl("api_apps_finish"))) as H, perms = (await import(routeUrl("api_apps_permissions"))) as H, verify = (await import(routeUrl("api_apps_verify"))) as H, index = (await import(routeUrl("api_apps_index"))) as H;
  const req = (path: string, token: string | null, body?: unknown) => new Request(`https://zeros.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  world.conns["uid-race"] = [{ id: "ca_race", toolkit: "github", status: "INITIATED" }]; world.perms = world.perms.filter((p) => p.user_id !== "uid-race"); world.listCalls = 0; world.activateAfter = 3;
  let res = await finish.Route.server.handlers["POST"]!({ request: req("/api/apps/finish", "tok-race", { toolkit: "github" }) });
  let body = (await res.json()) as { ok: boolean; permission?: { enabled: boolean; allowWrites: boolean } };
  check("returning from a sign-in that is still finishing waits, then switches the app on with chat and changes enabled", res.status === 200 && body.ok && body.permission?.enabled === true && body.permission.allowWrites === true, JSON.stringify(body));
  world.activateAfter = 0;
  world.perms = world.perms.filter((p) => p.user_id !== "uid-race"); world.perms.push({ user_id: "uid-race", toolkit_slug: "github", enabled: false, allow_writes: false });
  res = await finish.Route.server.handlers["POST"]!({ request: req("/api/apps/finish", "tok-race", { toolkit: "github" }) });
  body = (await res.json()) as typeof body;
  check("reconnecting keeps a person's earlier read-only choice", body.ok && body.permission?.enabled === true && body.permission.allowWrites === false);
  res = await finish.Route.server.handlers["POST"]!({ request: req("/api/apps/finish", "tok-a", { toolkit: "not a slug!" }) });
  check("finishing requires a real app", res.status === 400);
  res = await finish.Route.server.handlers["POST"]!({ request: req("/api/apps/finish", null, { toolkit: "github" }) });
  check("finishing requires sign-in", res.status === 401);

  world.conns["uid-b"] = [{ id: "ca_b_pending", toolkit: "slack", status: "INITIATED" }]; world.listCalls = 0; world.activateAfter = 4;
  res = await perms.Route.server.handlers["POST"]!({ request: req("/api/apps/permissions", "tok-b", { toolkit: "slack", enabled: true }) });
  check("switching on an app whose sign-in is still finishing waits instead of refusing", res.status === 200 && ((await res.json()) as { enabled: boolean }).enabled === true);
  world.activateAfter = 0;
  res = await perms.Route.server.handlers["POST"]!({ request: req("/api/apps/permissions", "tok-b", { toolkit: "asana", enabled: true }) });
  check("switching on an app that is not connected is refused at once", res.status === 409);
  world.perms = world.perms.filter((p) => p.user_id !== "uid-native");
  res = await perms.Route.server.handlers["POST"]!({ request: req("/api/apps/permissions", "tok-native", { toolkit: "github", enabled: true }) });
  check("direct GitHub can be switched on like any app", res.status === 200 && ((await res.json()) as { enabled: boolean }).enabled === true);

  setup("uid-a", { github: "ACTIVE", slack: "ACTIVE", notion: "EXPIRED", discord: "ACTIVE", todoist: "INITIATED" }, { slack: { enabled: false, allowWrites: false }, discord: { enabled: true, allowWrites: true }, github: { enabled: true, allowWrites: true }, notion: { enabled: true, allowWrites: true }, todoist: { enabled: false, allowWrites: false } });
  world.failTools = new Set(["DISCORD_GET_CURRENT_USER", "DISCORD_LIST_MY_GUILDS"]);
  res = await verify.Route.server.handlers["GET"]!({ request: req("/api/apps/verify", "tok-a") });
  const v = (await res.json()) as { results: { toolkit: string; status: string; connection: string; fixes: string[]; notes: string[]; probe: { tool?: string; ok?: boolean } | null; autoFix?: string }[]; summary: string[] };
  const by = (t: string) => v.results.find((x) => x.toolkit === t)!;
  check("a healthy app is proven working with a live read-only test through the real app", by("github").status === "ready" && by("github").probe?.ok === true && /AUTHENTICATED_USER|GET_THE/.test(by("github").probe?.tool ?? ""), JSON.stringify(by("github")));
  check("an app that is connected but switched off is flagged with a one-tap fix", by("slack").status === "attention" && by("slack").autoFix === "enable" && /Use in chat is OFF/.test(by("slack").fixes.join(" ")));
  check("an expired sign-in is renewed during the check and then passes", by("notion").connection === "active" && by("notion").notes.some((n) => /renewed/i.test(n)), JSON.stringify(by("notion")));
  check("an app that refuses the request is reported as not working, with what to do", by("discord").status === "broken" && /Reconnect/i.test(by("discord").fixes.join(" ")), JSON.stringify(by("discord")));
  check("an app still signing in is reported as such", by("todoist").connection === "pending" && by("todoist").status === "attention");
  check("the results are sorted with the worst first and summarised in plain words", v.results[0]!.status === "broken" && v.summary.length === v.results.length);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  res = await verify.Route.server.handlers["GET"]!({ request: req("/api/apps/verify?fix=1&toolkit=slack", "tok-a") });
  const fixedBody = (await res.json()) as { fixed: string[]; results: { toolkit: string; status: string; useInChat: boolean }[] };
  check("the one-tap fix switches the app on", fixedBody.fixed.join() === "slack" && world.perms.find((p) => p.user_id === "uid-a" && p.toolkit_slug === "slack")?.enabled === true);
  res = await verify.Route.server.handlers["GET"]!({ request: req("/api/apps/verify", "tok-a") });
  check("checks are rate limited so they cannot be hammered", res.status === 429);
  const probes = probeCandidates(infoOf.get("github")!);
  check("the test read picks a safe, no-input 'who am I' style action first", probes.length > 0 && probes.every((t) => !t.write && !(t.parameterDetails ?? []).some((p) => p.required)) && /AUTHENTICATED_USER/.test(probes[0]!.name), probes.map((p) => p.name).join());

  setup("uid-a", { github: [{ status: "ACTIVE", id: "ca_stale", created_at: "2026-01-01T00:00:00Z" }, { status: "ACTIVE", id: "ca_fresh", created_at: "2026-09-01T00:00:00Z" }], notion: "EXPIRED", todoist: "INITIATED" });
  res = await index.Route.server.handlers["GET"]!({ request: req("/api/apps?limit=60", "tok-a") });
  const idx = (await res.json()) as { items: { slug: string; connection: { id: string } | null; attention: string | null }[]; connected: { id: string; toolkit: string }[] };
  const item = (s: string) => idx.items.find((x) => x.slug === s)!;
  check("the app list shows the newest connection for an app", item("github").connection?.id === "ca_fresh" && idx.connected.filter((c) => c.toolkit === "github").length === 1);
  check("an expired app is shown as 'reconnect', a finishing one as 'pending', not as 'not connected'", item("notion").attention === "reconnect" && item("notion").connection === null && item("todoist").attention === "pending");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
