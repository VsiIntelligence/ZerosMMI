/** The browser's calls to the app routes. Everything is per signed-in person; the server decides what is allowed. */
import { authHeaders } from "@/lib/auth-token";
import type { AppProposal } from "@/lib/chat-attachments";

export type AppCategory = { slug: string; name: string; count?: number };
/** One app in the directory, with this person's own connection and settings for it. */
export type AppItem = {
  slug: string;
  name: string;
  logo: string;
  description: string;
  categories: AppCategory[];
  connection: { id: string; status: string } | null;
  /** The sign-in exists but needs the person (expired, or still being set up). */
  attention?: "reconnect" | "pending" | null;
  enabled: boolean;
  allowWrites: boolean;
};
/** One app's health check: evidence from a live read-only test, plus what to do when something is wrong. */
export type AppCheck = {
  toolkit: string;
  name: string;
  connection: "active" | "pending" | "needs_reconnect" | "missing";
  useInChat: boolean | null;
  allowChanges: boolean | null;
  actions: { total: number; reads: number; changes: number } | null;
  probe: { tool: string; ok: boolean; ms: number; detail: string } | { skipped: string } | null;
  status: "ready" | "attention" | "broken";
  fixes: string[];
  notes: string[];
  autoFix?: "enable";
};
export type AppsVerification = { checkedAt: string; results: AppCheck[]; summary: string[]; fixed: string[] };
export type AppsPage = {
  configured: boolean;
  items: AppItem[];
  total: number;
  nextOffset: number | null;
  categories: AppCategory[];
  connectedCount: number;
  catalogError: string | null;
};
export type AppsQuery = { q?: string; category?: string; view?: "all" | "connected"; offset?: number };
export type AppAction = { name: string; description: string; write: boolean };
type Result<T> = { ok: true; data: T } | { ok: false; error: string; needsConfirm?: boolean };

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Result<T>> {
  const res = await fetch(path, {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  }).catch(() => null);
  if (!res) return { ok: false, error: "ZerosX2.0 could not be reached. Check your connection and try again." };
  const body = (await res.json().catch(() => null)) as (T & { error?: string; needsConfirm?: boolean }) | null;
  if (!res.ok || !body) return { ok: false, error: body?.error ?? `The request failed (HTTP ${res.status}).`, needsConfirm: body?.needsConfirm === true };
  return { ok: true, data: body };
}

export function getApps(query: AppsQuery = {}): Promise<Result<AppsPage>> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.view === "connected") params.set("view", "connected");
  if (query.offset) params.set("offset", String(query.offset));
  const qs = params.toString();
  return call<AppsPage>(`/api/apps${qs ? `?${qs}` : ""}`);
}
export const getAppActions = (toolkit: string) => call<{ toolkit: string; tools: AppAction[] }>(`/api/apps/tools?toolkit=${encodeURIComponent(toolkit)}`);
export const connectApp = (toolkit: string) => call<{ redirectUrl: string; toolkit: string }>("/api/apps/connect", { json: { toolkit } });
export const connectGitHub = () => call<{ redirectUrl: string }>("/api/github/connect", { json: {} });
export const disconnectApp = (connectionId: string, toolkit: string) => call<{ ok: boolean }>("/api/apps/disconnect", { json: { connectionId, toolkit } });
/** Finishes a sign-in: waits for the connection to be live, then switches the app on for chat. */
export const finishApp = (toolkit: string) =>
  call<{ ok: boolean; pending?: boolean; keptReadOnly?: boolean; error?: string }>("/api/apps/finish", { json: { toolkit } });
/** Tests the person's connected apps for real (one app, or all of them); `fix` also switches on any that are still off. */
export const verifyApps = (toolkit?: string, fix = false) => {
  const params = new URLSearchParams();
  if (toolkit) params.set("toolkit", toolkit);
  if (fix) params.set("fix", "1");
  const qs = params.toString();
  return call<AppsVerification>(`/api/apps/verify${qs ? `?${qs}` : ""}`);
};
export const savePermission = (toolkit: string, patch: { enabled?: boolean; allowWrites?: boolean }) =>
  call<{ toolkit: string; enabled: boolean; allowWrites: boolean }>("/api/apps/permissions", { json: { toolkit, ...patch } });
export const runAppAction = (proposal: Pick<AppProposal, "toolkit" | "tool" | "arguments">, confirm: boolean) =>
  call<{ ok: boolean; text: string }>("/api/connectors/call", { json: { toolkit: proposal.toolkit, tool: proposal.tool, arguments: proposal.arguments, confirm } });

/* ------------------------------------------------------------------ coming back from an app's sign-in page */
const SLUG = /^[a-z0-9_-]{2,64}$/;
const APP_PARAMS = ["connected", "status", "connected_account_id", "error"];

/** Recognises the address an app sends the person back to after they sign in to it. */
export function readAppsReturn(search: string): { toolkit: string; ok: boolean } | null {
  const q = new URLSearchParams(search);
  const toolkit = (q.get("connected") ?? "").toLowerCase();
  if (!SLUG.test(toolkit)) return null;
  const status = (q.get("status") ?? "success").toLowerCase();
  return { toolkit, ok: status !== "failed" && status !== "error" && !q.get("error") };
}

export function clearAppsParams(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of APP_PARAMS) url.searchParams.delete(key);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch { /* the address bar keeps its parameters: harmless */ }
}

/** The name to show for an app slug the server only knows by its short name. */
export const appName = (slug: string): string => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
/** Composio serves every app's logo from one address. */
export const appLogo = (slug: string): string => `https://logos.composio.dev/api/${slug.toLowerCase()}`;
