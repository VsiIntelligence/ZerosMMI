/**
 * Sound design for Zeros films: impacts, whooshes, risers, glitches and sparkles, all synthesised procedurally (no samples,
 * no network) and scheduled from the COMPILED ELEMENTS, so every hit lands exactly when the matching thing appears on screen.
 */
import { Rng, TAU, clamp, dbToGain, mkStereo, type Stereo } from "./zeros-music/dsp";
import { approxMeasure, compileScene, motionOf } from "./video/layouts";
import type { TextEl, Transition, VideoElement, VideoSpec } from "./video/types";

export type SfxKind = "impact" | "boom" | "thump" | "whoosh-up" | "whoosh-down" | "riser" | "tick" | "pop" | "shimmer" | "glitch" | "swell";
export type SfxWhy = "open" | "cut" | "slam" | "reveal" | "stat" | "close";
export type SfxEvent = { /** start of the sample, ms */ tMs: number; /** the moment the ear hears as "the hit", ms */ peakMs: number; kind: SfxKind; gainDb: number; durMs: number; why: SfxWhy; scene: number };

/** Length of each sound and where inside it the accent falls (0 = at the start, 1 = at the very end). */
const SHAPE: Record<SfxKind, { durMs: number; peak: number; priority: number }> = {
  impact: { durMs: 1500, peak: 0, priority: 9 }, boom: { durMs: 2600, peak: 0, priority: 10 }, thump: { durMs: 520, peak: 0, priority: 7 },
  "whoosh-up": { durMs: 780, peak: 0.56, priority: 6 }, "whoosh-down": { durMs: 780, peak: 0.44, priority: 6 }, riser: { durMs: 1500, peak: 1, priority: 8 },
  tick: { durMs: 60, peak: 0, priority: 1 }, pop: { durMs: 220, peak: 0, priority: 3 }, shimmer: { durMs: 1100, peak: 0, priority: 4 },
  glitch: { durMs: 260, peak: 0.3, priority: 5 }, swell: { durMs: 1300, peak: 0.72, priority: 4 },
};
const make = (kind: SfxKind, peakMs: number, gainDb: number, why: SfxWhy, scene: number, durMs?: number): SfxEvent => {
  const sh = SHAPE[kind], d = durMs ?? sh.durMs;
  return { tMs: Math.round(peakMs - sh.peak * d), peakMs: Math.round(peakMs), kind, gainDb, durMs: d, why, scene };
};

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Planner                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export function planSfx(spec: VideoSpec): SfxEvent[] {
  const ev: SfxEvent[] = [], sc = spec.scenes, total = spec.durationSec * 1000;
  ev.push(make("thump", 0, -8, "open", 0), make("shimmer", 140, -19, "open", 0));
  for (let i = 1; i < sc.length; i++) {
    const kind: Transition = sc[i]!.transition ?? "cut", b = sc[i]!.startMs, m = motionOf(sc[i]!, i), strong = m === "explosive";
    switch (kind) {
      case "cut": ev.push(make(strong ? "impact" : "thump", b, strong ? -7 : -7, "cut", i)); break;
      case "flash": ev.push(make("riser", b, -17, "cut", i, 1100), make(strong ? "boom" : "impact", b, strong ? -6 : -8, "cut", i)); break;
      case "glitch": ev.push(make("glitch", b, -12, "cut", i), make("thump", b + 20, -8, "cut", i)); break;
      case "wipe": ev.push(make("whoosh-up", b, -14, "cut", i)); break;
      case "push": ev.push(make("whoosh-up", b, -13, "cut", i), make("thump", b + 20, -9, "cut", i)); break;
      case "zoom": ev.push(make("whoosh-down", b, -14, "cut", i), make("thump", b, -9, "cut", i)); break;
      case "iris": ev.push(make("whoosh-down", b, -15, "cut", i), make("shimmer", b + 160, -20, "cut", i)); break;
      case "fade": case "dip": ev.push(make("swell", b, -19, "cut", i)); break;
    }
    /* every cut gets a transient, so the change of picture is also heard (cut sounds are never thinned away below) */
    if (!ev.some((e) => e.why === "cut" && e.scene === i && (e.kind === "impact" || e.kind === "boom" || e.kind === "thump" || e.kind === "glitch"))) ev.push(make("pop", b, -6, "cut", i));
  }
  /* cues straight from the compiled elements: slams, pops, stat reveals */
  sc.forEach((s, i) => {
    let els: VideoElement[];
    try { els = compileScene({ spec, index: i, scene: s, startMs: s.startMs, durMs: s.endMs - s.startMs, W: spec.width, H: spec.height, measure: approxMeasure, beatMs: 60000 / spec.audio.bpm, inKind: s.transition, outKind: sc[i + 1]?.transition, isLast: i === sc.length - 1 }); } catch { return; }
    let pops = 0, statDone = false;
    for (const el of els) {
      const a = (el as { anim?: { in?: string; delay?: number; dur?: number } }).anim, at = s.startMs + (a?.delay ?? 0);
      if (!a || at > total - 400) continue;
      if (el.type === "text" && a.in === "slam") ev.push(make("thump", at, -12, "slam", i));
      else if (el.type === "stat" && !statDone) { statDone = true; ev.push(make("shimmer", at + Math.max(900, (a.dur ?? 700) * 1.8) * 0.85, -21, "stat", i)); }
      else if ((el.type === "card" || el.type === "icon" || (el.type === "shape" && (el.shape === "circle") && a.in === "pop")) && (a.in === "pop") && pops < 4) { pops++; ev.push(make("pop", at, -23, "reveal", i)); }
      else if (el.type === "text" && (a.in === "typewriter") && pops < 4) { pops++; ev.push(make("tick", at, -26, "reveal", i)); }
    }
  });
  /* a logo reveal gets a sonic sting on the mark */
  sc.forEach((s, i) => { if (s.layout === "logo") ev.push(make("impact", s.startMs + 280, -9, "slam", i)); });
  const last = sc[sc.length - 1];
  if (last) ev.push(make("shimmer", last.startMs + 1900, -19, "close", sc.length - 1));
  /* thin out: a quieter sound within 90 ms of a stronger one is just clutter */
  ev.sort((a, b) => a.peakMs - b.peakMs);
  const kept: SfxEvent[] = [];
  for (const e of ev) {
    const clash = e.why !== "cut" && kept.find((k) => Math.abs(k.peakMs - e.peakMs) < 90 && SHAPE[k.kind].priority >= SHAPE[e.kind].priority && k.kind !== e.kind && SHAPE[e.kind].priority <= 3);
    if (!clash && e.tMs < total) kept.push(e);
  }
  return kept.slice(0, 120);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Synthesis                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Chamberlin state-variable band-pass over noise with a moving centre frequency: the engine of whooshes and risers. */
function sweptNoise(len: number, sr: number, rng: Rng, f0: number, f1: number, q: number): Float32Array {
  const out = new Float32Array(len);
  let low = 0, band = 0;
  const qq = 1 / q;
  for (let i = 0; i < len; i++) {
    const t = i / len, fc = Math.min(f0 * Math.pow(f1 / f0, t), sr / 6.5), f = 2 * Math.sin((Math.PI * fc) / sr);
    const x = rng.next() * 2 - 1, high = x - low - qq * band;
    band += f * high; low += f * band;
    out[i] = band;
  }
  return out;
}
function lowpassNoise(len: number, sr: number, rng: Rng, fc: number): Float32Array {
  const out = new Float32Array(len), a = 1 - Math.exp((-TAU * fc) / sr);
  let y = 0, y2 = 0;
  for (let i = 0; i < len; i++) { y += a * ((rng.next() * 2 - 1) - y); y2 += a * (y - y2); out[i] = y2 * 2.2; }
  return out;
}
const peakOf = (a: Float32Array): number => { let m = 0; for (const v of a) { const x = Math.abs(v); if (x > m) m = x; } return m || 1; };

type Voice = { l: Float32Array; r: Float32Array };
const mono = (a: Float32Array, pan = 0): Voice => {
  const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4), l = new Float32Array(a.length), r = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) { l[i] = a[i]! * gl; r[i] = a[i]! * gr; }
  return { l, r };
};

function synth(kind: SfxKind, durMs: number, sr: number, rng: Rng): Voice {
  const n = Math.max(32, Math.round((durMs / 1000) * sr));
  const sine = (f: (t: number) => number, amp: (t: number) => number): Float32Array => { const o = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const t = i / sr; ph += (TAU * f(t)) / sr; o[i] = Math.sin(ph) * amp(t); } return o; };
  const add = (a: Float32Array, b: Float32Array, g = 1): void => { for (let i = 0; i < a.length; i++) a[i]! += (b[i] ?? 0) * g; };
  switch (kind) {
    case "impact": case "boom": {
      const tail = kind === "boom" ? 0.95 : 0.42, o = sine((t) => 46 + 130 * Math.exp(-t / 0.07), (t) => Math.exp(-t / tail));
      const burst = lowpassNoise(n, sr, rng, 2600); for (let i = 0; i < n; i++) burst[i]! *= Math.exp(-(i / sr) / 0.05) * 0.55;
      const rumble = lowpassNoise(n, sr, rng, 170); for (let i = 0; i < n; i++) rumble[i]! *= Math.exp(-(i / sr) / (tail * 1.4)) * 0.4;
      const sub = sine(() => (kind === "boom" ? 38 : 52), (t) => Math.exp(-t / (tail * 1.6)) * 0.5);
      add(o, burst); add(o, rumble); add(o, sub);
      const k = 0.92 / peakOf(o); for (let i = 0; i < n; i++) o[i]! *= k;
      return mono(o);
    }
    case "thump": {
      const o = sine((t) => 52 + 105 * Math.exp(-t / 0.028), (t) => Math.exp(-t / 0.11)), click = lowpassNoise(n, sr, rng, 5200);
      for (let i = 0; i < n; i++) o[i]! += click[i]! * Math.exp(-(i / sr) / 0.006) * 0.5;
      const k = 0.9 / peakOf(o); for (let i = 0; i < n; i++) o[i]! *= k;
      return mono(o);
    }
    case "whoosh-up": case "whoosh-down": {
      const up = kind === "whoosh-up", f0 = up ? 260 : 6200, f1 = up ? 6200 : 260;
      const a = sweptNoise(n, sr, rng, f0, f1, 1.3), b = sweptNoise(n, sr, rng, f0 * 1.07, f1 * 1.07, 1.3), pk = up ? 0.56 : 0.44;
      for (let i = 0; i < n; i++) { const t = i / n, e = Math.pow(Math.sin(Math.PI * Math.pow(t, Math.log(0.5) / Math.log(pk))), 2); a[i]! *= e; b[i]! *= e; }
      const k = 0.85 / Math.max(peakOf(a), peakOf(b));
      const l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) { const pan = (up ? -1 : 1) * Math.cos((i / n) * Math.PI); const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4); l[i] = a[i]! * k * gl * 1.2; r[i] = b[i]! * k * gr * 1.2; }
      return { l, r };
    }
    case "riser": {
      const a = sweptNoise(n, sr, rng, 380, 9000, 1.6), tone = sine((t) => 200 + 1000 * Math.pow(t / (n / sr), 2), () => 1);
      for (let i = 0; i < n; i++) { const t = i / n, e = Math.pow(t, 2.2) * (i > n - Math.round(sr * 0.012) ? Math.max(0, (n - i) / (sr * 0.012)) : 1); a[i]! = a[i]! * e + tone[i]! * e * 0.08; }
      const k = 0.8 / peakOf(a); for (let i = 0; i < n; i++) a[i]! *= k;
      return mono(a);
    }
    case "tick": { const o = sine(() => 2300, (t) => Math.exp(-t / 0.004)); return mono(o.map((v) => v * 0.7)); }
    case "pop": {
      const o = sine((t) => 380 + 520 * (1 - Math.exp(-t / 0.018)), (t) => Math.exp(-t / 0.05)), k = 0.8 / peakOf(o);
      return mono(o.map((v) => v * k));
    }
    case "shimmer": {
      const parts = [2093, 2637, 3136, 3951, 5274], l = new Float32Array(n), r = new Float32Array(n);
      parts.forEach((f, idx) => {
        const start = Math.round(idx * 0.022 * sr), det = 1 + (rng.next() - 0.5) * 0.004, pan = idx % 2 ? 0.6 : -0.6, gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
        let ph = 0;
        for (let i = start; i < n; i++) { const t = (i - start) / sr; ph += (TAU * f * det) / sr; const v = Math.sin(ph) * Math.exp(-t / 0.32) * (1 - Math.exp(-t / 0.004)) * 0.28; l[i]! += v * gl; r[i]! += v * gr; }
      });
      return { l, r };
    }
    case "glitch": {
      const o = new Float32Array(n);
      let hold = 0, val = 0, gate = 1, gateLeft = 0;
      for (let i = 0; i < n; i++) {
        if (hold-- <= 0) { hold = 3 + Math.floor(rng.next() * 40); val = Math.round((rng.next() * 2 - 1) * 12) / 12; }
        if (gateLeft-- <= 0) { gate = rng.next() > 0.35 ? 1 : 0; gateLeft = Math.round(sr * (0.006 + rng.next() * 0.02)); }
        o[i] = val * gate * Math.exp(-(i / n) * 2.2) * 0.5;
      }
      return { l: o, r: o.map((v, i) => v * (i % 2 ? 0.8 : 1)) };
    }
    case "swell": {
      const nz = lowpassNoise(n, sr, rng, 1500), tone = sine(() => 220, () => 1), tone2 = sine(() => 329.6, () => 1);
      for (let i = 0; i < n; i++) { const t = i / n, e = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 2); nz[i]! = (nz[i]! * 0.6 + tone[i]! * 0.12 + tone2[i]! * 0.09) * e; }
      const k = 0.7 / peakOf(nz); for (let i = 0; i < n; i++) nz[i]! *= k;
      return mono(nz);
    }
  }
}

/** Renders every event into one stereo bus (peak-limited at 0.95) and returns the moments of the strongest hits for visual sync. */
export function renderSfx(events: SfxEvent[], totalSamples: number, sr: number, seed: number): { track: Stereo; hitsMs: number[] } {
  const track = mkStereo(totalSamples), rng = new Rng(seed + 4242), hits: number[] = [];
  events.forEach((e, idx) => {
    const v = synth(e.kind, e.durMs, sr, new Rng(seed * 31 + idx * 977 + 11)), g = dbToGain(e.gainDb), start = Math.round((e.tMs / 1000) * sr);
    for (let i = 0; i < v.l.length; i++) { const j = start + i; if (j < 0 || j >= totalSamples) continue; track.l[j]! += v.l[i]! * g; track.r[j]! += v.r[i]! * g; }
    if (SHAPE[e.kind].priority >= 5) hits.push(e.peakMs);
  });
  void rng;
  let pk = 0;
  for (let i = 0; i < totalSamples; i++) { const a = Math.max(Math.abs(track.l[i]!), Math.abs(track.r[i]!)); if (a > pk) pk = a; }
  if (pk > 0.95) { const k = 0.95 / pk; for (let i = 0; i < totalSamples; i++) { track.l[i]! *= k; track.r[i]! *= k; } }
  hits.sort((a, b) => a - b);
  return { track, hitsMs: hits };
}

export const _clamp = clamp;
export type { TextEl };
