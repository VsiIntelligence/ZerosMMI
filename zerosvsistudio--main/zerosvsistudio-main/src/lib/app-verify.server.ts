/**
 * "Does every connected app really work?" answered with evidence, not hope. For each app this checks, in order: the connection
 * (renewing an expired sign-in when it can), the person's Zeros permissions, the app's action catalogue, and finally a live,
 * read-only probe through the real app. Each result says what is wrong and exactly what to do about it.
 */
import { describeToolkit, executeTool, isBroken, isLive, isPending, listConnections, listTools, pickConnection, refreshConnection, relevantTools, titleCase, type Connection, type ToolInfo } from "./composio-api.server";
import type { Permission } from "./app-permissions.server";

export type AppProbe = { tool: string; ok: boolean; ms: number; detail: string } | { skipped: string };
export type AppCheck = {
  toolkit: string;
  name: string;
  connection: "active" | "pending" | "needs_reconnect" | "missing";
  useInChat: boolean | null;
  allowChanges: boolean | null;
  actions: { total: number; reads: number; changes: number } | null;
  probe: AppProbe | null;
  status: "ready" | "attention" | "broken";
  fixes: string[];
  notes: string[];
  /** The one-tap fix the person can accept: turn the app on for chat. */
  autoFix?: "enable";
};

type Deps = {
  listConnections?: (uid: string) => Promise<Connection[]>;
  listPermissions?: (uid: string) => Promise<Permission[]>;
  listTools?: (toolkit: string) => Promise<ToolInfo[]>;
  executeTool?: typeof executeTool;
  refreshConnection?: typeof refreshConnection;
  /** GitHub authorized directly by the person: returns a login when a read probe through it works. */
  nativeGitHubProbe?: (uid: string) => Promise<{ ok: boolean; detail: string; login?: string } | null>;
};

const PROBE_HINT = "get my profile account user me current authenticated whoami self";
const clip = (s: string, n = 160): string => s.replace(/\s+/g, " ").trim().slice(0, n);
const looksLikeAuthProblem = (s: string): boolean => /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]token|expired|revoked|insufficient|scope|permission/i.test(s);

/** The reads that can be tried with no inputs at all, best "who am I" style probes first. */
export function probeCandidates(tools: ToolInfo[]): ToolInfo[] {
  const safe = tools.filter((t) => !t.write && !(t.parameterDetails ?? []).some((p) => p.required) && !(t.parameterDetails === undefined && t.parameters.length > 0));
  if (!safe.length) return [];
  const ranked = relevantTools(safe, PROBE_HINT, 6);
  const rest = safe.filter((t) => !ranked.includes(t));
  return [...ranked, ...rest].slice(0, 3);
}

async function checkOne(uid: string, toolkit: string, connections: Connection[], permission: Permission | undefined, deps: Required<Pick<Deps, "listTools" | "executeTool" | "refreshConnection">> & Pick<Deps, "nativeGitHubProbe">, probe: boolean): Promise<AppCheck> {
  const name = titleCase(toolkit);
  const check: AppCheck = { toolkit, name, connection: "missing", useInChat: permission ? permission.enabled : null, allowChanges: permission ? permission.allowWrites : null, actions: null, probe: null, status: "ready", fixes: [], notes: [] };
  let live = pickConnection(connections, toolkit);
  const mine = connections.filter((c) => c.toolkit === toolkit);

  if (!live) {
    const broken = mine.filter(isBroken).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (broken) {
      try {
        const renewed = await deps.refreshConnection(broken.id);
        if (renewed.status === "ACTIVE") { live = { ...broken, status: "ACTIVE" }; check.notes.push("The expired sign-in was renewed automatically."); }
      } catch { /* the person is asked to reconnect below */ }
    }
  }

  const native = toolkit === "github" && !live && deps.nativeGitHubProbe ? await deps.nativeGitHubProbe(uid).catch(() => null) : null;
  if (!live && !native) {
    if (mine.some(isPending)) { check.connection = "pending"; check.status = "attention"; check.fixes.push(`Finish signing in to ${name}, then check again.`); }
    else if (mine.some(isBroken)) { check.connection = "needs_reconnect"; check.status = "broken"; check.fixes.push(`The sign-in for ${name} has expired or was revoked. Reconnect ${name} in Settings → Apps.`); }
    else { check.connection = "missing"; check.status = "attention"; check.fixes.push(`${name} is not connected. Connect it in Settings → Apps.`); }
    return check;
  }
  check.connection = "active";

  if (native) {
    // Directly authorized GitHub: the probe is a real call to GitHub as the person.
    check.probe = { tool: "GET /user", ok: native.ok, ms: 0, detail: clip(native.detail) };
    check.actions = null;
    check.notes.push(`Authorized directly as @${native.login ?? "your account"}; Zeros reaches the whole GitHub API with it.`);
    if (!native.ok) { check.status = "broken"; check.fixes.push("Reauthorize GitHub in Settings → Apps."); }
  } else {
    let tools: ToolInfo[] = [];
    try { tools = await deps.listTools(toolkit); }
    catch (err) { check.status = "broken"; check.fixes.push(`${name}'s actions could not be loaded (${clip(err instanceof Error ? err.message : "unknown error", 120)}). Try again in a minute.`); return check; }
    check.actions = { total: tools.length, reads: tools.filter((t) => !t.write).length, changes: tools.filter((t) => t.write).length };
    if (!tools.length) { check.status = "broken"; check.fixes.push(`Composio lists no actions for ${name}.`); return check; }

    if (probe) {
      const candidates = probeCandidates(tools);
      if (!candidates.length) check.probe = { skipped: "Every read action for this app needs inputs, so there is nothing safe to try without your say-so." };
      else {
        let last: AppProbe | null = null;
        for (const tool of candidates) {
          const t0 = Date.now();
          const outcome = await deps.executeTool(uid, tool.name, {}, live!.id, { write: false }).catch((err: unknown) => ({ ok: false, text: err instanceof Error ? err.message : "no answer" }));
          last = { tool: tool.name, ok: outcome.ok, ms: Date.now() - t0, detail: clip(outcome.text) };
          if (outcome.ok) break;
        }
        check.probe = last;
        if (last && "ok" in last && !last.ok) {
          if (looksLikeAuthProblem(last.detail)) { check.status = "broken"; check.fixes.push(`${name} refused the request: ${last.detail}. Reconnect ${name} and approve every permission it asks for.`); }
          else { check.status = "attention"; check.fixes.push(`The test read failed (${last.detail}). The connection is live, so other actions may still work.`); }
        }
      }
    }
  }

  if (permission && !permission.enabled) {
    if (check.status === "ready") check.status = "attention";
    check.fixes.push(`Use in chat is OFF for ${name}, so Zeros will not touch it yet.`);
    check.autoFix = "enable";
  } else if (!permission) {
    if (check.status === "ready") check.status = "attention";
    check.fixes.push(`${name} is connected but not switched on for chat yet.`);
    check.autoFix = "enable";
  } else if (!permission.allowWrites) {
    check.notes.push("Read-only: Allow changes is OFF, so Zeros will look but not change anything.");
  }
  return check;
}

/** Checks one app, or every app the person has connected (or switched on). */
export async function verifyApps(uid: string, opts: { toolkit?: string; probe?: boolean; deps?: Deps } = {}): Promise<AppCheck[]> {
  const deps = opts.deps ?? {};
  const connections = await (deps.listConnections ?? ((id: string) => listConnections(id)))(uid);
  const permissions = await (deps.listPermissions ?? (async (id: string) => (await import("./app-permissions.server")).listPermissions(id)))(uid).catch(() => [] as Permission[]);
  const permissionOf = new Map(permissions.map((p) => [p.toolkit, p]));
  const wanted = opts.toolkit
    ? [opts.toolkit.toLowerCase()]
    : [...new Set([...connections.map((c) => c.toolkit), ...permissions.filter((p) => p.enabled).map((p) => p.toolkit)])];
  const inner = { listTools: deps.listTools ?? ((t: string) => listTools(t)), executeTool: deps.executeTool ?? executeTool, refreshConnection: deps.refreshConnection ?? ((id: string) => refreshConnection(id)), ...(deps.nativeGitHubProbe ? { nativeGitHubProbe: deps.nativeGitHubProbe } : {}) };
  const results: AppCheck[] = [];
  for (let i = 0; i < wanted.length; i += 4) {
    const chunk = wanted.slice(i, i + 4);
    results.push(...await Promise.all(chunk.map((toolkit) => checkOne(uid, toolkit, connections, permissionOf.get(toolkit), inner, opts.probe !== false))));
  }
  const order = { broken: 0, attention: 1, ready: 2 } as const;
  return results.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}

/** Plain-language one-liner for a check. */
export function summarizeCheck(c: AppCheck): string {
  if (c.status === "ready") return `${c.name}: ready${c.probe && "ok" in c.probe && c.probe.ok ? ` (live test read answered in ${c.probe.ms} ms)` : ""}.`;
  return `${c.name}: ${c.status === "broken" ? "not working" : "needs a quick look"}. ${c.fixes[0] ?? ""}`.trim();
}

/** For the owner: how every app in the catalogue signs in, without connecting anything. Apps that need the owner's own credentials are listed. */
export async function sweepCatalog(toolkits: { slug: string; name: string }[], opts: { concurrency?: number; only?: string[] } = {}): Promise<{ slug: string; name: string; oneClick: boolean | null; modes: string[]; actions: number | null; note: string }[]> {
  const list = opts.only?.length ? toolkits.filter((t) => opts.only!.includes(t.slug)) : toolkits;
  const out: { slug: string; name: string; oneClick: boolean | null; modes: string[]; actions: number | null; note: string }[] = [];
  const width = Math.max(1, opts.concurrency ?? 6);
  for (let i = 0; i < list.length; i += width) {
    out.push(...await Promise.all(list.slice(i, i + width).map(async (t) => {
      try {
        const [auth, tools] = await Promise.all([describeToolkit(t.slug), listTools(t.slug).catch(() => null)]);
        const oneClick = auth.noAuth || auth.managedSchemes.length > 0;
        return { slug: t.slug, name: auth.name, oneClick, modes: auth.noAuth ? ["NO_AUTH"] : auth.managedSchemes.length ? auth.managedSchemes : auth.authModes, actions: tools ? tools.length : null, note: oneClick ? "connects with one click" : "needs your own credentials: create an auth configuration for it in your Composio dashboard" };
      } catch (err) {
        return { slug: t.slug, name: t.name, oneClick: null, modes: [], actions: null, note: `could not be inspected: ${clip(err instanceof Error ? err.message : "unknown", 100)}` };
      }
    })));
  }
  return out;
}
