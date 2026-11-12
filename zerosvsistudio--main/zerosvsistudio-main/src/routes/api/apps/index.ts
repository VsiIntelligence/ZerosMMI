import { createFileRoute } from "@tanstack/react-router";
import { requirePaidUser } from "@/lib/app-guard.server";
import { categoriesOf, composioApiConfigured, filterCatalog, isBroken, isLive, isPending, listConnections, listToolkits, logoFor, pickConnection, titleCase, type Connection, type Toolkit } from "@/lib/composio-api.server";
import { listPermissions } from "@/lib/app-permissions.server";
import { getGitHubUserConnection, isGitHubOAuthConfigured } from "@/lib/github-oauth.server";

const fail = (error: string, status: number) => Response.json({ error }, { status });

/**
 * The app directory for this person: Composio's catalogue (searchable, by category, well-known apps first), each app marked with
 * this person's own connection and permissions. Pages of 24 by default so the list opens fast.
 */
export const Route = createFileRoute("/api/apps/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const guard = await requirePaidUser(request);
        if (!guard.ok) return guard.response;
        const params = new URL(request.url).searchParams;
        const q = (params.get("q") ?? "").slice(0, 80);
        const category = (params.get("category") ?? "").toLowerCase().slice(0, 64);
        const view = params.get("view") === "connected" ? "connected" : "all";
        const offset = Math.max(0, Math.floor(Number(params.get("offset"))) || 0);
        const limit = Math.min(60, Math.max(1, Math.floor(Number(params.get("limit"))) || 24));
        const configured = composioApiConfigured();
        try {
          const [permissions, connections] = await Promise.all([listPermissions(guard.uid), configured ? listConnections(guard.uid) : Promise.resolve([] as Connection[])]);
          let githubOAuthConnection: { login: string; githubUserId: number } | null = null;
          if (isGitHubOAuthConfigured()) {
            try { githubOAuthConnection = await getGitHubUserConnection(guard.uid); }
            catch (err) { console.warn("[Zeros] GitHub OAuth connection status could not be read:", err); }
          }
          let catalog: Toolkit[] = [], catalogError: string | null = null;
          if (configured) {
            try { catalog = await listToolkits(); }
            catch (err) { console.warn("[Zeros] The app directory could not be loaded:", err); catalogError = "The app directory could not be loaded right now."; }
          }
          if (isGitHubOAuthConfigured() && !catalog.some((toolkit) => toolkit.slug === "github")) {
            catalog = [...catalog, { slug: "github", name: "GitHub", logo: logoFor("github"), description: "Authorize your own GitHub account for repository access.", categories: [] }];
          }
          const live = connections.filter(isLive);
          const hasComposioGitHub = live.some((connection) => connection.toolkit === "github");
          const oauthOnlyConnection: Connection[] = githubOAuthConnection && !hasComposioGitHub
            ? [{ id: "github-oauth", toolkit: "github", status: "ACTIVE" }]
            : [];
          const effectiveLive = [...live, ...oauthOnlyConnection];
          // One connection per app: the NEWEST live one, so an old sign-in can never shadow the one just made.
          const connectionOf = new Map<string, Connection>();
          for (const slug of new Set(effectiveLive.map((c) => c.toolkit))) { const best = pickConnection(effectiveLive, slug); if (best) connectionOf.set(slug, best); }
          // Apps whose sign-in expired (or is still being set up) are shown as such, not as "not connected".
          const attentionOf = new Map<string, "reconnect" | "pending">();
          for (const c of connections) {
            if (connectionOf.has(c.toolkit)) continue;
            if (isBroken(c)) attentionOf.set(c.toolkit, "reconnect");
            else if (isPending(c) && !attentionOf.has(c.toolkit)) attentionOf.set(c.toolkit, "pending");
          }
          const permissionOf = new Map(permissions.map((p) => [p.toolkit, p]));
          const known = new Map(catalog.map((t) => [t.slug, t]));
          const poolSlugs = [...new Set([...connectionOf.keys(), ...attentionOf.keys()])];
          const pool: Toolkit[] = view === "connected"
            ? poolSlugs.map((slug) => known.get(slug) ?? { slug, name: titleCase(slug), logo: logoFor(slug), description: "", categories: [] })
            : catalog;
          const matches = filterCatalog(pool, { q, ...(view === "all" ? { category } : {}) });
          const items = matches.slice(offset, offset + limit).map((t) => {
            const c = connectionOf.get(t.slug), p = permissionOf.get(t.slug);
            return { ...t, connection: c ? { id: c.id, status: c.status || "ACTIVE" } : null, attention: c ? null : (attentionOf.get(t.slug) ?? null), enabled: !!c && !!p?.enabled, allowWrites: !!c && !!p?.enabled && !!p.allowWrites };
          });
          return Response.json({
            configured,
            items,
            total: matches.length,
            nextOffset: offset + limit < matches.length ? offset + limit : null,
            categories: categoriesOf(catalog),
            connectedCount: connectionOf.size,
            catalogError,
            connected: [...connectionOf.values()].map((c) => ({ id: c.id, toolkit: c.toolkit, status: c.status || "ACTIVE" })),
            permissions,
          });
        } catch (err) {
          console.error("[Zeros] Apps could not be loaded:", err);
          return fail("Your apps could not be loaded right now. Please try again.", 502);
        }
      },
    },
  },
});
