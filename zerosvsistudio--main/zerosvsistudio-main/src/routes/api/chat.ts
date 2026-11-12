import { createFileRoute } from "@tanstack/react-router";
import { buildSystemPrompt, type ZeroMode } from "@/lib/zeros";
import { engineJson, recentEngineFailures, textToSse, type Msg } from "@/lib/engine.server";
import { buildHistoryWindow } from "@/lib/chat-window";
import { WEIGHTS, canUseComplex } from "@/lib/billing.server";
import { charge, requireAccess } from "@/lib/access.server";
import { composioApiConfigured, isWriteTool, listToolkits, titleCase } from "@/lib/composio-api.server";
import { findMentionedToolkit, formatConnectionStatusAnswer, isConnectionStatusOnlyQuestion, isConnectorOperationRequest, isExplicitAppReadRequest, isExplicitAppWriteRequest, runAppAgent, type AppRun } from "@/lib/app-agent.server";
import { listPermissions } from "@/lib/app-permissions.server";
import { buildPatterns, hideTerms, redactSse } from "@/lib/redact.server";
import { parseReasoning, zerosRoute } from "@/lib/zeros-route.server";
import { isGitHubOAuthConfigured, listGitHubUserRepositories } from "@/lib/github-oauth.server";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Hit = { title: string; url: string; snippet: string };

async function readerSearch(query: string): Promise<Hit[]> {
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(`https://r.jina.ai/${target}`, {
    headers: { "User-Agent": UA, "X-Return-Format": "markdown" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const md = await res.text();
  const lines = md.split("\n");
  const out: Hit[] = [];
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    const heading = lines[i]?.match(/^#+\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (!heading) continue;
    const snippet =
      lines
        .slice(i + 1, i + 8)
        .map((l) => l.trim())
        .find((l) => l.length > 60 && !l.startsWith("[") && !l.startsWith("!")) ?? "";
    out.push({ title: heading[1]!, url: heading[2]!, snippet });
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

/** Decodes HTML entities (numeric first, then named, with &amp; last so nothing is decoded twice). */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })
    .replace(/&#(\d+);/g, (_, d: string) => { const n = parseInt(d, 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo|ldquo|rdquo);/gi, (m, name: string) => (name.toLowerCase() === "amp" ? m : NAMED_ENTITIES[name.toLowerCase()] ?? " "))
    .replace(/&amp;/gi, "&");
}

async function bingSearch(query: string): Promise<Hit[]> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-US&count=10`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10);
  const pick = (block: string, tag: string) =>
    decodeEntities(
      (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/<[^>]*>/g, ""),
    )
      .replace(/\s+/g, " ")
      .trim();
  return items.map((m) => {
    const b = m[1] ?? "";
    return { title: pick(b, "title"), url: pick(b, "link"), snippet: pick(b, "description") };
  });
}

async function newsSearch(query: string): Promise<Hit[]> {
  const res = await fetch(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10);
  const pick = (block: string, tag: string) =>
    decodeEntities(
      (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/<[^>]*>/g, ""),
    )
      .replace(/\s+/g, " ")
      .trim();
  return items.map((m) => {
    const b = m[1] ?? "";
    return {
      title: pick(b, "title"),
      url: pick(b, "link"),
      snippet: `${pick(b, "source")} — published ${pick(b, "pubDate")}`,
    };
  });
}

async function readPage(url: string): Promise<string> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "User-Agent": UA, "X-Return-Format": "text" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return "";
    const txt = await res.text();
    return txt.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").slice(0, 3500);
  } catch {
    return "";
  }
}

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_|igshid|spm$)/i;
function canonical(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
const domainOf = (raw: string): string => {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Turns the chat (incl. follow-ups like "and its price?") into 1-3 self-contained search queries. */
async function planQueries(question: string, history: Msg[]): Promise<string[]> {
  const fallback = [question.replace(/\s+/g, " ").trim().slice(0, 220)];
  try {
    const year = new Date().getUTCFullYear();
    const convo = history
      .slice(-7, -1)
      .map((m) => `${m.role}: ${String(m.content).slice(0, 300)}`)
      .join("\n");
    const out = await engineJson<{ queries?: unknown }>(
      `You write web search queries. Today is ${new Date().toISOString().slice(0, 10)}.
Turn the LATEST QUESTION (use the conversation to resolve pronouns and follow-ups) into 1 to 3 self-contained keyword queries, each at most 9 words, covering different angles (core facts, latest news/updates, official or primary source). Add the year ${year} only when recency matters. If the question is a single simple fact, return one query.
Return ONLY JSON: {"queries": ["..."]}`,
      `${convo ? `CONVERSATION:\n${convo}\n\n` : ""}LATEST QUESTION: ${question.slice(0, 600)}`,
      { maxTokens: 160, timeoutMs: 6000, temperature: 0 },
    );
    const qs = (Array.isArray(out?.queries) ? out!.queries : [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 2)
      .map((q) => q.trim().slice(0, 140))
      .slice(0, 3);
    return qs.length ? qs : fallback;
  } catch {
    return fallback;
  }
}

type Source = Hit & { n: number; domain: string; body: string };

async function gatherSources(queries: string[]): Promise<Source[]> {
  const jobs = queries.flatMap((q) => [readerSearch(q), bingSearch(q), newsSearch(q)]);
  const settled = await Promise.allSettled(jobs);
  // Score = how many result lists agree on a URL; ties keep list order (round-robin across queries/engines).
  const merged = new Map<string, { hit: Hit; score: number; order: number }>();
  let order = 0;
  const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const h = list[rank];
      if (!h?.url || !/^https?:/i.test(h.url)) continue;
      const key = canonical(h.url);
      const prev = merged.get(key);
      if (prev) prev.score += 1;
      else merged.set(key, { hit: h, score: 1, order: order++ });
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 10);
  const top = ranked.map((r) => r.hit);
  const bodies = await Promise.all(top.slice(0, 5).map((h) => readPage(h.url)));
  return top.map((h, i) => ({ ...h, n: i + 1, domain: domainOf(h.url), body: bodies[i] ?? "" }));
}

async function webSearch(question: string, history: Msg[]): Promise<string> {
  if (!question.trim()) return "";
  const work = (async () => {
    const queries = await planQueries(question, history);
    const sources = await gatherSources(queries);
    return { queries, sources };
  })();
  const capped = await Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 24000)),
  ]);
  if (!capped || !capped.sources.length) return "";
  const { queries, sources } = capped;
  const lines = sources.map((s) => {
    const extract = s.body.length > 200 ? `\n    EXTRACT: ${s.body.replace(/\s+/g, " ").slice(0, 1800)}` : "";
    return `[${s.n}] ${s.title} - ${s.domain}\n    URL: ${s.url}\n    SNIPPET: ${s.snippet}${extract}`;
  });
  return `SOURCES (fetched ${new Date().toISOString()} for queries: ${queries.map((q) => `"${q}"`).join(", ")}). Cite as [n](url):\n${lines.join("\n\n")}`;
}

const MODES: ZeroMode[] = ["chat", "search", "image", "model", "music", "web", "video"];

function cleanMessages(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  const out: Msg[] = [];
  for (const m of raw.slice(-40)) {
    if (!m || typeof m !== "object") continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) continue;
    out.push({ role, content: content.slice(0, 20000) });
  }
  /* the same bounded window the browser sends: recent turns that fit, the older ones condensed */
  return buildHistoryWindow(out, { maxMessages: 18, maxChars: 40000, perMessage: 12000, summaryTurns: 8, summaryChars: 140 });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => handleChat(request),
    },
  },
});

/**
 * One chat turn: who is asking, what they may use, what it costs, then the answer.
 * Order matters: identity and plan, then reasoning level, then the daily allowance, and only then the models.
 * Nothing about which engine or model answered is ever put in the response.
 */
async function handleChat(request: Request): Promise<Response> {
  const gate = await requireAccess(request);
  if (!gate.ok) return gate.response;
  const access = gate.access;
  const uid = access.uid;

  let body: { messages?: unknown; mode?: unknown; memories?: unknown; reasoning?: unknown; connectors?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("The request body was not valid JSON.", { status: 400 });
  }

  const reasoning = parseReasoning(body.reasoning);
  if (reasoning === "complex" && !canUseComplex(access.plan, access.unlimited)) {
    return Response.json({ error: "Complex reasoning is a Gold feature. Switch to Medium or Fast, or upgrade to Gold." }, { status: 403 });
  }
  const mode: ZeroMode = MODES.includes(body.mode as ZeroMode) ? (body.mode as ZeroMode) : "chat";
  const appCapableMode = mode === "chat" || mode === "search";

  /* a turn costs 1.2 requests while the person has at least one app turned on in Settings */
  const enabledAppSlugs: string[] = appCapableMode && (composioApiConfigured() || isGitHubOAuthConfigured())
    ? await listPermissions(uid).then((p) => p.filter((x) => x.enabled).map((x) => x.toolkit)).catch(() => [] as string[])
    : [];
  const enabledApps = enabledAppSlugs.length;
  const useConnectors = enabledApps > 0;
  const paid = await charge(access, useConnectors ? WEIGHTS.connector : WEIGHTS.chat);
  if (!paid.ok) return paid.response;
  const refund = paid.refund;

  try {
    const messages = cleanMessages(body.messages);
    if (!messages.length || messages[messages.length - 1]!.role !== "user") {
      await refund();
      return new Response("Send at least one user message.", { status: 400 });
    }
    const memories = (Array.isArray(body.memories) ? body.memories : [])
      .filter((m): m is string => typeof m === "string")
      .map((m) => m.slice(0, 400))
      .slice(0, 60);
    let system = buildSystemPrompt(mode, memories, reasoning);
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

    let apps: string[] = [];
    let connectorRun: AppRun | null = null;
    // Connector orchestration is expensive: don't discover connections, fetch tool catalogs,
    // or invoke the app planner for ordinary chat. Run it only for app operations/status checks.
    // Naming one of the person's own apps is enough too: their apps are not limited to a fixed vocabulary of words.
    const namesEnabledApp = enabledAppSlugs.length > 0 && findMentionedToolkit(lastUser, enabledAppSlugs.map((slug) => ({ slug, name: titleCase(slug) }))) !== null;
    const shouldInspectConnectedApps =
      appCapableMode &&
      (isConnectionStatusOnlyQuestion(lastUser) || isConnectorOperationRequest(lastUser) || namesEnabledApp);
    if (shouldInspectConnectedApps && (composioApiConfigured() || isGitHubOAuthConfigured())) {
      try {
        const run = await runAppAgent({ uid, messages });
        connectorRun = run;
        apps = run.apps;
        if (run.context) system += `

${run.context}`;
      } catch (err) {
        console.warn("[Zeros] app step skipped:", err);
        system += `

CONNECTED APP STATUS: UNVERIFIED. The connected-app service failed during this turn, so do not claim any app is connected, disconnected, read, or changed. No connected-app action was verified. Ask the person to retry or check Settings → Apps.`;
      }
    } else if (shouldInspectConnectedApps) {
      system += `

CONNECTED APP STATUS: UNAVAILABLE. This deployment has no configured connected-app service, so live app connections and actions cannot be verified. Do not claim any app is connected, disconnected, read, or changed.`;
    } else if (appCapableMode) {
      system += `

CONNECTED APP STATUS: NOT CHECKED. This message does not request a connected-app operation or connection-status check. Do not make claims about live app connections or perform connected-app actions.`;
    }

    // Keep account-status claims and live-data claims factual even when a model would otherwise guess.
    const connectorDirectReply = (answer: string, verified: boolean): Response => new Response(
      redactSse(textToSse(answer), buildPatterns(hideTerms())),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Zeros-Reasoning": reasoning,
          "X-Zeros-Verified": String(verified),
          "X-Zeros-Usage": paid.usage,
          "X-Zeros-Apps": apps.join(","),
        },
      },
    );

    const asksForGitHubRepositories =
      /\b(?:list|show|find|get|fetch|retrieve|what are|which are|tell me)\b/i.test(lastUser) &&
      /\bgithub\b/i.test(lastUser) &&
      /\b(?:repos?|repositories)\b/i.test(lastUser) &&
      !isExplicitAppWriteRequest(lastUser);
    const hasComposioGitHubRecord = connectorRun?.connectionStatus.connections.some((connection) => connection.toolkit.toLowerCase() === "github") ?? false;
    const mayUseGitHubOAuthFallback =
      !composioApiConfigured() ||
      (!!connectorRun?.connectionStatus.connectionsVerified && !hasComposioGitHubRecord);

    // GitHub repository reads use this Zeros user's own OAuth token. Never substitute a shared installation token.
    if (appCapableMode && asksForGitHubRepositories && mayUseGitHubOAuthFallback) {
      if (!isGitHubOAuthConfigured()) {
        return connectorDirectReply("Per-user GitHub authorization is not configured on this deployment. Configure GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and GITHUB_TOKEN_ENCRYPTION_KEY, apply the Supabase GitHub-token migration, and redeploy.", false);
      }
      try {
        const result = await listGitHubUserRepositories(uid);
        apps = ["github"];
        const repositories = result.repositories;
        const answer = repositories.length
          ? `Repositories accessible to @${result.login} (${repositories.length}${result.truncated ? "+" : ""} shown):\n\n${repositories.map((repository) => `- ${repository.full_name}${repository.private ? " (private)" : " (public)"}${repository.description ? ` — ${repository.description}` : ""}${repository.html_url ? `\n  ${repository.html_url}` : ""}`).join("\n")}${result.truncated ? "\n\nShowing the most recently updated repositories. Narrow the request to an owner or repository to inspect more." : ""}`
          : `GitHub account @${result.login} is connected, but GitHub returned no repositories for this account.`;
        return connectorDirectReply(answer, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The GitHub request failed.";
        return connectorDirectReply(`I couldn't retrieve repositories through your connected GitHub account. ${message}`, false);
      }
    }

    if (appCapableMode && isConnectionStatusOnlyQuestion(lastUser)) {
      let answer: string;
      let verified = false;
      if (!composioApiConfigured()) {
        answer = "I can't verify whether an app account is connected because Composio isn't configured in this deployment. Add the server-side COMPOSIO_CONNECTOR_KEY secret and redeploy, then check again.";
      } else if (connectorRun?.connectionStatus) {
        const catalog = await listToolkits().catch(() => []);
        answer = formatConnectionStatusAnswer(lastUser, connectorRun.connectionStatus, catalog);
        verified = connectorRun.connectionStatus.connectionsVerified;
      } else {
        answer = "I can't verify the connection right now because the connected-app check failed. I shouldn't guess yes or no. Retry or check Settings → Apps.";
      }
      return connectorDirectReply(answer, verified);
    }

    if (appCapableMode && connectorRun?.blockedRequestedApp) {
      const catalog = await listToolkits().catch(() => []);
      const status = formatConnectionStatusAnswer(lastUser, connectorRun.connectionStatus, catalog);
      apps = [];
      return connectorDirectReply(
        `${status}\n\n${connectorRun.blockedReason ?? "The requested app is not available for this turn."} I did not use a different app as a substitute, and no action was run.`,
        connectorRun.connectionStatus.connectionsVerified && connectorRun.connectionStatus.permissionsVerified,
      );
    }

    const knownConnectorApps = connectorRun ? [...connectorRun.connectionStatus.connections.map((connection) => connection.toolkit), ...connectorRun.connectionStatus.permissions.map((permission) => permission.toolkit)] : [];
    const requestedAppAction = !!connectorRun?.requestedToolkit && isConnectorOperationRequest(lastUser);
    const requestedActionVerified = connectorRun?.requestedToolkit
      ? isExplicitAppWriteRequest(lastUser)
        ? connectorRun.steps.some((step) => step.toolkit === connectorRun!.requestedToolkit && step.ok && (step.write ?? isWriteTool(step.tool, step.toolkit)))
        : connectorRun.readResultVerified
      : connectorRun?.readResultVerified ?? false;
    const shouldVerifyLiveResult =
      (isExplicitAppReadRequest(lastUser, knownConnectorApps) && !connectorRun?.readResultVerified) ||
      (requestedAppAction && !requestedActionVerified);
    if (appCapableMode && shouldVerifyLiveResult) {
      let answer: string;
      if (!composioApiConfigured()) {
        answer = "I couldn't retrieve live app data because Composio isn't configured in this deployment. Add the server-side COMPOSIO_CONNECTOR_KEY secret and redeploy. I won't invent a repo, file, email, or record.";
      } else if (connectorRun?.connectionStatus) {
        // Do not answer a data request with the connection-status sentence unless the person also asked about status.
        // An ACTIVE connection does not prove that a repository, message, file, or other read actually succeeded.
        const asksConnectionStatus = /\b(?:are you|are we|am i|is my|is the|do you|does zeros|can you|have you)\b[\s\S]{0,100}\b(?:connected|authenticated|authorized|authorised|linked|signed in|logged in|have access|access)\b/i.test(lastUser);
        const statusPrefix = asksConnectionStatus
          ? formatConnectionStatusAnswer(lastUser, connectorRun.connectionStatus, await listToolkits().catch(() => [])) + "\n\n"
          : "";
        const failedRead = connectorRun.steps.find((step) => !!step.toolkit && !step.ok);
        const failureDetail = !connectorRun.connectionStatus.connectionsVerified
          ? "the connected-account registry could not be verified"
          : !connectorRun.connectionStatus.permissionsVerified
            ? "app permissions could not be verified, so no app action was attempted"
            : connectorRun.readFailureReason
              ? connectorRun.readFailureReason
              : failedRead
                ? "the read action " + failedRead.tool + " returned an error: " + failedRead.result
                : "no read-only app action returned a successful result";
        if (isExplicitAppWriteRequest(lastUser)) {
          const failedStep = connectorRun.steps.find((step) => step.toolkit === connectorRun?.requestedToolkit && !step.ok);
          answer = statusPrefix + "I couldn't verify that the requested change completed. " + (failedStep ? "The app action " + failedStep.tool + " failed." : "No successful change action was returned.") + " I won't claim the change happened.";
        } else {
          answer = statusPrefix + "I couldn't retrieve the requested live app data this turn because " + failureDetail + ". I won't invent a repository name, file, email, or record.";
        }
        // Do not show a Used app badge for an unrelated tool call that did not answer this lookup.
        apps = [];
      } else {
        answer = "I couldn't verify the requested live app data because the connected-app service failed this turn. I won't invent a repository name, file, email, or record. Retry or check Settings → Apps.";
      }
      return connectorDirectReply(answer, !!connectorRun?.connectionStatus.connectionsVerified);
    }

    if (mode === "search") {
      const results = await webSearch(lastUser, messages);
      system += results
        ? `\n\n${results}`
        : `\n\nSOURCES: (the live search returned nothing usable - say so briefly, then answer from general knowledge and label it as such)`;
    }

    // 3D models, websites, songs and videos are very large requests: they get longer to begin answering.
    const heavy = mode === "model" || mode === "web" || mode === "music" || mode === "video";
    const routed = await zerosRoute(system, messages, { reasoning, skipAgent: mode === "search" || mode === "model", heavy });
    if (!routed) {
      await refund();
      console.error("[Zeros] No engine could answer. Check the engine settings in ENVIRONMENT.md. Recent engine problems:", JSON.stringify(recentEngineFailures().slice(-6)));
      return new Response(
        "ZerosX2.0 could not reach its reasoning engine just now. Give it a few seconds and send it again. Your request was not charged.",
        { status: 503 },
      );
    }
    return new Response(redactSse(routed.stream, buildPatterns(hideTerms())), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Zeros-Reasoning": reasoning,
        "X-Zeros-Verified": String(!!routed.verified),
        "X-Zeros-Usage": paid.usage,
        "X-Zeros-Apps": apps.join(","),
      },
    });
  } catch (err) {
    console.error("[Zeros] A chat turn failed:", err);
    await refund();
    return new Response("ZerosX2.0 hit an internal error. Your request was not charged. Please try again.", { status: 500 });
  }
}
