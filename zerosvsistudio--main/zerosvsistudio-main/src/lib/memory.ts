import { supabase } from "@/integrations/supabase/client";
import { readSettings, writeSettings } from "@/lib/settings-bridge";
import {
  MEMORY_MAX_FACTS,
  cleanFact,
  compareFacts,
  isSensitive,
  mayContainPersonalFact,
  similarity,
} from "@/lib/memory-utils";
import { authHeaders } from "@/lib/auth-token";

export type MemoryItem = { id: string; fact: string; created_at?: string };

/** Whether Zeros may remember facts for the signed-in account. Saved with the account, so it follows it to every device. */
export function memoryEnabled(): boolean {
  return readSettings().memoryEnabled;
}

export function setMemoryEnabled(on: boolean): void {
  writeSettings({ memoryEnabled: on });
}

export async function loadMemories(userId: string): Promise<MemoryItem[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("id, fact, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MEMORY_MAX_FACTS);
  if (error) throw error;
  return (data ?? []) as MemoryItem[];
}

/** Inserts new facts (deduped; a more detailed version replaces the older one). Returns the list, newest first. */
export async function addMemories(userId: string, facts: string[], current: MemoryItem[]): Promise<MemoryItem[]> {
  const fresh: string[] = [];
  const replaced = new Set<string>();
  for (const raw of facts) {
    const fact = cleanFact(raw);
    if (!fact || isSensitive(fact)) continue;
    let dup = false;
    for (const m of current) {
      if (replaced.has(m.id)) continue;
      const rel = compareFacts(m.fact, fact);
      if (rel === "same") dup = true;
      else if (rel === "supersedes") replaced.add(m.id);
    }
    if (dup || fresh.some((f) => compareFacts(f, fact) === "same")) continue;
    fresh.push(fact);
  }
  if (!fresh.length) return current;
  const { data, error } = await supabase
    .from("memories")
    .insert(fresh.map((fact) => ({ user_id: userId, fact })))
    .select("id, fact, created_at");
  if (error || !data) return current;
  if (replaced.size) await supabase.from("memories").delete().in("id", [...replaced]).eq("user_id", userId);
  let next = [...(data as MemoryItem[]), ...current.filter((m) => !replaced.has(m.id))];
  if (next.length > MEMORY_MAX_FACTS) {
    const drop = next.slice(MEMORY_MAX_FACTS);
    next = next.slice(0, MEMORY_MAX_FACTS);
    await supabase.from("memories").delete().in("id", drop.map((d) => d.id)).eq("user_id", userId);
  }
  return next;
}

/** Removes stored facts that match any needle (exact, contained, or similar). */
export async function forgetMemories(userId: string, needles: string[], current: MemoryItem[]): Promise<MemoryItem[]> {
  const gone = current.filter((m) =>
    needles.some((n) => {
      const a = m.fact.toLowerCase();
      const b = cleanFact(n).toLowerCase();
      return a === b || (b.length >= 5 && (a.includes(b) || b.includes(a))) || similarity(a, b) >= 0.55;
    }),
  );
  if (!gone.length) return current;
  await supabase.from("memories").delete().in("id", gone.map((g) => g.id)).eq("user_id", userId);
  const ids = new Set(gone.map((g) => g.id));
  return current.filter((m) => !ids.has(m.id));
}

export async function deleteMemory(userId: string, id: string): Promise<void> {
  await supabase.from("memories").delete().eq("id", id).eq("user_id", userId);
}

export async function clearMemories(userId: string): Promise<void> {
  await supabase.from("memories").delete().eq("user_id", userId);
}

/**
 * After a normal chat turn: ask the extractor whether the user revealed anything durable.
 * Returns the new list, or null when nothing changed. Never throws.
 */
export async function learnFromTurn(
  userId: string,
  userText: string,
  assistantText: string,
  current: MemoryItem[],
): Promise<MemoryItem[] | null> {
  try {
    if (!mayContainPersonalFact(userText)) return null;
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ user: userText, assistant: assistantText.slice(0, 1500), existing: current.map((m) => m.fact) }),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { add?: string[]; forget?: string[] };
    let next = current;
    if (out.forget?.length) next = await forgetMemories(userId, out.forget, next);
    if (out.add?.length) next = await addMemories(userId, out.add, next);
    return next === current ? null : next;
  } catch {
    return null;
  }
}
