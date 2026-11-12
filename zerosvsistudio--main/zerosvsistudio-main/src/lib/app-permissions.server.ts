/**
 * Per-app permissions for one person: whether Zeros may use an app in chat ("Use in chat"), and whether it may make changes
 * in that app ("Allow changes"). Changes still need a confirmation for each action. Turning an app off also turns changes off.
 */
import { adminRest } from "./supabase-admin.server";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
export type Permission = { toolkit: string; enabled: boolean; allowWrites: boolean };

export async function listPermissions(uid: string, opts: { env?: Env; fetch?: Fetch } = {}): Promise<Permission[]> {
  const res = await adminRest(opts.env ?? (process.env as Env), opts.fetch ?? fetch, `zeros_app_permissions?user_id=eq.${encodeURIComponent(uid)}&select=toolkit_slug,enabled,allow_writes`);
  if (!res.ok) throw new Error(`Reading app permissions failed (HTTP ${res.status}).`);
  const rows = (await res.json()) as { toolkit_slug?: string; enabled?: boolean; allow_writes?: boolean }[];
  return rows.filter((r) => r.toolkit_slug).map((r) => ({ toolkit: String(r.toolkit_slug), enabled: !!r.enabled, allowWrites: !!r.allow_writes && !!r.enabled }));
}

export async function savePermission(uid: string, toolkit: string, patch: { enabled?: boolean; allowWrites?: boolean }, opts: { env?: Env; fetch?: Fetch } = {}): Promise<Permission> {
  const current = (await listPermissions(uid, opts)).find((p) => p.toolkit === toolkit) ?? { toolkit, enabled: false, allowWrites: false };
  const enabled = patch.enabled ?? current.enabled;
  const allowWrites = enabled && (patch.allowWrites ?? current.allowWrites);
  const res = await adminRest(opts.env ?? (process.env as Env), opts.fetch ?? fetch, "zeros_app_permissions?on_conflict=user_id,toolkit_slug", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, toolkit_slug: toolkit, enabled, allow_writes: allowWrites, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Saving the app permission failed (HTTP ${res.status}).`);
  return { toolkit, enabled, allowWrites };
}
