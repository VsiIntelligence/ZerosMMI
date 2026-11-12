import { WebmMuxer } from "./video-mux";

export type EncodeAudio = { l: Float32Array; r: Float32Array; sampleRate: number };
export type EncodeOptions = {
  width: number; height: number; fps: number; frames: number; bitrate?: number;
  drawFrame: (index: number, timeSec: number) => void | Promise<void>;
  canvas: HTMLCanvasElement;
  audio?: EncodeAudio | null;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
};

export type EncoderSupport = { codec: "vp09.00.10.08" | "vp8" | "av01.0.05M.08"; mux: "V_VP9" | "V_VP8" | "V_AV1"; audio: boolean } | null;

export async function detectEncoder(width: number, height: number, fps: number, wantAudio: boolean): Promise<EncoderSupport> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  const cands = [["vp09.00.10.08", "V_VP9"], ["vp8", "V_VP8"], ["av01.0.05M.08", "V_AV1"]] as const;
  let audio = false;
  if (wantAudio && typeof AudioEncoder !== "undefined" && typeof AudioData !== "undefined") {
    try { audio = !!(await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported; } catch { audio = false; }
  }
  for (const [codec, mux] of cands) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 6_000_000, framerate: fps });
      if (s.supported) return { codec, mux, audio };
    } catch { /* try next */ }
  }
  return null;
}

/** Deterministic, faster-than-real-time render: every frame is drawn, encoded and muxed in order. */
export async function encodeWebm(support: NonNullable<EncoderSupport>, o: EncodeOptions): Promise<Blob> {
  const out: { data: Uint8Array; ts: number; key: boolean }[] = [];
  const audioOut: { data: Uint8Array; ts: number }[] = [];
  let failure: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); out.push({ data: d, ts: chunk.timestamp, key: chunk.type === "key" }); },
    error: (e) => { failure = e instanceof Error ? e : new Error(String(e)); },
  });
  venc.configure({ codec: support.codec, width: o.width, height: o.height, bitrate: o.bitrate ?? 7_000_000, framerate: o.fps, latencyMode: "quality", ...(support.codec.startsWith("avc") ? {} : {}) });

  const frameUs = 1_000_000 / o.fps;
  const audio = support.audio ? o.audio ?? null : null;
  let aenc: AudioEncoder | null = null;
  if (audio) {
    aenc = new AudioEncoder({
      output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); audioOut.push({ data: d, ts: chunk.timestamp }); },
      error: (e) => { failure = e instanceof Error ? e : new Error(String(e)); },
    });
    aenc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
  }

  for (let i = 0; i < o.frames; i++) {
    if (o.signal?.aborted) throw new Error("Cancelled.");
    if (failure) throw failure;
    await o.drawFrame(i, i / o.fps);
    const frame = new VideoFrame(o.canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
    venc.encode(frame, { keyFrame: i % Math.round(o.fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise<void>((r) => setTimeout(r, 2));
    if (i % 6 === 0) { o.onProgress?.(i / o.frames); await new Promise<void>((r) => setTimeout(r, 0)); }
  }
  await venc.flush(); venc.close();

  if (aenc && audio) {
    const total = Math.min(audio.l.length, Math.round((o.frames / o.fps) * 48000)), step = 48000; // 1 s per AudioData
    for (let s = 0; s < total; s += step) {
      const n = Math.min(step, total - s), planar = new Float32Array(n * 2);
      planar.set(audio.l.subarray(s, s + n), 0); planar.set(audio.r.subarray(s, s + n), n);
      const data = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((s / 48000) * 1e6), data: planar });
      aenc.encode(data); data.close();
      while (aenc.encodeQueueSize > 8) await new Promise<void>((r) => setTimeout(r, 2));
    }
    await aenc.flush(); aenc.close();
  }
  if (failure) throw failure;
  if (!out.length) throw new Error("The video encoder produced no frames.");

  const mux = new WebmMuxer(
    { codec: support.mux, width: o.width, height: o.height, fps: o.fps },
    audio ? { sampleRate: 48000, channels: 2, preSkip: 312 } : undefined,
  );
  for (const c of out) mux.addVideo(c.data, c.ts, c.key);
  for (const c of audioOut) mux.addAudio(c.data, c.ts);
  return mux.finalize((o.frames / o.fps) * 1000);
}
