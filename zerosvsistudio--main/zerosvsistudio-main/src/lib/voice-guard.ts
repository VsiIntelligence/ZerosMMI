/**
 * Zeros never opens like a task-runner. Whichever model answered, boring agent-speak ("I'll read the brief and turn it
 * into...", "Sure! Here is...", "Great question!") is stripped from the front of a reply - including while it streams.
 */

const FILLER: RegExp[] = [
  /^(sure|sure thing|certainly|of course|absolutely|definitely|okay|ok|alright|all right|got it|understood|no problem|no worries|great question|good question|great|awesome|perfect|sounds good|will do)\b/i,
  /^i(?:'|’)?ll\s+(?:now\s+|first\s+|go ahead and\s+)?(?:read|review|analy[sz]e|process|study|look|check|turn|build|create|start|begin|take|dive|work|put|write|craft|generate|make|help|break|go|get|handle|prepare|design)\b/i,
  /^i\s+will\s+(?:now\s+|first\s+)?/i,
  /^i(?:'|’)?ve\s+(?:created|built|made|generated|completed|finished|prepared|written|put together|designed)\b/i,
  /^i have\s+(?:created|built|made|generated|completed|finished|prepared|written)\b/i,
  /^i(?:'|’)?d be (?:happy|glad|delighted) to\b/i,
  /^i(?:'|’)?m (?:going to|about to|here to)\b/i,
  /^let me\b/i,
  /^let(?:'|’)?s\s+(?:get|dive|start|begin|jump|build|take|break|look)\b/i,
  /^here(?:'|’)?s?\s+(?:is|are|a|an|the|your|my|what)\b/i,
  /^below is\b/i,
  /^as an ai\b/i,
  /^based on (?:your|the) (?:request|brief|prompt|message|description)\b/i,
  /^(?:thank you|thanks) for\b/i,
  /^to (?:begin|start|get started)\b/i,
  /^(?:first|now),? (?:i|let)\b/i,
  /^(?:that(?:'|’)?s|what|this is) an? (?:great|good|excellent|fantastic|interesting|wonderful|fascinating|amazing|awesome|brilliant|fun|cool|really good|really great) (?:question|idea|request|prompt|topic|one|choice|thought)\b/i,
  /^(?:hello|hi|hey|greetings)[!,. ]+(?:there[!,. ]+)?(?:how can i|how may i|what can i|welcome|i(?:'|’)?m here|i am here|nice to meet)/i,
  /^(?:how can i|how may i|what can i do for you)\b/i,
  /^i (?:can|could) (?:certainly |definitely |absolutely )?(?:help|assist)\b/i,
  /^i (?:understand|see|get) (?:that |what |your |you )/i,
  /^(?:i(?:'|’)?m|i am) (?:happy|glad|excited|thrilled|delighted|pleased) to\b/i,
  /^(?:as requested|as per your|per your request|in response to your|to answer your question)\b/i,
  /^(?:here you go|there you go|there you have it|here goes)\b/i,
  /^(?:the following|in this (?:response|reply|answer|message))\b/i,
];

const SENTENCE_END = /[.!?…]+(?:["')\]]*)(?=\s|$)|\n/;

function firstSentence(text: string): { head: string; rest: string } | null {
  const m = SENTENCE_END.exec(text);
  if (!m) return null;
  const cut = m.index + m[0].length;
  return { head: text.slice(0, cut), rest: text.slice(cut) };
}

/** True for a short throat-clearing sentence that carries no content of its own. */
export function isBoringLine(line: string): boolean {
  const t = line.replace(/^[\s>*_#`~-]+/, "").replace(/^(?:[\p{Extended_Pictographic}\u200d\ufe0f]+\s*)+/u, "").trim();
  if (!t) return false;
  if (!FILLER.some((re) => re.test(t))) return false;
  const words = t.split(/\s+/).length;
  return words <= 22 && !/[0-9`]/.test(t.replace(/[:：]$/, ""));
}

/** Removes up to three boring opening sentences. Never returns less than the original when nothing useful would remain. */
const BARE_GREETING = /^(?:hello|hi|hey|greetings|hiya|howdy)(?:\s+there)?[!,. ]*$/i;

export function stripBoringOpener(text: string): string {
  let out = text.replace(/^\s+/, "");
  for (let i = 0; i < 3; i++) {
    const fs = firstSentence(out);
    if (!fs) break;
    /* "Hello! How can I help you today?": a bare greeting is only throat-clearing when the sentence after it is too */
    if (BARE_GREETING.test(fs.head.trim())) {
      const after = fs.rest.replace(/^\s+/, ""), second = firstSentence(after);
      if (second && isBoringLine(second.head)) { out = second.rest.replace(/^\s+/, "") || out; if (out === after) break; continue; }
      break;
    }
    if (!isBoringLine(fs.head)) break;
    const next = fs.rest.replace(/^\s+/, "");
    if (next.length < 24) return text.trim();
    out = next;
  }
  return out;
}

/** Help-desk sign-offs. Zeros ends on its curious question or a punchline instead. */
const CLOSER: RegExp[] = [
  /^(?:i|we) hope (?:this|that|it) (?:helps|was helpful|answers|clears)/i,
  /^hope (?:this|that|it) helps/i,
  /^(?:please )?(?:let me know|tell me) if (?:you|there)(?:'|’)?(?:d| would| need| have| want| are| 'd)?\b/i,
  /^(?:please |do )?feel free to (?:ask|reach out|contact|let me know|message)/i,
  /^(?:please )?(?:don(?:'|’)?t|do not) hesitate to\b/i,
  /^(?:i(?:'|’)?m|i am) (?:always )?(?:here|happy|glad|ready) (?:to help|if you|whenever|for)/i,
  /^happy to help\b/i,
  /^is there anything else\b/i,
  /^if you (?:have|need|want|would like|(?:'|’)?d like) (?:any )?(?:more |further |other |additional )?(?:questions|help|assistance|changes|anything|clarification)/i,
  /^(?:thank you|thanks) for (?:asking|your (?:question|patience|time)|reading|using)/i,
  /^(?:good luck|best of luck)(?: with [^.!?]{0,60})?[.!]*$/i,
];

const SENTENCES = /[^.!?…\n]+[.!?…]+(?:["')\]]*)\s*|[^.!?…\n]+$/g;

/**
 * Removes up to two help-desk sign-off sentences from the END of a reply ("I hope this helps!", "Let me know if you need
 * anything else"). Only the final paragraph is touched, a question mark is never removed (that is the curious follow-up we
 * want), and nothing is stripped when it would leave the reply nearly empty.
 */
export function stripBoringCloser(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const cut = trimmed.lastIndexOf("\n\n");
  const head = cut >= 0 ? trimmed.slice(0, cut) : "", last = cut >= 0 ? trimmed.slice(cut + 2) : trimmed;
  if (!last || /```/.test(last) || last.length > 400) return text;
  const sentences = last.match(SENTENCES) ?? [last];
  let drop = 0;
  for (let i = sentences.length - 1; i >= 0 && drop < 2; i--) {
    const t = sentences[i]!.replace(/^[\s>*_#~-]+/, "").replace(/^(?:[\p{Extended_Pictographic}\u200d\ufe0f]+\s*)+/u, "").trim();
    if (!t || t.includes("?")) break;
    if (CLOSER.some((re) => re.test(t)) && t.split(/\s+/).length <= 24) drop++; else break;
  }
  if (!drop) return text;
  const kept = sentences.slice(0, sentences.length - drop).join("").trimEnd();
  const out = (head ? head + (kept ? "\n\n" + kept : "") : kept).trimEnd();
  return out.length >= 12 ? out : text;
}

const STARTERS = ["i'll ", "i’ll ", "i will ", "i've ", "i’ve ", "i have ", "i'd be ", "i’d be ", "i'm going", "i’m going", "i'm about", "let me", "let's", "let’s", "here is", "here's", "here’s", "here are", "sure", "certainly", "of course", "absolutely", "definitely", "okay", "alright", "all right", "got it", "great", "good question", "as an ai", "based on", "thank", "to begin", "to start", "below is", "understood", "no problem", "awesome", "perfect"];

/** What to show while a reply is still streaming: hold back a half-written boring opener instead of flashing it. */
export function displayText(raw: string, done = false): string {
  if (done) return stripBoringCloser(stripBoringOpener(raw));
  const trimmed = raw.replace(/^\s+/, "");
  if (!trimmed) return "";
  if (!firstSentence(trimmed)) {
    const probe = trimmed.replace(/^[>*_#`~-]+\s*/, "").toLowerCase();
    const looksLikeFiller = STARTERS.some((st) => st.startsWith(probe) || probe.startsWith(st));
    if (looksLikeFiller && probe.length < 140) return "";
    return raw;
  }
  return stripBoringOpener(raw);
}
