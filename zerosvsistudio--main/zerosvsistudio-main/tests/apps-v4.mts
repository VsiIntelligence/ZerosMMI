/**
 * ZerosX2.0 apps: each person connects, enables and changes their own apps. Runs the real route bundles against stubbed Composio,
 * Supabase, Firebase and the text engines. Covers isolation between accounts, permissions, the confirmation for changes, and the chat headers.
 */
import { categoriesOf, clearCatalogCache, composioApiConfigured, executeTool, filterCatalog, isWriteTool, listConnections, listTools, listToolkits, parseToolkit, relevantTools, startConnection, toolBelongsTo, isLive } from "../src/lib/composio-api.server.ts";
import { routeUrl } from "./helpers/bundle-routes.mjs";
import { clearIdentityCache } from "../src/lib/firebase-user.server.ts";
import { findMentionedToolkit, formatConnectionStatusAnswer, isConnectionStatusOnlyQuestion, isConnectorOperationRequest, isExplicitAppReadRequest, isExplicitAppWriteRequest, runAppAgent } from "../src/lib/app-agent.server.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

process.env.COMPOSIO_CONNECTOR_KEY = "";
process.env.COMPOSIO_API_KEY = "ck-test";
process.env.COMPOSIO_API_BASE = "https://composio.test/api/v3";
process.env.ZEROS_A_URL = "https://engine-a.test/v1";
process.env.ZEROS_A_KEYS = "key-a1";
process.env.ZEROS_A_KEY_HEADER = "x-test-key";
process.env.ZEROS_A_MODELS = "a-strong";
process.env.ZEROS_A_FAST_MODELS = "a-fast";
process.env.ZEROS_B_URL = "https://engine-b.test/v1";
process.env.ZEROS_B_KEYS = "key-b1";
process.env.ZEROS_B_MODELS = "b-strong";
process.env.PROMO_CODE = "Open-Sesame-4821";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (text: string) => new Response([`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] })}\n\n`, `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] })}\n\n`].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

type Conn = { id: string; toolkit: string; status: string };
type Perm = { user_id: string; toolkit_slug: string; enabled: boolean; allow_writes: boolean };
const state = {
  plans: { "uid-a": "bronze", "uid-b": "bronze", "uid-c": "bronze", "uid-free": null } as Record<string, string | null>,
  perms: [] as Perm[],
  conns: { "uid-a": [{ id: "ca_1", toolkit: "github", status: "ACTIVE" }], "uid-b": [{ id: "cb_9", toolkit: "github", status: "ACTIVE" }], "uid-c": [] } as Record<string, Conn[]>,
  authConfigs: true,
  canCreateConfig: true,
  created: [] as Record<string, unknown>[],
  toolkitCalls: [] as string[],
  toolCalls: [] as string[],
  rejectSort: false,
  failToolkits: false,
  executed: [] as { tool: string; body: Record<string, unknown> }[],
  deleted: [] as string[],
  linked: [] as Record<string, unknown>[],
  rpc: [] as number[],
  router: '{"tool":null}',
  planner: [] as string[],
  failExecute: false,
  failNextExecute: false,
  failArtifact404: false,
};
const uidOf = (token: string) => ({ "tok-a": "uid-a", "tok-b": "uid-b", "tok-c": "uid-c", "tok-free": "uid-free" } as Record<string, string>)[token] ?? null;

/** Composio's real catalogue shape: logo, description and categories live under `meta`. */
const CATALOG = [
  { slug: "zapier", name: "Zapier", meta: { description: "Automation across thousands of apps", logo: "https://logos.composio.dev/api/zapier", categories: [{ slug: "automation", name: "Automation" }] } },
  { slug: "github", name: "GitHub", logo: null, meta: { description: "Code hosting and issues", categories: [{ slug: "developer-tools", name: "Developer tools" }] } },
  { slug: "gmail", name: "Gmail", meta: { description: "Email from Google", logo: "https://logos.composio.dev/api/gmail", categories: [{ slug: "communication", name: "Communication" }] } },
  { slug: "BAD SLUG!", name: "bad" },
  { slug: "notion", name: "Notion", meta: { description: "Docs and wikis for teams", categories: ["Productivity"] } },
  { slug: "evil", name: "Evil", meta: { logo: "javascript:alert(1)" } },
];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = typeof init?.body === "string" ? init.body : "";
  const method = (init?.method ?? "GET").toUpperCase();
  const h = url.href.replace("/api/v3.1/", "/api/v3/");
  if (h.startsWith("https://identitytoolkit.googleapis.com/")) { const uid = uidOf(JSON.parse(body || "{}").idToken); return uid ? json({ users: [{ localId: uid, email: `${uid}@x.co` }] }) : json({}, 400); }
  if (h.startsWith("https://db.test/rest/v1/zeros_billing?")) { const uid = /user_id=eq\.([^&]+)/.exec(url.search)?.[1] ?? ""; const plan = state.plans[uid]; return json(plan ? [{ plan, subscription_id: `I-${uid}`, status: "ACTIVE", paid_through: new Date(Date.now() + 20 * 86400000).toISOString(), cancel_requested: false, checked_at: new Date().toISOString() }] : []); }
  if (h.startsWith("https://db.test/rest/v1/zeros_promo?")) return json([]);
  if (h.startsWith("https://db.test/rest/v1/zeros_usage?")) return json([]);
  if (h === "https://db.test/rest/v1/rpc/zeros_consume_usage") { const p = JSON.parse(body) as { p_units: number; p_now: string }; state.rpc.push(p.p_units); return json({ allowed: true, used_units: 0, window_start: p.p_now }); }
  if (h.startsWith("https://db.test/rest/v1/zeros_app_permissions?user_id=")) { const uid = /user_id=eq\.([^&]+)/.exec(url.search)?.[1] ?? ""; return json(state.perms.filter((p) => p.user_id === uid).map((p) => ({ toolkit_slug: p.toolkit_slug, enabled: p.enabled, allow_writes: p.allow_writes }))); }
  if (h.startsWith("https://db.test/rest/v1/zeros_app_permissions?on_conflict") && method === "POST") {
    const row = JSON.parse(body) as Perm;
    const i = state.perms.findIndex((p) => p.user_id === row.user_id && p.toolkit_slug === row.toolkit_slug);
    if (i >= 0) state.perms[i] = row; else state.perms.push(row);
    return new Response(null, { status: 201 });
  }
  if (h === "https://api.github.com/app/installations?per_page=100&page=1" && method === "GET") return json([{ id: 42, account: { login: "VsiStudio-Official" } }]);
  if (h === "https://api.github.com/app/installations/42/access_tokens" && method === "POST") return json({ token: "short-lived-route-installation-token" });
  if (h.startsWith("https://api.github.com/installation/repositories?") && method === "GET") return json({ repositories: [
    { id: 77, name: "zerosvsistudio-", full_name: "VsiStudio-Official/zerosvsistudio-", html_url: "https://github.com/VsiStudio-Official/zerosvsistudio-", private: true, description: "Zeros AI", default_branch: "main" }
  ] });
  if (h.startsWith("https://composio.test/api/v3/toolkits")) {
    state.toolkitCalls.push(url.search);
    if (state.failToolkits) return json({ error: "down" }, 500);
    if (state.rejectSort && url.searchParams.has("sort_by")) return json({ error: "unsupported sort" }, 400);
    return url.searchParams.get("cursor") === "c2" ? json({ items: CATALOG.slice(3) }) : json({ items: CATALOG.slice(0, 3), next_cursor: "c2" });
  }
  if (h.startsWith("https://composio.test/api/v3/tools?")) {
    state.toolCalls.push(url.search);
    if (url.searchParams.get("cursor") === "tools-page-2") {
      return json({ items: [{
        slug: "GITHUB_CREATE_GIT_COMMIT",
        description: "Create a git commit that adds or updates repository files",
        input_parameters: {
          required: ["owner", "repo", "message", "tree", "parent"],
          properties: {
            owner: { type: "string", description: "Repository owner" },
            repo: { type: "string", description: "Repository name" },
            message: { type: "string", description: "Commit message" },
            tree: { type: "string", description: "Git tree SHA" },
            parent: { type: "string", description: "Parent commit SHA" }
          }
        }
      }] });
    }
    return json({
      items: [
        { slug: "GITHUB_GET_INTERACTION_RESTRICTIONS_FOR_PUBLIC_REPOS", description: "Get interaction restrictions for public repositories", input_parameters: {} },
        { slug: "GITHUB_LIST_ACCESSIBLE_REPOSITORIES", description: "List repositories accessible to the user through an installation token", input_parameters: {} },
        { slug: "GITHUB_LIST_REPOS", description: "List the repositories of the user", input_parameters: { owner: { type: "string", description: "Repository owner", required: false } } },
        { slug: "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY", description: "List GitHub Actions artifacts for a repository", input_parameters: { owner: { type: "string", description: "Repository owner", required: true }, repo: { type: "string", description: "Repository name", required: true } } },
        { slug: "GITHUB_CREATE_ISSUE", description: "Create an issue in a repository", input_parameters: { title: { type: "string", description: "Issue title", required: true } } },
        { slug: "GITHUB_GET_REPO_METADATA", description: "Get metadata for a repository", input_parameters: {} }
      ],
      next_cursor: "tools-page-2"
    });
  }
  if (h.startsWith("https://composio.test/api/v3/connected_accounts?")) { const uid = decodeURIComponent(/user_ids=([^&]+)/.exec(url.search)?.[1] ?? ""); return json({ items: (state.conns[uid] ?? []).map((c) => ({ id: c.id, status: c.status, toolkit: { slug: c.toolkit } })) }); }
  if (h === "https://composio.test/api/v3/auth_configs" && method === "POST") {
    state.created.push(JSON.parse(body));
    return state.canCreateConfig ? json({ auth_config: { id: "ac_created", is_composio_managed: true } }, 201) : json({ error: "this app needs your own OAuth credentials" }, 400);
  }
  if (h.startsWith("https://composio.test/api/v3/auth_configs")) return json({ items: state.authConfigs ? [{ id: "ac_github", status: "ENABLED" }] : [] });
  if (h === "https://composio.test/api/v3/connected_accounts/link") { state.linked.push(JSON.parse(body)); return json({ redirect_url: "https://github.com/login/oauth/authorize", connected_account_id: "ca_new" }); }
  if (h.startsWith("https://composio.test/api/v3/connected_accounts/") && method === "DELETE") { state.deleted.push(decodeURIComponent(url.pathname.split("/").pop() ?? "")); return new Response(null, { status: 204 }); }
  if (h.startsWith("https://composio.test/api/v3/tools/execute/")) {
    const tool = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const b = JSON.parse(body) as Record<string, unknown>;
    state.executed.push({ tool, body: b });
    const failThisCall = state.failExecute || state.failNextExecute;
    state.failNextExecute = false;
    if (state.failArtifact404 && tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY") {
      return json({ successful: false, error: "GitHub returned HTTP 404: Not Found (status: 404)" });
    }
    return failThisCall ? json({ successful: false, error: "boom from the app" }) : json({ successful: true, data: { repos: ["alpha", "beta"] } });
  }
  if (h.includes(":generateContent")) return body.includes("TOOLS YOU CAN USE:") ? json({ candidates: [{ content: { parts: [{ text: state.planner.shift() ?? '{"done":true}' }] } }] }) : json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  if (h.includes(":streamGenerateContent")) return sse("Here is what I found.");
  if (h === "https://engine-b.test/v1/chat/completions") return new Response('data: {"choices":[{"delta":{"content":"fallback"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  return json({ error: `unexpected ${method} ${h}` }, 500);
}) as typeof fetch;

async function main(): Promise<void> {
  /* ================================================================ the Composio REST layer */
  section("Composio: connections, actions and their parsing");
  const toolkits = await listToolkits();
  check("the catalogue keeps valid app slugs, follows the pages, and drops malformed ones", toolkits.map((t) => t.slug).join(",") === "zapier,github,gmail,notion,evil", toolkits.map((t) => t.slug).join(","));
  check("the catalogue was read in two pages with the most-used apps first", state.toolkitCalls.length === 2 && /sort_by=usage/.test(state.toolkitCalls[0]!) && /cursor=c2/.test(state.toolkitCalls[1]!), state.toolkitCalls.join(" | "));
  check("every app has its own logo: Composio's, or the address derived from its name", toolkits.find((t) => t.slug === "gmail")?.logo === "https://logos.composio.dev/api/gmail" && toolkits.find((t) => t.slug === "github")?.logo === "https://logos.composio.dev/api/github");
  check("a logo that is not an https address is never used", toolkits.find((t) => t.slug === "evil")?.logo === "https://logos.composio.dev/api/evil");
  check("descriptions and categories are read from the listing", toolkits.find((t) => t.slug === "github")?.description === "Code hosting and issues" && toolkits.find((t) => t.slug === "notion")?.categories[0]?.slug === "productivity");
  await listToolkits();
  check("the catalogue is kept for half an hour (no new calls)", state.toolkitCalls.length === 2);
  check("a row with no name falls back to a readable one", parseToolkit({ slug: "google_drive" })?.name === "Google Drive");
  check("without search words the well-known apps come first, in order", filterCatalog(toolkits).map((t) => t.slug).join(",") === "gmail,notion,github,zapier,evil", filterCatalog(toolkits).map((t) => t.slug).join(","));
  check("searching ranks the best name match first and also searches descriptions", filterCatalog(toolkits, { q: "git" })[0]?.slug === "github" && filterCatalog(toolkits, { q: "docs" }).map((t) => t.slug).join() === "notion" && filterCatalog(toolkits, { q: "zzz" }).length === 0);
  check("a category shows only its own apps", filterCatalog(toolkits, { category: "communication" }).map((t) => t.slug).join() === "gmail");
  check("the directory offers categories to browse by", categoriesOf(toolkits).map((c) => c.slug).sort().join() === "automation,communication,developer-tools,productivity");
  clearCatalogCache(); state.toolkitCalls.length = 0; state.rejectSort = true;
  const strict = await listToolkits();
  check("an API that refuses the sort option still answers (the first page is retried without it)", strict.length === 5 && !/sort_by/.test(state.toolkitCalls.at(-1) ?? ""), state.toolkitCalls.join(" | "));
  state.rejectSort = false; clearCatalogCache(); await listToolkits(); state.failToolkits = true; state.toolkitCalls.length = 0;
  const kept = await listToolkits();
  check("if Composio is briefly unreachable the last directory is still shown", kept.length === 5);
  state.failToolkits = false;
  const gh = await listTools("github");
  check("actions carry their read/change flag and their parameters", gh.find((t) => t.name === "GITHUB_CREATE_ISSUE")?.write === true && gh.find((t) => t.name === "GITHUB_LIST_REPOS")?.write === false && gh.find((t) => t.name === "GITHUB_CREATE_ISSUE")?.parameters.join() === "title", JSON.stringify(gh));
  check("current Composio input_parameters are parsed into parameters and required flags", gh.find((t) => t.name === "GITHUB_LIST_REPOS")?.parameterDetails?.some((p) => p.name === "owner" && p.type === "string" && !p.required) === true && gh.find((t) => t.name === "GITHUB_CREATE_ISSUE")?.parameterDetails?.some((p) => p.name === "title" && p.required) === true, JSON.stringify(gh));
  check("GitHub Actions artifact listing marks the repository owner and name as required", gh.find((t) => t.name === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY")?.parameterDetails?.filter((p) => p.required).map((p) => p.name).sort().join(",") === "owner,repo", JSON.stringify(gh));
  check("tool catalogue calls explicitly request the latest toolkit version", state.toolCalls.length > 0 && state.toolCalls.every((query) => new URLSearchParams(query).get("toolkit_versions") === "latest"), JSON.stringify(state.toolCalls));
  check("the action catalogue follows pagination and keeps required parameter schemas", gh.some((t) => t.name === "GITHUB_CREATE_GIT_COMMIT") && gh.find((t) => t.name === "GITHUB_CREATE_GIT_COMMIT")?.parameterDetails?.some((parameter) => parameter.name === "message" && parameter.required && parameter.type === "string") === true, JSON.stringify(gh));
  check("commit/edit wording prioritizes the real commit operation", relevantTools(gh, "commit these changes to GitHub")[0]?.name === "GITHUB_CREATE_GIT_COMMIT", relevantTools(gh, "commit these changes to GitHub").map((t) => t.name).join(","));
  check("a person's connections are listed with their app and status", (await listConnections("uid-a")).map((c) => `${c.id}:${c.toolkit}:${c.status}`).join() === "ca_1:github:ACTIVE");
  check("only live connections count", isLive({ id: "x", toolkit: "github", status: "ACTIVE" }) && !isLive({ id: "x", toolkit: "github", status: "EXPIRED" }));
  const disabledConnection = await runAppAgent({ uid: "uid-a", messages: [{ role: "user", content: "Are you connected to GitHub?" }] });
  const disabledStatus = (disabledConnection.context ?? "").toLowerCase();
  check("Zeros knows a live connection exists even when Use in chat is OFF", disabledStatus.includes("github (github): authenticated connection active; use in chat: off; allow changes: off") && disabledConnection.apps.length === 0, disabledConnection.context ?? "no status context");
  check("a disabled connection cannot execute an action just to answer a connection-status question", disabledConnection.steps.length === 0);
  check("connection-only questions are separated from requests for real app data", isConnectionStatusOnlyQuestion("Are you connected to my personal GitHub account?") && !isConnectionStatusOnlyQuestion("Are you connected through Composio to GitHub, and can you see a repo named zerosvsistudio-?"));
  const verifiedGithubStatus = { connectionsVerified: true, permissionsVerified: true, connections: [{ id: "ca_1", toolkit: "github", status: "ACTIVE" }], permissions: [] };
  const githubStatusAnswer = formatConnectionStatusAnswer("Are you connected to my personal GitHub account?", verifiedGithubStatus, toolkits);
  const gmailStatusAnswer = formatConnectionStatusAnswer("Are you connected to my Gmail account?", { connectionsVerified: true, permissionsVerified: true, connections: [], permissions: [] }, toolkits);
  check("GitHub connection answers come from the registry and include chat permission state", /active GitHub connection/.test(githubStatusAnswer) && /Use in chat.*OFF/.test(githubStatusAnswer), githubStatusAnswer);
  check("connection status works for other apps too", /No connection for that app/.test(gmailStatusAnswer) && /Gmail/.test(gmailStatusAnswer), gmailStatusAnswer);
  check("natural phrasing such as one of my repos is treated as an app data lookup", isExplicitAppReadRequest("Tell me name of any one of my repo from connected GitHub account") && isExplicitAppReadRequest("Can you see a repo named zerosvsistudio-?") && !isExplicitAppReadRequest("Are you connected to GitHub?"));
  check("natural read/write intent is recognized for multiple connected apps", isConnectorOperationRequest("Tell me one repository in my GitHub account") && isConnectorOperationRequest("Create an issue in GitHub") && isExplicitAppWriteRequest("Create an issue in GitHub") && !isExplicitAppWriteRequest("How do I create an issue in GitHub?"));
  check("natural email-summary requests still invoke connected apps while draft requests stay writes", isConnectorOperationRequest("Summarize my latest emails in Gmail") && isExplicitAppReadRequest("Summarize my latest emails in Gmail", ["gmail"]) && isConnectorOperationRequest("Summarise recent Gmail messages") && isConnectorOperationRequest("Review my recent Gmail messages") && isConnectorOperationRequest("Analyze my latest Gmail emails") && isConnectorOperationRequest("Draft an email in Gmail") && isExplicitAppWriteRequest("Draft an email in Gmail") && !isExplicitAppReadRequest("Draft an email in Gmail", ["gmail"]));
  check("app-name requests without a named data object still route to the correct app", isConnectorOperationRequest("Check my Gmail") && isExplicitAppReadRequest("Check my Gmail", ["gmail"]) && isConnectorOperationRequest("Search Slack") && isExplicitAppReadRequest("Search Slack", ["slack"]) && !isConnectorOperationRequest("How do I use Gmail?"));
  check("workflow artifact questions are classified as live GitHub data reads", isConnectorOperationRequest("List GitHub Actions artifacts for acme/widget") && isExplicitAppReadRequest("List GitHub Actions artifacts for acme/widget", ["github"]));
  check("app names resolve from the live directory", findMentionedToolkit("Tell me one repository from GitHub", toolkits)?.slug === "github" && findMentionedToolkit("Find a message from Gmail", toolkits)?.slug === "gmail" && findMentionedToolkit("Open Google Drive", [{ slug: "googledrive", name: "Google Drive" }])?.slug === "googledrive");
  check("plural repository wording also triggers live lookup", isExplicitAppReadRequest("Tell me one of my GitHub repositories", ["github"]));
  check("the read classifier covers non-GitHub apps using each connected toolkit name", isExplicitAppReadRequest("List latest transactions on Stripe", ["stripe"]) && isExplicitAppReadRequest("Find recent issues in Linear", ["linear"]) && isExplicitAppReadRequest("Show unread messages in Slack", ["slack"]));
  check("singular repo lookup ranks the actual repository-list action first", relevantTools(gh, "Tell me name of any one of my repo from connected GitHub account")[0]?.name === "GITHUB_LIST_REPOS", relevantTools(gh, "Tell me name of any one of my repo from connected GitHub account").map((tool) => tool.name).join(","));
  // Retry a planner that tries to stop before reading; the app agent should still use the matching read-only action.
  state.perms.push({ user_id: "uid-a", toolkit_slug: "github", enabled: true, allow_writes: false });
  state.planner = ['{"done":true}', '{"tool":"GITHUB_LIST_REPOS","arguments":{"owner":"me"}}'];
  state.executed.length = 0;
  const naturalRead = await runAppAgent({ uid: "uid-a", messages: [{ role: "user", content: "Tell me name of any one of my repo from connected GitHub account" }] });
  check("a live-data request retries a no-op plan and runs a matching read action", naturalRead.apps.includes("github") && state.executed.some((call) => call.tool === "GITHUB_LIST_REPOS") && naturalRead.steps.some((step) => step.ok && step.tool === "GITHUB_LIST_REPOS"), JSON.stringify(naturalRead.steps));
  // If the planner keeps returning done instead of calling a tool, a safe deterministic read fallback must still run.
  state.planner = ['{"done":true}', '{"done":true}', '{"done":true}'];
  state.executed.length = 0;
  const fallbackRead = await runAppAgent({ uid: "uid-a", messages: [{ role: "user", content: "Tell me one repo from my GitHub account" }] });
  check("a no-op planner falls back to the best read-only tool when it requires no arguments", fallbackRead.readResultVerified && state.executed.some((call) => call.tool === "GITHUB_LIST_REPOS") && fallbackRead.steps.some((step) => step.ok && step.tool === "GITHUB_LIST_REPOS" && step.result.includes("alpha")), JSON.stringify({ executed: state.executed.map((c) => c.tool), steps: fallbackRead.steps }));

  // A successful neighboring action must not satisfy a request for a repository list.
  // The planner first returns public-repository interaction restrictions, then a no-op; Zeros
  // must continue and run the target-specific repository action instead of treating the first
  // provider success as the requested answer.
  state.planner = [
    '{"tool":"GITHUB_GET_INTERACTION_RESTRICTIONS_FOR_PUBLIC_REPOS","arguments":{}}',
    '{"done":true}',
    '{"tool":"GITHUB_LIST_REPOS","arguments":{"owner":"me"}}'
  ];
  state.executed.length = 0;
  const targetVerifiedRead = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "What are my GitHub repositories for an organization?" }]
  });
  check(
    "an unrelated successful read does not verify the requested repository data and the planner recovers",
    targetVerifiedRead.readResultVerified &&
      state.executed[0]?.tool === "GITHUB_GET_INTERACTION_RESTRICTIONS_FOR_PUBLIC_REPOS" &&
      state.executed.some((call) => call.tool === "GITHUB_LIST_REPOS") &&
      targetVerifiedRead.steps.some((step) => step.ok && step.tool === "GITHUB_LIST_REPOS"),
    JSON.stringify({ executed: state.executed.map((c) => c.tool), verified: targetVerifiedRead.readResultVerified, steps: targetVerifiedRead.steps })
  );
  check(
    "the final answer context excludes the unrelated successful read after the correct repository list is retrieved",
    !targetVerifiedRead.context.includes("GITHUB_GET_INTERACTION_RESTRICTIONS_FOR_PUBLIC_REPOS -> succeeded") &&
      targetVerifiedRead.context.includes("VERIFIED TARGET-SPECIFIC APP RESULT") &&
      targetVerifiedRead.context.includes("GITHUB_LIST_REPOS -> succeeded"),
    targetVerifiedRead.context
  );

  // The installation-scoped endpoint returns 403 unless a GitHub App installation token is used.
  // For a user's own repositories, skip it and choose the ordinary repository-list action.
  state.planner = [
    '{"tool":"GITHUB_LIST_ACCESSIBLE_REPOSITORIES","arguments":{}}',
    '{"tool":"GITHUB_LIST_REPOS","arguments":{"owner":"me"}}'
  ];
  state.executed.length = 0;
  const installationTokenRead = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "What are my GitHub repositories for an organization?" }]
  });
  check(
    "an installation-token-only repository endpoint is skipped in favor of the user's repository list",
    installationTokenRead.readResultVerified &&
      !state.executed.some((call) => call.tool === "GITHUB_LIST_ACCESSIBLE_REPOSITORIES") &&
      state.executed.some((call) => call.tool === "GITHUB_LIST_REPOS") &&
      installationTokenRead.steps.some((step) => step.tool === "GITHUB_LIST_ACCESSIBLE_REPOSITORIES" && !step.ok && step.result.includes("installation access token")),
    JSON.stringify({ executed: state.executed.map((c) => c.tool), verified: installationTokenRead.readResultVerified, steps: installationTokenRead.steps })
  );

  // Ordinary questions phrased as questions (not commands) use the deterministic target too.
  state.planner = [];
  state.executed.length = 0;
  const questionRead = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "What are my GitHub repositories?" }]
  });
  check(
    "a natural-language repository question directly runs the repository-list tool",
    questionRead.readResultVerified && state.executed[0]?.tool === "GITHUB_LIST_REPOS",
    JSON.stringify({ executed: state.executed.map((c) => c.tool), steps: questionRead.steps })
  );


  // Artifact listing is repository-scoped: never guess a repository or send "me" as the owner.
  state.planner = [
    '{"tool":"GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY","arguments":{"owner":"me","repo":"my-repo"}}',
    '{"done":true}',
    '{"done":true}'
  ];
  state.executed.length = 0;
  const ungroundedArtifacts = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "List GitHub Actions artifacts for my repository" }]
  });
  check(
    "an artifact lookup without a known repository is blocked before reaching GitHub",
    !state.executed.some((call) => call.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY") &&
      ungroundedArtifacts.steps.some((step) => step.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY" && !step.ok && /exact repository owner and name/i.test(step.result)),
    JSON.stringify({ executed: state.executed.map((call) => call.tool), steps: ungroundedArtifacts.steps })
  );

  state.planner = [
    '{"tool":"GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY","arguments":{"owner":"acme"}}',
    '{"done":true}',
    '{"done":true}'
  ];
  state.executed.length = 0;
  const missingArtifactArgument = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "List GitHub Actions artifacts for acme/widget" }]
  });
  check(
    "a tool with missing required parameters is stopped before the provider is called",
    !state.executed.some((call) => call.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY") &&
      missingArtifactArgument.steps.some((step) => step.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY" && /required parameter.*repo.*missing/i.test(step.result)),
    JSON.stringify({ executed: state.executed.map((call) => call.tool), steps: missingArtifactArgument.steps })
  );

  state.planner = ['{"tool":"GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY","arguments":{"owner":"acme","repo":"widget"}}'];
  state.executed.length = 0;
  const validArtifactLookup = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "List GitHub Actions artifacts for acme/widget" }]
  });
  check(
    "a repository-scoped artifact request runs when its exact owner and repository are provided",
    validArtifactLookup.readResultVerified &&
      state.executed.filter((call) => call.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY").length === 1 &&
      validArtifactLookup.steps.some((step) => step.ok && step.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY"),
    JSON.stringify({ executed: state.executed.map((call) => call.tool), steps: validArtifactLookup.steps })
  );

  state.failArtifact404 = true;
  state.planner = [
    '{"tool":"GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY","arguments":{"owner":"acme","repo":"widget"}}',
    '{"tool":"GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY","arguments":{"owner":"acme","repo":"widget"}}',
    '{"done":true}',
    '{"done":true}'
  ];
  state.executed.length = 0;
  const artifactNotFound = await runAppAgent({
    uid: "uid-a",
    messages: [{ role: "user", content: "List GitHub Actions artifacts for acme/widget" }]
  });
  state.failArtifact404 = false;
  check(
    "a permanent GitHub 404 is explained and the identical request is not sent twice",
    state.executed.filter((call) => call.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY").length === 1 &&
      artifactNotFound.steps.some((step) => step.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY" && !step.ok && /GitHub 404 guidance/i.test(step.result)) &&
      artifactNotFound.steps.some((step) => step.tool === "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY" && !step.ok && /Not retried/i.test(step.result)),
    JSON.stringify({ executed: state.executed.map((call) => call.tool), steps: artifactNotFound.steps })
  );

  // Older planner responses used action/parameters and friendly action slugs instead of exact Composio tool names.
  state.failNextExecute = true;
  state.planner = ['{"action":"list_repos","parameters":{}}', '{"action":"list_repos","parameters":{}}'];
  state.executed.length = 0;
  const legacyRead = await runAppAgent({ uid: "uid-a", messages: [{ role: "user", content: "Tell me one release from my GitHub account" }] });
  check("the older action/parameters response maps to the exact authorized Composio tool", state.executed[0]?.tool === "GITHUB_LIST_REPOS" && legacyRead.steps.some((step) => step.ok && step.tool === "GITHUB_LIST_REPOS"), JSON.stringify(legacyRead.steps));
  check("a transient read failure is retried once and Zeros waits for the live result", state.executed.length === 2 && legacyRead.readResultVerified && legacyRead.steps.some((step) => step.ok && step.result.includes("alpha")), JSON.stringify({ executed: state.executed.length, steps: legacyRead.steps }));

  // An explicitly named app must be the only provider available to the planner for this turn.
  state.conns["uid-a"]!.push({ id: "gmail-a", toolkit: "gmail", status: "ACTIVE" });
  state.perms.push({ user_id: "uid-a", toolkit_slug: "gmail", enabled: true, allow_writes: false });
  state.planner = ['{"tool":"GITHUB_LIST_REPOS","arguments":{"owner":"me"}}'];
  state.executed.length = 0;
  const scopedGithub = await runAppAgent({ uid: "uid-a", messages: [{ role: "user", content: "Tell me one repository from my GitHub account" }] });
  check("a GitHub request stays scoped to GitHub when Gmail is connected too", scopedGithub.requestedToolkit === "github" && scopedGithub.apps.includes("github") && !scopedGithub.apps.includes("gmail") && state.executed.at(-1)?.body["connected_account_id"] === "ca_1", JSON.stringify({ requested: scopedGithub.requestedToolkit, apps: scopedGithub.apps }));

  // Notion is present in the live catalog but is not connected in this test account.
  state.executed.length = 0;
  state.planner = [];
  const blockedNotion = await runAppAgent({ uid: "uid-a", messages: [{ role: "user", content: "Find a document in my Notion workspace" }] });
  check("an unconnected named app is blocked instead of silently using GitHub or Gmail", blockedNotion.blockedRequestedApp === "notion" && blockedNotion.steps.length === 0 && state.executed.length === 0 && (blockedNotion.context ?? "").includes("No other app was used as a substitute"), JSON.stringify(blockedNotion));

  state.conns["uid-a"] = state.conns["uid-a"]!.filter((connection) => connection.toolkit !== "gmail");
  state.perms = state.perms.filter((permission) => !(permission.user_id === "uid-a" && permission.toolkit_slug === "gmail"));
  state.planner = [];
  state.executed.length = 0;
  state.planner = [];
  state.perms = state.perms.filter((permission) => !(permission.user_id === "uid-a" && permission.toolkit_slug === "github"));
  state.authConfigs = false; state.canCreateConfig = false;
  const noConfig = await startConnection("uid-a", "gmail").catch((e: Error) => e.message);
  check("an app that cannot be set up automatically says exactly what to do", typeof noConfig === "string" && /auth configuration/.test(noConfig) && /Gmail/.test(noConfig), String(noConfig));
  state.canCreateConfig = true; state.created.length = 0; state.linked.length = 0;
  const auto = await startConnection("uid-c", "gmail", { callbackUrl: "https://zeros.test/chat?connected=gmail" });
  const createdBody = state.created[0] as { toolkit?: { slug?: string }; auth_config?: { type?: string } } | undefined;
  check("an app with no configuration is set up automatically with Composio's own sign-in (no dashboard work)", createdBody?.toolkit?.slug === "gmail" && createdBody.auth_config?.type === "use_composio_managed_auth" && state.linked.at(-1)?.["auth_config_id"] === "ac_created", JSON.stringify(state.created));
  check("the person is sent back to Zeros after signing in to the app", state.linked.at(-1)?.["callback_url"] === "https://zeros.test/chat?connected=gmail");
  state.authConfigs = true;
  const link = await startConnection("uid-c", "github");
  check("connecting returns the app's sign-in link, for this person only", link.redirectUrl.startsWith("https://github.com") && link.connectionId === "ca_new" && state.linked.at(-1)?.["user_id"] === "uid-c" && state.linked.at(-1)?.["auth_config_id"] === "ac_github", JSON.stringify(link));
  state.failExecute = false;
  await executeTool("uid-b", "GITHUB_LIST_REPOS", { owner: "me" }, "cb_9");
  const ex = state.executed.at(-1)!;
  check("an action runs with the person's own user id and their own connected account", ex.body["user_id"] === "uid-b" && ex.body["connected_account_id"] === "cb_9", JSON.stringify(ex));
  check("tool execution explicitly selects the latest Composio tool version", ex.body["version"] === "latest", JSON.stringify(ex));
  state.failExecute = true;
  const failed = await executeTool("uid-b", "GITHUB_LIST_REPOS", {}, "cb_9");
  state.failExecute = false;
  check("a failed action says why", failed.ok === false && failed.text === "boom from the app", failed.text);
  check("actions that belong to an app are recognised, and changes are recognised as changes", toolBelongsTo("GITHUB_LIST_REPOS", "github") && !toolBelongsTo("GMAIL_SEND_EMAIL", "github") && isWriteTool("GITHUB_CREATE_ISSUE") && !isWriteTool("GITHUB_LIST_REPOS"));
  check("the actions that match a request come first", relevantTools(gh, "list my github repositories")[0]?.name === "GITHUB_LIST_REPOS");
  check("the app integration accepts COMPOSIO_CONNECTOR_KEY", composioApiConfigured({ COMPOSIO_CONNECTOR_KEY: "ck-connector-test" }));
  check("the legacy COMPOSIO_API_KEY remains supported", composioApiConfigured({ COMPOSIO_API_KEY: "ck-test" }));
  check("the app integration is reported as configured when its key is set", composioApiConfigured());

  /* ================================================================ routes (real bundles) */
  section("App routes: sign-in, plan, connect, permissions, disconnect");
  const appsIndex = (await import(routeUrl("api_apps_index"))) as { Route: { server: { handlers: { GET: (a: { request: Request }) => Promise<Response> } } } };
  const appsConnect = (await import(routeUrl("api_apps_connect"))) as { Route: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } } };
  const appsPerms = (await import(routeUrl("api_apps_permissions"))) as { Route: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } } };
  const appsDisconnect = (await import(routeUrl("api_apps_disconnect"))) as { Route: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } } };
  const callRoute = (await import(routeUrl("api_connectors_call"))) as { Route: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } } };
  const chatRoute = (await import(routeUrl("api_chat"))) as { Route: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } } };
  clearIdentityCache();
  const req = (path: string, token: string | null, body?: unknown) => new Request(`https://zeros.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  check("the apps list requires sign-in (401)", (await appsIndex.Route.server.handlers.GET({ request: req("/api/apps", null) })).status === 401);
  check("the apps list requires a plan (402)", (await appsIndex.Route.server.handlers.GET({ request: req("/api/apps", "tok-free") })).status === 402);
  clearCatalogCache();
  const list = await appsIndex.Route.server.handlers.GET({ request: req("/api/apps", "tok-a") });
  type Item = { slug: string; name: string; logo: string; description: string; connection: { id: string } | null; enabled: boolean };
  const lj = await list.json() as { configured: boolean; items: Item[]; total: number; nextOffset: number | null; categories: { slug: string }[]; connected: { id: string }[]; catalogError: string | null };
  check("a person sees the directory (well-known apps first), with logos and descriptions", list.status === 200 && lj.configured && lj.items[0]?.slug === "gmail" && lj.items.every((a) => /^https:\/\//.test(a.logo)) && lj.items.find((a) => a.slug === "github")?.description === "Code hosting and issues", JSON.stringify(lj).slice(0, 200));
  check("each app shows this person's own connection", lj.items.find((a) => a.slug === "github")?.connection?.id === "ca_1" && lj.items.find((a) => a.slug === "gmail")?.connection === null && lj.connected[0]?.id === "ca_1");
  check("the directory offers categories", lj.categories.some((c) => c.slug === "communication") && lj.total === 5);
  const apps = async (query: string, token = "tok-a") => (await (await appsIndex.Route.server.handlers.GET({ request: req(`/api/apps${query}`, token) })).json()) as typeof lj;
  check("searching the directory filters it on the server", (await apps("?q=hub")).items.map((a) => a.slug).join() === "github");
  check("a category filters the directory", (await apps("?category=productivity")).items.map((a) => a.slug).join() === "notion");
  const paged = await apps("?limit=2");
  check("the directory loads in pages and says where the next page starts", paged.items.length === 2 && paged.nextOffset === 2 && (await apps("?limit=2&offset=4")).nextOffset === null && (await apps("?limit=2&offset=4")).items.length === 1);
  const connectedView = await apps("?view=connected");
  check("the Connected view lists only this person's apps", connectedView.items.map((a) => a.slug).join() === "github" && connectedView.total === 1 && (await apps("?view=connected", "tok-c")).items.length === 0);
  /* the routes run from their own bundle, which keeps its own copy of the directory: a different key means a cold start */
  state.failToolkits = true;
  const warmKey = process.env.COMPOSIO_API_KEY; process.env.COMPOSIO_API_KEY = "ck-cold-start";
  const degraded = await apps("");
  const degradedConnected = await apps("?view=connected");
  process.env.COMPOSIO_API_KEY = warmKey;
  check("if the directory cannot load, the person still sees their connected apps and a clear note", degraded.items.length === 0 && !!degraded.catalogError && !/HTTP|Composio/.test(degraded.catalogError) && degraded.connected.length === 1 && degradedConnected.items[0]?.slug === "github", JSON.stringify(degraded).slice(0, 160));
  state.failToolkits = false;
  const savedKey = process.env.COMPOSIO_API_KEY; delete process.env.COMPOSIO_API_KEY;
  const unconfigured = await apps("");
  const unconfiguredConnect = await appsConnect.Route.server.handlers.POST({ request: req("/api/apps/connect", "tok-c", { toolkit: "github" }) });
  process.env.COMPOSIO_API_KEY = savedKey;
  check("without a Composio key the directory says apps are not set up (and connecting is refused kindly)", unconfigured.configured === false && unconfigured.items.length === 0 && unconfiguredConnect.status === 503 && !/COMPOSIO/.test((await unconfiguredConnect.json()).error));
  state.linked.length = 0;
  const connectRoute = await appsConnect.Route.server.handlers.POST({ request: req("/api/apps/connect", "tok-c", { toolkit: "github" }) });
  check("connecting from the app sends the person back to the chat when they finish", connectRoute.status === 200 && (await connectRoute.json()).redirectUrl.startsWith("https://github.com") && state.linked.at(-1)?.["callback_url"] === "https://zeros.test/chat?connected=github" && state.linked.at(-1)?.["user_id"] === "uid-c");
  const notConnected = await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-c", { toolkit: "gmail", enabled: true }) });
  check("an app must be connected before it can be turned on (409)", notConnected.status === 409);
  const on = await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-a", { toolkit: "github", enabled: true }) });
  check("turning on a connected app saves it for this person", on.status === 200 && (await on.json()).enabled === true && state.perms.find((p) => p.user_id === "uid-a")?.enabled === true);
  const writesOn = await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-a", { toolkit: "github", allowWrites: true }) });
  check("allowing changes is saved for this person", writesOn.status === 200 && (await writesOn.json()).allowWrites === true);
  const off = await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-a", { toolkit: "github", enabled: false }) });
  const offj = await off.json() as { enabled: boolean; allowWrites: boolean };
  check("turning an app off also turns changes off", offj.enabled === false && offj.allowWrites === false);
  await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-a", { toolkit: "github", enabled: true, allowWrites: true }) });
  const wrongConn = await appsDisconnect.Route.server.handlers.POST({ request: req("/api/apps/disconnect", "tok-a", { toolkit: "github", connectionId: "cb_9" }) });
  check("a person cannot disconnect someone else's connection (404)", wrongConn.status === 404 && state.deleted.length === 0);
  const mine = await appsDisconnect.Route.server.handlers.POST({ request: req("/api/apps/disconnect", "tok-a", { toolkit: "github", connectionId: "ca_1" }) });
  check("disconnecting removes the person's own connection and turns the app off", mine.status === 200 && state.deleted.includes("ca_1") && state.perms.find((p) => p.user_id === "uid-a")?.enabled === false);
  // restore person B's app for the action tests
  await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-b", { toolkit: "github", enabled: true }) });

  /* ================================================================ actions: isolation, changes, confirmation */
  section("Actions: each person uses only their own account; changes need permission and confirmation");
  const act = (token: string, body: object) => callRoute.Route.server.handlers.POST({ request: req("/api/connectors/call", token, body) });
  state.executed.length = 0; state.rpc.length = 0;
  const readB = await act("tok-b", { toolkit: "github", tool: "GITHUB_LIST_REPOS", arguments: {} });
  const rb = state.executed.at(-1)!;
  check("a read action runs with person B's own connected account (never person A's)", readB.status === 200 && rb.body["user_id"] === "uid-b" && rb.body["connected_account_id"] === "cb_9", JSON.stringify(rb));
  check("each action costs 1.2 requests", state.rpc.at(-1) === 12, String(state.rpc.at(-1)));
  state.executed.length = 0;
  state.rpc.length = 0;
  const incompleteArtifactCall = await act("tok-b", {
    toolkit: "github",
    tool: "GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY",
    arguments: { owner: "acme" },
  });
  const incompleteArtifactJson = await incompleteArtifactCall.json() as { error?: string; missingParameters?: string[] };
  check(
    "the direct connector route blocks missing required fields before provider execution or billing",
    incompleteArtifactCall.status === 400 &&
      incompleteArtifactJson.missingParameters?.join() === "repo" &&
      state.executed.length === 0 &&
      state.rpc.length === 0,
    JSON.stringify({ status: incompleteArtifactCall.status, body: incompleteArtifactJson, executed: state.executed.length, usage: state.rpc })
  );
  state.executed.length = 0;
  const writeNoPerm = await act("tok-b", { toolkit: "github", tool: "GITHUB_CREATE_ISSUE", arguments: { title: "x" } });
  check("a change is refused while changes are off for that app (403)", writeNoPerm.status === 403);
  await appsPerms.Route.server.handlers.POST({ request: req("/api/apps/permissions", "tok-b", { toolkit: "github", allowWrites: true }) });
  const writeNoConfirm = await act("tok-b", { toolkit: "github", tool: "GITHUB_CREATE_ISSUE", arguments: { title: "x" } });
  const wnc = await writeNoConfirm.json() as { needsConfirm?: boolean };
  check("a change without the person's confirmation is not run (409, needsConfirm)", writeNoConfirm.status === 409 && wnc.needsConfirm === true && !state.executed.some((e) => e.tool === "GITHUB_CREATE_ISSUE"));
  const writeOk = await act("tok-b", { toolkit: "github", tool: "GITHUB_CREATE_ISSUE", arguments: { title: "Hello" }, confirm: true });
  check("a confirmed change runs, with person B's account", writeOk.status === 200 && state.executed.at(-1)?.body["connected_account_id"] === "cb_9");
  const wrongApp = await act("tok-b", { toolkit: "github", tool: "GMAIL_SEND_EMAIL", arguments: {} });
  check("an action must belong to the app it is sent for (400)", wrongApp.status === 400);
  const notOn = await act("tok-free", { toolkit: "github", tool: "GITHUB_LIST_REPOS", arguments: {} });
  check("an app that is not turned on is refused for everyone (no plan: 402, not on: 403)", notOn.status === 402 && (await act("tok-c", { toolkit: "github", tool: "GITHUB_LIST_REPOS", arguments: {} })).status === 403);
  state.failExecute = true; state.rpc.length = 0;
  const failing = await act("tok-b", { toolkit: "github", tool: "GITHUB_LIST_REPOS", arguments: {} });
  state.failExecute = false;
  check("a failed action is refunded", failing.status === 502 && state.rpc.includes(12) && state.rpc.includes(-12), JSON.stringify(state.rpc));

  /* ================================================================ chat: the app is used, and changes are proposed */
  section("Chat: replies say which app they used, and propose changes instead of making them");
  const chatBody = (extra: object = {}) => ({ messages: [{ role: "user", content: "list my github repositories" }], mode: "chat", memories: [], reasoning: "fast", ...extra });
  state.planner = ['{"done":true}'];
  state.executed.length = 0;
  const directStatus = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-b", chatBody({ messages: [{ role: "user", content: "Are you connected to my personal GitHub account?" }] })) });
  const directStatusText = await directStatus.text();
  check("chat reports verified connection status instead of guessing", directStatus.status === 200 && directStatusText.includes("active GitHub connection") && directStatusText.includes("Use in chat") && directStatus.headers.get("X-Zeros-Verified") === "true", directStatusText.slice(0, 300));
  check("a status question does not run an app action or call the app planner", state.executed.length === 0 && state.planner.length === 1);
  state.planner = [];
  const combinedStatusAndRead = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-b", chatBody({ messages: [{ role: "user", content: "Are you connected through Composio to GitHub? Also can you see a repo named zerosvsistudio-?" }] })) });
  const combinedStatusAndReadText = await combinedStatusAndRead.text();
  check("a combined connection-and-repository request executes the repository read", combinedStatusAndRead.status === 200 && combinedStatusAndRead.headers.get("X-Zeros-Apps") === "github" && state.executed.at(-1)?.tool === "GITHUB_LIST_REPOS" && !combinedStatusAndReadText.includes("no read-only app action returned a successful result"), combinedStatusAndReadText.slice(0, 500));
  state.planner = [];
  state.failNextExecute = true;
  const dataOnlyReadFailure = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-b", chatBody({ messages: [{ role: "user", content: "Tell me one repository in my GitHub account" }] })) });
  const dataOnlyReadFailureText = await dataOnlyReadFailure.text();
  check("a data-only read failure does not incorrectly answer with connection status", dataOnlyReadFailure.status === 200 && dataOnlyReadFailureText.includes("I couldn't retrieve the requested live app data") && !dataOnlyReadFailureText.includes("active GitHub connection") && !dataOnlyReadFailureText.includes("Use in chat") && !/I found your repo|repository exists/i.test(dataOnlyReadFailureText), dataOnlyReadFailureText.slice(0, 500));
  state.planner = [];
  state.planner = ['{"tool":"GITHUB_LIST_REPOS","arguments":{}}'];
  state.executed.length = 0; state.rpc.length = 0;
  const chatRead = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-b", chatBody()) });
  await chatRead.text();
  check("a reply that read from an app says so in its headers", chatRead.status === 200 && chatRead.headers.get("X-Zeros-Apps") === "github", chatRead.headers.get("X-Zeros-Apps") ?? "none");
  state.planner = [];
  state.executed.length = 0;
  const singleRepo = await runAppAgent({ uid: "uid-b", messages: [{ role: "user", content: "Tell me one repo from my GitHub account" }] });
  check("one-repo requests call the repository-list tool directly instead of an adjacent repository read", singleRepo.readResultVerified && state.executed.length === 1 && state.executed[0]?.tool === "GITHUB_LIST_REPOS" && !state.executed.some((call) => call.tool === "GITHUB_GET_REPO_METADATA" || call.tool === "GITHUB_LIST_ACCESSIBLE_REPOSITORIES"), JSON.stringify({ tools: state.executed.map((call) => call.tool), steps: singleRepo.steps }));
  check("the app was read with the asking person's own account", state.executed.at(-1)?.body["connected_account_id"] === "cb_9" && state.executed.at(-1)?.body["user_id"] === "uid-b");
  check("a turn that uses apps costs 1.2 requests", state.rpc.at(0) === 12, String(state.rpc.at(0)));

  state.planner = ['{"tool":"GITHUB_CREATE_ISSUE","arguments":{"title":"Launch day"}}'];
  state.executed.length = 0;
  const chatWrite = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-b", chatBody({ messages: [{ role: "user", content: "create a github issue titled Launch day" }] })) });
  await chatWrite.text();
  const ranWrite = state.executed.find((e) => e.tool === "GITHUB_CREATE_ISSUE");
  check("a change asked for in chat runs straight away when the app allows changes", ranWrite !== undefined && ranWrite.body["connected_account_id"] === "cb_9" && JSON.stringify(ranWrite.body["arguments"] ?? {}).includes("Launch day"), JSON.stringify(state.executed));
  check("the reply is not a proposal any more", !chatWrite.headers.get("X-Zeros-Proposal"));

  const bRow = state.perms.find((p) => p.user_id === "uid-b" && p.toolkit_slug === "github");
  const wasWrites = bRow?.allow_writes ?? false;
  if (bRow) bRow.allow_writes = false;
  state.planner = ['{"tool":"GITHUB_CREATE_ISSUE","arguments":{"title":"Blocked"}}'];
  state.executed.length = 0;
  const chatBlocked = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-b", chatBody({ messages: [{ role: "user", content: "create a github issue titled Blocked" }] })) });
  await chatBlocked.text();
  check("a change is refused when the app is read only, and nothing is executed", chatBlocked.status === 200 && !state.executed.some((e) => e.tool === "GITHUB_CREATE_ISSUE"));
  if (bRow) bRow.allow_writes = wasWrites;

  state.planner = [];
  state.rpc.length = 0;
  const chatPlain = await chatRoute.Route.server.handlers.POST({ request: req("/api/chat", "tok-c", chatBody({ messages: [{ role: "user", content: "what is the capital of France" }] })) });
  await chatPlain.text();
  check("a person with no apps on is charged the normal 1 request and sees no app headers", state.rpc.at(0) === 10 && (chatPlain.headers.get("X-Zeros-Apps") ?? "") === "" && !chatPlain.headers.get("X-Zeros-Proposal"));

  /* ================================================================ summary */
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error("TEST CRASH:", err); process.exit(2); });
