import { WebmMuxer } from "@/lib/video-mux";

export type Pcm = { l: Float32Array; r: Float32Array; sampleRate: number };

export const canEncodeOpus = (): boolean => typeof AudioEncoder !== "undefined" && typeof AudioData !== "undefined";

/** High-quality resample to 48 kHz (Opus' native rate) using the browser's own resampler; linear fallback. */
async function to48k(pcm: Pcm): Promise<{ l: Float32Array; r: Float32Array }> {
  if (pcm.sampleRate === 48000) return { l: pcm.l, r: pcm.r };
  const frames = Math.ceil((pcm.l.length * 48000) / pcm.sampleRate);
  try {
    if (typeof OfflineAudioContext !== "undefined") {
      const ctx = new OfflineAudioContext(2, frames, 48000);
      const buf = ctx.createBuffer(2, pcm.l.length, pcm.sampleRate);
      buf.copyToChannel(pcm.l as Float32Array<ArrayBuffer>, 0); buf.copyToChannel(pcm.r as Float32Array<ArrayBuffer>, 1);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
      const out = await ctx.startRendering();
      return { l: out.getChannelData(0).slice(), r: out.getChannelData(1).slice() };
    }
  } catch { /* fall through */ }
  const l = new Float32Array(frames), r = new Float32Array(frames), ratio = pcm.sampleRate / 48000;
  for (let i = 0; i < frames; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0, a = Math.min(pcm.l.length - 1, i0), b = Math.min(pcm.l.length - 1, i0 + 1);
    l[i] = pcm.l[a]! * (1 - f) + pcm.l[b]! * f; r[i] = pcm.r[a]! * (1 - f) + pcm.r[b]! * f;
  }
  return { l, r };
}

/**
 * Encodes stereo PCM to Opus in a WebM container (about 10x smaller than WAV, plays in Chrome / Edge / Firefox / Android / VLC).
 * Returns null when this browser has no Opus AudioEncoder.
 */
export async function encodeOpusWebm(pcm: Pcm, opts: { kbps?: number; onProgress?: (fraction: number) => void } = {}): Promise<Blob | null> {
  if (!canEncodeOpus()) return null;
  const bitrate = Math.round((opts.kbps ?? 160) * 1000);
  const config: AudioEncoderConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate };
  try { if (!(await AudioEncoder.isConfigSupported(config)).supported) return null; } catch { return null; }
  const { l, r } = await to48k(pcm);
  const total = l.length, durationMs = (total / 48000) * 1000;
  const mux = new WebmMuxer(undefined, { sampleRate: 48000, channels: 2, preSkip: 312 });
  let error: Error | null = null;
  const enc = new AudioEncoder({
    output: (chunk) => { const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf); mux.addAudio(buf, chunk.timestamp); },
    error: (e) => { error = e instanceof Error ? e : new Error(String(e)); },
  });
  enc.configure(config);
  const FRAME = 4800; /* 100 ms per AudioData; the encoder re-frames to 20 ms internally */
  for (let a = 0; a < total && !error; a += FRAME) {
    const n = Math.min(FRAME, total - a), data = new Float32Array(n * 2);
    data.set(l.subarray(a, a + n), 0); data.set(r.subarray(a, a + n), n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((a / 48000) * 1e6), data });
    enc.encode(ad); ad.close();
    if (enc.encodeQueueSize > 24) await new Promise<void>((res) => setTimeout(res, 0));
    if (((a / FRAME) | 0) % 40 === 0) { opts.onProgress?.(a / total); await new Promise<void>((res) => setTimeout(res, 0)); }
  }
  await enc.flush();
  enc.close();
  if (error) return null;
  opts.onProgress?.(1);
  return mux.finalize(durationMs);
}
