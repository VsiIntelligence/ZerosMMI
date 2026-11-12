/**
 * Vocal-audibility toolkit for the Zeros Music mixer.
 *
 * Why this exists: a sung lyric is only audible when it stands out from the band in the frequency range where speech
 * lives (about 300 Hz - 3.4 kHz, with the consonants that make words understandable around 1.5 - 5 kHz). Measuring the
 * vocal against the backing there - instead of trusting a single loudness number for the whole track - lets the mixer
 *   1. carve a little room out of the backing exactly while somebody is singing (a "dynamic EQ" keyed by the lyric),
 *   2. ride the vocal fader automatically wherever the band would bury it,
 *   3. report the result as an objective number.
 *
 * Everything here is pure DSP (no DOM, no network) so it runs identically in the browser, in a worker and in the tests.
 */
import { Biquad, clamp, dbToGain, type Stereo } from "./dsp";

export type VocalBalance = {
  /** Vocal-to-backing level ratio in the speech band (300 Hz - 3.4 kHz), energy-weighted over the sung passages, in dB. */
  speechDb: number;
  /** Same ratio in the consonant / clarity band (1.5 - 5 kHz), in dB. */
  clarityDb: number;
  /** Vocal-to-backing ratio over the whole spectrum (how loud the singer is against the entire band), dB. */
  overallDb: number;
  /** Share of sung 100 ms windows (0..1) in which the vocal is at least 0 dB above the backing in the speech band. */
  coverage: number;
  /** The weakest tenth of the sung windows (10th percentile of the per-window ratio), in dB. */
  p10Db: number;
  /** Number of sung windows the numbers are based on. */
  windows: number;
};

/** Anything that carries per-window band energy (a BandEnergy, or an energy curve after a ride has been applied). */
export type Meter = { readonly e: Float64Array };

export const SPEECH_BAND: [number, number] = [300, 3400];
export const CLARITY_BAND: [number, number] = [1500, 5000];
export const FULL_BAND: [number, number] = [40, 16000];
export const WINDOW_SEC = 0.1;

/**
 * Per-window energy of a band-limited signal, accumulated bus by bus. The audio is summed to mono (mid) and run through a
 * 4th-order band-pass, so one pass over a 4-minute track costs a few hundred milliseconds and no extra buffer is allocated.
 */
export class BandEnergy {
  readonly e: Float64Array;
  private readonly win: number;
  constructor(totalSamples: number, private readonly sr: number, readonly band: [number, number], winSec = WINDOW_SEC) {
    this.win = Math.max(1, Math.round(winSec * sr));
    this.e = new Float64Array(Math.ceil(totalSamples / this.win) + 1);
  }
  /** Adds `gainDb`-scaled band energy of `s` (the buffer itself is not modified). */
  add(s: Stereo, gainDb = 0): void {
    const g = dbToGain(gainDb), sr = this.sr, [lo, hi] = this.band;
    const hp1 = new Biquad("hp", lo, 0.7071, 0, sr), hp2 = new Biquad("hp", lo, 0.7071, 0, sr);
    const lp1 = new Biquad("lp", hi, 0.7071, 0, sr), lp2 = new Biquad("lp", hi, 0.7071, 0, sr);
    const n = s.l.length, win = this.win;
    let acc = 0, w = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const y = lp2.process(lp1.process(hp2.process(hp1.process((s.l[i]! + s.r[i]!) * 0.5 * g))));
      acc += y * y;
      if (++k === win) { this.e[w++]! += acc; acc = 0; k = 0; }
    }
    if (k > 0) this.e[w]! += acc;
  }
}

const db10 = (x: number): number => 10 * Math.log10(Math.max(x, 1e-30));

/** Windows in which the lead vocal is actually singing (not a breath or a tail): within 40 dB of its loudest window. */
function sungWindows(vocal: Meter): number[] {
  let peak = 0;
  for (const v of vocal.e) if (v > peak) peak = v;
  const floor = peak * 1e-4, out: number[] = [];
  for (let w = 0; w < vocal.e.length; w++) if (vocal.e[w]! > floor) out.push(w);
  return out;
}

function ratioDb(vocal: Meter, back: Meter, windows: number[]): number {
  let ev = 0, eb = 0;
  for (const w of windows) { ev += vocal.e[w]!; eb += back.e[w]!; }
  return windows.length ? db10(ev) - db10(eb + 1e-30) : 0;
}

/** Objective vocal-vs-band balance from the speech-band and clarity-band meters of the vocal and of everything else. */
export function vocalBalance(speech: { vocal: Meter; back: Meter }, clarity?: { vocal: Meter; back: Meter }, overall?: { vocal: Meter; back: Meter }): VocalBalance {
  const win = sungWindows(speech.vocal);
  if (!win.length) return { speechDb: 0, clarityDb: 0, overallDb: 0, coverage: 0, p10Db: 0, windows: 0 };
  const per = win.map((w) => db10(speech.vocal.e[w]!) - db10(speech.back.e[w]! + 1e-30)).sort((a, b) => a - b);
  const clarityWin = clarity ? sungWindows(clarity.vocal) : win;
  return {
    speechDb: Math.round(ratioDb(speech.vocal, speech.back, win) * 10) / 10,
    clarityDb: clarity ? Math.round(ratioDb(clarity.vocal, clarity.back, clarityWin) * 10) / 10 : 0,
    overallDb: overall ? Math.round(ratioDb(overall.vocal, overall.back, sungWindows(overall.vocal)) * 10) / 10 : 0,
    coverage: Math.round((per.filter((r) => r >= 0).length / per.length) * 100) / 100,
    p10Db: Math.round(per[Math.min(per.length - 1, Math.floor(per.length * 0.1))]! * 10) / 10,
    windows: win.length,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Vocal-keyed carving: duck only the speech band of the backing while the lead is singing                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * 1 kHz-resolution "someone is singing" curve built from the sung notes: 0..1, instant-ish attack, slow release so the
 * backing blooms back between phrases instead of pumping on every syllable.
 */
export function vocalActivity(notes: { t: number; dur: number }[], totalSec: number, attackMs = 12, releaseMs = 240): Float32Array {
  const n = Math.max(2, Math.ceil(totalSec * 1000) + 2), raw = new Float32Array(n);
  for (const nt of notes) {
    const a = Math.max(0, Math.floor((nt.t - 0.03) * 1000)), b = Math.min(n - 1, Math.ceil((nt.t + nt.dur + 0.04) * 1000));
    for (let i = a; i <= b; i++) raw[i] = 1;
  }
  const ka = 1 - Math.exp(-1 / Math.max(1, attackMs)), kr = 1 - Math.exp(-1 / Math.max(1, releaseMs));
  let y = 0;
  for (let i = 0; i < n; i++) { y += (raw[i]! > y ? ka : kr) * (raw[i]! - y); raw[i] = y; }
  return raw;
}

/**
 * Dynamic EQ in place: `x' = x - band(x) * (1 - g(t))`, with `g(t) = 10^(-depthDb * activity(t) / 20)`.
 * When nobody sings g = 1 and the signal is untouched (perfect reconstruction); while the lead sings only the speech
 * band of this bus dips, so bass weight, kick punch and sparkle above the band stay where they were.
 */
export function carveForVocal(bus: Stereo, activity: Float32Array, depthDb: number, sr: number, band: [number, number] = [260, 4200]): void {
  if (depthDb <= 0.05) return;
  const chans: Float32Array[] = [bus.l, bus.r];
  for (const ch of chans) {
    const hp1 = new Biquad("hp", band[0], 0.7071, 0, sr), hp2 = new Biquad("hp", band[0], 0.7071, 0, sr);
    const lp1 = new Biquad("lp", band[1], 0.7071, 0, sr), lp2 = new Biquad("lp", band[1], 0.7071, 0, sr);
    const n = ch.length, last = activity.length - 1;
    let gi = -1, g = 1;
    for (let i = 0; i < n; i++) {
      const x = ch[i]!, mid = lp2.process(lp1.process(hp2.process(hp1.process(x))));
      const idx = Math.min(last, Math.floor((i / sr) * 1000));
      if (idx !== gi) { gi = idx; g = dbToGain(-depthDb * activity[idx]!); }
      ch[i] = x - mid * (1 - g);
    }
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Automatic vocal riding                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RideOptions = {
  /** Wanted vocal-over-backing ratio in the speech band, dB. */
  targetDb: number;
  /** Also lift sung windows whose consonant band (1.5 - 5 kHz) sits below this ratio, dB - consonants are what make words decodable. */
  clarityTargetDb?: number;
  /** ...but never push the speech-band ratio beyond this while doing so, dB (keeps the voice from sitting on top of the band). */
  maxSpeechDb?: number;
  /** Largest boost / cut the rider may apply, dB. */
  maxBoostDb: number; maxCutDb: number;
  /** A vocal already this far above the target is brought back down (so the track never turns into an acapella with a hum). */
  headroomDb: number;
};

/**
 * Per-window gain curve (dB) that brings every sung window to `targetDb` over the backing, never pushing the vocal below the
 * target - headroom, and always smoothed so it can not be heard as pumping. Windows without singing get the gain of their
 * neighbours so tails and breaths follow the lead.
 */
export function vocalRideCurve(speech: { vocal: Meter; back: Meter }, o: RideOptions, clarity?: { vocal: Meter; back: Meter }): Float32Array {
  const n = speech.vocal.e.length, raw = new Float32Array(n), sung = new Uint8Array(n);
  for (const w of sungWindows(speech.vocal)) sung[w] = 1;
  for (let w = 0; w < n; w++) {
    if (!sung[w]) continue;
    const r = db10(speech.vocal.e[w]!) - db10(speech.back.e[w]! + 1e-30);
    let g = 0;
    if (r < o.targetDb) g = Math.min(o.maxBoostDb, o.targetDb - r);
    else if (r > o.targetDb + o.headroomDb) g = -Math.min(o.maxCutDb, r - (o.targetDb + o.headroomDb));
    if (clarity && o.clarityTargetDb !== undefined && clarity.vocal.e[w]! > 0) {
      /* a bright band (distorted guitars, hats) can bury the consonants even when the vowels are fine: lift for them, within a cap */
      const rc = db10(clarity.vocal.e[w]!) - db10(clarity.back.e[w]! + 1e-30);
      const need = Math.min(o.maxBoostDb, o.clarityTargetDb - rc), cap = (o.maxSpeechDb ?? o.targetDb + 5) - r;
      if (need > g) g = Math.max(g, Math.min(need, cap));
    }
    raw[w] = g;
  }
  /* unsung windows (breaths, reverb tails, the lead-in) take the value of the nearest earlier sung window, so a tail rides with its phrase */
  const filled = new Float32Array(raw), first = firstSung(sung);
  let carry = Number.NaN;
  for (let w = 0; w < n; w++) { if (sung[w]) carry = raw[w]!; else if (!Number.isNaN(carry)) filled[w] = carry; }
  for (let w = 0; w < first && first < n; w++) filled[w] = raw[first]!;
  /* 5-window median (kills single-window spikes) followed by a one-pole glide: gentle, inaudible riding */
  const med = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    const a: number[] = [];
    for (let k = -2; k <= 2; k++) a.push(filled[clamp(w + k, 0, n - 1)]!);
    a.sort((x, y) => x - y);
    med[w] = a[2]!;
  }
  const out = new Float32Array(n);
  let y = med[0]!;
  for (let w = 0; w < n; w++) { y += (med[w]! > y ? 0.55 : 0.3) * (med[w]! - y); out[w] = y; }
  return out;
}
const firstSung = (sung: Uint8Array): number => { for (let i = 0; i < sung.length; i++) if (sung[i]) return i; return sung.length; };

/** Applies a per-window dB curve to a bus in place, interpolating linearly between window centres (no zipper noise). */
export function applyRide(bus: Stereo, curveDb: Float32Array, sr: number, winSec = WINDOW_SEC): void {
  const win = Math.max(1, Math.round(winSec * sr)), n = bus.l.length, last = curveDb.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = i / win - 0.5, w0 = clamp(Math.floor(pos), 0, last), w1 = Math.min(last, w0 + 1), f = clamp(pos - w0, 0, 1);
    const g = dbToGain(curveDb[w0]! * (1 - f) + curveDb[w1]! * f);
    bus.l[i]! *= g; bus.r[i]! *= g;
  }
}

/** Per-window energy of a bus after a ride curve has been applied (so the final meter needs no second filtering pass). */
export function rideEnergy(vocal: Meter, curveDb: Float32Array): Meter {
  const e = new Float64Array(vocal.e.length);
  for (let w = 0; w < e.length; w++) e[w] = vocal.e[w]! * Math.pow(10, curveDb[Math.min(w, curveDb.length - 1)]! / 10);
  return { e };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Vocal presence: a touch of harmonic excitation so consonants cut through at moderate level                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Parallel exciter in place: soft-saturated, band-limited content above `hpHz` blended in at `mix` (kept below 0.2). */
export function exciteHighs(bus: Stereo, sr: number, hpHz = 2400, drive = 2.4, mix = 0.12, lpHz = 9500): void {
  const chans: Float32Array[] = [bus.l, bus.r], norm = 1 / Math.tanh(drive);
  for (const ch of chans) {
    const hp1 = new Biquad("hp", hpHz, 0.7071, 0, sr), hp2 = new Biquad("hp", hpHz, 0.7071, 0, sr), lp = new Biquad("lp", lpHz, 0.7071, 0, sr);
    for (let i = 0; i < ch.length; i++) {
      const h = hp2.process(hp1.process(ch[i]!));
      ch[i] = ch[i]! + mix * lp.process(Math.tanh(h * drive) * norm * 0.5);
    }
  }
}
