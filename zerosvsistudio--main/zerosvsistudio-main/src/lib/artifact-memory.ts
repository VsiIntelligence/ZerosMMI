/**
 * Which earlier artifact a new request refers to, and whether the request is an edit at all.
 *
 * The chat page uses these to decide whether a picture, 3D model, song, film or website is rebuilt from the one the person already
 * has, or started fresh. Nothing here calls a model; every decision follows from the words of the request and of the artifacts.
 */
import type { ChatAttachment } from "@/lib/chat-attachments";

export type ArtifactKind = "image" | "model" | "web" | "song" | "video";

const ATTACHMENT_OF: Record<ArtifactKind, ChatAttachment["kind"]> = { image: "image", model: "forge", web: "web", song: "song", video: "video" };

/** An earlier artifact of one kind. `index` is 0 for the newest. */
export type Remembered = { index: number; text: string; attachment: ChatAttachment };

const titleOf = (html: string): string => (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();

/** The words that describe an artifact: its prompt, title, genre, brand or opening script. */
export function artifactText(attachment: ChatAttachment): string {
  switch (attachment.kind) {
    case "image":
      return attachment.prompt ?? "";
    case "forge":
      return attachment.prompt ?? "";
    case "web":
      return [attachment.brief ?? "", titleOf(attachment.project.files?.["index.html"] ?? "")].join(" ");
    case "song":
      return [attachment.spec.title, attachment.spec.genre ?? "", attachment.spec.style ?? "", attachment.spec.key ?? ""].join(" ");
    case "video":
      return [attachment.spec.title, attachment.spec.brand?.name ?? "", (attachment.spec.script ?? "").slice(0, 240)].join(" ");
    default:
      return "";
  }
}

/** Only artifacts that really hold their content can be edited (a picture that never arrived cannot). */
function usable(attachment: ChatAttachment): boolean {
  switch (attachment.kind) {
    case "image":
      return !!(attachment.src || attachment.storagePath);
    case "forge":
      return attachment.code.trim().length > 0;
    case "web":
      return !!attachment.project?.files && Object.keys(attachment.project.files).length > 0;
    case "song":
      return !!attachment.spec;
    case "video":
      return !!attachment.spec;
    default:
      return false;
  }
}

/** Earlier artifacts of one kind in a conversation, newest first. */
export function rememberedArtifacts(messages: readonly { attachment?: ChatAttachment | null }[], kind: ArtifactKind): Remembered[] {
  const want = ATTACHMENT_OF[kind];
  const out: Remembered[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const attachment = messages[i]?.attachment;
    if (attachment && attachment.kind === want && usable(attachment)) out.push({ index: out.length, text: artifactText(attachment), attachment });
  }
  return out;
}

const STOP = new Set([
  "the", "and", "with", "make", "makes", "made", "change", "changes", "this", "that", "these", "those", "into", "from", "for", "out", "its", "are",
  "was", "were", "but", "not", "just", "very", "you", "your", "our", "can", "could", "would", "should", "have", "has", "had", "turn", "add", "remove",
  "please", "now", "also", "more", "less", "again", "instead", "same", "keep", "put", "replace", "bigger", "smaller", "some", "one", "all", "let",
  "show", "give", "about", "like", "want", "need", "there", "here", "then", "when", "where", "what", "which", "who", "how", "make", "model", "image",
  "picture", "song", "video", "film", "site", "website", "page", "track", "file",
]);

/** The content words of a text (lower case, three letters or more, without filler words). */
function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

/**
 * The earlier artifact a request refers to: the one whose description shares the most content words with the request ("the car's
 * wheels" finds the car). With no shared words the newest artifact is used, which is what "change it" means.
 */
export function pickTarget(items: readonly Remembered[], request: string): Remembered | null {
  if (!items.length) return null;
  const want = contentWords(request);
  let best = items[0]!, bestScore = 0;
  for (const item of items) {
    let score = 0;
    for (const word of contentWords(item.text)) if (want.has(word)) score++;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

/** A request that starts a new subject: "draw a red barn", "make a dragon", "a song about rain". */
const NEW_SUBJECT = /^(?:please\s+)?(?:draw|paint|sketch|create|generate|design|illustrate|render|compose|write|build|sculpt|model|animate|film|shoot|record|produce|start\s+(?:over|again|fresh|from\s+scratch)|make\s+(?:a|an|me|some|another|new)\b|give\s+me\s+(?:a|an|another|some)\b|show\s+me\s+(?:a|an)\b|another\b|new\s+(?:one|song|video|picture|image|model|site|website|track|film|version)\b|(?:a|an|some)\s)/i;

/** Words that point at an earlier artifact: "it", "the chorus", "scene 2", "my picture". */
const REFERENCE = /\b(?:it|its|it's|again|instead)\b|\b(?:this|that)\s+(?:one|version|picture|image|model|song|track|video|film|site|page|scene|chorus)\b|\b(?:the|my|our)\s+(?:same|previous|last|earlier|original|first|second|third|latest|current|old|one|picture|image|photo|model|character|object|prop|song|track|tune|video|film|clip|site|website|page|scene|chorus|verse|bridge|intro|outro|title|lyrics?|background|colou?r|palette|font|logo|music|voice|ending|lighting|wings?|head|body|legs?|arms?|tail|wheels?|door|roof|top|bottom|hair|face|eyes?)\b|\b(?:scene|verse|chorus|bridge|section|line)\s*\d+\b/i;

/** Requests that open with a change: "make it night", "shorter", "add a bridge", "darker". */
const EDIT_LEAD = /^(?:please\s+)?(?:make|change|turn|switch|add|remove|replace|put|keep|move|rotate|flip|swap|brighten|darken|lighten|lengthen|shorten|shrink|enlarge|recolou?r|resize|tweak|adjust|fix|update|edit|revise|rewrite|reduce|increase|boost|cut|drop|extend|more|less|bigger|smaller|darker|brighter|lighter|louder|quieter|softer|faster|slower|shorter|longer|again|also|instead|now|same|just|only|actually|slightly|even|too)\b/i;

/**
 * Whether a request changes the earlier artifact rather than asking for a new one. Requests that start a new subject are never
 * edits; otherwise a request is an edit when it points at the earlier artifact or opens with a change. Without an earlier artifact
 * nothing is an edit.
 */
export function wantsEdit(request: string, hasPrevious: boolean): boolean {
  if (!hasPrevious) return false;
  const text = request.trim().replace(/\s+/g, " ");
  if (!text || NEW_SUBJECT.test(text)) return false;
  return REFERENCE.test(text) || EDIT_LEAD.test(text);
}
