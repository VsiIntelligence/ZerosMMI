/**
 * Server-only engine pool for Zeros. Three engines sit behind one interface:
 *
 *   A  streaming text, JSON, vision, images and voice     (keys in ZEROS_A_KEYS)
 *   B  very fast streaming text                           (keys in ZEROS_B_KEYS)
 *   C  a slower agent that polls for its answer           (keys in ZEROS_C_KEYS), the last resort
 *
 * Nothing about who runs an engine is written in the code: addresses, key header names, model names and voices all come from
 * server-side secrets (see ENVIRONMENT.md). Keys live there too and are never sent to the browser.
 */
import { stripBoringOpener } from "@/lib/voice-guard";
import { engineCatalog, listOf } from "@/lib/zeros-models.server";

export type Msg = { role: "user" | "assistant"; content: string };
export type ImageInput = { mimeType: string; data: string };

type Env = Record<string, string | undefined>;

/** Env read that never throws (Workers may not populate process.env until a request arrives). */
const env = (): Env => {
  try { return typeof process !== "undefined" && process.env ? (process.env as Env) : {}; } catch { return {}; }
};
const setting = (name: string): string => (env()[name] ?? "").trim();
const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/* ------------------------------------------------------------------ configuration */
export type KeyedEngine = { url: string; keys: string[] };
export type HeaderEngine = KeyedEngine & { header: string };

/** Engine A: the address, the name of the header that carries the key, and the keys. Null until all three are set. */
export function engineA(): HeaderEngine | null {
  const url = trimSlash(setting("ZEROS_A_URL")), header = setting("ZEROS_A_KEY_HEADER"), keys = listOf(setting("ZEROS_A_KEYS"));
  return url && header && keys.length ? { url, header, keys } : null;
}
/** Engine B: the address and the keys (sent as a bearer token). */
export function engineB(): KeyedEngine | null {
  const url = trimSlash(setting("ZEROS_B_URL")), keys = listOf(setting("ZEROS_B_KEYS"));
  return url && keys.length ? { url, keys } : null;
}
/** Engine C: the address, the key header, the keys and the agent profile to run. */
export function engineC(): (HeaderEngine & { profile: string }) | null {
  const url = trimSlash(setting("ZEROS_C_URL")), header = setting("ZEROS_C_KEY_HEADER"), keys = listOf(setting("ZEROS_C_KEYS"));
  return url && header && keys.length ? { url, header, keys, profile: setting("ZEROS_C_PROFILE") } : null;
}

/** Which engines are ready (for the server log and the health checks; never shown to people). */
export function enginesReady(): { a: boolean; b: boolean; c: boolean } {
  return { a: !!engineA(), b: !!engineB(), c: !!engineC() };
}

/** fetch that aborts if response headers don't arrive in time (stream-safe). */
export async function fetchHeaders(url: string, init: RequestInit, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ what went wrong, and calling carefully */
export type EngineName = "a" | "b" | "c" | "i";
export type EngineFailure = { engine: EngineName; model: string; status: number; detail: string; at: number };
const failures: EngineFailure[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Pause before a retry. Tests shorten it with ZEROS_ENGINE_BACKOFF_MS. */
const backoffMs = (n: number): number => { const base = Number(setting("ZEROS_ENGINE_BACKOFF_MS")); return (Number.isFinite(base) && base >= 0 && setting("ZEROS_ENGINE_BACKOFF_MS") !== "" ? base : 400) * (n + 1) * (n + 1); };

/** Every configured key, so a provider's error text can never put one into a log or a diagnostics report. */
function secretValues(): string[] {
  return ["ZEROS_A_KEYS", "ZEROS_B_KEYS", "ZEROS_C_KEYS", "ZEROS_I_KEY", "ZEROS_I_KEYS", "ZEROS_A_VOICE_KEYS"].flatMap((name) => listOf(setting(name))).filter((k) => k.length >= 8);
}
function scrub(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const secret of secretValues()) out = out.split(secret).join("***");
  return out.replace(/\b(?:AIza|sk-|ghp_|ghu_|xox[bap]-)[A-Za-z0-9_\-]{12,}/g, "***").slice(0, 240);
}
/** Remembers why an engine call failed (never the keys). The owner reads this in the log and in the engine health report. */
export function noteFailure(f: { engine: EngineName; model: string; status: number; detail?: string }): void {
  const entry: EngineFailure = { engine: f.engine, model: f.model, status: f.status, detail: scrub(f.detail ?? ""), at: Date.now() };
  failures.push(entry);
  if (failures.length > 40) failures.shift();
  console.warn(`[Zeros] engine ${entry.engine} · ${entry.model || "-"}: ${entry.status ? `HTTP ${entry.status}` : "no answer (timed out or unreachable)"}${entry.detail ? `: ${entry.detail}` : ""}`);
}
export const recentEngineFailures = (): EngineFailure[] => failures.slice(-20);

/** A model that was reported missing or retired is skipped for a few minutes, so a bad name costs one call, not one per request. */
const deadModels = new Map<string, number>();
const DEAD_MS = 5 * 60_000;
const isDead = (key: string): boolean => { const until = deadModels.get(key); if (!until) return false; if (until < Date.now()) { deadModels.delete(key); return false; } return true; };
export function resetEngineMemory(): void { deadModels.clear(); failures.length = 0; discovered.clear(); }

const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const TOKEN_LIMIT = /(max(?:imum)?[_ -]?(?:output[_ -]?|completion[_ -]?)?tokens|output tokens|token limit|too many tokens|exceeds? the (?:model'?s |maximum |max )?(?:limit|output))/i;
const MODEL_MISSING = /(not found|does not exist|no such model|unknown model|unsupported model|is not supported|invalid model|decommission|deprecated|retired|shut down|not available)/i;

export type EngineCall = {
  engine: EngineName;
  model: string;
  url: string;
  headers: Record<string, string>;
  /** The request body for a given output cap, so a provider that rejects the cap is simply asked again with a smaller one. */
  body: (maxOut: number) => string;
  timeoutMs: number;
  maxOut?: number;
};

/**
 * One call to an engine with the care a person would take: a busy or briefly broken provider (429, 5xx, a dropped connection) is asked
 * again after a short pause; a provider that refuses the output size is asked for less; a model that does not exist is remembered
 * as missing. Every failure is noted with its real reason. Returns the successful response, or null.
 */
export async function callEngine(spec: EngineCall): Promise<Response | null> {
  // keyed by address too: the same model name at a different engine address is a different thing
  const deadKey = `${spec.engine}|${spec.url.replace(/[?#].*$/, "")}|${spec.model}`;
  if (isDead(deadKey)) return null;
  let maxOut = spec.maxOut ?? 65536, transient = 0, hung = 0, shrunk = false;
  for (let guard = 0; guard < 7; guard++) {
    const res = await fetchHeaders(spec.url, { method: "POST", headers: spec.headers, body: spec.body(maxOut) }, spec.timeoutMs);
    if (!res) {
      noteFailure({ engine: spec.engine, model: spec.model, status: 0 });
      if (hung++ < 1) { await sleep(backoffMs(0)); continue; }
      return null;
    }
    if (res.ok) return res;
    const detail = await res.text().catch(() => "");
    noteFailure({ engine: spec.engine, model: spec.model, status: res.status, detail });
    if (res.status === 400 && !shrunk && maxOut > 8192 && TOKEN_LIMIT.test(detail)) { shrunk = true; maxOut = 8192; continue; }
    if (TRANSIENT.has(res.status) && transient < (res.status === 429 ? 2 : 1)) {
      const asked = Number(res.headers.get("retry-after"));
      await sleep(Math.min(Number.isFinite(asked) && asked > 0 ? asked * 1000 : backoffMs(transient), 4000));
      transient++;
      continue;
    }
    if (res.status === 404 || (res.status === 400 && MODEL_MISSING.test(detail))) deadModels.set(deadKey, Date.now() + DEAD_MS);
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ asking the engines what they have */
export type DiscoveredModels = { best: string[]; fast: string[]; image: string[]; limit: Record<string, number> };
const discovered = new Map<string, { at: number; value: DiscoveredModels | null }>();
/** Models that are not for writing text (or are for pictures, sound or search), recognised by generic words in their names. */
const NOT_TEXT = /embed|tts|speech|audio|transcri|whisper|moderat|rerank|guard|realtime|\blive\b|video|music|aqa|image|img|dall|flux|diffus|sora|\bocr\b|robot|computer-use/i;
const IS_IMAGE = /image|img|dall|flux|diffus|sdxl|imagine|picture/i;
const BEST_TIER = /(?:^|[-_/. ])(?:pro|large|max|ultra|opus|plus|xl|sonnet|reason\w*|think\w*)(?:$|[-_/. ])|(?:^|[-_/])(?:70|72|120|235|405)b/i;
const FAST_TIER = /(?:^|[-_/. ])(?:flash|mini|small|lite|nano|haiku|instant|turbo|fast)(?:$|[-_/. ])|(?:^|[-_/])(?:3|7|8|9)b\b/i;
function rank(name: string, tier: RegExp): number {
  let n = tier.test(name) ? 100 : 0;
  const version = /(\d+(?:\.\d+)?)/.exec(name)?.[1];
  if (version) n += Math.min(Number(version), 30) * 4;
  if (/preview|exp(?:erimental)?|deprecated|legacy|beta|-\d{3,4}\b|-\d{2}-\d{2}/i.test(name)) n -= 15;
  if (/latest/i.test(name)) n += 6;
  return n;
}
const top = (names: string[], tier: RegExp, n: number): string[] => [...names].sort((x, y) => rank(y, tier) - rank(x, tier) || x.localeCompare(y)).slice(0, n);

async function listModels(engine: "a" | "b"): Promise<{ name: string; methods?: string[]; limit?: number }[] | null> {
  const out: { name: string; methods?: string[]; limit?: number }[] = [];
  const keys = engine === "a" ? (engineA()?.keys ?? []) : (engineB()?.keys ?? []);
  for (const key of keys) {
    let token = "";
    for (let page = 0; page < 4; page++) {
      const base = engine === "a" ? engineA()!.url : engineB()!.url;
      const res = await fetchHeaders(`${base}/models${engine === "a" ? `?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ""}` : ""}`, { headers: engine === "a" ? { [engineA()!.header]: key } : { Authorization: `Bearer ${key}` } }, 8000);
      if (!res?.ok) { if (res) noteFailure({ engine, model: "(model list)", status: res.status, detail: await res.text().catch(() => "") }); else noteFailure({ engine, model: "(model list)", status: 0 }); break; }
      const json = (await res.json().catch(() => null)) as { models?: { name?: string; supportedGenerationMethods?: string[]; outputTokenLimit?: number }[]; data?: { id?: string }[]; nextPageToken?: string } | null;
      for (const m of json?.models ?? []) if (m.name) out.push({ name: m.name.replace(/^models\//, ""), ...(m.supportedGenerationMethods ? { methods: m.supportedGenerationMethods } : {}), ...(m.outputTokenLimit ? { limit: m.outputTokenLimit } : {}) });
      for (const m of json?.data ?? []) if (m.id) out.push({ name: m.id });
      token = json?.nextPageToken ?? "";
      if (!token) break;
    }
    if (out.length) return out;
  }
  return out.length ? out : null;
}

/** What an engine really offers right now, so a retired or misspelt model in the settings can never leave Zeros without an answer. Kept for ten minutes. */
export async function discoverModels(engine: "a" | "b"): Promise<DiscoveredModels | null> {
  const key = `${engine}|${(engine === "a" ? engineA()?.url : engineB()?.url) ?? ""}`;
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? 10 * 60_000 : 60_000)) return hit.value;
  if (!(engine === "a" ? engineA() : engineB())) return null;
  const listed = await listModels(engine);
  let value: DiscoveredModels | null = null;
  if (listed?.length) {
    const generates = (m: { methods?: string[] }): boolean => !m.methods || m.methods.includes("generateContent") || m.methods.includes("predict");
    const text = listed.filter((m) => generates(m) && !NOT_TEXT.test(m.name)).map((m) => m.name);
    const image = listed.filter((m) => generates(m) && IS_IMAGE.test(m.name) && !/embed|tts|audio|video/i.test(m.name)).map((m) => m.name);
    value = { best: top(text, BEST_TIER, 6), fast: top(text, FAST_TIER, 6), image: top(image, /./, 4), limit: Object.fromEntries(listed.filter((m) => m.limit).map((m) => [m.name, m.limit!])) };
  }
  discovered.set(key, { at: Date.now(), value });
  return value;
}
/** The most output a model is known to allow (from discovery), else the usual cap. */
const outputCap = (engine: "a" | "b", model: string): number => {
  const known = discovered.get(`${engine}|${(engine === "a" ? engineA()?.url : engineB()?.url) ?? ""}`)?.value?.limit[model];
  return known && known > 1024 ? Math.min(65536, known) : 65536;
};

/** For the owner only: how each engine is set up and what has gone wrong lately. Never contains a key. */
export async function describeEngines(opts: { discover?: boolean } = {}): Promise<Record<string, unknown>> {
  const a = engineA(), b = engineB(), c = engineC();
  const cat = engineCatalog();
  const probe = opts.discover ? { a: await discoverModels("a").catch(() => null), b: await discoverModels("b").catch(() => null) } : null;
  return {
    a: { configured: !!a, keys: a?.keys.length ?? 0, models: cat.a.best, fastModels: cat.a.fast, imageModels: listOf(setting("ZEROS_A_IMAGE_MODELS")), ...(probe ? { available: probe.a } : {}) },
    b: { configured: !!b, keys: b?.keys.length ?? 0, models: cat.b.best, fastModels: cat.b.fast, ...(probe ? { available: probe.b } : {}) },
    c: { configured: !!c, keys: c?.keys.length ?? 0 },
    problems: recentEngineFailures(),
    missing: [
      ...(!a && !b && !c ? ["No text engine is configured: set ZEROS_A_URL, ZEROS_A_KEY_HEADER and ZEROS_A_KEYS (engine A), or ZEROS_B_URL and ZEROS_B_KEYS (engine B), or the agent (engine C)."] : []),
      ...(a && !cat.a.best.length ? ["Engine A has no models listed in ZEROS_A_MODELS; Zeros will use whatever the engine offers."] : []),
      ...(b && !cat.b.best.length ? ["Engine B has no models listed in ZEROS_B_MODELS; Zeros will use whatever the engine offers."] : []),
    ],
  };
}

/* ------------------------------------------------------------------ engine C: the agent */
type AgentEvent = {
  type?: string;
  assistant_message?: { content?: string };
  error_message?: { content?: string };
  status_update?: { agent_status?: string };
};

async function agentPoll(c: HeaderEngine, key: string, id: string, deadline: number): Promise<string | null> {
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(
      `${c.url}/task.listMessages?task_id=${encodeURIComponent(id)}&order=asc&limit=100`,
      { headers: { [c.header]: key } },
    ).catch(() => null);
    if (!res || !res.ok) continue;
    const json = (await res.json().catch(() => null)) as { messages?: AgentEvent[] } | null;
    const events = json?.messages ?? [];
    const text = events
      .filter((e) => e.type === "assistant_message")
      .map((e) => e.assistant_message?.content ?? "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) last = text;
    const status = [...events].reverse().find((e) => e.type === "status_update")?.status_update?.agent_status;
    if (events.some((e) => e.type === "error_message")) return last || null;
    if (status === "stopped" || status === "finished") return last || null;
  }
  return last || null;
}

/** Tries every agent key in order. Returns the reply text, or null if all fail. */
export async function agentChat(system: string, messages: Msg[], budgetMs = 60000): Promise<string | null> {
  const c = engineC();
  if (!c) return null;

  const convo = messages
    .map((m) => `${m.role === "user" ? "User" : "Zeros"}: ${m.content}`)
    .join("\n\n");
  const prompt =
    `${system}\n\nConversation so far:\n${convo}\n\n` +
    `Reply now as Zeros to the last user message. Follow the system instructions exactly, including any required code fences, JSON, website files, song composition data, or other structured artifact. Do not add meta-commentary about the technology or the generation process. Zeros is a funny, witty, warm friend: never open with task-runner phrases like "I'll read...", "I will...", "Let me...", "Sure" or "Here is" - open with a specific, playful hook instead.`;

  const deadline = Date.now() + budgetMs;
  for (const key of c.keys) {
    if (Date.now() > deadline - 6000) break;
    try {
      const res = await fetchHeaders(`${c.url}/task.create`, {
        method: "POST",
        headers: { [c.header]: key, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: { content: prompt.slice(0, 16000) },
          mode: "speed",
          ...(c.profile ? { agent_profile: c.profile } : {}),
        }),
      }, 25000);
      if (!res?.ok) continue;
      const created = (await res.json().catch(() => ({}))) as { task_id?: string; ok?: boolean };
      if (!created.task_id) continue;
      const text = await agentPoll(c, key, created.task_id, deadline);
      if (text && text.length > 20) return stripBoringOpener(text);   /* the agent's task-runner voice never reaches the user */
    } catch {
      /* next key */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ engine A: content API */
type Part = { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } };
type Candidates = { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[] };

export function nativeBody(system: string, messages: Msg[], maxOut = 65536) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { temperature: 1, maxOutputTokens: maxOut },
  };
}

const nativeText = (json: Candidates): string => (json.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");

/**
 * Engine A's event stream -> the chat-style SSE the browser already understands.
 *
 * `pull()` must NEVER return without enqueueing (or closing): the Streams spec only calls `pull()` again after an enqueue, so a
 * network chunk that ends in the middle of an event would otherwise leave the consumer's pending `read()` hanging forever
 * (the chat would freeze mid-sentence). We therefore keep reading until at least one event is complete, or the stream ends.
 */
export function toChatSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buffer = "";

  /** Handles one SSE line; returns what to emit and whether the model said it is finished. */
  const handleLine = (line: string): { out: string[]; finished: boolean } => {
    const t = line.trim();
    if (!t.startsWith("data:")) return { out: [], finished: false };
    const payload = t.slice(5).trim();
    if (!payload) return { out: [], finished: false };
    if (payload === "[DONE]") return { out: [], finished: true };
    try {
      const json = JSON.parse(payload) as Candidates;
      const out: string[] = [];
      const text = nativeText(json);
      if (text) out.push(sseDelta(text));
      const reason = json.candidates?.[0]?.finishReason;
      if (reason) out.push(sseFinish(reason));
      return { out, finished: !!reason };
    } catch {
      return { out: [], finished: false };   /* a half-delivered or non-JSON line: skip it, the next event is independent */
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += dec.decode();
          for (const line of buffer.split("\n")) for (const o of handleLine(line).out) controller.enqueue(enc.encode(o));
          buffer = "";
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let emitted = false, finished = false;
        for (const line of lines) {
          const r = handleLine(line);
          for (const o of r.out) { controller.enqueue(enc.encode(o)); emitted = true; }
          if (r.finished) finished = true;
        }
        if (finished) {
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
          void reader.cancel();
          return;
        }
        if (emitted) return;   /* the runtime calls pull() again when the consumer wants more */
        /* nothing complete yet (the chunk ended mid-event): keep reading instead of returning empty-handed */
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

export function sseDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

export function sseFinish(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
}

export function textToSse(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks = text.match(/[\s\S]{1,240}/g) ?? [text];
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(sseDelta(chunks[i++] ?? "")));
    },
  });
}

/** Streams one specific engine-A model (every key is tried). Returns chat-style SSE, or null when the model is unavailable. */
export async function streamA(model: string, system: string, messages: Msg[], timeoutMs = 20000): Promise<ReadableStream<Uint8Array> | null> {
  const a = engineA();
  if (!a) return null;
  for (const key of a.keys) {
    const res = await callEngine({
      engine: "a", model, timeoutMs,
      url: `${a.url}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: { [a.header]: key, "Content-Type": "application/json" },
      body: (maxOut) => JSON.stringify(nativeBody(system, messages, maxOut)),
      maxOut: outputCap("a", model),
    });
    if (res?.body) return toChatSse(res.body);
  }
  return null;
}

/** One complete (non-streamed) answer from a specific engine-A model: used for planning, quality review and routing decisions. */
export async function textA(model: string, system: string, messages: Msg[], timeoutMs = 25000): Promise<string | null> {
  const a = engineA();
  if (!a) return null;
  for (const key of a.keys) {
    const res = await callEngine({
      engine: "a", model, timeoutMs,
      url: `${a.url}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { [a.header]: key, "Content-Type": "application/json" },
      body: (maxOut) => JSON.stringify(nativeBody(system, messages, maxOut)),
      maxOut: outputCap("a", model),
    });
    if (!res) continue;
    const json = (await res.json().catch(() => null)) as Candidates | null;
    const text = json ? nativeText(json).trim() : "";
    if (text) return text;
  }
  return null;
}

/* ------------------------------------------------------------------ engine B: chat-completions API */
/** Streams one specific engine-B model (every key is tried). The reply is already chat-style SSE. */
export async function streamB(model: string, system: string, messages: Msg[], structured = false, timeoutMs = 25000): Promise<ReadableStream<Uint8Array> | null> {
  const b = engineB();
  if (!b) return null;
  for (const key of b.keys) {
    const res = await callEngine({
      engine: "b", model, timeoutMs,
      url: `${b.url}/chat/completions`,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: (maxOut) => JSON.stringify({
        model,
        stream: true,
        temperature: 1,
        max_completion_tokens: maxOut,
        ...(structured ? { reasoning_effort: "low", include_reasoning: false } : {}),
        messages: [{ role: "system", content: system }, ...messages],
      }),
      maxOut: outputCap("b", model),
    });
    if (res?.body) return res.body;
  }
  return null;
}

/** One complete answer from engine B, trying every configured model and key. */
export async function textB(system: string, prompt: string): Promise<string | null> {
  const b = engineB();
  if (!b) return null;
  const cat = engineCatalog().b;
  const found = cat.best.length || cat.fast.length ? null : await discoverModels("b").catch(() => null);
  for (const model of [...new Set([...cat.best, ...cat.fast, ...(found ? [...found.fast, ...found.best] : [])])]) {
    for (const key of b.keys) {
      const res = await callEngine({
        engine: "b", model, timeoutMs: 45000,
        url: `${b.url}/chat/completions`,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: (maxOut) => JSON.stringify({
          model,
          temperature: 1,
          max_completion_tokens: Math.min(16384, maxOut),
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res) continue;
      const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
      const text = json?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ images (engine A) */
/**
 * Fallback pictures from engine A. Keep the provider base64 decode to one pass and return bytes directly;
 * converting the image to a second base64 data URL caused avoidable memory spikes on Cloudflare Workers.
 */
export async function nativeImageBytes(prompt: string, budgetMs = 30_000, base?: ImageInput): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const a = engineA();
  if (!a) throw new Error("no picture models are set");
  const configured = listOf(setting("ZEROS_A_IMAGE_MODELS"));
  // Picture models that are not named in the settings (or have been retired) are found by asking the engine what it has.
  const found = (await discoverModels("a").catch(() => null))?.image ?? [];
  const models = [...new Set([...configured, ...found])].slice(0, 6);
  if (!models.length) throw new Error("no picture models are set");
  const deadline = Date.now() + budgetMs;
  const problems: string[] = [];
  // An existing picture (to change it) travels with the request; models that cannot take one are simply tried without it.
  const parts = (withBase: boolean): Record<string, unknown>[] => [...(withBase && base ? [{ inlineData: { mimeType: base.mimeType, data: base.data } }] : []), { text: prompt }];
  for (const model of models) {
    for (const key of a.keys) {
      for (const modalities of [["IMAGE"], ["TEXT", "IMAGE"]]) {
        const remaining = deadline - Date.now();
        if (remaining < 2000) throw new Error([...new Set(problems)].slice(0, 3).join(", ") || "timed out");
        const res = await callEngine({
          engine: "a", model, timeoutMs: Math.min(30_000, remaining),
          url: `${a.url}/models/${encodeURIComponent(model)}:generateContent`,
          headers: { [a.header]: key, "Content-Type": "application/json" },
          body: () => JSON.stringify({ contents: [{ role: "user", parts: parts(!!base) }], generationConfig: { responseModalities: modalities } }),
        });
        if (!res) { problems.push("no answer"); continue; }
        const json = (await res.json().catch(() => null)) as Candidates | null;
        for (const part of json?.candidates?.[0]?.content?.parts ?? []) {
          const data = part.inlineData?.data;
          if (data && data.length > 100) {
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return { bytes, mimeType: part.inlineData?.mimeType ?? "image/png" };
          }
        }
        problems.push("no picture in the reply");
      }
    }
  }
  throw new Error([...new Set(problems)].slice(0, 3).join(", ") || "no picture models are set");
}

/**
 * A picture from engine B's image endpoint (the common "images/generations" shape), when it has one. Models come from
 * ZEROS_B_IMAGE_MODELS or, failing that, from whatever the engine says it offers. Returns null quickly when there is nothing to try.
 */
export async function engineBImageBytes(prompt: string, size: { width?: number | undefined; height?: number | undefined } = {}, budgetMs = 30_000): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const b = engineB();
  if (!b) return null;
  const configured = listOf(setting("ZEROS_B_IMAGE_MODELS"));
  const models = [...new Set([...configured, ...((await discoverModels("b").catch(() => null))?.image ?? [])])].slice(0, 3);
  if (!models.length) return null;
  const deadline = Date.now() + budgetMs;
  const w = Math.min(1536, Math.max(512, Math.round(size.width ?? 1024))), h = Math.min(1536, Math.max(512, Math.round(size.height ?? 1024)));
  for (const model of models) {
    for (const key of b.keys) {
      const remaining = deadline - Date.now();
      if (remaining < 2000) return null;
      const res = await callEngine({
        engine: "b", model, timeoutMs: Math.min(30_000, remaining),
        url: `${b.url}/images/generations`,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: () => JSON.stringify({ model, prompt, n: 1, size: `${w}x${h}`, response_format: "b64_json" }),
      });
      if (!res) continue;
      const json = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[] } | null;
      const item = json?.data?.[0];
      if (item?.b64_json && item.b64_json.length > 100) {
        const binary = atob(item.b64_json);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return { bytes, mimeType: "image/png" };
      }
      if (item?.url && /^https:\/\//.test(item.url)) {
        const picture = await fetchHeaders(item.url, {}, Math.min(20_000, Math.max(2000, deadline - Date.now())));
        const type = picture?.headers.get("content-type")?.split(";", 1)[0] ?? "";
        if (picture?.ok && type.startsWith("image/")) return { bytes: new Uint8Array(await picture.arrayBuffer()), mimeType: type };
      }
    }
  }
  return null;
}

/**
 * One complete answer as plain text from whichever text engine can give it: engine A (configured models, or whatever it offers),
 * then engine B, then the agent. For work that has no stream to show (a drawing, a plan).
 */
export async function engineText(system: string, prompt: string, opts: { timeoutMs?: number; maxTokens?: number } = {}): Promise<string | null> {
  const cat = engineCatalog();
  const found = cat.a.fast.length || cat.a.best.length ? null : await discoverModels("a").catch(() => null);
  const models = [...new Set([...cat.a.fast, ...cat.a.best, ...(found ? [...found.fast, ...found.best] : [])])].slice(0, 4);
  for (const model of models) {
    const text = await textA(model, system, [{ role: "user", content: prompt }], opts.timeoutMs ?? 45000);
    if (text) return text;
  }
  const viaB = await textB(system, prompt).catch(() => null);
  if (viaB) return viaB;
  return agentChat(system, [{ role: "user", content: prompt }], opts.timeoutMs ?? 45000).catch(() => null);
}

/* ------------------------------------------------------------------ voice (engine A) */
export type VoiceKind = "male" | "female";
export const isVoiceKind = (v: unknown): v is VoiceKind => v === "male" || v === "female";

/** Narration audio as base64 PCM. The voice names come from ZEROS_A_VOICE_MALE / ZEROS_A_VOICE_FEMALE. */
export async function voicePcmBase64(text: string, kind: VoiceKind = "female"): Promise<string | null> {
  const a = engineA();
  const voice = setting(kind === "male" ? "ZEROS_A_VOICE_MALE" : "ZEROS_A_VOICE_FEMALE");
  if (!a || !voice) return null;
  for (const model of listOf(setting("ZEROS_A_VOICE_MODELS"))) {
    for (const key of a.keys) {
      try {
        const res = await fetchHeaders(`${a.url}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { [a.header]: key, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
        }, 45000);
        if (!res?.ok) continue;
        const json = (await res.json()) as Candidates;
        for (const p of json.candidates?.[0]?.content?.parts ?? []) {
          const d = p.inlineData?.data;
          if (d && d.length > 1000) return d;
        }
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ JSON / vision */
function parseJsonLoose<T>(text: string): T | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * One-shot JSON completion on engine A (thinking off, JSON mime type). Optional images make it a vision call (used by the website
 * and 3D reviewers). Tries every model x key; falls back to engine B for text-only calls; returns null if all fail.
 */
export async function engineJson<T = unknown>(
  system: string,
  prompt: string,
  opts: { images?: ImageInput[]; maxTokens?: number; timeoutMs?: number; temperature?: number } = {},
): Promise<T | null> {
  const a = engineA();
  const hasImages = !!(opts.images && opts.images.length);
  if (a) {
    const cat = engineCatalog().a;
    const found = cat.best.length || cat.fast.length ? null : await discoverModels("a").catch(() => null);
    const models = hasImages ? (cat.best.length ? cat.best : (found?.best ?? [])) : (cat.fast.length ? cat.fast : (found?.fast ?? []));
    const parts: Record<string, unknown>[] = [{ text: prompt }];
    for (const img of opts.images ?? []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });

    const body = (withThinking: boolean) =>
      JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens ?? 4096,
          responseMimeType: "application/json",
          ...(withThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });

    for (const model of models) {
      for (const key of a.keys) {
        for (const withThinking of [true, false]) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 40000);
          try {
            const res = await fetch(`${a.url}/models/${encodeURIComponent(model)}:generateContent`, {
              method: "POST",
              headers: { [a.header]: key, "Content-Type": "application/json" },
              body: body(withThinking),
              signal: ctrl.signal,
            });
            if (res.status === 400 && withThinking) continue; // this model may reject thinkingBudget:0
            if (!res.ok) break;
            const json = (await res.json().catch(() => null)) as Candidates | null;
            const text = json ? nativeText(json).trim() : "";
            const parsed = text ? parseJsonLoose<T>(text) : null;
            if (parsed) return parsed;
            break;
          } catch {
            break;
          } finally {
            clearTimeout(timer);
          }
        }
      }
    }
  }

  // Last resort: text-only fallback through engine B (no vision).
  if (!hasImages) {
    const text = await textB(system + "\nReturn ONLY a JSON object.", prompt).catch(() => null);
    if (text) return parseJsonLoose<T>(text);
  }
  return null;
}
