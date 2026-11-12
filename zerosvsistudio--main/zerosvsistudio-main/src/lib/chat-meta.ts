/** What the last reply used: the apps it read, and any action it proposes (never run without the person's confirmation). */
export type AppProposal = { toolkit: string; tool: string; arguments: Record<string, unknown>; summary: string };
export type ChatMeta = { apps: string[]; proposal: AppProposal | null };

let pending: ChatMeta | null = null;

export function readChatMeta(headers: Headers): ChatMeta {
  const apps = (headers.get("X-Zeros-Apps") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let proposal: AppProposal | null = null;
  const raw = headers.get("X-Zeros-Proposal");
  if (raw) {
    try {
      const p = JSON.parse(decodeURIComponent(raw)) as Partial<AppProposal>;
      if (typeof p.tool === "string" && typeof p.toolkit === "string" && typeof p.summary === "string") {
        proposal = { toolkit: p.toolkit, tool: p.tool, arguments: typeof p.arguments === "object" && p.arguments ? p.arguments : {}, summary: p.summary };
      }
    } catch { /* a malformed proposal is ignored, never shown */ }
  }
  return { apps, proposal };
}

export function setChatMeta(meta: ChatMeta): void {
  pending = meta;
}

/** The meta of the reply that just finished (or null when no app was used). */
export function takeChatMeta(): ChatMeta | null {
  const meta = pending;
  pending = null;
  return meta && (meta.apps.length > 0 || meta.proposal) ? meta : null;
}
