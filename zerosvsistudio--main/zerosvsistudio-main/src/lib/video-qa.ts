/**
 * Measured quality for finished films. Nothing here is a promise: frames are sampled while rendering, the final mix is
 * analysed after mastering, and the report states what was found - including problems.
 */
import type { LintResult } from "./video-lint";
import type { AudioReport } from "./video-audio";
import type { VideoSpec } from "./video-spec";
import { transitionMs } from "./video/stage";
import { worldFor } from "./video/world";

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Frames                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type FrameProbe = { tMs: number; luma: number; std: number; /** mean absolute change vs the previous probe, 0..1 */ diff: number; /** share of near-white pixels */ bright: number };

type Probeable = CanvasImageSource;
export class Prober {
  private readonly c: OffscreenCanvas | HTMLCanvasElement; private readonly x: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private prev: Uint8Array | null = null;
  readonly probes: FrameProbe[] = [];
  constructor(private readonly w = 96, private readonly h = 54) {
    this.c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const x = this.c.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!x) throw new Error("Canvas 2D is unavailable.");
    this.x = x;
  }
  sample(src: Probeable, tMs: number): FrameProbe {
    (this.x as CanvasRenderingContext2D).drawImage(src, 0, 0, this.w, this.h);
    const d = (this.x as CanvasRenderingContext2D).getImageData(0, 0, this.w, this.h).data, n = this.w * this.h, y = new Uint8Array(n);
    let sum = 0, bright = 0;
    for (let i = 0; i < n; i++) { const l = Math.round(0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!); y[i] = l; sum += l; if (l > 235) bright++; }
    const mean = sum / n;
    let v = 0, diff = 0;
    for (let i = 0; i < n; i++) { v += (y[i]! - mean) ** 2; if (this.prev) diff += Math.abs(y[i]! - this.prev[i]!); }
    const p: FrameProbe = { tMs, luma: mean, std: Math.sqrt(v / n), diff: this.prev ? diff / n / 255 : 0, bright: bright / n };
    this.prev = y; this.probes.push(p);
    return p;
  }
}

export type VideoQa = {
  frames: number; probes: number; blank: number; frozenRuns: number; frozenMs: number;
  /** average change per probe step, % of full scale */
  motionPct: number; hookOk: boolean; brightPct: number; minLuma: number; maxLuma: number;
  scenes: { index: number; motionPct: number; animated: boolean; luma: number; std: number }[];
};

export function summarizeProbes(probes: FrameProbe[], spec: VideoSpec, frames: number): VideoQa {
  const ps = probes.filter((p) => p.tMs > 0);
  /* a dip-to-black or a flash is designed to be near-blank at its midpoint: those moments are not defects */
  const intentional: [number, number][] = [];
  spec.scenes.forEach((s, i) => { const k = i === 0 ? "cut" : (s.transition ?? "cut"); if (k === "dip" || k === "flash") { const d = transitionMs(k); intentional.push([s.startMs - d / 2, s.startMs + d / 2]); } });
  const designed = (t: number): boolean => intentional.some(([a, b]) => t >= a && t <= b);
  let blank = 0, run = 0, frozenRuns = 0, frozenMs = 0, last = 0;
  for (const p of ps) {
    if (p.std < 2.2 && (p.luma < 5 || p.luma > 250) && !designed(p.tMs)) blank++;
    if (p.diff < 0.0004) { run += p.tMs - last; } else { if (run > 1200) { frozenRuns++; frozenMs += run; } run = 0; }
    last = p.tMs;
  }
  if (run > 1200) { frozenRuns++; frozenMs += run; }
  const scenes = spec.scenes.map((s, index) => {
    const own = ps.filter((p) => p.tMs >= s.startMs + 700 && p.tMs < s.endMs - 100);
    const motion = own.length ? own.reduce((a, p) => a + p.diff, 0) / own.length : 0;
    return { index, motionPct: Math.round(motion * 1000) / 10, animated: motion > 0.0009, luma: own.length ? Math.round(own.reduce((a, p) => a + p.luma, 0) / own.length) : 0, std: own.length ? Math.round((own.reduce((a, p) => a + p.std, 0) / own.length) * 10) / 10 : 0 };
  });
  const hook = ps.find((p) => p.tMs >= 1000) ?? ps[ps.length - 1];
  const lumas = ps.map((p) => p.luma);
  return {
    frames, probes: ps.length, blank, frozenRuns, frozenMs: Math.round(frozenMs),
    motionPct: ps.length ? Math.round((ps.reduce((a, p) => a + p.diff, 0) / ps.length) * 1000) / 10 : 0,
    hookOk: !!hook && hook.std > 8, brightPct: ps.length ? Math.round((ps.reduce((a, p) => a + p.bright, 0) / ps.length) * 1000) / 10 : 0,
    minLuma: lumas.length ? Math.round(Math.min(...lumas)) : 0, maxLuma: lumas.length ? Math.round(Math.max(...lumas)) : 0, scenes,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Audio                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export type AudioQa = { cuts: number; accented: number; liftsDb: number[]; silencePct: number; crestDb: number };

/**
 * Measures, in the FINAL mix, whether each cut has an audible accent: the loudest 40 ms around the cut (hits peak ON it,
 * whooshes and swells build up to it) against the surrounding bed on both sides. A cut with no sound design stays flat.
 */
export function audioQa(l: Float32Array, r: Float32Array, sr: number, spec: VideoSpec, lufs: number, peakDb: number): AudioQa {
  const energyAt = (t0: number, t1: number): number => {
    const a = Math.max(0, Math.round((t0 / 1000) * sr)), b = Math.min(l.length, Math.round((t1 / 1000) * sr));
    let e = 0;
    for (let i = a; i < b; i++) { const m = (l[i]! + r[i]!) * 0.5; e += m * m; }
    return e / Math.max(1, b - a);
  };
  const lifts: number[] = [];
  for (let i = 1; i < spec.scenes.length; i++) {
    const b = spec.scenes[i]!.startMs;
    let peak = 0;
    for (let t = b - 140; t <= b + 140; t += 20) peak = Math.max(peak, energyAt(t, t + 40));
    const bed = (energyAt(b - 1200, b - 520) + energyAt(b + 520, b + 1200)) / 2 || 1e-9;
    lifts.push(Math.round(10 * Math.log10(Math.max(peak, 1e-12) / bed) * 10) / 10);
  }
  let quiet = 0, wins = 0;
  const step = Math.round(sr * 0.1);
  for (let i = 0; i + step <= l.length; i += step) { let e = 0; for (let j = i; j < i + step; j += 4) { const m = (l[j]! + r[j]!) * 0.5; e += m * m; } wins++; if (10 * Math.log10(e / (step / 4) + 1e-12) < -58) quiet++; }
  return { cuts: lifts.length, accented: lifts.filter((x) => x >= 2.5).length, liftsDb: lifts, silencePct: wins ? Math.round((quiet / wins) * 1000) / 10 : 0, crestDb: Math.round((peakDb - lufs) * 10) / 10 };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Report                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ReportCheck = { label: string; value: string; ok: boolean; /** worth knowing, not a failure */ note?: boolean };
export type VideoReport = { score: number; headline: string; checks: ReportCheck[] };
export type EncodeInfo = { width: number; height: number; fps: number; codec: string; ext: string; bytes: number; hasAudio: boolean; encoder: "webcodecs" | "mediarecorder" };

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const sgn = (n: number): string => (n > 0 ? "+" : "") + n;

export function videoReport(spec: VideoSpec, lint: LintResult, qa: VideoQa | null, audio: AudioReport | null, aqa: AudioQa | null, enc: EncodeInfo | null): VideoReport {
  const checks: ReportCheck[] = [];
  const st = lint.stats, kinds = new Set(spec.scenes.map((s) => s.layout)), trans = new Set(spec.scenes.slice(1).map((s) => s.transition ?? "cut"));
  const fell = spec.source === "fallback";
  checks.push({ label: "Director", value: fell ? "studio template (the AI director was unavailable)" : `AI-directed from a treatment, pre-flight ${lint.score}/100${lint.fixes.length ? `, ${lint.fixes.length} auto-fixes` : ""}`, ok: !fell && lint.score >= 80, note: fell });
  checks.push({ label: "Storyboard", value: `${spec.scenes.length} scenes · ${kinds.size} layouts · ${trans.size} transition styles · ${mmss(spec.durationSec)}`, ok: spec.scenes.length >= 5 && kinds.size >= 4 });
  const world = worldFor(spec);
  checks.push({ label: "Plan", value: spec.plan?.keyMessage ? `${spec.plan.keyMessage}${spec.plan.metaphor ? ` · metaphor: ${spec.plan.metaphor}` : ""}` : "no written treatment (the storyboard was built directly)", ok: true, note: !spec.plan?.keyMessage });
  checks.push({ label: "Research", value: spec.research?.length ? `${spec.research.length} verified fact${spec.research.length === 1 ? "" : "s"} shaped the film` : "no public information found, so the film is built from the request alone", ok: true, note: !spec.research?.length });
  checks.push({ label: "Length", value: `${mmss(spec.durationSec)} (films run 20-45 seconds)`, ok: spec.durationSec >= 20 && spec.durationSec <= 45 });
  checks.push({ label: "Background", value: `${world.name}, unique to this film${qa ? `; every scene animates over it` : ""}`, ok: !qa || qa.scenes.every((x) => x.animated && x.std >= 4) });
  if (spec.brand) {
    const li = spec.scenes.findIndex((x) => x.layout === "logo"), ls = qa && li >= 0 ? qa.scenes[li] : undefined;
    checks.push({ label: "Brand", value: li >= 0 ? `${spec.brand.name} logo reveal on screen (scene ${li + 1})` : `${spec.brand.name} lockup on the closing scene`, ok: li < 0 || !ls || ls.std >= 8 });
  }
  checks.push({ label: "Pacing", value: `${st.cutsOnBeat}/${st.cuts} cuts on the ${spec.audio.bpm} BPM grid${audio && audio.score.beatConfidence >= 2.6 ? ` (beat measured in the score, +${audio.score.beatOffsetMs} ms)` : ""}`, ok: st.cuts === 0 || st.cutsOnBeat === st.cuts });
  checks.push({ label: "Readability", value: `smallest text ${st.minTextSize}% of frame height · contrast ≥ ${st.minContrast}:1 · ${st.overlaps} overlaps in ${st.textBoxes} text boxes`, ok: st.minTextSize >= 2.3 && st.minContrast >= 4.5 && st.overlaps === 0 });
  if (qa) {
    checks.push({ label: "Frames", value: `${qa.frames} rendered · ${qa.blank} blank · ${qa.frozenRuns} frozen stretches · brightness ${qa.minLuma}-${qa.maxLuma}/255`, ok: qa.blank === 0 && qa.frozenRuns === 0 });
    const still = qa.scenes.filter((s) => !s.animated).length;
    checks.push({ label: "Motion", value: `${qa.motionPct}% average change per step · ${still === 0 ? "every scene animates" : `${still} scene(s) barely move`} · hook ${qa.hookOk ? "lands in the first second" : "is weak"}`, ok: still === 0 && qa.hookOk });
  }
  if (audio) {
    const v = audio.voice;
    if (v.requested) checks.push({ label: "Narration", value: `${v.recorded}/${v.requested} lines recorded${audio.mix.narrationOverMusicDb !== null ? ` · voice ${sgn(audio.mix.narrationOverMusicDb)} dB over the music in the speech band` : ""}`, ok: v.recorded === v.requested && (audio.mix.narrationOverMusicDb ?? 99) >= 8, note: v.recorded < v.requested });
    else checks.push({ label: "Narration", value: "none requested (music and sound design only)", ok: true, note: true });
    if (aqa) checks.push({ label: "Sound design", value: `${audio.sfx.events} hits, whooshes and risers · ${aqa.accented}/${aqa.cuts} cuts audibly accented in the final mix`, ok: !spec.audio.sfx || aqa.cuts === 0 || aqa.accented >= Math.ceil(aqa.cuts * 0.8) });
    checks.push({ label: "Score", value: audio.score.ok ? `${audio.score.genre} · ${audio.score.bpm} BPM · ${spec.audio.key}` : "score could not be rendered (film is silent apart from effects)", ok: audio.score.ok });
    checks.push({ label: "Loudness", value: `${audio.mix.lufs} LUFS · peak ${audio.mix.peakDb} dBFS · ${audio.mix.clipped} clipped samples${aqa ? ` · ${aqa.silencePct}% silence` : ""}`, ok: Math.abs(audio.mix.lufs + 14) <= 1.6 && audio.mix.clipped === 0 && audio.mix.peakDb <= -0.8 });
  }
  if (spec.captions && audio) checks.push({ label: "Captions", value: `${audio.voice.recorded} narration lines burned in, word by word`, ok: audio.voice.recorded > 0 });
  if (enc) checks.push({ label: "Encode", value: `${enc.width}×${enc.height} @ ${enc.fps} fps · ${enc.codec} · ${(enc.bytes / 1e6).toFixed(1)} MB${enc.hasAudio ? "" : " · no audio track"}${enc.encoder === "mediarecorder" ? " · real-time capture (this browser has no WebCodecs)" : ""}`, ok: enc.hasAudio && enc.encoder === "webcodecs", note: !enc.hasAudio || enc.encoder === "mediarecorder" });
  const failed = checks.filter((c) => !c.ok && !c.note).length, notes = checks.filter((c) => !c.ok && c.note).length;
  const score = Math.max(0, Math.round(100 - failed * 9 - notes * 3));
  const headline = failed === 0 ? (notes ? `Premium cut with ${notes} note${notes > 1 ? "s" : ""}` : "Premium cut: every check passed") : `Needs a look: ${failed} check${failed > 1 ? "s" : ""} flagged`;
  return { score, headline, checks };
}
