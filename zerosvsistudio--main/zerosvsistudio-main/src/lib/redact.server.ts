/**
 * Keeps the companies and services behind ZerosX2.0 out of what people read, even when a model slips and describes itself.
 *
 * The names to hide come from the server-side secret ZEROS_HIDE_TERMS (comma-separated, any case), so no name is written in the
 * code. Only sentences where the assistant talks about ITSELF are rewritten ("I'm X", "I was built by X", "powered by X", "my
 * model is X"). A name used any other way is left alone, so ordinary words are never mangled and people can still ask about
 * anything. This is a safety net behind the instructions the assistant already follows; it is not a substitute for them.
 */
type Env = Record<string, string | undefined>;

export const REPLACEMENT = "Zeros";

/** The names to hide, from ZEROS_HIDE_TERMS. */
export function hideTerms(e: Env = typeof process !== "undefined" ? (process.env as Env) : {}): string[] {
  return [...new Set((e["ZEROS_HIDE_TERMS"] ?? "").split(",").map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 60);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One term as a pattern: exact words, flexible spaces, never inside a longer word. */
const termRe = (t: string): string => `(?<![\\p{L}\\p{N}_])${t.split(/\s+/).map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}_])`;

/* Words that may not sit between "I'm" and a name: negations, and prepositions or verbs that make it a place or an activity, not an identity. */
const STOP = "not|no|never|in|at|on|from|to|with|for|of|near|by|into|about|like|than|as|and|or|but|using|via|through|watching|reading|visiting|learning";
const NOT = `(?:(?!(?:${STOP})\\b|n['’]t\\b)[\\p{L}\\p{N}'’-]+\\s+)`;

/** How many characters are held back while streaming, so a name split across two chunks is still caught. Longer than any pattern. */
export const HOLD = 110;

/** The patterns for a set of names. Each keeps what came before the name (group 1) and replaces only the name. */
export function buildPatterns(terms: string[]): RegExp[] {
  if (!terms.length) return [];
  const names = terms.sort((a, b) => b.length - a.length).map(termRe).join("|");
  return [
    /* "I am / I'm / my name is / you are talking to ... NAME"  (not "I'm not NAME") */
    new RegExp(`(\\b(?:I\\s+am|I['’]m|I\\s+was|I\\s+am\\s+called|my\\s+name\\s+is|my\\s+name['’]s|you['’]re\\s+(?:talking|speaking|chatting)\\s+(?:to|with)|you\\s+are\\s+(?:talking|speaking|chatting)\\s+(?:to|with)|this\\s+is)\\s+(?:(?:a|an|the)\\s+)?${NOT}{0,4}?)(?:${names})`, "giu"),
    /* "powered by / built on / trained by / made by / running on ... NAME" */
    new RegExp(`(\\b(?:powered\\s+by|built\\s+(?:on|with|using|upon|by)|based\\s+on|running\\s+on|runs\\s+on|run\\s+on|made\\s+by|created\\s+by|developed\\s+(?:by|with)|trained\\s+by|backed\\s+by|driven\\s+by|hosted\\s+(?:on|by))\\s+(?:(?:[\\p{L}\\p{N}'’-]+\\s+){0,2}?))(?:${names})`, "giu"),
    /* "my model is NAME", "the underlying model is NAME", "my real engine is NAME" */
    new RegExp(`(\\b(?:my\\s+(?:(?:underlying|actual|real|base|core|true)\\s+)?|the\\s+(?:underlying|actual|real|base|core|true)\\s+)(?:engine|model|brain|backend|llm|ai|technology|tech|system)\\s+(?:is|are|was|=|:)\\s+(?:(?:a|an|the)\\s+)?)(?:${names})`, "giu"),
  ];
}

/** Rewrites every self-description of the assistant that names one of the hidden services. */
export function redactText(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const p of patterns) out = out.replace(p, (_m, before: string) => `${before}${REPLACEMENT}`);
  return out;
}

/** Applies the patterns to a stream of text pieces, holding back a short tail so a name split across two pieces is still caught. */
export class Redactor {
  private pending = "";
  constructor(private readonly patterns: RegExp[], private readonly hold = HOLD) {}

  /** Adds text; returns what is safe to show now (possibly nothing). */
  push(text: string): string {
    this.pending = redactText(this.pending + text, this.patterns);
    if (this.pending.length <= this.hold) return "";
    let cut = this.pending.length - this.hold;
    const space = this.pending.lastIndexOf(" ", cut);
    if (space > 0) cut = space + 1;
    const out = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return out;
  }

  /** Whatever is still held back, at the end of the reply. */
  flush(): string {
    const out = redactText(this.pending, this.patterns);
    this.pending = "";
    return out;
  }
}

const sse = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/**
 * Filters a chat-style SSE stream. Text deltas pass through the redactor; every other event (finish reasons, [DONE]) is forwarded
 * after any held-back text has been released, so the reply always arrives complete and in order.
 */
export function redactSse(stream: ReadableStream<Uint8Array>, patterns: RegExp[]): ReadableStream<Uint8Array> {
  if (!patterns.length) return stream;
  const redactor = new Redactor(patterns);
  const reader = stream.getReader();
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buffer = "";
  const out: string[] = [];

  const line = (raw: string): void => {
    const t = raw.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      const rest = redactor.flush();
      if (rest) out.push(sse(rest));
      out.push("data: [DONE]\n\n");
      return;
    }
    try {
      const json = JSON.parse(payload) as { choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] };
      const choice = json.choices?.[0];
      const piece = choice?.delta?.content;
      if (typeof piece === "string" && piece) {
        const safe = redactor.push(piece);
        if (safe) out.push(sse(safe));
      }
      if (choice?.finish_reason) {
        const rest = redactor.flush();
        if (rest) out.push(sse(rest));
        out.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: choice.finish_reason }] })}\n\n`);
      }
    } catch {
      /* a malformed event carries nothing to show */
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!out.length) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += dec.decode();
          for (const l of buffer.split("\n")) line(l);
          buffer = "";
          const rest = redactor.flush();
          if (rest) out.push(sse(rest));
          if (out.length) break;
          controller.close();
          return;
        }
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines) line(l);
      }
      controller.enqueue(enc.encode(out.splice(0).join("")));
    },
    cancel() {
      void reader.cancel();
    },
  });
}
