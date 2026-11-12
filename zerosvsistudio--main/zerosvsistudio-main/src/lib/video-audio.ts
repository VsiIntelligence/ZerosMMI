/**
 * Soundtrack builder for Zeros films: a Zeros-composed score, an AI narrator, procedural sound design and a proper mix.
 *
 *   score -> measured beat grid (so cuts land on real beats) -> narration (parallel, retried) -> sound design ->
 *   mix: score carved + ducked under the voice (same technique as the song mixer) -> -14 LUFS master with a true limiter ->
 *   audio-reactive envelope for the picture.
 *
 * Never throws: a failed score or narrator degrades the film honestly (and the QA report says so).
 */
import { renderZerosSong } from "./zeros-music/engine";
import { BandEnergy, SPEECH_BAND, carveForVocal, vocalActivity, vocalBalance } from "./zeros-music/mix-analysis";
import { Biquad, compress, dbToGain, integratedLufs, limit, mkStereo, peakDb, type Stereo } from "./zeros-music/dsp";
import { planSfx, renderSfx, type SfxEvent } from "./video-sfx";
import { snapBoundariesToBeats } from "./video-lint";
import type { AudioEnv, CaptionClip } from "./video/stage";
import type { VideoSpec } from "./video-spec";
import { authHeaders } from "@/lib/auth-token";

export const SR = 48000;
/** Beat-grid confidence needed to trust a measured offset. Calibrated: random noise scores 1.4-1.8, real rendered scores 4.9-11.7. */
export const BEAT_TRUST = 2.6;

export type AudioReport = {
  score: { ok: boolean; genre: string; bpm: number; beatOffsetMs: number; beatConfidence: number; lufs: number | null };
  voice: { requested: number; recorded: number; failed: string[]; totalMs: number };
  sfx: { events: number; hits: number; byWhy: Record<string, number> };
  mix: { lufs: number; peakDb: number; clipped: number; narrationOverMusicDb: number | null; duckDb: number };
};
export type Soundtrack = {
  l: Float32Array; r: Float32Array; sampleRate: 48000;
  /** the spec with cuts re-snapped to the MEASURED beat grid */
  spec: VideoSpec;
  clips: CaptionClip[]; env: AudioEnv; report: AudioReport; sfxEvents: SfxEvent[];
  hasVoice: boolean; lufs: number;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Voice                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export function resample(src: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return src;
  const n = Math.floor((src.length * to) / from), out = new Float32Array(n), k = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * k, i0 = Math.floor(x), f = x - i0, a = src[i0] ?? 0, b = src[i0 + 1] ?? a, c = src[i0 - 1] ?? a, d = src[i0 + 2] ?? b;
    const c1 = 0.5 * (b - c), c2 = c - 2.5 * a + 2 * b - 0.5 * d, c3 = 0.5 * (d - c) + 1.5 * (a - b);
    out[i] = ((c3 * f + c2) * f + c1) * f + a;
  }
  return out;
}
export function decodePcm16(b64: string): Float32Array {
  const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); if (v & 0x8000) v -= 0x10000; out[i] = v / 32768; }
  return out;
}

async function fetchVoice(text: string, voice: "male" | "female", attempts = 2): Promise<Float32Array | null> {
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ text, voice }), signal: AbortSignal.timeout(26000) });
      if (!res.ok) { if (res.status >= 400 && res.status < 500 && res.status !== 429) return null; continue; }
      const j = (await res.json()) as { pcm?: string; sampleRate?: number };
      if (!j.pcm) continue;
      const pcm = resample(decodePcm16(j.pcm), j.sampleRate ?? 24000, SR);
      if (pcm.length > SR * 0.25) return pcm;
    } catch { /* timeout / network: retry once */ }
  }
  return null;
}

/** Trims silence from both ends of a narration clip (TTS engines pad generously) and fades the edges. */
function trimClip(pcm: Float32Array): Float32Array {
  let a = 0, b = pcm.length - 1;
  const thr = 0.012;
  while (a < b && Math.abs(pcm[a]!) < thr) a++;
  while (b > a && Math.abs(pcm[b]!) < thr) b--;
  a = Math.max(0, a - Math.round(SR * 0.04)); b = Math.min(pcm.length - 1, b + Math.round(SR * 0.08));
  const out = pcm.slice(a, b + 1), f = Math.min(out.length >> 1, Math.round(SR * 0.012));
  for (let i = 0; i < f; i++) { const g = i / f; out[i]! *= g; out[out.length - 1 - i]! *= g; }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Beat grid                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Finds where the beats really fall in a rendered score: low-band onsets folded over the beat period; the phase with the
 * most onset energy is the grid offset. `confidence` is how much stronger that phase is than the average phase.
 */
export function detectBeatGrid(l: Float32Array, r: Float32Array, sr: number, bpm: number, maxSec = 40): { offsetMs: number; confidence: number } {
  const n = Math.min(l.length, Math.round(sr * maxSec)), hop = Math.round(sr / 200), frames = Math.floor(n / hop);
  const lp1 = new Biquad("lp", 160, 0.707, 0, sr), lp2 = new Biquad("lp", 160, 0.707, 0, sr);
  const env = new Float32Array(frames);
  let acc = 0, f = 0, k = 0;
  for (let i = 0; i < n && f < frames; i++) { const y = lp2.process(lp1.process((l[i]! + r[i]!) * 0.5)); acc += y * y; if (++k === hop) { env[f++] = Math.sqrt(acc / hop); acc = 0; k = 0; } }
  const on = new Float32Array(frames);
  for (let i = 2; i < frames; i++) on[i] = Math.max(0, (env[i]! + env[i - 1]!) / 2 - (env[i - 2]! + env[i - 3 < 0 ? 0 : i - 3]!) / 2);
  const beat = 60000 / bpm, beatFrames = beat / 5, bins = Math.round(beatFrames), score = new Float64Array(bins);
  for (let i = 0; i < frames; i++) score[Math.round(i % beatFrames) % bins]! += on[i]!;
  let best = 0, bi = 0, sum = 0;
  for (let b = 0; b < bins; b++) { sum += score[b]!; if (score[b]! > best) { best = score[b]!; bi = b; } }
  const mean = sum / bins || 1, off = (bi * 5) % beat;
  return { offsetMs: Math.round(off > beat / 2 ? off - beat : off), confidence: Math.round((best / mean) * 100) / 100 };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Visual envelope                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export function analyzeEnv(l: Float32Array, r: Float32Array, sr: number, fps: number, frames: number, hitsMs: number[]): AudioEnv {
  const hop = sr / fps, energy = new Float32Array(frames), bassRaw = new Float32Array(frames), lp1 = new Biquad("lp", 140, 0.707, 0, sr), lp2 = new Biquad("lp", 140, 0.707, 0, sr);
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * hop), b = Math.min(l.length, Math.floor((f + 1) * hop));
    let e = 0, bs = 0;
    for (let i = a; i < b; i++) { const m = (l[i]! + r[i]!) * 0.5; e += m * m; const y = lp2.process(lp1.process(m)); bs += y * y; }
    const n = Math.max(1, b - a);
    energy[f] = Math.sqrt(e / n); bassRaw[f] = Math.sqrt(bs / n);
  }
  const p95 = (arr: Float32Array): number => { const s = Array.from(arr).sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)] || 1e-6; };
  const pe = p95(energy), pb = p95(bassRaw);
  const energyN = new Float32Array(frames), pulse = new Float32Array(frames), warp = new Float32Array(frames);
  const diffs = new Float32Array(frames);
  for (let f = 1; f < frames; f++) diffs[f] = Math.max(0, bassRaw[f]! - bassRaw[f - 1]!);
  const pd = p95(diffs);
  let sm = 0, w = 0;
  for (let f = 0; f < frames; f++) {
    sm += 0.35 * (Math.min(1, energy[f]! / pe) - sm); energyN[f] = sm;
    const onset = Math.min(1, diffs[f]! / pd) * Math.min(1, bassRaw[f]! / pb + 0.2);
    pulse[f] = Math.max((pulse[f - 1] ?? 0) * 0.8, onset > 0.35 ? onset : 0);
    w += (1 / fps) * (0.8 + 0.8 * energyN[f]!); warp[f] = w;
  }
  /* the sound-design hits are known exactly: make sure the picture punches on them even if the score is quiet there */
  for (const h of hitsMs) { const f0 = Math.round((h / 1000) * fps); for (let k = 0; k < 8; k++) { const f = f0 + k; if (f >= 0 && f < frames) pulse[f] = Math.max(pulse[f]!, Math.pow(0.78, k)); } }
  return { fps, energy: energyN, pulse, warp };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Mix                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

function applyDuck(bus: Stereo, activity: Float32Array, depthDb: number, sr: number): void {
  const last = activity.length - 1;
  for (let i = 0; i < bus.l.length; i++) { const g = dbToGain(-depthDb * activity[Math.min(last, Math.floor((i / sr) * 1000))]!); bus.l[i]! *= g; bus.r[i]! *= g; }
}
const cloneStereo = (s: Stereo): Stereo => ({ l: s.l.slice(), r: s.r.slice() });

export async function buildSoundtrack(input: VideoSpec, onStatus?: (s: string) => void): Promise<Soundtrack> {
  const seconds = Math.max(8, input.durationSec), total = Math.round(seconds * SR), mood = input.audio.mood;
  const music: Stereo = mkStereo(total);
  let scoreOk = false, scoreLufs: number | null = null;
  try {
    onStatus?.("Composing the score…");
    const score = await renderZerosSong(
      { title: input.title, style: `${input.style} ${mood} film score, no vocals`, genre: input.audio.genre, bpm: input.audio.bpm, key: input.audio.key, instrumental: true, durationSec: Math.min(235, seconds + 4), arrangement: { seed: input.seed } },
      { sampleRate: SR, skipWav: true, targetLufs: -17, onProgress: (f: number, label: string) => onStatus?.(`Score: ${label}… ${Math.round(f * 100)}%`) },
    );
    const n = Math.min(total, score.pcm.l.length);
    music.l.set(score.pcm.l.subarray(0, n)); music.r.set(score.pcm.r.subarray(0, n));
    scoreOk = true; scoreLufs = Math.round(integratedLufs(music, SR) * 10) / 10;
  } catch (e) { console.warn("[Zeros] score failed", e); }

  /* ---- measured beat grid; re-snap the cuts to it ---- */
  const grid = scoreOk ? detectBeatGrid(music.l, music.r, SR, input.audio.bpm) : { offsetMs: 0, confidence: 0 };
  const offset = grid.confidence >= BEAT_TRUST ? grid.offsetMs : 0;
  const spec: VideoSpec = JSON.parse(JSON.stringify(input)) as VideoSpec;
  spec.audio.beatOffsetMs = offset;
  snapBoundariesToBeats(spec, offset);

  /* ---- narration ---- */
  const lines = spec.audio.voiceoverLines.filter((l) => l.text.trim()).slice(0, 12), failed: string[] = [], clips: CaptionClip[] = [];
  const voice = mkStereo(total);
  let recorded = 0, voiceMs = 0;
  if (lines.length) {
    onStatus?.("Recording the narrator…");
    const name = spec.audio.voice === "male" ? "male" : "female", pcms: (Float32Array | null)[] = new Array(lines.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => { while (next < lines.length) { const i = next++; pcms[i] = await fetchVoice(lines[i]!.text.slice(0, 240), name); } };
    await Promise.all([worker(), worker(), worker()]);
    let cursor = 0;
    lines.forEach((l, i) => {
      const raw = pcms[i];
      if (!raw) { failed.push(l.text); return; }
      const clip = trimClip(raw);
      let peak = 0; for (const v of clip) { const a = Math.abs(v); if (a > peak) peak = a; }
      const k = peak > 0 ? 0.6 / peak : 1;
      const start = Math.max(Math.round((l.startMs / 1000) * SR), cursor + Math.round(SR * 0.25));
      if (start + clip.length > total - Math.round(SR * 0.3)) { failed.push(l.text); return; }
      for (let j = 0; j < clip.length; j++) { const v = clip[j]! * k; voice.l[start + j] = v; voice.r[start + j] = v; }
      cursor = start + clip.length; recorded++; voiceMs += (clip.length / SR) * 1000;
      clips.push({ startMs: Math.round((start / SR) * 1000), endMs: Math.round(((start + clip.length) / SR) * 1000), text: l.text });
    });
    if (recorded) {
      /* a touch of presence and control so the narrator reads on phone speakers */
      const hp = new Biquad("hp", 90, 0.707, 0, SR), pres = new Biquad("peak", 3200, 0.9, 2.6, SR);
      for (const ch of [voice.l, voice.r]) { const a = new Biquad("hp", 90, 0.707, 0, SR), b = new Biquad("peak", 3200, 0.9, 2.6, SR); for (let i = 0; i < ch.length; i++) ch[i] = b.process(a.process(ch[i]!)); }
      void hp; void pres;
      compress(voice, { thresh: -22, ratio: 2.6, attack: 6, release: 120, knee: 6, makeup: 3 }, SR);
    }
  }
  const hasVoice = recorded > 0;

  /* ---- sound design ---- */
  onStatus?.("Designing the sound…");
  const events = spec.audio.sfx ? planSfx(spec) : [];
  const sfx = events.length ? renderSfx(events, total, SR, spec.seed) : { track: mkStereo(total), hitsMs: [] as number[] };

  /* ---- mix: carve + duck the score under the voice, measure, deepen if the voice is not clearly in front ---- */
  onStatus?.("Mixing…");
  const activity = hasVoice ? vocalActivity(clips.map((c) => ({ t: c.startMs / 1000, dur: (c.endMs - c.startMs) / 1000 })), seconds + 1) : new Float32Array(2);
  const voMeter = hasVoice ? new BandEnergy(total, SR, SPEECH_BAND) : null;
  if (voMeter) voMeter.add(voice);
  let duck = 0, ratio: number | null = null, mixed = mkStereo(total);
  const build = (carveDb: number, broadDb: number): void => {
    const m = cloneStereo(music);
    if (hasVoice) { carveForVocal(m, activity, carveDb, SR, [250, 4200]); applyDuck(m, activity, broadDb, SR); }
    const s = cloneStereo(sfx.track);
    if (hasVoice) applyDuck(s, activity, 2.5, SR);
    mixed = mkStereo(total);
    for (let i = 0; i < total; i++) { mixed.l[i] = m.l[i]! + s.l[i]! * 0.9 + voice.l[i]! * 1.0; mixed.r[i] = m.r[i]! + s.r[i]! * 0.9 + voice.r[i]! * 1.0; }
    if (voMeter) { const back = new BandEnergy(total, SR, SPEECH_BAND); back.add(m); back.add(s, -0.9); ratio = vocalBalance({ vocal: voMeter, back }).speechDb; }
  };
  /* the voice is the star: -14 LUFS-ish voice over a score ducked until the speech band shows >= +9 dB */
  const tiers: [number, number][] = [[9, 3.5], [11, 5], [13, 7]];
  for (const [c, b] of tiers) { build(c, b); duck = b; if (!hasVoice || (ratio ?? 99) >= 9) break; }

  /* ---- master ---- */
  limit(mixed, -1.5, SR, 4, 120);
  const lf = integratedLufs(mixed, SR);
  const g = dbToGain(Math.max(-12, Math.min(12, -14 - lf)));
  for (let i = 0; i < total; i++) { mixed.l[i]! *= g; mixed.r[i]! *= g; }
  limit(mixed, -1.0, SR, 4, 100);
  const finalLufs = Math.round(integratedLufs(mixed, SR) * 10) / 10, pk = Math.round(peakDb(mixed) * 10) / 10;
  let clipped = 0;
  for (let i = 0; i < total; i++) if (Math.abs(mixed.l[i]!) >= 0.999 || Math.abs(mixed.r[i]!) >= 0.999) clipped++;

  const frames = Math.round(seconds * spec.fps) + 2;
  const env = analyzeEnv(mixed.l, mixed.r, SR, spec.fps, frames, sfx.hitsMs);
  const byWhy: Record<string, number> = {};
  for (const e of events) byWhy[e.why] = (byWhy[e.why] ?? 0) + 1;
  return {
    l: mixed.l, r: mixed.r, sampleRate: 48000, spec, clips, env, sfxEvents: events, hasVoice, lufs: finalLufs,
    report: {
      score: { ok: scoreOk, genre: spec.audio.genre, bpm: spec.audio.bpm, beatOffsetMs: offset, beatConfidence: grid.confidence, lufs: scoreLufs },
      voice: { requested: lines.length, recorded, failed, totalMs: Math.round(voiceMs) },
      sfx: { events: events.length, hits: sfx.hitsMs.length, byWhy },
      mix: { lufs: finalLufs, peakDb: pk, clipped, narrationOverMusicDb: hasVoice ? ratio : null, duckDb: hasVoice ? duck : 0 },
    },
  };
}
