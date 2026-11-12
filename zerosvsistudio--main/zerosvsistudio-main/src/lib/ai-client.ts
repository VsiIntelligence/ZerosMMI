import { authHeaders } from "@/lib/auth-token";
import { buildHistoryWindow } from "@/lib/chat-window";
import { getReasoningLevel } from "@/lib/reasoning-settings";
import { readChatMeta, setChatMeta } from "@/lib/chat-meta";
import type { ZeroMode } from "./zeros";
import { displayText } from "./voice-guard";

export type Msg = { role: "user" | "assistant"; content: string };

function explainResponseFailure(raw: string, status: number, kind: "chat" | "image"): string {
  const text = raw.trim();
  const output = kind === "image" ? "image generator" : "reasoning engine";
  if (/<!doctype html|<html[\s>]/i.test(text)) {
    if (/\b1102\b|worker exceeded resource limits/i.test(text)) {
      return "Zeros' " + output + " hit a temporary Cloudflare resource limit (1102). Try Fast or Medium, shorten the prompt, and retry.";
    }
    if (/cloudflare|gateway|temporarily unavailable/i.test(text)) {
      return "Zeros' " + output + " returned a temporary server error (HTTP " + status + "). Please retry in a moment.";
    }
    return "Zeros received an HTML error page instead of a " + (kind === "image" ? "picture" : "reply") + " (HTTP " + status + "). Please retry.";
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim().slice(0, 1000);
  } catch {}
  return text.slice(0, 1000) || ("Generation failed (HTTP " + status + "). Please retry.");
}

export async function streamChat(
  messages: Msg[],
  mode: ZeroMode,
  memories: string[],
  onDelta: (full: string) => void,
  signal?: AbortSignal,
  onFinishReason?: (reason: string | null) => void,
): Promise<string> {
  const conversational = mode === "chat" || mode === "search";
  const show = (full: string) => onDelta(conversational ? displayText(full) : full);
  const timeoutMs =
    mode === "model" ? 300_000
    : mode === "music" ? 180_000
    : mode === "web" ? 300_000
    : mode === "video" ? 180_000
    : 120_000;
  const controller = signal ? null : new AbortController();
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  const selectedReasoning = getReasoningLevel();

  const runOnce = async (reasoning = selectedReasoning): Promise<{ full: string; finishReason: string | null }> => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ messages: buildHistoryWindow(messages), mode, memories, reasoning }),
      signal: signal ?? controller?.signal ?? null,
    });
    setChatMeta(readChatMeta(res.headers));
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      throw new Error(explainResponseFailure(raw, res.status, "chat"));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finishReason: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const choice = json?.choices?.[0];
          const reason = choice?.finish_reason;
          if (typeof reason === "string" && reason) finishReason = reason;
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta) {
            full += delta;
            show(full);
          }
        } catch {}
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) {
      const payload = trailing.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const json = JSON.parse(payload);
          const choice = json?.choices?.[0];
          const reason = choice?.finish_reason;
          if (typeof reason === "string" && reason) finishReason = reason;
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta) {
            full += delta;
            show(full);
          }
        } catch {}
      }
    }
    return { full, finishReason };
  };

  try {
    let result: { full: string; finishReason: string | null } | null = null;
    try {
      result = await runOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const structured = mode === "model" || mode === "web" || mode === "music" || mode === "video";
      const resourceLimit = mode === "model" && /1102|resource limit|worker exceeded|failed to fetch|load failed|networkerror/i.test(message);
      // When the engines did not answer at one reasoning level, another level reaches different models: try it before giving up.
      const unreachable = structured && /could not reach|reasoning engine|\b50[234]\b/i.test(message);
      const shouldDegrade = resourceLimit || unreachable;
      const fallbackLevels: ("medium" | "fast")[] = shouldDegrade
        ? selectedReasoning === "complex" ? ["medium", "fast"] : selectedReasoning === "medium" ? ["fast"] : unreachable ? ["medium"] : []
        : [];
      let lastError: unknown = error;
      let recovered = false;
      for (const level of fallbackLevels) {
        try {
          result = await runOnce(level);
          recovered = true;
          break;
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
      if (!recovered || !result) throw lastError;
    }
    if (!result) throw new Error("3D generation failed before a response was received.");
    let { full, finishReason } = result;
    if (!full.trim()) {
      ({ full, finishReason } = await runOnce());
    }
    if (!full.trim()) throw new Error("Zeros received an empty generation. Please try again.");
    onFinishReason?.(finishReason);
    if (conversational) { const clean = displayText(full, true); onDelta(clean); return clean; }
    return full;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
}

function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return Promise.resolve(blob);
  return createImageBitmap(blob).then((bitmap) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PNG conversion is unavailable in this browser");
      context.drawImage(bitmap, 0, 0);
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (png) => (png ? resolve(png) : reject(new Error("PNG encoding failed"))),
          "image/png",
        );
      });
    } finally {
      bitmap.close();
    }
  });
}

export async function downloadImageAsPng(src: string, filename = "zeros-image.png"): Promise<void> {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}`);
  const blob = await response.blob();
  const png = await blobToPng(blob);
  const objectUrl = URL.createObjectURL(png);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

export type MadeImage = { src: string; /** The full prompt this picture was made from; kept so "change it" can build on it. */ prompt: string; /** True when no picture model could be reached and Zeros drew an illustration instead. */ drawn: boolean };

/** A drawn illustration (SVG) as an ordinary PNG, so uploads, downloads and viewers treat it like any other picture. */
async function svgToPng(svg: Blob): Promise<Blob> {
  const url = URL.createObjectURL(svg);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("drawing failed")); img.src = url; });
    const natural = Math.max(img.naturalWidth || 1024, 1), naturalH = Math.max(img.naturalHeight || 1024, 1);
    const scale = Math.min(2048 / natural, 2048 / naturalH, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(natural * scale); canvas.height = Math.round(naturalH * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The picture at `src` as a small base64 JPEG for sending back to be changed. Null when it cannot be read (the change then works from the prompt alone). */
export async function imageForEdit(src: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const blob = await (await fetch(src)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.88).split(",")[1] ?? "";
    return data.length > 100 ? { mimeType: "image/jpeg", data } : null;
  } catch {
    return null;
  }
}

/**
 * Makes a picture. To change an earlier one, pass what it was made from (`previousPrompt`) and, if you have it, the picture itself
 * (`base`): the change is then applied to that picture instead of starting a new one.
 */
export async function generateImageDetailed(prompt: string, edit: { previousPrompt?: string; base?: { mimeType: string; data: string } | null } = {}): Promise<MadeImage> {
  const res = await fetch("/api/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ prompt, ...(edit.previousPrompt ? { previousPrompt: edit.previousPrompt } : {}), ...(edit.base ? { base: edit.base } : {}) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(explainResponseFailure(text, res.status, "image"));
  }

  let blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The image could not be created. Please try again.");
  const drawn = res.headers.get("X-Zeros-Style") === "illustration";
  if (blob.type === "image/svg+xml") blob = await svgToPng(blob).catch(() => blob);
  let used = prompt;
  try { used = decodeURIComponent(res.headers.get("X-Zeros-Prompt") ?? "") || prompt; } catch { /* keep the typed prompt */ }
  return { src: URL.createObjectURL(blob), prompt: used, drawn };
}

export async function generateImage(prompt: string): Promise<string> {
  return (await generateImageDetailed(prompt)).src;
}
