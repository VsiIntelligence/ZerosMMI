import { supabase } from "@/integrations/supabase/client";

/**
 * Chat assets (images, songs, 3D models, website archives) live in a private Supabase Storage bucket.
 * The repo's migration creates `ZerosMessages`; older deployments used `KerisAccounts`. We support both:
 * uploads go to whichever bucket accepts them first (remembered for the session), reads/deletes try both.
 */
export const CHAT_ASSET_BUCKETS = ["ZerosMessages", "KerisAccounts"] as const;
export const CHAT_ASSET_BUCKET = CHAT_ASSET_BUCKETS[0];

let preferred: string = CHAT_ASSET_BUCKETS[0];
const order = (): string[] => [preferred, ...CHAT_ASSET_BUCKETS.filter((b) => b !== preferred)];

export type StoredAsset = { storagePath: string; mimeType: string; name: string };

export async function uploadChatAsset(
  userId: string,
  conversationId: string,
  blob: Blob,
  name: string,
): Promise<StoredAsset> {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `${userId}/${conversationId}/${crypto.randomUUID()}-${safeName}`;
  let lastError: unknown = null;
  for (const bucket of order()) {
    const { error } = await supabase.storage.from(bucket).upload(path, blob, {
      contentType: blob.type || "application/octet-stream",
      upsert: false,
      cacheControl: "31536000",
    });
    if (!error) {
      preferred = bucket;
      return { storagePath: path, mimeType: blob.type || "application/octet-stream", name: safeName };
    }
    lastError = error;
  }
  throw lastError ?? new Error("Upload failed.");
}

/** Upload any serializable payload (model spec, web project) as JSON into the chat bucket. */
export async function uploadChatJson(
  userId: string,
  conversationId: string,
  data: unknown,
  name: string,
): Promise<StoredAsset> {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  return uploadChatAsset(userId, conversationId, blob, name.endsWith(".json") ? name : `${name}.json`);
}

type SignedRows = { data: { path: string | null; signedUrl: string; error: string | null }[] | null; error: unknown };

/** Rejects after `ms` so a stalled storage request can never freeze the chat. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Signs many asset paths with ONE request per bucket (instead of one per asset, each trying both buckets in turn).
 * Paths a bucket does not hold are retried against the next bucket; paths nobody holds are simply absent from the result.
 */
export async function signedChatAssetUrls(paths: string[], expiresIn = 3600 * 24 * 7): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let todo = [...new Set(paths.filter(Boolean))];
  for (const bucket of order()) {
    if (!todo.length) break;
    try {
      const { data, error } = (await withTimeout(supabase.storage.from(bucket).createSignedUrls(todo, expiresIn), 9000, "Asset signing")) as SignedRows;
      if (error || !data) continue;
      for (const row of data) if (row.path && row.signedUrl && !row.error) { out[row.path] = row.signedUrl; preferred = bucket; }
      todo = todo.filter((p) => !out[p]);
    } catch (e) { console.warn(`[Zeros] signing in ${bucket} failed:`, e); }
  }
  return out;
}

export async function signedChatAssetUrl(storagePath: string, expiresIn = 3600 * 24 * 7): Promise<string> {
  const url = (await signedChatAssetUrls([storagePath], expiresIn))[storagePath];
  if (!url) throw new Error("Could not create asset URL.");
  return url;
}

/** Fetch a JSON asset previously stored in the chat bucket (bounded: a slow download never blocks the chat). */
export async function fetchChatJson<T = unknown>(storagePath: string, signedUrl?: string): Promise<T> {
  const url = signedUrl ?? (await signedChatAssetUrl(storagePath));
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Asset fetch failed (${res.status})`);
  return (await res.json()) as T;
}

export async function deleteChatAssets(paths: string[]): Promise<void> {
  const clean = [...new Set(paths.filter(Boolean))];
  if (!clean.length) return;
  for (let i = 0; i < clean.length; i += 1000) {
    const chunk = clean.slice(i, i + 1000);
    // A path lives in exactly one bucket; removing from the other is a harmless no-op.
    for (const bucket of CHAT_ASSET_BUCKETS) {
      const { error } = await supabase.storage.from(bucket).remove(chunk);
      if (error && !/not found/i.test(error.message ?? "")) throw error;
    }
  }
}

/**
 * Removes every asset a conversation stored (songs, videos, images, website archives, specs). They all live flat under
 * `<user>/<conversation>/`, so one listing finds them. Best effort and never throws: deleting a chat must not fail, or leave
 * the user staring at a chat they asked to erase, just because storage is briefly unreachable.
 */
export async function deleteConversationAssets(userId: string, conversationId: string): Promise<number> {
  const dir = `${userId}/${conversationId}`;
  let removed = 0;
  for (const bucket of CHAT_ASSET_BUCKETS) {
    try {
      const store = supabase.storage.from(bucket);
      const names: string[] = [];
      for (let offset = 0; offset < 5000; offset += 100) {
        const { data, error } = await store.list(dir, { limit: 100, offset });
        if (error || !data?.length) break;
        names.push(...data.map((f) => `${dir}/${f.name}`));
        if (data.length < 100) break;
      }
      for (let i = 0; i < names.length; i += 1000) {
        const { error } = await store.remove(names.slice(i, i + 1000));
        if (!error) removed += Math.min(1000, names.length - i);
      }
    } catch { /* storage is best-effort here */ }
  }
  return removed;
}
