/** Pure helpers for Zeros long-term memory (no I/O — unit-testable). */

export const MEMORY_MAX_FACTS = 80;
export const MEMORY_MAX_LEN = 280;

export function cleanFact(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’:;,\-–—]+|[\s"'“”‘’]+$/g, "")
    .slice(0, MEMORY_MAX_LEN)
    .trim();
}

/** True for anything that looks like a secret or a financial / government identifier. */
export function isSensitive(text: string): boolean {
  if (/\b(password|passcode|passwd|cvv|otp|one[\s-]?time (?:code|password)|secret key|api[\s_-]?key|private key|seed phrase|recovery phrase)\b/i.test(text)) return true;
  if (/\bpin\b\s*(?:is|=|:)?\s*\d{3,8}\b/i.test(text)) return true;
  if (/(?:\d[ -]?){13,19}/.test(text)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
  if (/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}/.test(text)) return true;
  return false;
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u00c0-\uffff\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !["the", "and", "that", "user", "with", "for", "are", "was"].includes(w)),
  );

export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/** How a new fact relates to a stored one: duplicate, a more specific update of it, or unrelated. */
export function compareFacts(oldFact: string, newFact: string): "same" | "supersedes" | "different" {
  const a = tokens(oldFact);
  const b = tokens(newFact);
  if (!a.size || !b.size) return oldFact.trim().toLowerCase() === newFact.trim().toLowerCase() ? "same" : "different";
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jac = inter / (a.size + b.size - inter);
  if (jac >= 0.75) return "same";
  if (inter === b.size && a.size >= b.size) return "same"; // stored fact already says everything the new one does
  if (inter === a.size && b.size > a.size && inter / b.size >= 0.5) return "supersedes"; // new = old + more detail
  return "different";
}

const LEAD = String.raw`^(?:(?:hey|hi|hello|ok(?:ay)?|yo|so|also|and|please|pls|zeros|zero)[\s,!.:-]+)*(?:please\s+)?`;

const REMEMBER_RE = new RegExp(
  LEAD +
    String.raw`(?:remember|don'?t\s+forget|do\s+not\s+forget|keep\s+in\s+mind|save\s+(?:this\s+)?(?:to|in)\s+(?:your\s+)?memory|add\s+(?:this\s+)?to\s+(?:your\s+)?memory)\s*(?:that|this|:|-|,)?\s*(.+)$`,
  "is",
);

/** "remember that I prefer dark mode" -> "I prefer dark mode". Null when not an instruction. */
export function detectExplicitRemember(text: string): string | null {
  const t = text.trim();
  if (t.length > 600) return null;
  const m = t.match(REMEMBER_RE);
  if (!m?.[1]) return null;
  const fact = cleanFact(m[1]);
  if (fact.length < 4) return null;
  if (/\?\s*$/.test(fact)) return null; // "remember what I said?" is a question, not an instruction
  if (/^(?:what|when|how|why|who|where|if|me\b(?!\s+as)|it\b|this\b)\b/i.test(fact) && fact.length < 12) return null;
  if (isSensitive(fact)) return null;
  return fact;
}

const FORGET_ALL_RE = new RegExp(
  LEAD +
    String.raw`(?:forget|clear|wipe|delete|erase|reset)\s+(?:everything|all(?:\s+of)?\s+(?:it|that|this|memor(?:y|ies))?|(?:my|your|the)\s+(?:whole\s+|entire\s+)?memor(?:y|ies))(?:\s+(?:you\s+)?(?:know|remember|have)(?:\s+about\s+me)?)?\s*[.!]?$`,
  "i",
);
const FORGET_ONE_RE = new RegExp(LEAD + String.raw`forget\s+(?:that\s+|about\s+|what\s+i\s+(?:said|told\s+you)\s+about\s+)?(.+)$`, "is");

export function detectForgetAll(text: string): boolean {
  return FORGET_ALL_RE.test(text.trim());
}

/** "forget that I like jazz" -> "I like jazz". */
export function detectExplicitForget(text: string): string | null {
  const t = text.trim();
  if (t.length > 300 || detectForgetAll(t)) return null;
  const m = t.match(FORGET_ONE_RE);
  if (!m?.[1]) return null;
  const needle = cleanFact(m[1]);
  if (needle.length < 3 || /^(?:it|that|this|them|about it|everything|the last (?:thing|message))$/i.test(needle)) return null;
  return needle;
}

/** Cheap gate so we only pay for an LLM extraction call when the message may contain personal facts. */
export function mayContainPersonalFact(text: string): boolean {
  if (text.trim().length < 14) return false;
  return /\b(i|i'm|im|i've|ive|i'll|my|mine|myself|we|our|call me|prefer|favou?rite|love|hate|allergic|work(?:ing)?|live|living|studying|student|building|my name|born|from|based in|speak|learning)\b/i.test(text);
}

/** Facts most relevant first, hard-capped so the system prompt never balloons. */
export function factsForPrompt(facts: string[]): string[] {
  return facts.map(cleanFact).filter((f) => f && !isSensitive(f)).slice(0, 60);
}
