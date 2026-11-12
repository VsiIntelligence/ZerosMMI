/**
 * The conversation window that is sent with each message. A long chat is never sent in full: only the most recent turns that fit a
 * budget go over the wire, and the older turns are condensed into one short note so Zeros keeps the thread without a huge payload.
 * (This is what keeps requests small, so they never fail on the way to the server.)
 */
export type WindowMsg = { role: "user" | "assistant"; content: string };

export const HISTORY_LIMITS = { maxMessages: 14, maxChars: 24000, perMessage: 8000, summaryTurns: 8, summaryChars: 140 } as const;

export type WindowLimits = { maxMessages: number; maxChars: number; perMessage: number; summaryTurns: number; summaryChars: number };

export function buildHistoryWindow(messages: WindowMsg[], limits: WindowLimits = HISTORY_LIMITS): WindowMsg[] {
  const clean: WindowMsg[] = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.length > limits.perMessage ? `${m.content.slice(0, limits.perMessage)}…` : m.content }));
  const kept: WindowMsg[] = [];
  let chars = 0;
  for (let i = clean.length - 1; i >= 0 && kept.length < limits.maxMessages; i--) {
    const item = clean[i]!;
    if (kept.length && chars + item.content.length > limits.maxChars) break;
    kept.unshift(item);
    chars += item.content.length;
  }
  while (kept.length && kept[0]!.role !== "user") kept.shift();
  const dropped = clean.slice(0, clean.length - kept.length);
  if (dropped.length) {
    const digest = dropped
      .slice(-limits.summaryTurns)
      .map((m) => `${m.role === "user" ? "Them" : "Zeros"}: ${m.content.replace(/\s+/g, " ").slice(0, limits.summaryChars)}`)
      .join("\n");
    const note: WindowMsg[] = [{ role: "user", content: `Earlier in this chat (condensed, for context only):\n${digest}` }];
    if (kept[0]?.role === "user") note.push({ role: "assistant", content: "Understood, I have the earlier thread in mind." });
    kept.unshift(...note);
  }
  return kept;
}
