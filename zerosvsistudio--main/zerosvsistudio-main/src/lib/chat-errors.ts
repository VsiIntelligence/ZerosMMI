/**
 * Honest error text for the chat. A failed chat request is a connection or model problem, never a database one, so the database
 * wording is used only by the code that talks to the database (see load-conversations.ts).
 */
export function formatChatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (error instanceof TypeError || /failed to fetch|load failed|networkerror|network request failed|aborterror|operation was aborted|timed? ?out/i.test(raw)) {
    return "ZerosX2.0 could not be reached just now. Check your connection and send it again; nothing you wrote was lost.";
  }
  return raw.trim() || "ZerosX2.0 hit a snag. Please try again.";
}
