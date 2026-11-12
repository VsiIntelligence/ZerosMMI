import { Biquad, Rng, TAU, clamp, mtof, polyBlep, type Stereo, mixMono } from "./dsp";

/* ------------------------------------------------------------ phoneme data */
type F3 = [number, number, number];
type Kind = "v" | "d" | "n" | "l" | "f" | "s" | "a";
export type PhDef = { k: Kind; voiced: boolean; f?: F3; f2?: F3; nz?: [number, number, number]; place?: "b" | "a" | "v"; len: number; lp?: number };

const V = (f: F3, len = 0.2): PhDef => ({ k: "v", voiced: true, f, len });
const D = (f: F3, f2: F3, len = 0.22): PhDef => ({ k: "d", voiced: true, f, f2, len });
export const PHONEMES: Record<string, PhDef> = {
  IY: V([270, 2290, 3010]), IH: V([390, 1990, 2550]), EH: V([530, 1840, 2480]), AE: V([660, 1720, 2410]), AA: V([730, 1090, 2440]), AO: V([570, 840, 2410]),
  UH: V([440, 1020, 2240]), UW: V([300, 870, 2240]), AH: V([640, 1190, 2390]), AX: V([500, 1500, 2500], 0.12), ER: V([490, 1350, 1690]),
  AY: D([730, 1090, 2440], [330, 2150, 2950]), EY: D([530, 1840, 2480], [320, 2150, 2900]), OW: D([520, 900, 2380], [340, 850, 2250]), AW: D([730, 1090, 2440], [330, 880, 2240]), OY: D([570, 840, 2410], [320, 2150, 2900]),
  L: { k: "l", voiced: true, f: [370, 1250, 2800], len: 0.065 }, R: { k: "l", voiced: true, f: [420, 1250, 1650], len: 0.07 }, W: { k: "l", voiced: true, f: [300, 700, 2200], len: 0.06 }, Y: { k: "l", voiced: true, f: [270, 2250, 3000], len: 0.055 },
  M: { k: "n", voiced: true, f: [260, 1150, 2200], len: 0.075, lp: 900, place: "b" }, N: { k: "n", voiced: true, f: [260, 1650, 2600], len: 0.07, lp: 1000, place: "a" }, NG: { k: "n", voiced: true, f: [260, 2000, 2700], len: 0.075, lp: 1000, place: "v" },
  S: { k: "f", voiced: false, nz: [7200, 1.3, 0.095], len: 0.095 }, SH: { k: "f", voiced: false, nz: [3800, 1.2, 0.1], len: 0.1 }, F: { k: "f", voiced: false, nz: [5600, 0.45, 0.032], len: 0.075 },
  TH: { k: "f", voiced: false, nz: [6000, 0.45, 0.024], len: 0.08 }, HH: { k: "f", voiced: false, nz: [0, 0, 0.05], len: 0.06 },
  Z: { k: "f", voiced: true, nz: [6800, 1.3, 0.05], len: 0.08 }, ZH: { k: "f", voiced: true, nz: [3400, 1.2, 0.05], len: 0.085 }, V: { k: "f", voiced: true, nz: [5400, 0.45, 0.02], len: 0.065 }, DH: { k: "f", voiced: true, nz: [5800, 0.45, 0.015], len: 0.055 },
  P: { k: "s", voiced: false, nz: [1300, 0.6, 0.12], place: "b", len: 0.07 }, T: { k: "s", voiced: false, nz: [4900, 1.1, 0.13], place: "a", len: 0.065 }, K: { k: "s", voiced: false, nz: [2100, 1.0, 0.12], place: "v", len: 0.075 },
  B: { k: "s", voiced: true, nz: [1000, 0.6, 0.06], place: "b", len: 0.055 }, D: { k: "s", voiced: true, nz: [3900, 1.0, 0.07], place: "a", len: 0.05 }, G: { k: "s", voiced: true, nz: [1900, 1.0, 0.065], place: "v", len: 0.06 },
  CH: { k: "a", voiced: false, nz: [3900, 1.2, 0.11], place: "a", len: 0.1 }, JH: { k: "a", voiced: true, nz: [3500, 1.2, 0.07], place: "a", len: 0.1 },
};

export type VoiceType = { name: string; fScale: [number, number, number, number]; tilt: number; breath: number; vibDepth: number };
export const VOICES: Record<string, VoiceType> = {
  male: { name: "male", fScale: [1, 1, 1, 1], tilt: 3200, breath: 0.03, vibDepth: 28 },
  female: { name: "female", fScale: [1.17, 1.13, 1.1, 1.08], tilt: 3800, breath: 0.04, vibDepth: 32 },
  soprano: { name: "soprano", fScale: [1.24, 1.18, 1.12, 1.1], tilt: 4200, breath: 0.035, vibDepth: 36 },
};

export type Syllable = { onset: string[]; nucleus: string; coda: string[]; stress: number };
export type SungNote = {
  t: number; dur: number; midi: number; vel: number; syl: Syllable;
  prevMidi?: number; vowelEnd?: number; onsetStart?: number; vib?: number; breath?: number; scoop?: boolean; legato?: boolean;
};

/* ------------------------------------------------------- resonator toolkit */
class Reso {
  a = 1; b = 0; c = 0; y1 = 0; y2 = 0;
  set(f: number, bw: number, sr: number): void {
    const T = 1 / sr, r = Math.exp(-Math.PI * bw * T);
    this.c = -r * r; this.b = 2 * r * Math.cos(TAU * f * T); this.a = 1 - this.b - this.c;
  }
  tick(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1; this.y1 = y; return y;
  }
}

/** RMS of the glottal source shaped by 4 formants at fundamental f0 (analytic, used to level vowels). */
function formantRms(fm: number[], bw: number[], f0: number, tilt: number, sr: number): number {
  let sum = 0;
  for (let h = 1; h * f0 < 6500; h++) {
    const f = h * f0, w = (TAU * f) / sr;
    let mag = 1 / h / Math.sqrt(1 + (f / tilt) ** 2);
    for (let k = 0; k < 4; k++) {
      const r = Math.exp(-Math.PI * bw[k]! / sr), c = -r * r, b = 2 * r * Math.cos((TAU * fm[k]!) / sr), a = 1 - b - c;
      const re = 1 - b * Math.cos(w) - c * Math.cos(2 * w), im = b * Math.sin(w) + c * Math.sin(2 * w);
      mag *= a / Math.hypot(re, im);
    }
    sum += mag * mag;
  }
  return Math.sqrt(sum / 2);
}

type Frame = { f: [number, number, number, number]; bw: [number, number, number, number]; va: number; na: number; fc: number; q: number; nth: number; lp: number };
type Seg = { t0: number; t1: number; p: Frame; glide: number };

const smooth = (x: number): number => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
function blend(a: Frame, b: Frame, x: number): Frame {
  const s = smooth(x), m = (u: number, v: number) => u + (v - u) * s;
  return {
    f: [m(a.f[0], b.f[0]), m(a.f[1], b.f[1]), m(a.f[2], b.f[2]), m(a.f[3], b.f[3])], bw: [m(a.bw[0], b.bw[0]), m(a.bw[1], b.bw[1]), m(a.bw[2], b.bw[2]), m(a.bw[3], b.bw[3])],
    va: m(a.va, b.va), na: m(a.na, b.na), fc: m(a.fc || b.fc, b.fc || a.fc), q: m(a.q || b.q, b.q || a.q), nth: m(a.nth, b.nth), lp: m(a.lp, b.lp),
  };
}

function frameAt(segs: Seg[], t: number): Frame {
  let i = 0;
  while (i < segs.length - 1 && t >= segs[i]!.t1) i++;
  const s = segs[i]!;
  // blend into next/prev near boundaries
  const nxt = segs[i + 1], prv = segs[i - 1];
  if (nxt) {
    const h = Math.min(nxt.glide, (s.t1 - s.t0) * 0.5, (nxt.t1 - nxt.t0) * 0.5 + 0.004);
    if (t > s.t1 - h) return blend(s.p, nxt.p, 0.5 * (t - (s.t1 - h)) / h);
  }
  if (prv) {
    const h = Math.min(s.glide, (s.t1 - s.t0) * 0.5, (prv.t1 - prv.t0) * 0.5 + 0.004);
    if (t < s.t0 + h) return blend(prv.p, s.p, 0.5 + 0.5 * (t - s.t0) / h);
  }
  return s.p;
}

const BW0: [number, number, number, number] = [75, 105, 150, 210];

/* ---------------------------------------------------------- syllable synth */
export function synthSyllable(
  out: Float32Array, n: SungNote, voice: VoiceType, sr: number, rng: Rng, opts: { detuneCents?: number; breathAdd?: number } = {},
): void {
  const syl = n.syl, nuc = PHONEMES[syl.nucleus] ?? PHONEMES["AH"]!;
  const sc = (f: F3): [number, number, number, number] => [f[0] * voice.fScale[0], f[1] * voice.fScale[1], f[2] * voice.fScale[2], 3300 * voice.fScale[3]];
  const T0 = n.t, vEnd = n.vowelEnd ?? n.t + n.dur * 0.82;
  const onset = syl.onset.map((p) => PHONEMES[p]).filter((p): p is PhDef => !!p), coda = syl.coda.map((p) => PHONEMES[p]).filter((p): p is PhDef => !!p);
  const nucF = sc(nuc.f!);
  const f0Nom = mtof(n.midi + (opts.detuneCents ?? 0) / 100);
  // singers tune F1 up toward high fundamentals
  if (f0Nom > nucF[0] * 0.82) nucF[0] = nucF[0] + (Math.min(f0Nom * 1.04, 1100) - nucF[0]) * 0.78;

  const phFrame = (p: PhDef, vowelF: [number, number, number, number], kind: "closure" | "burst" | "asp" | "main"): Frame => {
    const base: Frame = { f: [...vowelF] as Frame["f"], bw: [...BW0] as Frame["bw"], va: 0, na: 0, fc: 0, q: 1, nth: 0, lp: 22000 };
    if (p.k === "l" || p.k === "n") {
      base.f = sc(p.f!); base.va = p.k === "n" ? 0.62 : 0.8; base.lp = p.lp ?? 22000;
      if (p.k === "n") base.bw = [90, 180, 260, 300];
    } else if (p.k === "f") {
      base.va = p.voiced ? 0.32 : 0; base.na = p.nz![2]; base.fc = p.nz![0]; base.q = p.nz![1];
      if (p.nz![0] === 0) { base.nth = 1; base.na = p.nz![2]; } // HH: noise through the vowel's formants
    } else if (p.k === "s" || p.k === "a") {
      if (kind === "closure") base.va = p.voiced ? 0.2 : 0, base.lp = 500;
      else if (kind === "burst") { base.na = p.nz![2]; base.fc = p.nz![0]; base.q = p.nz![1]; base.va = p.voiced ? 0.2 : 0; }
      else if (kind === "asp") { base.na = 0.06; base.nth = 1; base.va = 0.15; }
      else { base.na = p.nz![2]; base.fc = p.nz![0]; base.q = p.nz![1]; }
    } else { base.va = 1; }
    return base;
  };

  const segs: Seg[] = [];
  // onset chain ends at T0
  const pre: { p: PhDef; dur: number; kind: "closure" | "burst" | "asp" | "main" }[] = [];
  const consDur = (p: PhDef, scale: number): { d: number; kind: "closure" | "burst" | "asp" | "main" }[] => {
    if (p.k === "s") return p.voiced ? [{ d: 0.032 * scale, kind: "closure" }, { d: 0.012, kind: "burst" }] : [{ d: 0.034 * scale, kind: "closure" }, { d: 0.012, kind: "burst" }, { d: 0.026 * scale, kind: "asp" }];
    if (p.k === "a") return [{ d: 0.03 * scale, kind: "closure" }, { d: p.len * scale, kind: "main" }];
    return [{ d: p.len * scale, kind: "main" }];
  };
  const room = Math.min(0.2, Math.max(0.05, n.t - (n.onsetStart ?? n.t - 0.18)));
  let onsetTotal = 0;
  const onsetSegs = onset.map((p) => consDur(p, 1));
  for (const arr of onsetSegs) for (const x of arr) onsetTotal += x.d;
  const oScale = onsetTotal > room ? room / onsetTotal : 1;
  onset.forEach((p, i) => { for (const x of onsetSegs[i]!) pre.push({ p, dur: x.d * oScale, kind: x.kind }); });
  let cursor = T0 - pre.reduce((a, b) => a + b.dur, 0);
  const tStart = cursor;
  for (const x of pre) { segs.push({ t0: cursor, t1: cursor + x.dur, p: phFrame(x.p, nucF, x.kind), glide: 0.016 }); cursor += x.dur; }
  // nucleus
  const nDur = Math.max(0.05, vEnd - T0);
  const nucFrame = phFrame(nuc, nucF, "main");
  if (nuc.k === "d") {
    const f2 = sc(nuc.f2!), fr2: Frame = { ...nucFrame, f: f2 };
    const cut = T0 + nDur * 0.6;
    segs.push({ t0: T0, t1: cut, p: nucFrame, glide: 0.03 }, { t0: cut, t1: vEnd, p: fr2, glide: Math.min(0.12, nDur * 0.3) });
  } else segs.push({ t0: T0, t1: vEnd, p: nucFrame, glide: 0.035 });
  const lastVowelF = nuc.k === "d" ? sc(nuc.f2!) : nucF;
  cursor = vEnd;
  coda.forEach((p) => { for (const x of consDur(p, 0.9)) { segs.push({ t0: cursor, t1: cursor + x.d, p: phFrame(p, lastVowelF as [number, number, number, number], x.kind), glide: 0.018 }); cursor += x.d; } });
  const tEnd = cursor;
  // fade in/out padding so the syllable starts and stops cleanly
  const first = segs[0]!, last = segs[segs.length - 1]!;
  const padIn = 0.012, padOut = 0.03;
  segs.unshift({ t0: first.t0 - padIn, t1: first.t0, p: { ...first.p, va: 0, na: 0 }, glide: 0.01 });
  segs.push({ t0: last.t1, t1: last.t1 + padOut, p: { ...last.p, va: 0, na: 0 }, glide: padOut });

  const s0 = Math.max(0, Math.floor((tStart - padIn) * sr)), s1 = Math.min(out.length, Math.ceil((tEnd + padOut) * sr));
  if (s1 <= s0) return;
  const R = [new Reso(), new Reso(), new Reso(), new Reso(), new Reso()];
  const lpO = new Biquad("lp", 22000, 0.7, 0, sr), tilt = new Biquad("lp", voice.tilt, 0.6, 0, sr), noiseBp = new Biquad("bp", 5000, 1, 0, sr), noiseHp = new Biquad("hp", 600, 0.7, 0, sr);
  const vibRate = 5.2 + rng.next() * 0.9, vibPh = rng.next() * TAU, driftPh = rng.next() * TAU;
  const vibDepth = (n.vib ?? 1) * voice.vibDepth;
  const breathBase = (n.breath ?? 1) * voice.breath + (opts.breathAdd ?? 0);
  const velAmp = 0.35 + 0.65 * n.vel;
  const nucBw: [number, number, number, number] = nuc.k === "v" || nuc.k === "d" ? [...BW0] : [...BW0];
  const norm = Math.min(40, 0.075 / Math.max(0.01, formantRms([...nucF], [...nucBw], f0Nom, voice.tilt, sr)));
  const airHp = new Biquad("hp", 3600, 0.7, 0, sr);
  const f0Base = mtof(n.midi);
  let phase = rng.next(), jit = 0, shim = 0, pitchRatio = 1, curFrame = frameAt(segs, tStart);
  const CTRL = 24;
  for (let i = s0; i < s1; i++) {
    const t = i / sr;
    const k = i - s0;
    if (k % CTRL === 0) {
      curFrame = frameAt(segs, t);
      for (let r = 0; r < 4; r++) R[r]!.set(curFrame.f[r]!, curFrame.bw[r]!, sr);
      R[4]!.set(4700 * voice.fScale[3], 280, sr);
      lpO.set("lp", clamp(curFrame.lp, 300, 22000), 0.7, 0, sr);
      if (curFrame.fc > 0) noiseBp.set("bp", clamp(curFrame.fc, 500, 17000), Math.max(0.3, curFrame.q), 0, sr);
    }
    // pitch: scoop, glide from previous note, vibrato, jitter
    const tn = t - T0;
    let cents = 0;
    if (n.prevMidi !== undefined && n.legato) cents += (n.prevMidi - n.midi) * 100 * (1 - smooth((tn + 0.035) / 0.085));
    else if (n.scoop) cents += -45 * (1 - smooth((tn + 0.01) / 0.07));
    cents += vibDepth * Math.sin(vibPh + TAU * vibRate * t) * clamp((tn - 0.22) / 0.35, 0, 1);
    cents += 6 * Math.sin(driftPh + TAU * 0.7 * t) + (opts.detuneCents ?? 0);
    if ((k & 63) === 0) { jit = (jit * 0.8 + (rng.next() - 0.5) * 0.0016); shim = shim * 0.9 + (rng.next() - 0.5) * 0.05; }
    if ((k & 7) === 0) pitchRatio = Math.pow(2, cents / 1200);
    const f0 = f0Base * pitchRatio * (1 + jit);
    const dt = f0 / sr;
    phase += dt; if (phase >= 1) phase -= 1;
    const saw = 2 * phase - 1 - polyBlep(phase, dt);
    const src = tilt.process(saw) * (1 + shim);
    const white = rng.next() * 2 - 1;
    const voiced = src * curFrame.va + white * (breathBase + 0.018 * curFrame.va) * (0.4 + 0.6 * Math.abs(saw)) * curFrame.va + white * curFrame.nth * curFrame.na * 2.2;
    let y = voiced;
    for (let r = 0; r < 5; r++) y = R[r]!.tick(y);
    y = lpO.process(y) * norm;
    // un-modelled upper formants / radiation: a little of the raw source above 3.6 kHz keeps the voice from sounding muffled
    y += airHp.process(saw) * 0.012 * curFrame.va * (0.5 + 0.5 * velAmp) * (curFrame.lp > 5000 ? 1 : 0);
    if (curFrame.nth < 1 && curFrame.na > 0 && curFrame.fc > 0) y += noiseBp.process(noiseHp.process(white)) * curFrame.na * (1 - curFrame.nth) * 2.1;
    out[i]! += y * velAmp;
  }
}

/** Soft breath-in before a phrase (very quiet, shaped noise). */
export function synthBreath(out: Float32Array, t: number, dur: number, sr: number, rng: Rng, level = 0.02): void {
  const s0 = Math.floor(t * sr), n = Math.floor(dur * sr), bp = new Biquad("bp", 1800, 0.6, 0, sr);
  for (let i = 0; i < n && s0 + i < out.length; i++) { const x = i / n; out[s0 + i]! += bp.process(rng.next() * 2 - 1) * Math.sin(Math.PI * x) ** 2 * level; }
}

export type VocalPart = { notes: SungNote[]; voice: VoiceType; gain: number; pan: number; detuneCents?: number; delaySec?: number; breathAdd?: number };

/** Renders one vocal part (a sequence of sung notes) and ADDS it into `bus`. Yields to the caller via `tick` between syllables. */
export async function renderVocalPart(part: VocalPart, bus: Stereo, sr: number, rng: Rng, tick?: () => Promise<void>): Promise<void> {
  const mono = new Float32Array(bus.l.length);
  for (const n of part.notes) {
    const d = part.delaySec ?? 0;
    synthSyllable(mono, { ...n, t: n.t + d, ...(n.vowelEnd !== undefined ? { vowelEnd: n.vowelEnd + d } : {}), ...(n.onsetStart !== undefined ? { onsetStart: n.onsetStart + d } : {}) }, part.voice, sr, rng, { detuneCents: part.detuneCents ?? 0, breathAdd: part.breathAdd ?? 0 });
    if (tick) await tick();
  }
  mixMono(bus, mono, 0, part.gain, part.pan);
}
