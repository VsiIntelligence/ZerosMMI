import { Biquad, Rng, TAU, clamp, mixMono, mkStereo, mtof, sawBL, squareBL, softClip, type Stereo } from "./dsp";

export type NoteEv = { t: number; dur: number; midi: number; vel: number; glideFrom?: number; pan?: number };
export type DrumName = "kick" | "kickDeep" | "kickSoft" | "snare" | "snareTight" | "clap" | "rim" | "hatC" | "hatO" | "hatP" | "tomL" | "tomM" | "tomH" | "crash" | "ride" | "shaker" | "conga" | "cowbell";
export type DrumEv = { t: number; drum: DrumName; vel: number; pan?: number };

const expDecay = (t: number, tau: number): number => Math.exp(-t / tau);

/* ------------------------------------------------------------------ drums */
function oneShot(name: DrumName, sr: number): Float32Array {
  const rng = new Rng(name.length * 7919 + name.charCodeAt(0) * 131);
  const len = (sec: number) => Math.max(8, Math.round(sec * sr));
  const noise = () => rng.next() * 2 - 1;
  let out: Float32Array;
  switch (name) {
    case "kick": case "kickDeep": case "kickSoft": {
      const p = name === "kick" ? { f0: 150, f1: 50, tp: 0.016, ta: 0.17, n: 0.4, drive: 1.9 } : name === "kickDeep" ? { f0: 125, f1: 43, tp: 0.03, ta: 0.3, n: 0.55, drive: 1.5 } : { f0: 105, f1: 56, tp: 0.02, ta: 0.2, n: 0.3, drive: 1.2 };
      out = new Float32Array(len(p.n)); let ph = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr, f = p.f1 + (p.f0 - p.f1) * expDecay(t, p.tp);
        ph += (TAU * f) / sr;
        const env = Math.min(1, t / 0.0012) * expDecay(t, p.ta);
        const click = t < 0.004 ? noise() * 0.35 * (1 - t / 0.004) : 0;
        out[i] = softClip(Math.sin(ph) * env + click, p.drive);
      }
      if (name === "kickSoft") { const lp = new Biquad("lp", 520, 0.7, 0, sr); for (let i = 0; i < out.length; i++) out[i] = lp.process(out[i]!) * 1.2; }
      break;
    }
    case "snare": case "snareTight": {
      const tight = name === "snareTight"; out = new Float32Array(len(tight ? 0.22 : 0.4));
      const hp = new Biquad("hp", 1400, 0.7, 0, sr), pk = new Biquad("peak", 5200, 1.1, 5, sr), bp = new Biquad("bp", 3200, 0.8, 0, sr);
      let p1 = 0, p2 = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr; p1 += (TAU * (185 + 40 * expDecay(t, 0.012))) / sr; p2 += (TAU * 331) / sr;
        const body = Math.sin(p1) * expDecay(t, tight ? 0.045 : 0.07) * 0.6 + Math.sin(p2) * expDecay(t, 0.035) * 0.25;
        const n = pk.process(hp.process(noise())) * expDecay(t, tight ? 0.05 : 0.11) + bp.process(noise()) * expDecay(t, 0.025) * 0.5;
        out[i] = softClip((body + n * 0.85) * Math.min(1, t / 0.0006), 1.4);
      }
      break;
    }
    case "clap": {
      out = new Float32Array(len(0.34)); const bp = new Biquad("bp", 1500, 1.1, 0, sr), hp = new Biquad("hp", 650, 0.7, 0, sr);
      const hits = [0, 0.0095, 0.019, 0.0295];
      for (let i = 0; i < out.length; i++) {
        const t = i / sr; let env = 0;
        for (let h = 0; h < hits.length; h++) if (t >= hits[h]!) env += (h === hits.length - 1 ? 1 : 0.7) * expDecay(t - hits[h]!, h === hits.length - 1 ? 0.07 : 0.006);
        out[i] = softClip(hp.process(bp.process(noise())) * env * 1.8, 1.2);
      }
      break;
    }
    case "rim": {
      out = new Float32Array(len(0.1)); let a = 0, b = 0; const hp = new Biquad("hp", 2500, 0.7, 0, sr);
      for (let i = 0; i < out.length; i++) { const t = i / sr; a += (TAU * 1750) / sr; b += (TAU * 480) / sr; out[i] = (Math.sin(a) * 0.4 + Math.sin(b) * 0.5 + hp.process(noise()) * 0.3) * expDecay(t, 0.012); }
      break;
    }
    case "hatC": case "hatO": case "hatP": {
      const dec = name === "hatC" ? 0.035 : name === "hatP" ? 0.05 : 0.2; out = new Float32Array(len(name === "hatO" ? 0.7 : 0.18));
      const fr = [263, 400, 421, 474, 587, 845], ph = fr.map(() => 0), hp = new Biquad("hp", 7200, 0.8, 0, sr), bp = new Biquad("bp", 10500, 0.6, 0, sr), hp2 = new Biquad("hp", 5500, 0.7, 0, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr; let s = 0;
        for (let k = 0; k < fr.length; k++) { ph[k]! += fr[k]! / sr; ph[k]! -= Math.floor(ph[k]!); s += squareBL(ph[k]!, fr[k]! / sr); }
        const v = hp2.process(hp.process(s * 0.18)) * 0.8 + bp.process(noise()) * 0.5;
        out[i] = v * Math.min(1, t / 0.0004) * expDecay(t, dec);
      }
      break;
    }
    case "tomL": case "tomM": case "tomH": {
      const f = name === "tomL" ? 90 : name === "tomM" ? 130 : 185; out = new Float32Array(len(0.5)); let ph = 0;
      for (let i = 0; i < out.length; i++) { const t = i / sr; ph += (TAU * (f * (1 + 0.5 * expDecay(t, 0.03)))) / sr; out[i] = softClip(Math.sin(ph) * expDecay(t, 0.17) * Math.min(1, t / 0.001) + (t < 0.006 ? noise() * 0.25 : 0), 1.5); }
      break;
    }
    case "crash": case "ride": {
      const dec = name === "crash" ? 0.8 : 0.4; out = new Float32Array(len(name === "crash" ? 3 : 1.6));
      const fr = [310, 452, 567, 719, 912, 1233, 1541], ph = fr.map(() => 0), hp = new Biquad("hp", 3500, 0.7, 0, sr), bp = new Biquad("bp", 8800, 0.5, 0, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr; let s = 0;
        for (let k = 0; k < fr.length; k++) { ph[k]! += (fr[k]! * (name === "ride" ? 1.4 : 1)) / sr; ph[k]! -= Math.floor(ph[k]!); s += squareBL(ph[k]!, fr[k]! / sr); }
        out[i] = (hp.process(s * 0.12) * 0.6 + bp.process(noise()) * 0.7) * Math.min(1, t / 0.002) * (expDecay(t, dec) * 0.8 + expDecay(t, dec * 0.18) * 0.6);
      }
      break;
    }
    case "shaker": {
      out = new Float32Array(len(0.1)); const bp = new Biquad("bp", 6500, 1.0, 0, sr);
      for (let i = 0; i < out.length; i++) { const t = i / sr; out[i] = bp.process(noise()) * Math.min(1, t / 0.012) * expDecay(t, 0.03); }
      break;
    }
    case "conga": {
      out = new Float32Array(len(0.3)); let ph = 0;
      for (let i = 0; i < out.length; i++) { const t = i / sr; ph += (TAU * (210 + 60 * expDecay(t, 0.02))) / sr; out[i] = (Math.sin(ph) * expDecay(t, 0.09) + (t < 0.01 ? noise() * 0.3 : 0)) * 0.9; }
      break;
    }
    case "cowbell": {
      out = new Float32Array(len(0.4)); let a = 0, b = 0; const bp = new Biquad("bp", 1100, 2, 0, sr);
      for (let i = 0; i < out.length; i++) { const t = i / sr; a += 540 / sr; b += 810 / sr; out[i] = bp.process(squareBL(a % 1, 540 / sr) + squareBL(b % 1, 810 / sr)) * 0.5 * expDecay(t, 0.12); }
      break;
    }
  }
  let pk = 0;
  for (const v of out) pk = Math.max(pk, Math.abs(v));
  if (pk > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / pk;
  return out;
}

export class DrumKit {
  private cache = new Map<DrumName, Float32Array>();
  constructor(private sr: number) {}
  get(n: DrumName): Float32Array {
    let s = this.cache.get(n);
    if (!s) { s = oneShot(n, this.sr); this.cache.set(n, s); }
    return s;
  }
}

const DRUM_GAIN: Record<DrumName, number> = { kick: 1, kickDeep: 1, kickSoft: 0.9, snare: 0.8, snareTight: 0.75, clap: 0.7, rim: 0.5, hatC: 0.34, hatO: 0.3, hatP: 0.3, tomL: 0.8, tomM: 0.75, tomH: 0.7, crash: 0.55, ride: 0.35, shaker: 0.3, conga: 0.5, cowbell: 0.3 };

export type DrumGroup = "kick" | "snare" | "tom" | "cym" | "perc" | "hat";
export const DRUM_GROUPS: DrumGroup[] = ["kick", "snare", "hat", "tom", "cym", "perc"];
export function groupOf(d: DrumName): DrumGroup {
  return d.startsWith("kick") ? "kick" : d.startsWith("snare") || d === "clap" || d === "rim" ? "snare" : d.startsWith("tom") ? "tom" : d === "crash" || d === "ride" ? "cym" : d === "conga" || d === "cowbell" || d === "shaker" ? "perc" : "hat";
}

export function renderDrums(events: DrumEv[], total: number, sr: number, kit: DrumKit, groups: Record<string, Stereo>, rng: Rng): void {
  for (const e of events) {
    const shot = kit.get(e.drum);
    const g = groupOf(e.drum);
    const bus = (groups[g] ??= mkStereo(total));
    const rate = 1 + (rng.next() - 0.5) * (e.drum.startsWith("kick") ? 0.01 : 0.035);
    const gain = DRUM_GAIN[e.drum] * Math.pow(clamp(e.vel, 0, 1.2), 1.3);
    const start = Math.round(e.t * sr);
    let src = shot;
    if (Math.abs(rate - 1) > 0.002) {
      const n = Math.floor(shot.length / rate); src = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = i * rate, i0 = Math.floor(x), f = x - i0; src[i] = shot[i0]! * (1 - f) + (shot[i0 + 1] ?? 0) * f; }
    }
    mixMono(bus, src, start, gain, e.pan ?? 0);
  }
}

/* ------------------------------------------------------------------- bass */
export type BassKind = "sub" | "synth" | "808" | "electric" | "pluck" | "offbeat";

export function renderBass(notes: NoteEv[], kind: BassKind, total: number, sr: number): Float32Array {
  const out = new Float32Array(total);
  for (const n of notes) {
    const s0 = Math.floor(n.t * sr), len = Math.min(total - s0, Math.floor((n.dur + 0.25) * sr));
    if (len <= 0) continue;
    const f1 = mtof(n.midi), f0 = n.glideFrom ? mtof(n.glideFrom) : f1;
    let ph = 0, ph2 = 0, ph3 = 0;
    const lp = new Biquad("lp", 400, kind === "synth" || kind === "offbeat" ? 2.2 : 0.8, 0, sr);
    const rel = kind === "808" ? 0.35 : 0.06, vel = 0.5 + 0.5 * n.vel;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const gl = n.glideFrom ? Math.exp(-t / 0.045) : 0, f = f1 + (f0 - f1) * gl;
      const dt = f / sr; ph += dt; ph -= Math.floor(ph);
      let env: number, v: number;
      const gate = t < n.dur ? 1 : Math.exp(-(t - n.dur) / rel);
      if (kind === "808") {
        env = Math.min(1, t / 0.004) * Math.exp(-t / Math.max(0.45, n.dur * 0.9)) * gate;
        const pb = 1 + 0.6 * expDecay(t, 0.012); ph2 += (TAU * f * pb) / sr;
        v = softClip(Math.sin(ph2) * env * 1.4, 2.4) * 0.8;
      } else if (kind === "sub") {
        env = Math.min(1, t / 0.008) * gate * (0.85 + 0.15 * expDecay(t, 0.3));
        v = softClip((Math.sin(TAU * ph) + 0.18 * Math.sin(TAU * ph * 2) + 0.05 * Math.sin(TAU * ph * 3)) * env * 0.9, 1.5);
      } else {
        ph2 += (f * 1.0029) / sr; ph2 -= Math.floor(ph2); ph3 += (f * 0.4995) / sr; ph3 -= Math.floor(ph3);
        const fenv = kind === "electric" || kind === "pluck" ? 150 + 1700 * expDecay(t, 0.09) : 220 + 2400 * expDecay(t, kind === "offbeat" ? 0.07 : 0.16);
        lp.set("lp", fenv * (0.6 + 0.8 * vel), kind === "offbeat" || kind === "synth" ? 2.4 : 1.1, 0, sr);
        env = Math.min(1, t / 0.004) * gate;
        const raw = sawBL(ph, dt) * 0.5 + sawBL(ph2, dt) * 0.4 + Math.sin(TAU * ph3) * 0.7;
        v = softClip(lp.process(raw) * env, 1.8) * 0.8;
      }
      out[s0 + i]! += v * vel * (kind === "808" ? 1.0 : 0.9);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- chords */
export type ChordInst = "pad" | "supersaw" | "strings" | "rhodes" | "piano" | "bell";

function adsr(t: number, dur: number, a: number, d: number, s: number, r: number): number {
  if (t < dur) return t < a ? t / a : t < a + d ? 1 - (1 - s) * ((t - a) / d) : s;
  const tail = t - dur, base = dur < a ? dur / a : dur < a + d ? 1 - (1 - s) * ((dur - a) / d) : s;
  return base * Math.exp(-tail / (r * 0.35));
}

export function renderChordInst(kind: ChordInst, notes: NoteEv[], total: number, sr: number, rng: Rng): Stereo {
  const out = mkStereo(total);
  for (const n of notes) {
    const f = mtof(n.midi), rel = kind === "pad" || kind === "strings" ? 0.7 : kind === "supersaw" ? 0.12 : kind === "bell" ? 1.5 : kind === "piano" ? 0.35 : 0.3;
    const s0 = Math.floor(n.t * sr), len = Math.min(total - s0, Math.floor((n.dur + rel * 1.6 + (kind === "rhodes" || kind === "piano" || kind === "bell" ? 1.2 : 0)) * sr));
    if (len <= 0) continue;
    const mono = new Float32Array(len), vel = 0.45 + 0.55 * n.vel;
    if (kind === "pad" || kind === "strings" || kind === "supersaw") {
      const det = kind === "supersaw" ? [-0.26, -0.13, 0, 0.13, 0.26] : kind === "strings" ? [-0.1, -0.035, 0.035, 0.1] : [-0.09, 0, 0.09];
      const phs = det.map(() => rng.next()), lp = new Biquad("lp", 1200, 0.8, 0, sr);
      const a = kind === "pad" ? 0.38 : kind === "strings" ? 0.32 : 0.006, dd = kind === "supersaw" ? 0.25 : 0.2, su = kind === "supersaw" ? 0.65 : 0.9, vf = 5.2 + rng.next() * 0.5, vd = rng.next() * 6;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const vib = kind === "strings" ? 1 + 0.0035 * Math.sin(TAU * vf * t) * Math.min(1, t / 0.5) : 1;
        let s = 0;
        for (let k = 0; k < det.length; k++) {
          const fk = f * vib * Math.pow(2, det[k]! / 12 * (kind === "supersaw" ? 1 : 1)), dt = fk / sr;
          phs[k]! += dt; phs[k]! -= Math.floor(phs[k]!); s += sawBL(phs[k]!, dt);
        }
        s /= det.length;
        const cut = kind === "supersaw" ? 1500 + 4200 * vel * expDecay(t, 0.35) + 800 : kind === "strings" ? 1500 + 1700 * vel : 700 + 1500 * vel + 500 * Math.sin(TAU * 0.13 * t + vd);
        if ((i & 15) === 0) lp.set("lp", cut, 0.75, 0, sr);
        mono[i] = lp.process(s) * adsr(t, n.dur, a, dd, su, rel) * vel * 0.55;
      }
    } else if (kind === "rhodes") {
      let pc = 0, pm = 0, pb = 0;
      const tau = 2.4 / Math.pow(f / 220, 0.35), trem = 4.2 + rng.next() * 0.6, dp = (TAU * f) / sr;
      const d1 = Math.exp(-1 / (0.35 * sr)), d2 = Math.exp(-1 / (2 * sr)), dA = Math.exp(-1 / (tau * sr)), dR = Math.exp(-1 / (0.25 * sr)), dB = Math.exp(-1 / (0.05 * sr));
      let e1 = 1, e2 = 1, eA = 1, eR = 1, eB = 1;
      const dingLen = Math.floor(0.2 * sr);
      for (let i = 0; i < len; i++) {
        const t = i / sr; pm += dp; pc += dp;
        const idx = (0.4 + 1.9 * vel * e1) + 0.25 * vel * e2;
        let tine = Math.sin(pc + idx * Math.sin(pm));
        if (i < dingLen) { pb += dp * 14; tine += 0.06 * vel * Math.sin(pb) * eB; eB *= dB; }
        if (t >= n.dur) eR *= dR;
        const amp = Math.min(1, t / 0.003) * eA * eR;
        e1 *= d1; e2 *= d2; eA *= dA;
        mono[i] = tine * amp * vel * 0.42 * (1 + 0.1 * Math.sin(TAU * trem * t));
      }
    } else if (kind === "bell") {
      let pc = 0, pm = 0, e1 = 1, e2 = 1;
      const d1 = Math.exp(-1 / (0.4 * sr)), d2 = Math.exp(-1 / (1.3 * sr));
      for (let i = 0; i < len; i++) {
        const t = i / sr; pm += (TAU * f * 3.5) / sr; pc += (TAU * f) / sr;
        mono[i] = Math.sin(pc + (2.8 * e1 + 0.2) * Math.sin(pm)) * Math.min(1, t / 0.002) * e2 * vel * 0.35;
        e1 *= d1; e2 *= d2;
      }
    } else { // piano: inharmonic additive, rotating phasors + multiplicative decays (no per-sample transcendentals)
      const K = f > 900 ? 5 : f > 450 ? 7 : f > 200 ? 9 : 11, B = 0.00012 * Math.pow(f / 100, 1.3);
      const re = new Float64Array(K), im = new Float64Array(K), cr = new Float64Array(K), ci = new Float64Array(K), amp = new Float64Array(K), dec = new Float64Array(K), env = new Float64Array(K).fill(1);
      const tau0 = clamp(5.5 - 1.7 * Math.log2(f / 55), 0.9, 6);
      let longest = 0;
      for (let k = 0; k < K; k++) {
        const h = k + 1, fk = f * h * Math.sqrt(1 + B * h * h), w = (TAU * fk) / sr, tk = tau0 / (1 + 0.7 * k * (1.2 - 0.5 * vel));
        const ph0 = rng.next() * 0.2;
        re[k] = Math.cos(ph0); im[k] = Math.sin(ph0); cr[k] = Math.cos(w); ci[k] = Math.sin(w);
        amp[k] = (1 / Math.pow(h, 1.05)) * Math.pow(vel, 0.4 * h) * (fk < sr * 0.45 ? 1 : 0); dec[k] = Math.exp(-1 / (tk * sr));
        longest = Math.max(longest, tk);
      }
      const stop = Math.min(len, Math.floor((n.dur + 0.4 + longest * 0.6) * sr));
      const hp = new Biquad("hp", 700, 0.7, 0, sr), relD = Math.exp(-1 / (0.2 * sr));
      let rel = 1;
      for (let i = 0; i < stop; i++) {
        let sum = 0;
        for (let k = 0; k < K; k++) {
          const r = re[k]! * cr[k]! - im[k]! * ci[k]!, m = re[k]! * ci[k]! + im[k]! * cr[k]!;
          re[k] = r; im[k] = m; env[k]! *= dec[k]!;
          sum += m * amp[k]! * env[k]!;
        }
        const t = i / sr;
        const hammer = t < 0.012 ? hp.process(rng.next() * 2 - 1) * (1 - t / 0.012) * 0.25 * vel : 0;
        if (t >= n.dur) rel *= relD;
        mono[i] = (sum * 0.5 + hammer) * Math.min(1, t / 0.0015) * rel * 0.9;
        if (i % 4096 === 0 && i > 0) { // renormalise phasors against drift
          for (let k = 0; k < K; k++) { const mag = Math.hypot(re[k]!, im[k]!); re[k] = re[k]! / mag; im[k] = im[k]! / mag; }
        }
      }
    }
    mixMono(out, mono, s0, 1, n.pan ?? 0);
  }
  return out;
}

/* ------------------------------------------------------------ guitar (KS) */
export function renderGuitar(strums: { t: number; notes: number[]; dir: 1 | -1; vel: number; dur: number; spread: number }[], total: number, sr: number, rng: Rng, bright = 0.55, nylon = false): Stereo {
  const out = mkStereo(total);
  for (const s of strums) {
    const order = s.dir === 1 ? s.notes : [...s.notes].reverse();
    order.forEach((midi, idx) => {
      const off = idx * s.spread * (0.8 + rng.next() * 0.4), f = mtof(midi), N = sr / f;
      const len = Math.min(total - Math.floor((s.t + off) * sr), Math.floor((s.dur + 0.6) * sr));
      if (len <= 0) return;
      const D = Math.floor(N - 0.5), frac = N - 0.5 - D, C = (1 - frac) / (1 + frac);
      const buf = new Float32Array(D + 2); let w = 0, apx = 0, apy = 0;
      const pick = new Biquad("lp", nylon ? 2200 : 4800 + bright * 4000, 0.7, 0, sr);
      for (let i = 0; i < D + 1; i++) buf[i] = pick.process((rng.next() * 2 - 1) * (0.55 + 0.45 * s.vel));
      const decay = 0.9965 + 0.0028 * (1 - bright) - (f > 400 ? 0.0006 : 0) + (nylon ? -0.001 : 0.0003);
      const mono = new Float32Array(len); let prev = 0;
      for (let i = 0; i < len; i++) {
        const cur = buf[w]!, nxt = buf[(w + 1) % (D + 1)]!;
        const avg = (cur + nxt) * 0.5 * decay;
        const ap = C * avg + apx - C * apy; apx = avg; apy = ap; // allpass fractional delay
        buf[w] = ap; w = (w + 1) % (D + 1);
        const t = i / sr, damp = t < s.dur ? 1 : Math.exp(-(t - s.dur) / 0.12);
        mono[i] = cur * damp; prev = cur;
      }
      void prev;
      mixMono(out, mono, Math.floor((s.t + off) * sr), 0.55 * (0.5 + 0.5 * s.vel), ((idx / Math.max(1, order.length - 1)) - 0.5) * 0.6);
    });
  }
  return out;
}

/* ------------------------------------------------------------------- lead */
export type LeadKind = "saw" | "square" | "pluck" | "bell" | "strings";

export function renderLead(kind: LeadKind, notes: NoteEv[], total: number, sr: number, rng: Rng): Stereo {
  const out = mkStereo(total);
  for (const n of notes) {
    const s0 = Math.floor(n.t * sr), rel = kind === "pluck" ? 0.08 : kind === "bell" ? 1 : 0.18, len = Math.min(total - s0, Math.floor((n.dur + rel * 2 + (kind === "bell" ? 1 : 0)) * sr));
    if (len <= 0) continue;
    const f1 = mtof(n.midi), f0 = n.glideFrom ? mtof(n.glideFrom) : f1, vel = 0.5 + 0.5 * n.vel, mono = new Float32Array(len);
    if (kind === "bell") {
      let pc = 0, pm = 0;
      for (let i = 0; i < len; i++) { const t = i / sr; pm += (TAU * f1 * 3.5) / sr; pc += (TAU * f1) / sr; mono[i] = Math.sin(pc + (2.4 * expDecay(t, 0.35) + 0.15) * Math.sin(pm)) * Math.min(1, t / 0.002) * expDecay(t, 1.0) * vel * 0.4; }
    } else {
      const det = kind === "square" ? [0] : kind === "pluck" ? [-0.06, 0.06] : [-0.08, 0, 0.08], phs = det.map(() => rng.next()), lp = new Biquad("lp", 3000, 0.9, 0, sr);
      for (let i = 0; i < len; i++) {
        const t = i / sr, g = n.glideFrom ? Math.exp(-t / 0.06) : 0, fb = f1 + (f0 - f1) * g;
        const vib = 1 + 0.004 * Math.sin(TAU * 5.4 * t) * clamp((t - 0.18) / 0.3, 0, 1) * (kind === "pluck" ? 0 : 1);
        let s = 0;
        for (let k = 0; k < det.length; k++) { const fk = fb * vib * Math.pow(2, det[k]! / 12), dt = fk / sr; phs[k]! += dt; phs[k]! -= Math.floor(phs[k]!); s += kind === "square" ? squareBL(phs[k]!, dt, 0.38) : sawBL(phs[k]!, dt); }
        s /= det.length;
        if ((i & 15) === 0) lp.set("lp", kind === "pluck" ? 700 + 4200 * expDecay(t, 0.12) * vel : kind === "square" ? 2400 : 1800 + 2200 * vel, 0.9, 0, sr);
        const a = kind === "pluck" ? 0.003 : kind === "strings" ? 0.12 : 0.012;
        mono[i] = lp.process(s) * adsr(t, n.dur, a, kind === "pluck" ? 0.12 : 0.1, kind === "pluck" ? 0.0 : 0.85, rel) * vel * 0.5;
      }
    }
    mixMono(out, mono, s0, 1, n.pan ?? 0);
  }
  return out;
}

/* -------------------------------------------------------------------- fx */
export function renderRiser(t: number, dur: number, rootMidi: number, total: number, sr: number, rng: Rng): Stereo {
  const out = mkStereo(total), s0 = Math.floor(t * sr), len = Math.min(total - s0, Math.floor(dur * sr));
  if (len <= 0) return out;
  const L = new Float32Array(len), R = new Float32Array(len), bpL = new Biquad("bp", 400, 2.5, 0, sr), bpR = new Biquad("bp", 400, 2.5, 0, sr);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const x = i / len, fc = 350 * Math.pow(30, x * x);
    if ((i & 7) === 0) { bpL.set("bp", fc, 2.2, 0, sr); bpR.set("bp", fc * 1.03, 2.2, 0, sr); }
    ph += (TAU * mtof(rootMidi + 24 + 12 * x)) / sr;
    const env = x * x * (i > len - 200 ? (len - i) / 200 : 1);
    const tone = Math.sin(ph) * 0.12 * env;
    L[i] = (bpL.process(rng.next() * 2 - 1) * 1.6 + tone) * env * 0.8; R[i] = (bpR.process(rng.next() * 2 - 1) * 1.6 + tone) * env * 0.8;
  }
  for (let i = 0; i < len; i++) { out.l[s0 + i] = L[i]!; out.r[s0 + i] = R[i]!; }
  return out;
}

export function renderImpact(t: number, rootMidi: number, total: number, sr: number, rng: Rng): Stereo {
  const out = mkStereo(total), s0 = Math.floor(t * sr), len = Math.min(total - s0, Math.floor(2.2 * sr));
  if (len <= 0) return out;
  const lp = new Biquad("lp", 5000, 0.7, 0, sr); let ph = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / sr; ph += (TAU * (mtof(rootMidi - 12) * (1 + 1.5 * expDecay(tt, 0.08)))) / sr;
    const v = softClip(Math.sin(ph) * expDecay(tt, 0.7) * 1.2, 2) * 0.8 + lp.process(rng.next() * 2 - 1) * expDecay(tt, 0.25) * 0.6;
    out.l[s0 + i] = v; out.r[s0 + i] = v;
  }
  return out;
}

export function renderVinyl(total: number, sr: number, rng: Rng): Stereo {
  const out = mkStereo(total), hp = new Biquad("hp", 800, 0.7, 0, sr), lp = new Biquad("lp", 7000, 0.7, 0, sr);
  let pop = 0;
  for (let i = 0; i < total; i++) {
    let v = lp.process(hp.process(rng.next() * 2 - 1)) * 0.0035;
    if (rng.next() < 3.2 / sr * 5) pop = (rng.next() > 0.5 ? 1 : -1) * (0.015 + rng.next() * 0.05);
    v += pop; pop *= 0.55;
    out.l[i] = v; out.r[i] = v * (0.8 + 0.2 * rng.next());
  }
  return out;
}
