/**
 * ZerosX2.0's reasoning router. Three levels, one voice:
 *   fast    - the fastest model of engine A and of engine B are called directly and in parallel; the first to answer wins. Speed first.
 *   medium  - the established pipeline: the agent (engine C), then engine A, then engine B, with the strongest models tried first. Balanced.
 *   complex - medium's pipeline plus a planning pass before the answer and a quality review after it. Quality first.
 * Every level can reach every configured model before a request is given up.
 */
import { agentChat, discoverModels, streamA, streamB, textA, textToSse, type Msg } from "./engine.server";
import { engineCatalog, type Catalog } from "./zeros-models.server";
import type { ReasoningLevelName } from "./zeros";

/** Any value the browser sends becomes a valid level; the default is Medium. */
export function parseReasoning(value: unknown): ReasoningLevelName {
  return value === "fast" || value === "complex" ? value : "medium";
}

export type RouteResult = {
  stream: ReadableStream<Uint8Array>;
  /** Which engine answered. Server-side only: it is never put in a response. */
  engine: "a" | "b" | "c";
  model?: string;
  planned?: boolean;
  verified?: boolean;
};

const PLAN_SYSTEM =
  "You are the planning brain of ZerosX2.0 (created by VsiStudio). Read the conversation and write a short, concrete plan for the best possible answer: what the person really needs, the facts that must be right, the structure, the funniest honest angle and the traps to avoid. Maximum 180 words, plain text, no preamble.";

const REVIEW_SYSTEM =
  "You are the quality editor for ZerosX2.0 (created by VsiStudio). You receive the user's request and a draft answer. Check for factual errors, logic gaps, missing parts, unclear steps, and the persona rules (witty, funny, long, detailed, emoji-rich, never boring, never an 'I'll read...' opener). Return the FINAL improved answer only: no notes about the review, no preamble. If the draft is already excellent, return it unchanged.";

/** Resolves with the first non-null result. Losing results are cancelled so no connection is left open. */
export function raceFirst<T>(tasks: (() => Promise<T | null>)[], cancel: (value: T) => void = () => undefined): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = tasks.length, settled = false;
    if (!pending) return resolve(null);
    for (const task of tasks) {
      task()
        .then((value) => {
          if (value && !settled) { settled = true; resolve(value); }
          else if (value) cancel(value);
          else if (--pending === 0 && !settled) resolve(null);
        })
        .catch(() => { if (--pending === 0 && !settled) resolve(null); });
    }
  });
}

/** Reads a chat-style SSE stream into the full text (used to review a draft before it is shown). */
export async function readSseText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffer = "", out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith("data:")) continue;
      const payload = text.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string }; message?: { content?: string } }[] };
        const piece = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
        if (typeof piece === "string") out += piece;
      } catch { /* a malformed chunk is skipped */ }
    }
  }
  return out.trim();
}

async function tryA(model: string, system: string, messages: Msg[], timeoutMs: number): Promise<RouteResult | null> {
  const stream = await streamA(model, system, messages, timeoutMs);
  return stream ? { stream, engine: "a", model } : null;
}

async function tryB(model: string, system: string, messages: Msg[], timeoutMs = 25000): Promise<RouteResult | null> {
  const stream = await streamB(model, system, messages, false, timeoutMs);
  return stream ? { stream, engine: "b", model } : null;
}

/** The agent, then engine A, then engine B, strongest models first: the established pipeline. */
async function pipeline(system: string, messages: Msg[], cat: Catalog, o: { agentBudgetMs: number; skipAgent: boolean; aTries: number; bTries: number; heavy?: boolean }): Promise<RouteResult | null> {
  // Heavy structured work (a 3D build, a whole website, a song) sends a very large request: a model may take a good while to begin its answer.
  const wait = o.heavy ? 60000 : 25000;
  if (!o.skipAgent && o.agentBudgetMs > 0) {
    const text = await agentChat(system, messages, o.agentBudgetMs).catch(() => null);
    if (text) return { stream: textToSse(text), engine: "c" };
  }
  for (const model of cat.a.best.slice(0, o.aTries)) {
    const hit = await tryA(model, system, messages, wait);
    if (hit) return hit;
  }
  for (const model of cat.b.best.slice(0, o.bTries)) {
    const hit = await tryB(model, system, messages, wait);
    if (hit) return hit;
  }
  return null;
}

/** Fast: the fastest model of each text engine race; then the rest of the list, fastest first. */
async function fast(system: string, messages: Msg[], cat: Catalog): Promise<RouteResult | null> {
  const a = cat.a.fast, b = cat.b.fast;
  const racers: (() => Promise<RouteResult | null>)[] = [];
  if (a[0]) racers.push(() => tryA(a[0]!, system, messages, 15000));
  if (b[0]) racers.push(() => tryB(b[0]!, system, messages));
  const winner = await raceFirst(racers, (loser) => { void loser.stream.cancel().catch(() => undefined); });
  if (winner) return winner;
  for (const model of a.slice(1, 7)) {
    const hit = await tryA(model, system, messages, 15000);
    if (hit) return hit;
  }
  for (const model of b.slice(1, 7)) {
    const hit = await tryB(model, system, messages);
    if (hit) return hit;
  }
  return null;
}

/** Complex: plan, answer through the full pipeline, then review the answer before it is shown. */
async function complex(system: string, messages: Msg[], cat: Catalog, skipAgent = false, heavy = false): Promise<RouteResult | null> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const quick = cat.a.fast[0];
  const strongest = cat.a.best[0];
  const plan = quick ? await textA(quick, PLAN_SYSTEM, messages, 15000).catch(() => null) : null;
  const planned = system + (plan ? `\n\nPLAN FOR THIS ANSWER (follow it, never mention it):\n${plan}` : "");
  const routed = await pipeline(planned, messages, cat, { agentBudgetMs: skipAgent ? 0 : 60000, skipAgent, aTries: 4, bTries: 4, heavy });
  if (!routed) return null;
  const draft = await readSseText(routed.stream);
  if (!draft) return null;
  const review = strongest
    ? await textA(strongest, REVIEW_SYSTEM, [{ role: "user", content: `USER REQUEST:\n${lastUser}\n\nDRAFT ANSWER:\n${draft}` }], 30000).catch(() => null)
    : null;
  const accepted = review && review.length >= draft.length * 0.6 && !/^(here is|here's|the review|revised|sure)/i.test(review) ? review : draft;
  return {
    stream: textToSse(accepted),
    engine: routed.engine,
    ...(routed.model ? { model: routed.model } : {}),
    planned: !!plan,
    verified: accepted === review,
  };
}

/** The levels as they always worked. */
async function routeLevel(
  system: string,
  messages: Msg[],
  cat: Catalog,
  o: { reasoning: ReasoningLevelName; skipAgent?: boolean; heavy?: boolean },
): Promise<RouteResult | null> {
  if (o.reasoning === "fast") {
    return (await fast(system, messages, cat)) ?? (await pipeline(system, messages, cat, { agentBudgetMs: 0, skipAgent: true, aTries: 8, bTries: 8, ...(o.heavy ? { heavy: true } : {}) }));
  }
  if (o.reasoning === "complex") return complex(system, messages, cat, !!o.skipAgent, !!o.heavy);
  return pipeline(system, messages, cat, { agentBudgetMs: 30000, skipAgent: !!o.skipAgent, aTries: 3, bTries: 4, ...(o.heavy ? { heavy: true } : {}) });
}

/**
 * Routes one request through the chosen reasoning level. Returns null only when no model at all can answer. Before giving up it
 * (1) asks the engines what models they really offer, in case the settings name retired or misspelt ones or none, and
 * (2) tries the agent, even in modes that skip it for speed: a slower answer is better than an error.
 */
export async function zerosRoute(
  system: string,
  messages: Msg[],
  o: { reasoning: ReasoningLevelName; skipAgent?: boolean; heavy?: boolean },
): Promise<RouteResult | null> {
  const cat = engineCatalog();
  const first = await routeLevel(system, messages, cat, o);
  if (first) return first;

  const [da, db] = await Promise.all([discoverModels("a").catch(() => null), discoverModels("b").catch(() => null)]);
  const tried = new Set([...cat.a.best, ...cat.a.fast, ...cat.b.best, ...cat.b.fast]);
  const fresh = (list: string[] | undefined): string[] => (list ?? []).filter((m) => !tried.has(m));
  const extra: Catalog = {
    a: { best: [...new Set([...fresh(da?.best), ...fresh(da?.fast)])], fast: [...new Set([...fresh(da?.fast), ...fresh(da?.best)])] },
    b: { best: [...new Set([...fresh(db?.best), ...fresh(db?.fast)])], fast: [...new Set([...fresh(db?.fast), ...fresh(db?.best)])] },
  };
  if (extra.a.best.length || extra.b.best.length) {
    const again = await pipeline(system, messages, extra, { agentBudgetMs: 0, skipAgent: true, aTries: 4, bTries: 4, ...(o.heavy ? { heavy: true } : {}) });
    if (again) return again;
  }
  if (o.skipAgent) {
    const text = await agentChat(system, messages, 50000).catch(() => null);
    if (text) return { stream: textToSse(text), engine: "c" };
  }
  return null;
}
