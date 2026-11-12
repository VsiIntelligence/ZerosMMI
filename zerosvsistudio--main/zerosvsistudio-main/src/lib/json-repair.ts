/**
 * Tolerant JSON extraction for model output. Long structured replies (lyrics, scene lists, site briefs) are often
 * cut off mid-string by an output limit, wrapped in prose / code fences, or carry trailing commas. This salvages
 * every complete element instead of throwing the whole reply away.
 */

const FENCE = /```(?:json|JSON|js|javascript)?[ \t]*\r?\n?([\s\S]*?)(?:```|$)/;

function tryParse(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

const stripTrailingCommas = (s: string): string => s.replace(/,\s*([}\]])/g, "$1");

/** Repairs a (possibly truncated) JSON document that starts at the first { or [. Returns the parsed value or undefined. */
export function repairJson(input: string): unknown | undefined {
  const startObj = input.indexOf("{"), startArr = input.indexOf("[");
  const start = startObj < 0 ? startArr : startArr < 0 ? startObj : Math.min(startObj, startArr);
  if (start < 0) return undefined;
  const src = input.slice(start);

  /* fast paths */
  const whole = tryParse(src);
  if (whole !== undefined) return whole;
  const lastClose = Math.max(src.lastIndexOf("}"), src.lastIndexOf("]"));
  if (lastClose > 0) {
    const cut = tryParse(stripTrailingCommas(src.slice(0, lastClose + 1)));
    if (cut !== undefined) return cut;
  }

  /* scan: track strings and the stack of open containers, remember every comma outside a string as a safe cut point */
  const stack: string[] = [];
  let inStr = false, esc = false;
  const cuts: { pos: number; stack: string }[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") { if (stack.length && stack[stack.length - 1] === c) stack.pop(); }
    else if (c === ",") cuts.push({ pos: i, stack: stack.join("") });
  }
  const closers = (st: string): string => st.split("").reverse().join("");

  /* 1. close an unterminated string and every open container */
  let tail = src;
  if (inStr) tail += '"';
  const closed = tryParse(stripTrailingCommas(tail.replace(/[,:\s]+$/, "") + closers(stack.join(""))));
  if (closed !== undefined) return closed;
  const closed2 = tryParse(stripTrailingCommas(tail.replace(/,?\s*"[^"]*"\s*:?\s*$/, "") + closers(stack.join(""))));
  if (closed2 !== undefined) return closed2;

  /* 2. walk back through the commas: keep everything before the last element that could not be completed */
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 400; k--, tries++) {
    const cut = cuts[k]!;
    const v = tryParse(src.slice(0, cut.pos) + closers(cut.stack));
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Finds JSON in a model reply: fenced block, balanced object, or the truncated remainder. */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(FENCE)?.[1];
  for (const cand of [fenced, text]) {
    if (!cand) continue;
    const v = repairJson(cand);
    if (v !== undefined && v !== null && typeof v === "object") return v as T;
  }
  return null;
}

/** First balanced {...} (or the repaired remainder) as a plain object. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const v = extractJson<unknown>(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
