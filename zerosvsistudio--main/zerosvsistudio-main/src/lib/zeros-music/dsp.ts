/** Zeros Music - DSP primitives (DOM-free; runs in the browser main thread, a worker or Node). */
export const TAU = Math.PI * 2;
export type Stereo = { l: Float32Array; r: Float32Array };
export const mkStereo = (n: number): Stereo => ({ l: new Float32Array(n), r: new Float32Array(n) });
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, 1e-9));
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }
  gauss(): number {
    let u = 0;
    for (let i = 0; i < 6; i++) u += this.next();
    return (u - 3) / Math.sqrt(0.5);
  }
}

export type BiquadType = "lp" | "hp" | "bp" | "notch" | "peak" | "ls" | "hs";

export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  constructor(type?: BiquadType, f?: number, q = 0.707, gainDb = 0, sr = 44100) {
    if (type && f) this.set(type, f, q, gainDb, sr);
  }
  set(type: BiquadType, f: number, q: number, gainDb: number, sr: number): this {
    const fc = clamp(f, 10, sr * 0.49);
    const w0 = (TAU * fc) / sr, cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * Math.max(q, 0.05));
    const A = Math.pow(10, gainDb / 40), sA = Math.sqrt(A);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
      case "lp": b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case "hp": b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case "bp": b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case "notch": b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case "peak": b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
      case "ls":
        b0 = A * (A + 1 - (A - 1) * cs + 2 * sA * alpha); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - 2 * sA * alpha);
        a0 = A + 1 + (A - 1) * cs + 2 * sA * alpha; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - 2 * sA * alpha; break;
      case "hs":
        b0 = A * (A + 1 + (A - 1) * cs + 2 * sA * alpha); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - 2 * sA * alpha);
        a0 = A + 1 - (A - 1) * cs + 2 * sA * alpha; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - 2 * sA * alpha; break;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset(): void { this.z1 = 0; this.z2 = 0; }
}

export function filterMono(buf: Float32Array, f: Biquad): void {
  for (let i = 0; i < buf.length; i++) buf[i] = f.process(buf[i]!);
}
export function eqStereo(s: Stereo, bands: { type: BiquadType; f: number; q?: number; g?: number }[], sr: number): void {
  for (const b of bands) {
    filterMono(s.l, new Biquad(b.type, b.f, b.q ?? 0.707, b.g ?? 0, sr));
    filterMono(s.r, new Biquad(b.type, b.f, b.q ?? 0.707, b.g ?? 0, sr));
  }
}

/** Band-limited sawtooth / square helpers (PolyBLEP). */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}
export const sawBL = (ph: number, dt: number): number => 2 * ph - 1 - polyBlep(ph, dt);
export const squareBL = (ph: number, dt: number, pw = 0.5): number => {
  const p2 = ph + 1 - pw >= 1 ? ph + 1 - pw - 1 : ph + 1 - pw;
  return (ph < pw ? 1 : -1) + polyBlep(ph, dt) - polyBlep(p2, dt);
};

export function addInto(dst: Stereo, src: Stereo, gain = 1, offset = 0): void {
  const n = Math.min(src.l.length, dst.l.length - offset);
  for (let i = 0; i < n; i++) { dst.l[offset + i]! += src.l[i]! * gain; dst.r[offset + i]! += src.r[i]! * gain; }
}
/** Mix a mono one-shot into a stereo bus with equal-power pan. */
export function mixMono(dst: Stereo, mono: Float32Array, start: number, gain: number, pan = 0): void {
  const a = (clamp(pan, -1, 1) + 1) * (Math.PI / 4), gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  const s0 = Math.max(0, start), n = Math.min(mono.length - (s0 - start), dst.l.length - s0);
  for (let i = 0; i < n; i++) { const v = mono[i + (s0 - start)]!; dst.l[s0 + i]! += v * gl; dst.r[s0 + i]! += v * gr; }
}

/** Stereo-linked feed-forward compressor with soft knee. Optional external sidechain (mono, same length). */
export function compress(
  s: Stereo,
  o: { thresh: number; ratio: number; attack: number; release: number; knee?: number; makeup?: number; side?: Float32Array },
  sr: number,
): void {
  const aC = Math.exp(-1 / (o.attack * 0.001 * sr)), rC = Math.exp(-1 / (o.release * 0.001 * sr));
  const knee = o.knee ?? 6, mk = dbToGain(o.makeup ?? 0), n = s.l.length;
  let env = 0, gain = mk;
  for (let i = 0; i < n; i++) {
    const det = o.side ? Math.abs(o.side[i]!) : Math.max(Math.abs(s.l[i]!), Math.abs(s.r[i]!));
    env = det > env ? aC * env + (1 - aC) * det : rC * env + (1 - rC) * det;
    const lvl = 20 * Math.log10(env + 1e-9), over = lvl - o.thresh;
    if ((i & 3) === 0) {
      let gr = 0;
      if (2 * over < -knee) gr = 0;
      else if (2 * Math.abs(over) <= knee) gr = ((1 - 1 / o.ratio) * (over + knee / 2) ** 2) / (2 * knee);
      else gr = (1 - 1 / o.ratio) * over;
      gain = Math.exp(-gr * 0.115129) * mk;
    }
    s.l[i]! *= gain; s.r[i]! *= gain;
  }
}

/** Look-ahead brick-wall limiter (peak-safe). */
export function limit(s: Stereo, ceilingDb: number, sr: number, lookMs = 4, releaseMs = 120): void {
  const n = s.l.length, ceil = dbToGain(ceilingDb), la = Math.max(2, Math.round(lookMs * 0.001 * sr));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(s.l[i]!), Math.abs(s.r[i]!)); req[i] = p > ceil ? ceil / p : 1; }
  // sliding minimum over [i, i+la]
  const mn = new Float32Array(n), dq = new Int32Array(n + la + 2);
  let head = 0, tail = 0;
  for (let i = n - 1 + la; i >= 0; i--) {
    const v = i < n ? req[i]! : 1;
    while (tail > head && (dq[tail - 1]! < 0 ? 1 : (dq[tail - 1]! < n ? req[dq[tail - 1]!]! : 1)) >= v) tail--;
    dq[tail++] = i;
    while (dq[head]! > i + la) head++;
    if (i < n) { const m = dq[head]!; mn[i] = m < n ? req[m]! : 1; }
  }
  // attack smoothing (box of la+1 samples, causal) then release (one-pole upward)
  const rC = Math.exp(-1 / (releaseMs * 0.001 * sr));
  let acc = 0, g = 1;
  const win = la + 1, hist = new Float32Array(win);
  for (let i = 0; i < n; i++) {
    acc += mn[i]! - hist[i % win]!; hist[i % win] = mn[i]!;
    const avg = acc / win;
    const target = Math.min(avg, mn[i]!);
    g = target < g ? target : rC * g + (1 - rC) * target;
    if (g > target) g = Math.min(g, 1);
    const gg = Math.min(g, avg);
    s.l[i]! *= gg; s.r[i]! *= gg;
  }
}

export const softClip = (x: number, drive: number): number => Math.tanh(x * drive) / Math.tanh(drive);

/** Schroeder-style diffusion + 8-line feedback delay network (Hadamard) stereo reverb. Returns wet only. */
export function reverb(
  inp: Stereo,
  o: { rt60: number; size?: number; damp?: number; preMs?: number; width?: number },
  sr: number,
): Stereo {
  const n = inp.l.length, out = mkStereo(n);
  const size = o.size ?? 1, damp = clamp(o.damp ?? 0.35, 0.02, 0.95), width = o.width ?? 1;
  const base = [1117, 1327, 1559, 1733, 1993, 2251, 2503, 2777];
  const lens = base.map((b) => Math.max(64, Math.round((b * size * sr) / 44100)));
  const bufs = lens.map((len) => new Float32Array(len));
  const idx = new Int32Array(8), lp = new Float32Array(8), g = new Float32Array(8);
  for (let i = 0; i < 8; i++) g[i] = Math.pow(10, (-3 * lens[i]!) / (o.rt60 * sr));
  const dampC = 1 - damp;
  const pre = Math.round(((o.preMs ?? 15) * sr) / 1000), preL = new Float32Array(pre + 1), preR = new Float32Array(pre + 1);
  // input diffusers
  const apLens = [142, 107, 379, 277].map((x) => Math.round((x * sr) / 29761));
  const apBuf = apLens.map((len) => new Float32Array(len)), apIdx = new Int32Array(4);
  const x = new Float32Array(8);
  let pi = 0;
  for (let t = 0; t < n; t++) {
    let inL = inp.l[t]!, inR = inp.r[t]!;
    const dl = preL[pi]!, dr = preR[pi]!; preL[pi] = inL; preR[pi] = inR; pi = pi + 1 > pre ? 0 : pi + 1; inL = dl; inR = dr;
    let mono = (inL + inR) * 0.5;
    for (let a = 0; a < 4; a++) {
      const b = apBuf[a]!, j = apIdx[a]!; const d = b[j]!; const y = -0.6 * mono + d; b[j] = mono + 0.6 * y; apIdx[a] = j + 1 >= b.length ? 0 : j + 1; mono = y;
    }
    for (let i = 0; i < 8; i++) { const v = bufs[i]![idx[i]!]!; lp[i] = lp[i]! + (v - lp[i]!) * dampC; x[i] = lp[i]! * g[i]!; }
    // fast Walsh-Hadamard (8)
    for (let h = 1; h < 8; h <<= 1) for (let i = 0; i < 8; i += h << 1) for (let j = i; j < i + h; j++) { const a = x[j]!, b = x[j + h]!; x[j] = a + b; x[j + h] = a - b; }
    const sc = 0.35355339; // 1/sqrt(8)
    for (let i = 0; i < 8; i++) {
      const inj = (i & 1 ? inR : inL) * 0.5 + mono * 0.25;
      bufs[i]![idx[i]!] = x[i]! * sc + inj;
      idx[i] = idx[i]! + 1 >= lens[i]! ? 0 : idx[i]! + 1;
    }
    const l = x[0]! - x[2]! + x[4]! - x[6]!, r = x[1]! - x[3]! + x[5]! - x[7]!;
    out.l[t] = (l + (r - l) * (1 - width) * 0.5) * 0.45; out.r[t] = (r + (l - r) * (1 - width) * 0.5) * 0.45;
  }
  return out;
}

/** Stereo chorus / ensemble, in place (mix = wet amount). */
export function chorus(s: Stereo, o: { rate: number; depthMs: number; delayMs: number; mix: number; voices?: number }, sr: number): void {
  const n = s.l.length, voices = o.voices ?? 2, max = Math.ceil(((o.delayMs + o.depthMs * 2 + 2) * sr) / 1000);
  const bl = new Float32Array(max), br = new Float32Array(max);
  let w = 0;
  for (let i = 0; i < n; i++) {
    bl[w] = s.l[i]!; br[w] = s.r[i]!;
    let wl = 0, wr = 0;
    for (let v = 0; v < voices; v++) {
      const ph = TAU * (o.rate * (i / sr) + v / voices);
      const dL = ((o.delayMs + o.depthMs * Math.sin(ph)) * sr) / 1000, dR = ((o.delayMs + o.depthMs * Math.sin(ph + 1.7)) * sr) / 1000;
      for (let c = 0; c < 2; c++) {
        const d = c === 0 ? dL : dR, pos = w - d, p0 = Math.floor(pos), fr = pos - p0;
        const b = c === 0 ? bl : br;
        const a0 = b[((p0 % max) + max) % max]!, a1 = b[(((p0 + 1) % max) + max) % max]!;
        const val = a0 + (a1 - a0) * fr;
        if (c === 0) wl += val; else wr += val;
      }
    }
    wl /= voices; wr /= voices;
    s.l[i] = s.l[i]! * (1 - o.mix * 0.5) + wl * o.mix; s.r[i] = s.r[i]! * (1 - o.mix * 0.5) + wr * o.mix;
    w = w + 1 >= max ? 0 : w + 1;
  }
}

/** Tempo-synced stereo ping-pong delay (input enters the left line). Returns wet only. */
export function pingPong(inp: Stereo, o: { timeSec: number; feedback: number; lpHz?: number }, sr: number): Stereo {
  const n = inp.l.length, d = Math.max(1, Math.round(o.timeSec * sr)), out = mkStereo(n);
  const bl = new Float32Array(d), br = new Float32Array(d);
  const lpL = new Biquad("lp", o.lpHz ?? 4500, 0.7, 0, sr), lpR = new Biquad("lp", o.lpHz ?? 4500, 0.7, 0, sr);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const l = bl[w]!, r = br[w]!;
    out.l[i] = l; out.r[i] = r;
    bl[w] = lpL.process((inp.l[i]! + inp.r[i]!) * 0.5 + r * o.feedback);
    br[w] = lpR.process(l * o.feedback);
    w = w + 1 >= d ? 0 : w + 1;
  }
  return out;
}

/** ITU-R BS.1770 integrated loudness (LUFS) with absolute and relative gating. */
export function integratedLufs(s: Stereo, sr: number): number {
  const kw = (src: Float32Array): Float32Array => {
    const out = new Float32Array(src.length), a = new Biquad("hs", 1681.97, 0.7071, 3.9998, sr), b = new Biquad("hp", 38.1355, 0.5003, 0, sr);
    for (let i = 0; i < src.length; i++) out[i] = b.process(a.process(src[i]!));
    return out;
  };
  const L = kw(s.l), R = kw(s.r), block = Math.round(0.4 * sr), step = Math.round(0.1 * sr), ms: number[] = [];
  for (let st = 0; st + block <= L.length; st += step) {
    let acc = 0;
    for (let i = st; i < st + block; i++) acc += L[i]! * L[i]! + R[i]! * R[i]!;
    ms.push(acc / block);
  }
  const lk = (z: number) => -0.691 + 10 * Math.log10(z + 1e-12);
  const gated = ms.filter((z) => lk(z) > -70);
  if (!gated.length) return -70;
  const rel = lk(gated.reduce((a, b) => a + b, 0) / gated.length) - 10;
  const kept = gated.filter((z) => lk(z) > rel);
  return kept.length ? lk(kept.reduce((a, b) => a + b, 0) / kept.length) : -70;
}

export function peakDb(s: Stereo): number {
  let p = 0;
  for (let i = 0; i < s.l.length; i++) p = Math.max(p, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
  return gainToDb(p);
}

/** 16-bit stereo WAV with TPDF dither. */
export function encodeWav16(s: Stereo, sr: number, rng: Rng): Uint8Array {
  const n = s.l.length, bytes = 44 + n * 4, out = new Uint8Array(bytes), dv = new DataView(out.buffer);
  const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, bytes - 8, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of [s.l, s.r]) {
      const d = (rng.next() - rng.next()) / 32768;
      const v = clamp(ch[i]! + d, -1, 1);
      dv.setInt16(o, Math.round(v * 32767), true); o += 2;
    }
  }
  return out;
}
