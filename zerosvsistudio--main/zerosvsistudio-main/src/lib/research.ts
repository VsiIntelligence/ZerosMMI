/**
 * Research before creating. A short, time-boxed web-search pass (the app's search mode) that returns verified facts, the audience,
 * the strongest creative angle and what to avoid. The notes feed the director's prompt; if nothing is found, the pipeline says so
 * and relies on the request alone (it never invents facts to fill the gap).
 */
import type { Msg } from "@/lib/ai-client";
import type { ZeroMode } from "@/lib/zeros";

type StreamChat = (messages: Msg[], mode: ZeroMode, memories: string[], onDelta: (full: string) => void) => Promise<string>;

export type Research = { found: boolean; facts: string[]; audience: string; angle: string; avoid: string };

export const researchPrompt = (kind: "video" | "website", request: string): string =>
  `Research this for a ${kind === "video" ? "short promotional video" : "website"} brief. If it is a real company, product, place, person or industry, search the web. Reply in under 170 words with exactly four labelled lines:\nFACTS: 3-5 verified, concrete facts (give years or numbers only if you are sure of them).\nAUDIENCE: who it is for and what they care about.\nANGLE: the single strongest creative angle, plus two visual cues (colours, motifs) that fit the subject.\nAVOID: clichés or claims to avoid.\nIf the subject is private, fictional or unknown, write "NO PUBLIC INFO" on the FACTS line and base the other lines on the request alone.\nRequest: ${request}`;

export function parseResearch(text: string): Research {
  const line = (label: string): string => (new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:FACTS|AUDIENCE|ANGLE|AVOID)\\s*:|$)`, "i").exec(text)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const facts = line("FACTS");
  const none = !facts || /NO PUBLIC INFO/i.test(facts);
  return {
    found: !none,
    facts: none ? [] : facts.split(/(?<=[.;])\s+|\s*[•\u2022]\s*|\s+-\s+|\s*\d\)\s+/).map((f) => f.trim()).filter((f) => f.length > 12).slice(0, 5).map((f) => f.slice(0, 200)),
    audience: line("AUDIENCE").slice(0, 220), angle: line("ANGLE").slice(0, 260), avoid: line("AVOID").slice(0, 200),
  };
}

export async function researchTopic(args: { kind: "video" | "website"; request: string; streamChat: StreamChat; memories?: string[]; timeoutMs?: number }): Promise<Research> {
  const empty: Research = { found: false, facts: [], audience: "", angle: "", avoid: "" };
  try {
    const text = await Promise.race([
      args.streamChat([{ role: "user", content: researchPrompt(args.kind, args.request) }], "search", args.memories ?? [], () => undefined),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("research timed out")), args.timeoutMs ?? 24000)),
    ]);
    return parseResearch(text);
  } catch { return empty; }
}

/** The block appended to the director's request. */
export function researchBlock(r: Research): string {
  if (!r.found && !r.audience && !r.angle) return "RESEARCH NOTES: none found (private or unknown subject). Work only from the request; do not invent facts.";
  return `RESEARCH NOTES (from a web search; use real facts only from here or from the request):\n${r.facts.length ? `FACTS: ${r.facts.join(" | ")}\n` : "FACTS: none verified\n"}AUDIENCE: ${r.audience || "unknown"}\nANGLE: ${r.angle || "none"}\nAVOID: ${r.avoid || "none"}`;
}
