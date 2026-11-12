/**
 * Zeros Cinema Engine - the renderer. Pre-flight lint -> soundtrack (score, narration, sound design, mix) -> frames drawn by the
 * Stage -> encode -> measured QA report. Deterministic and faster than real time wherever WebCodecs exists; a real-time recorder
 * (with audio) elsewhere. It never hands back a fake success: if a film cannot be made it throws, and the caller says so.
 */
import { Stage } from "./video/stage";
import { makeMeasure } from "./video/draw";
import { buildSoundtrack, SR, type Soundtrack } from "./video-audio";
import { detectEncoder, encodeWebm } from "./video-encode";
import { lintVideoSpec, type LintResult } from "./video-lint";
import { Prober, audioQa, summarizeProbes, videoReport, type AudioQa, type EncodeInfo, type VideoQa, type VideoReport } from "./video-qa";
import type { CaptionClip } from "./video/stage";
import type { VideoSpec } from "./video-spec";

export type RenderVideoResult = {
  blob: Blob; ext: "mp4" | "webm"; audio?: boolean;
  /** the spec that was actually rendered (cuts re-snapped to the beat measured in the score) */
  spec: VideoSpec;
  report: VideoReport;
  /** WebVTT / SRT of the narration, for accessibility and re-use */
  vtt: string; srt: string;
  poster?: Blob;
  qa: { video: VideoQa | null; audio: AudioQa | null; lint: LintResult };
};
export type RenderOptions = { quality?: "standard" | "cinema"; plates?: boolean; signal?: AbortSignal };

const ts = (ms: number, comma: boolean): string => { const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), x = Math.floor(ms % 1000); const p = (n: number, w = 2): string => String(n).padStart(w, "0"); return `${p(h)}:${p(m)}:${p(s)}${comma ? "," : "."}${p(x, 3)}`; };
export const toVtt = (clips: CaptionClip[]): string => "WEBVTT\n\n" + clips.map((c, i) => `${i + 1}\n${ts(c.startMs, false)} --> ${ts(c.endMs, false)}\n${c.text}\n`).join("\n");
export const toSrt = (clips: CaptionClip[]): string => clips.map((c, i) => `${i + 1}\n${ts(c.startMs, true)} --> ${ts(c.endMs, true)}\n${c.text}\n`).join("\n");

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function loadPlates(spec: VideoSpec, onStatus?: (s: string) => void): Promise<(CanvasImageSource | null)[]> {
  const plates: (CanvasImageSource | null)[] = spec.scenes.map(() => null);
  const want = spec.scenes.map((s, i) => ({ s, i })).filter((x) => x.s.plate && x.s.imagePrompt).slice(0, 3);
  if (!want.length) return plates;
  onStatus?.("Painting image plates…");
  const { generateImage } = await import("./ai-client");
  await Promise.all(want.map(async ({ s, i }) => {
    try {
      const url = await Promise.race([generateImage(`${s.imagePrompt}, cinematic, dark moody lighting, no text, no watermark`), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("plate timeout")), 12000))]);
      const img = new Image(); img.crossOrigin = "anonymous"; img.src = url;
      await img.decode();
      plates[i] = img;
    } catch { s.plate = false; }
  }));
  return plates;
}

/** Real-time capture for browsers without WebCodecs: records the canvas and the soundtrack together. */
async function recordRealtime(stage: Stage, canvas: HTMLCanvasElement, track: Soundtrack | null, fps: number, frames: number, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<{ blob: Blob; ext: "mp4" | "webm"; hasAudio: boolean; mime: string }> {
  if (typeof MediaRecorder === "undefined") throw new Error("This browser can neither encode nor record video.");
  const stream = canvas.captureStream(fps);
  let ctx: AudioContext | null = null, src: AudioBufferSourceNode | null = null, hasAudio = false;
  if (track) {
    try {
      ctx = new AudioContext({ sampleRate: SR });
      const dest = ctx.createMediaStreamDestination(), buf = ctx.createBuffer(2, track.l.length, SR);
      buf.copyToChannel(track.l as Float32Array<ArrayBuffer>, 0); buf.copyToChannel(track.r as Float32Array<ArrayBuffer>, 1);
      src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
      const at = dest.stream.getAudioTracks()[0];
      if (at) { stream.addTrack(at); hasAudio = true; }
    } catch { hasAudio = false; }
  }
  const mimes = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = mimes.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(250);
  if (ctx && src) { await ctx.resume().catch(() => undefined); src.start(); }
  const t0 = performance.now();
  let drawn = -1;
  while (drawn < frames - 1) {
    if (signal?.aborted) { rec.stop(); throw new Error("Cancelled."); }
    const f = Math.min(frames - 1, Math.floor(((performance.now() - t0) / 1000) * fps));
    if (f > drawn) { stage.drawFrame(f); drawn = f; onProgress?.((f + 1) / frames); }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  await new Promise((r) => setTimeout(r, 250));
  rec.stop(); await done; void ctx?.close();
  const type = rec.mimeType || mime || "video/webm";
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm", hasAudio, mime: type };
}

export async function renderVideoWithMeta(input: VideoSpec, onProgress?: (fraction: number) => void, onStatus?: (s: string) => void, opts: RenderOptions = {}): Promise<RenderVideoResult> {
  if (typeof document === "undefined") throw new Error("Video rendering needs a browser.");
  const cinema = opts.quality === "cinema";
  const prelim: VideoSpec = { ...input, width: cinema ? 1920 : 1280, height: cinema ? 1080 : 720, fps: 30 };

  /* ---- 1. pre-flight: lint with real font metrics ---- */
  onStatus?.("Pre-flight checks…");
  const scratch = document.createElement("canvas").getContext("2d");
  if (!scratch) throw new Error("Canvas 2D is unavailable in this browser.");
  const lint = lintVideoSpec(prelim, { measure: makeMeasure(scratch) });
  onProgress?.(0.02);

  /* ---- 2. soundtrack ---- */
  let step = 0.02;
  const track = await buildSoundtrack(lint.spec, (s) => { step = Math.min(0.2, step + 0.012); onProgress?.(step); onStatus?.(s); });
  const spec = track.spec;
  const finalLint = lintVideoSpec(spec, { measure: makeMeasure(scratch), beatOffsetMs: spec.audio.beatOffsetMs ?? 0 });
  finalLint.fixes.unshift(...lint.fixes);
  onProgress?.(0.22);

  /* ---- 3. stage ---- */
  const plates = opts.plates === false ? [] : await loadPlates(spec, onStatus);
  const canvas = document.createElement("canvas"); canvas.width = spec.width; canvas.height = spec.height;
  const stage = new Stage({ spec, canvas, audio: track.env, captions: track.clips, plates });
  const frames = Math.round(spec.durationSec * spec.fps), prober = new Prober();
  const draw = (i: number): void => { stage.drawFrame(i); if (i % 3 === 0) prober.sample(canvas, (i / spec.fps) * 1000); };

  /* ---- 4. encode ---- */
  onStatus?.("Rendering frames…");
  const support = await detectEncoder(spec.width, spec.height, spec.fps, true);
  let blob: Blob, ext: "mp4" | "webm" = "webm", hasAudio = false, codec = "VP9", encoder: EncodeInfo["encoder"] = "webcodecs";
  if (support) {
    codec = support.codec.startsWith("vp09") ? "VP9" : support.codec === "vp8" ? "VP8" : "AV1";
    blob = await encodeWebm(support, {
      width: spec.width, height: spec.height, fps: spec.fps, frames, canvas, bitrate: cinema ? 8_000_000 : 4_000_000,
      audio: { l: track.l, r: track.r, sampleRate: SR }, drawFrame: (i) => { draw(i); return i % 24 === 0 ? tick() : undefined; }, ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (r) => onProgress?.(0.22 + 0.74 * r),
    });
    hasAudio = support.audio; if (support.audio) codec += " + Opus";
  } else {
    onStatus?.("This browser cannot encode faster than real time; recording live (keep this tab open)…");
    const rec = await recordRealtime(stage, canvas, track, spec.fps, frames, (r) => onProgress?.(0.22 + 0.74 * r), opts.signal);
    blob = rec.blob; ext = rec.ext; hasAudio = rec.hasAudio; encoder = "mediarecorder";
    codec = rec.mime.includes("mp4") ? "H.264" : rec.mime.includes("vp9") ? "VP9" : "VP8";
    for (let i = 0; i < frames; i += 3) prober.sample(canvas, (i / spec.fps) * 1000);
  }

  /* ---- 5. measure ---- */
  onStatus?.("Checking the finished film…");
  const qaVideo = summarizeProbes(prober.probes, spec, frames);
  const qaAudio = audioQa(track.l, track.r, SR, spec, track.report.mix.lufs, track.report.mix.peakDb);
  const enc: EncodeInfo = { width: spec.width, height: spec.height, fps: spec.fps, codec, ext, bytes: blob.size, hasAudio, encoder };
  const report = videoReport(spec, finalLint, qaVideo, track.report, qaAudio, enc);
  let poster: Blob | undefined;
  try { stage.drawFrame(stage.posterFrame()); poster = await new Promise<Blob | undefined>((res) => canvas.toBlob((b) => res(b ?? undefined), "image/jpeg", 0.86)); } catch { /* the poster is a nicety */ }
  onProgress?.(1);
  return { blob, ext, audio: hasAudio, spec, report, vtt: toVtt(track.clips), srt: toSrt(track.clips), ...(poster ? { poster } : {}), qa: { video: qaVideo, audio: qaAudio, lint: finalLint } };
}

/** Back-compat helper: renders and returns just the file. */
export async function renderVideo(spec: VideoSpec, onProgress?: (fraction: number) => void): Promise<Blob> {
  return (await renderVideoWithMeta(spec, onProgress)).blob;
}
