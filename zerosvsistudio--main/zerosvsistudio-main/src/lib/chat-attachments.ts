import type { ParticleSculptSpec } from "@/lib/particle-model";
import { clampParticleSpec } from "@/lib/particle-model";
import { particleSpecToGlb } from "@/lib/particle-glb";
import type { WebProject } from "@/lib/web-project";
import type { SiteReportLite } from "@/lib/site-verifier";
import type { ForgeStats } from "@/lib/forge/forge-client";
import type { SongInfoLite, SongSpec } from "@/lib/song";
import type { SongReport } from "@/lib/song-report";
import type { VideoSpec } from "@/lib/video-spec";
import type { VideoReport } from "@/lib/video-qa";
import {
  fetchChatJson,
  signedChatAssetUrl,
  signedChatAssetUrls,
  uploadChatAsset,
  uploadChatJson,
} from "@/lib/chat-assets";

export type AppProposal = { toolkit: string; tool: string; arguments: Record<string, unknown>; summary: string };

export type ChatAttachment =
  | { kind: "apps"; apps: string[]; proposal?: AppProposal | null }
  | { kind: "image"; src: string; storagePath?: string; prompt?: string; drawn?: boolean }
  | {
      kind: "model";
      source?: string;
      prompt?: string;
      spec?: ParticleSculptSpec;
      storagePath?: string;
      glbPath?: string;
    }
  | { kind: "forge"; code: string; prompt?: string; stats?: ForgeStats; score?: number; quality?: "hyper" | "draft" }
  | { kind: "web"; project: WebProject; storagePath?: string; brief?: string; report?: SiteReportLite }
  | { kind: "song"; spec: SongSpec; storagePath?: string; info?: SongInfoLite; report?: SongReport }
  | { kind: "video"; spec: VideoSpec; storagePath?: string; format?: "mp4" | "webm"; audio?: boolean; report?: VideoReport; vtt?: string };

/** Upload model spec + GLB into the same accounts bucket as images. */
export async function persistModelAssets(
  userId: string,
  conversationId: string,
  spec: ParticleSculptSpec,
): Promise<{ storagePath?: string; glbPath?: string }> {
  try {
    const clamped = clampParticleSpec(spec);
    const jsonAsset = await uploadChatJson(userId, conversationId, clamped, "zeros-model-spec.json");
    const glb = particleSpecToGlb(clamped);
    const glbAsset = await uploadChatAsset(userId, conversationId, glb, "zeros-model.glb");
    return { storagePath: jsonAsset.storagePath, glbPath: glbAsset.storagePath };
  } catch (e) {
    console.error("[Zeros] model asset upload failed:", e);
    return {};
  }
}

/** Upload website project JSON. */
export async function persistWebAssets(
  userId: string,
  conversationId: string,
  project: WebProject,
): Promise<{ storagePath?: string }> {
  try {
    const asset = await uploadChatJson(userId, conversationId, project, "zeros-website.json");
    return { storagePath: asset.storagePath };
  } catch (e) {
    console.error("[Zeros] website asset upload failed:", e);
    return {};
  }
}

/** Upload the rendered song (compressed Opus/WebM when available, else the lossless WAV). */
export async function persistSongAssets(
  userId: string,
  conversationId: string,
  blob: Blob,
  title: string,
): Promise<{ storagePath?: string }> {
  try {
    const ext = /webm|ogg|opus/i.test(blob.type) ? "webm" : "wav";
    const asset = await uploadChatAsset(userId, conversationId, blob, `${title || "zeros-song"}.${ext}`);
    return { storagePath: asset.storagePath };
  } catch (e) {
    console.error("[Zeros] song asset upload failed:", e);
    return {};
  }
}

/** Upload rendered video WebM + optional VideoSpec JSON. */
export async function persistVideoAssets(
  userId: string,
  conversationId: string,
  blob: Blob,
  spec: VideoSpec,
  ext: "mp4" | "webm" = "webm",
): Promise<{ storagePath?: string }> {
  try {
    const title = (spec.title || "zeros-video").replace(/[^a-z0-9]+/gi, "-").slice(0, 48);
    const asset = await uploadChatAsset(
      userId,
      conversationId,
      blob,
      `${title || "zeros-video"}.${ext}`,
    );
    try {
      await uploadChatJson(userId, conversationId, spec, "zeros-video-spec.json");
    } catch {}
    return { storagePath: asset.storagePath };
  } catch (e) {
    console.error("[Zeros] video asset upload failed:", e);
    return {};
  }
}

/** Rehydrate attachment blobs/specs from the shared bucket (cross-device). */
export async function hydrateAttachment(
  attachment: ChatAttachment | null,
  messageId: string,
): Promise<{ attachment: ChatAttachment | null; songUrl?: string; videoUrl?: string }> {
  if (!attachment) return { attachment: null };
  try {
    if (attachment.kind === "image" && attachment.storagePath) {
      const url = await signedChatAssetUrl(attachment.storagePath);
      return { attachment: { ...attachment, src: url } };
    }
    if (attachment.kind === "song" && attachment.storagePath) {
      const url = await signedChatAssetUrl(attachment.storagePath);
      return { attachment, songUrl: url };
    }
    if (attachment.kind === "video" && attachment.storagePath) {
      const url = await signedChatAssetUrl(attachment.storagePath);
      return { attachment, videoUrl: url };
    }
    if (attachment.kind === "model") {
      if (!attachment.spec && attachment.storagePath) {
        const remote = await fetchChatJson<ParticleSculptSpec>(attachment.storagePath);
        return { attachment: { ...attachment, spec: remote } };
      }
      return { attachment };
    }
    if (attachment.kind === "web") {
      const hasFiles = attachment.project && Object.keys(attachment.project.files ?? {}).length > 0;
      if (!hasFiles && attachment.storagePath) {
        const remote = await fetchChatJson<WebProject>(attachment.storagePath);
        return { attachment: { ...attachment, project: remote } };
      }
      return { attachment };
    }
  } catch (e) {
    console.error("[Zeros] chat asset restore failed:", messageId, e);
  }
  return { attachment };
}


export type HydrationResult = { attachment: ChatAttachment | null; songUrl?: string; videoUrl?: string };

/**
 * Restores the media of many messages WITHOUT ever blocking the conversation:
 *   1. every image / song / video path is signed with one bulk request,
 *   2. heavy JSON (3D model specs, website projects) downloads with a small concurrency limit and a timeout each,
 *   3. every message reports back as soon as ITS media is ready (`onEach`), and one failure never affects another.
 * The caller shows the text first and lets the media arrive.
 */
export async function hydrateAttachments(
  items: { id: string; attachment: ChatAttachment | null }[],
  onEach: (id: string, result: HydrationResult) => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const withMedia = items.filter((x) => x.attachment && ["image", "song", "video"].includes(x.attachment.kind) && (x.attachment as { storagePath?: string }).storagePath);
  const urls = withMedia.length ? await signedChatAssetUrls(withMedia.map((x) => (x.attachment as { storagePath: string }).storagePath)).catch(() => ({} as Record<string, string>)) : {};
  if (!isCurrent()) return;
  const heavy: (() => Promise<void>)[] = [];
  for (const { id, attachment } of items) {
    if (!attachment) continue;
    const path = (attachment as { storagePath?: string }).storagePath;
    try {
      if (attachment.kind === "image" && path) { const u = urls[path]; if (u) onEach(id, { attachment: { ...attachment, src: u } }); else onEach(id, { attachment }); continue; }
      if (attachment.kind === "song" && path) { const u = urls[path]; onEach(id, { attachment, ...(u ? { songUrl: u } : {}) }); continue; }
      if (attachment.kind === "video" && path) { const u = urls[path]; onEach(id, { attachment, ...(u ? { videoUrl: u } : {}) }); continue; }
      if (attachment.kind === "model") {
        if (!attachment.spec && attachment.storagePath) heavy.push(async () => { try { onEach(id, { attachment: { ...attachment, spec: await fetchChatJson<ParticleSculptSpec>(attachment.storagePath!) } }); } catch (e) { console.warn("[Zeros] 3D model restore failed:", id, e); onEach(id, { attachment }); } });
        else onEach(id, { attachment });
        continue;
      }
      if (attachment.kind === "web") {
        const hasFiles = attachment.project && Object.keys(attachment.project.files ?? {}).length > 0;
        if (!hasFiles && attachment.storagePath) heavy.push(async () => { try { onEach(id, { attachment: { ...attachment, project: await fetchChatJson<WebProject>(attachment.storagePath!) } }); } catch (e) { console.warn("[Zeros] website restore failed:", id, e); onEach(id, { attachment }); } });
        else onEach(id, { attachment });
        continue;
      }
      onEach(id, { attachment });
    } catch (e) { console.warn("[Zeros] chat asset restore failed:", id, e); onEach(id, { attachment }); }
  }
  /* heavy downloads: three at a time, newest first (the end of the chat is what people look at) */
  const queue = heavy.reverse();
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length && isCurrent()) await queue.shift()!(); }));
}
