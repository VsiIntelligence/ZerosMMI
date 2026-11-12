import {
  Biquad, Rng, addInto, chorus, compress, dbToGain, encodeWav16, eqStereo, filterMono, integratedLufs, limit, mkStereo, peakDb, pingPong, reverb, softClip, clamp,
  type Stereo,
} from "./dsp";
import { DRUM_GROUPS, DrumKit, groupOf, renderBass, renderChordInst, renderDrums, renderGuitar, renderImpact, renderLead, renderRiser, renderVinyl, type NoteEv } from "./instruments";
import { VOICES, renderVocalPart, synthBreath, type SungNote } from "./vocal";
import { arpEvents, bassEvents, buildPlan, chordEvents, drumEvents, fxEvents, leadHookEvents, lyricTimeline, vocalEvents, type LyricTiming, type SongInput } from "./composer";
import { applyDips, applyDynamics, preChorusDips, type BusName } from "./dynamics";
import { BandEnergy, CLARITY_BAND, FULL_BAND, SPEECH_BAND, applyRide, carveForVocal, exciteHighs, rideEnergy, vocalActivity, vocalBalance, vocalRideCurve, type VocalBalance } from "./mix-analysis";

export type RenderInfo = {
  bpm: number; key: string; genre: string; sections: { name: string; start: number; bars: number; kind: string }[]; lufs: number; peakDb: number; ms: number; stems: Record<string, number>;
  /** every sung line with its start time (seconds) - drives karaoke highlighting and .lrc export */
  lyrics: LyricTiming[];
  /** 0..255 peak envelope of the finished master (mono), for the waveform display */
  waveform: number[];
  /** short-term loudness per ~3 s window (dB), for the energy-contour readout */
  contour: number[];
  durationSec: number; sampleRate: number; voice: string; vocalsRendered: boolean;
  /** objective measure of how clearly the lyric stands out from the band (undefined for instrumentals / stems) */
  vocalBalance?: VocalBalance;
};
export type RenderResult = { wav: Uint8Array; durationSec: number; info: RenderInfo; pcm: { l: Float32Array; r: Float32Array; sampleRate: number } };
export type RenderOptions = { skipWav?: boolean; sampleRate?: number; onProgress?: (fraction: number, label: string) => void; targetLufs?: number; /** full mix (default), instrumental / karaoke (no vocals) or vocals-only (acapella) */ stem?: "full" | "instrumental" | "vocals" };

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
function makeYielder(): () => Promise<void> {
  let last = now();
  return async () => {
    if (now() - last > 28) {
      await new Promise<void>((r) => setTimeout(r, 0));
      last = now();
    }
  };
}

function scaleInPlace(s: Stereo, g: number): void {
  for (let i = 0; i < s.l.length; i++) { s.l[i]! *= g; s.r[i]! *= g; }
}
function toStereo(m: Float32Array, pan = 0): Stereo {
  const s = mkStereo(m.length), a = (clamp(pan, -1, 1) + 1) * (Math.PI / 4), gl = Math.cos(a), gr = Math.sin(a);
  for (let i = 0; i < m.length; i++) { s.l[i] = m[i]! * gl * 1.414; s.r[i] = m[i]! * gr * 1.414; }
  return s;
}
function mulEnv(s: Stereo, env: Float32Array): void {
  for (let i = 0; i < s.l.length; i++) { s.l[i]! *= env[i]!; s.r[i]! *= env[i]!; }
}
function sidechainEnv(kicks: number[], total: number, sr: number, depth: number, releaseSec = 0.16): Float32Array {
  const env = new Float32Array(total).fill(1);
  if (depth <= 0) return env;
  const len = Math.floor(releaseSec * 3.2 * sr), tau = releaseSec * sr, att = Math.floor(0.004 * sr);
  for (const t of kicks) {
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < len && s0 + i < total; i++) {
      const dip = 1 - depth * Math.min(1, (i + 1) / att) * Math.exp(-i / tau);
      if (dip < env[s0 + i]!) env[s0 + i] = dip;
    }
  }
  return env;
}
function midSide(s: Stereo, sideGain: number, sideHp: number, sr: number): void {
  const hp = new Biquad("hp", sideHp, 0.7, 0, sr);
  for (let i = 0; i < s.l.length; i++) {
    const m = (s.l[i]! + s.r[i]!) * 0.5, sd = (s.l[i]! - s.r[i]!) * 0.5, sh = hp.process(sd);
    const sOut = sd + (sh) * (sideGain - 1);
    s.l[i] = m + sOut; s.r[i] = m - sOut;
  }
}


/** Wanted vocal-over-band ratio in the speech band (300 Hz - 3.4 kHz) while the lead sings. +9 dB reads as "the singer is clearly in front" without sounding pasted on. */
export const VOCAL_TARGET_DB = 9;
/** Wanted ratio in the consonant band (1.5 - 5 kHz): the part of the spectrum that decides whether words are understood. */
export const VOCAL_CLARITY_DB = 5.5;

export async function renderZerosSong(spec: SongInput, opts: RenderOptions = {}): Promise<RenderResult> {
  const t0 = now();
  const sr = opts.sampleRate ?? 44100, tick = makeYielder(), progress = opts.onProgress ?? (() => {});
  progress(0.02, "Composing");
  const plan = buildPlan(spec);
  const tail = plan.genre.reverb > 0.6 ? 4.5 : 3.2;
  const total = Math.ceil((plan.totalSec + tail) * sr), rng = new Rng(plan.seed ^ 0x51ed);
  const g = plan.genre;
  const drumEv = drumEvents(plan), bass = bassEvents(plan), chords = chordEvents(plan), arp = arpEvents(plan);
  const voc = vocalEvents(plan);
  const sung = !plan.instrumental && voc.lead.length > 0;
  const kicks = drumEv.filter((e) => e.drum.startsWith("kick")).map((e) => e.t);
  await tick();

  /* Every stage is its own function so its temporaries can be garbage-collected before the next one starts
     (a 3-minute stereo buffer is ~60 MB; keeping them all alive would exhaust a phone). */

  const makeDrums = async (): Promise<Stereo> => {
    progress(0.06, "Recording drums");
    const bandsFor: Record<string, { type: "hp" | "peak" | "hs" | "ls" | "lp"; f: number; q?: number; g?: number }[]> = {
      kick: [{ type: "hp", f: 34 }, { type: "peak", f: 62, q: 1, g: 1 }, { type: "peak", f: 340, q: 1.2, g: -2.5 }, { type: "peak", f: 3500, q: 1, g: 1.5 }],
      snare: [{ type: "hp", f: 110 }, { type: "peak", f: 220, q: 1, g: 1.5 }, { type: "peak", f: 4200, q: 0.9, g: 2 }],
      hat: [{ type: "hp", f: 500 }, { type: "hs", f: 9500, g: 1.5 }], tom: [{ type: "hp", f: 70 }], cym: [{ type: "hp", f: 450 }], perc: [{ type: "hp", f: 300 }],
    };
    const bus = mkStereo(total), kit = new DrumKit(sr);
    for (const grp of DRUM_GROUPS) {
      const ev = drumEv.filter((e) => groupOf(e.drum) === grp);
      if (!ev.length) continue;
      const slot: Record<string, Stereo> = {};
      renderDrums(ev, total, sr, kit, slot, rng);
      const st = slot[grp]!;
      eqStereo(st, bandsFor[grp] ?? [], sr);
      if (grp === "snare" || grp === "cym") {
        const wet = reverb(st, { rt60: grp === "cym" ? 1.4 : g.drums === "ballad" || g.drums === "cinematic" ? 2 : 1.1, size: grp === "cym" ? 1 : 0.8, preMs: 8 }, sr);
        scaleInPlace(wet, grp === "cym" ? 0.12 : g.drums === "lofi" ? 0.1 : 0.2);
        addInto(bus, wet, 1);
      }
      addInto(bus, st, 1);
      await tick();
    }
    compress(bus, { thresh: -15, ratio: 2.6, attack: 14, release: 90, knee: 6, makeup: 2 }, sr);
    return bus;
  };

  const makeBass = async (): Promise<Stereo> => {
    progress(0.14, "Laying the bass");
    const m = renderBass(bass.notes, bass.kind, total, sr);
    await tick();
    for (let k = 0; k < 2; k++) filterMono(m, new Biquad("hp", 36, 0.8, 0, sr));
    filterMono(m, new Biquad("lp", bass.kind === "808" || bass.kind === "sub" ? 2400 : 4200, 0.707, 0, sr));
    const bus = toStereo(m);
    compress(bus, { thresh: -21, ratio: 3, attack: 20, release: 120, makeup: 3 }, sr);
    return bus;
  };

  const makeChords = async (): Promise<Stereo> => {
    progress(0.22, "Playing the chords");
    let bus: Stereo;
    if (chords.kind === "guitar") {
      bus = renderGuitar(chords.strums, total, sr, rng, g.bright, g.id === "acoustic" || g.id === "ballad");
      eqStereo(bus, [{ type: "hp", f: 90 }, { type: "peak", f: 110, q: 1, g: 2 }, { type: "peak", f: 2300, q: 1, g: 2 }, { type: "peak", f: 320, q: 1, g: -2 }], sr);
    } else {
      bus = renderChordInst(chords.kind, chords.notes, total, sr, rng);
      if (chords.kind === "pad" || chords.kind === "supersaw" || chords.kind === "strings") chorus(bus, { rate: 0.35, depthMs: 2.2, delayMs: 14, mix: 0.6, voices: 3 }, sr);
      eqStereo(bus, [{ type: "hp", f: 110 }, { type: "peak", f: 300, q: 1, g: -2 }], sr);
    }
    await tick();
    if (chords.layerPad.length) {
      const pad = renderChordInst("pad", chords.layerPad, total, sr, rng);
      chorus(pad, { rate: 0.3, depthMs: 2, delayMs: 15, mix: 0.6, voices: 3 }, sr);
      eqStereo(pad, [{ type: "hp", f: 100 }], sr);
      addInto(bus, pad, 0.7);
    }
    const padLike = chords.kind === "pad" || chords.kind === "strings" || chords.kind === "supersaw";
    const wet = reverb(bus, { rt60: 0.9 + 2.2 * g.reverb, size: 1.1, damp: 0.45, preMs: 22 }, sr);
    addInto(bus, wet, (padLike ? 0.34 : 0.22) * (0.6 + 0.6 * g.reverb));
    return bus;
  };

  const makeLead = async (): Promise<Stereo> => {
    progress(0.3, "Adding the hooks");
    const bus = mkStereo(total);
    if (arp.length) {
      const a = renderLead("pluck", arp, total, sr, rng);
      addInto(a, pingPong(a, { timeSec: plan.beat * 0.75, feedback: 0.38, lpHz: 4200 }, sr), 0.32);
      eqStereo(a, [{ type: "hp", f: 250 }], sr);
      addInto(bus, a, plan.genre.id === "cinematic" ? 0.5 : 0.65);
    }
    const hookNotes: NoteEv[] = plan.instrumental
      ? voc.lead.map((n) => ({ t: n.t, dur: n.dur, midi: n.midi + (g.lead === "bell" || g.lead === "pluck" ? 12 : 0), vel: n.vel * 0.95 }))
      : leadHookEvents(plan, voc.hook);
    if (hookNotes.length) {
      const kind = g.lead === "none" ? (g.id === "rnb" || g.id === "hiphop" ? "bell" : "pluck") : g.lead;
      const h = renderLead(kind, hookNotes, total, sr, rng);
      addInto(h, pingPong(h, { timeSec: plan.beat * 0.75, feedback: 0.3, lpHz: 3800 }, sr), 0.25);
      eqStereo(h, [{ type: "hp", f: 220 }], sr);
      addInto(bus, h, 1);
    }
    addInto(bus, reverb(bus, { rt60: 1.8, size: 1, preMs: 20 }, sr), 0.28);
    await tick();
    return bus;
  };

  const makeVocals = async (): Promise<Stereo> => {
    const bus = mkStereo(total);
    if (!sung) return bus;
    progress(0.44, "Singing the lead");
    const vr = new Rng(plan.seed ^ 0x77);
    let leadNotes = voc.lead, maleNotes: SungNote[] = [];
    if (plan.voice === "duet") {
      // duet: verses trade between the two singers (the man sings an octave below); choruses are the woman plus a male octave
      const sectionAt = (t: number) => plan.sections.find((sec) => t >= sec.startBar * plan.bar && t < (sec.startBar + sec.bars) * plan.bar);
      const isMale = (n: SungNote) => { const sec = sectionAt(n.t); return !!sec && sec.kind !== "chorus" && sec.idx % 2 === 1; };
      maleNotes = voc.lead.filter(isMale).map((n) => ({ ...n, midi: n.midi - 12, ...(n.prevMidi !== undefined ? { prevMidi: n.prevMidi - 12 } : {}) }));
      leadNotes = voc.lead.filter((n) => !isMale(n));
    }
    const baseVoice = plan.voice === "male" ? VOICES["male"]! : VOICES["female"]!;
    await renderVocalPart({ notes: leadNotes, voice: baseVoice, gain: 1, pan: 0 }, bus, sr, vr, tick);
    if (maleNotes.length) await renderVocalPart({ notes: maleNotes, voice: VOICES["male"]!, gain: 1, pan: 0 }, bus, sr, vr, tick);
    const breath = new Float32Array(total);
    for (const t of voc.breaths) if (t > 0.1) synthBreath(breath, t, 0.12, sr, vr, 0.02);
    addInto(bus, toStereo(breath), 1);

    progress(0.56, "Stacking harmonies");
    const stack = mkStereo(total);
    const doubles = mkStereo(total);
    await renderVocalPart({ notes: voc.dbl, voice: baseVoice, gain: 0.55, pan: -0.5, detuneCents: 9, delaySec: 0.014 }, doubles, sr, vr, tick);
    await renderVocalPart({ notes: voc.dbl, voice: baseVoice, gain: 0.55, pan: 0.5, detuneCents: -10, delaySec: 0.022 }, doubles, sr, vr, tick);
    chorus(doubles, { rate: 0.5, depthMs: 1.4, delayMs: 9, mix: 0.4, voices: 2 }, sr);
    addInto(bus, doubles, 1);
    if (voc.harm.length) await renderVocalPart({ notes: voc.harm, voice: plan.voice === "male" ? VOICES["female"]! : VOICES["soprano"]!, gain: 0.5, pan: 0.3, detuneCents: 4, delaySec: 0.01 }, stack, sr, vr, tick);
    if (voc.oct.length) await renderVocalPart({ notes: voc.oct, voice: plan.voice === "male" ? VOICES["female"]! : VOICES["male"]!, gain: 0.42, pan: -0.3, delaySec: 0.008 }, stack, sr, vr, tick);
    const oohNotes: SungNote[] = voc.ooh.map((o) => ({ t: o.t, dur: o.dur, midi: o.midi, vel: 0.6, syl: { onset: [], nucleus: "UW", coda: [], stress: 1 }, vib: 0.8, breath: 2, vowelEnd: o.t + o.dur * 0.92 }));
    if (oohNotes.length) await renderVocalPart({ notes: oohNotes, voice: VOICES["female"]!, gain: 0.3, pan: 0 }, stack, sr, vr, tick);
    addInto(bus, stack, 1);

    progress(0.68, "Polishing the vocal");
    /* clarity first: less mud, more presence in the consonant range, then a touch of harmonic excitation so words stay readable at moderate level */
    eqStereo(bus, [{ type: "hp", f: 95 }, { type: "peak", f: 280, q: 1, g: -2.6 }, { type: "peak", f: 1900, q: 0.9, g: 1.4 }, { type: "peak", f: 3300, q: 0.9, g: 3.4 }, { type: "hs", f: 10000, g: 2.2 }, { type: "peak", f: 7200, q: 3, g: -2.5 }], sr);
    compress(bus, { thresh: -24, ratio: 3.2, attack: 6, release: 85, knee: 8, makeup: 3.5 }, sr);
    exciteHighs(bus, sr, 2400, 2.4, 0.13);
    /* the space around the voice is kept smaller than before: a wet wash lowers the dry level the ear uses to follow the words */
    addInto(bus, reverb(bus, { rt60: 0.9 + 1.0 * g.reverb, size: 0.9, preMs: 28, damp: 0.45 }, sr), 0.14 + 0.07 * g.reverb);
    addInto(bus, pingPong(bus, { timeSec: plan.beat * 0.75, feedback: 0.28, lpHz: 3000 }, sr), plan.genre.rap ? 0.06 : 0.1);
    await tick();
    return bus;
  };

  const makeFx = async (): Promise<Stereo> => {
    progress(0.38, "Adding transitions");
    const bus = mkStereo(total), fx = fxEvents(plan);
    for (const r of fx.risers) addInto(bus, renderRiser(r.t, r.dur, plan.key.root + 36, total, sr, rng), 0.5);
    for (const t of fx.impacts) addInto(bus, renderImpact(t, plan.key.root + 36, total, sr, rng), 0.7);
    if (g.vinyl) addInto(bus, renderVinyl(total, sr, rng), 1);
    addInto(bus, reverb(bus, { rt60: 2.4, size: 1.2 }, sr), 0.2);
    return bus;
  };

  /* ---- build -> automate -> level -> place, one bus at a time (peak memory stays near 3 stereo buffers) ----
     Vocal-first mix: the band is balanced against the singer, the singer is built last and then ridden (see mix-analysis.ts).
     That keeps the lyric audible in every section instead of trusting one loudness number for the whole track. */
  const REF = -20;                                   /* anchor loudness; the master normalises the sum afterwards */
  const mix = mkStereo(total);
  const stems: Record<string, number> = {};
  const lf = (s: Stereo): number => integratedLufs(s, sr);
  const stem = opts.stem ?? "full";
  const together = sung && stem === "full";          /* a full mix with a lead vocal: meter, carve and ride */
  const activity = together ? vocalActivity(voc.lead, plan.totalSec + tail) : null;
  const meters = together ? {
    speech: { vocal: new BandEnergy(total, sr, SPEECH_BAND), back: new BandEnergy(total, sr, SPEECH_BAND) },
    clarity: { vocal: new BandEnergy(total, sr, CLARITY_BAND), back: new BandEnergy(total, sr, CLARITY_BAND) },
    overall: { vocal: new BandEnergy(total, sr, FULL_BAND), back: new BandEnergy(total, sr, FULL_BAND) },
  } : null;
  /* how much of the speech band each backing bus gives up while the lead is singing (dB): pads and leads fight the voice most, drums and bass least */
  const CARVE_DB: Record<BusName, number> = { vocal: 0, drums: 1.6, bass: 0.8, chords: 4.5, lead: 5, fx: 3.5 };
  /* ...and over which range: bright buses (distorted guitars, saws, shimmer) reach into the consonant band, so their carve extends higher */
  const CARVE_BAND: Record<BusName, [number, number]> = { vocal: [260, 4200], drums: [300, 4200], bass: [250, 1800], chords: [250, 5800], lead: [250, 5800], fx: [250, 5800] };
  const place = (name: BusName, bus: Stereo, offDb: number, depth = 1): void => {
    applyDynamics(bus, plan, name, sr, depth);       /* verses breathe, pre-choruses build, choruses open up */
    const m = lf(bus);
    if (m < -69) { stems[name] = -99; bus.l = new Float32Array(0); bus.r = new Float32Array(0); return; }
    const gdb = clamp(REF + offDb - m, -24, 12);
    if (meters && activity && name !== "vocal") {
      carveForVocal(bus, activity, CARVE_DB[name], sr, CARVE_BAND[name]);   /* after the level is chosen, so re-normalising can not undo the carve */
      meters.speech.back.add(bus, gdb); meters.clarity.back.add(bus, gdb); meters.overall.back.add(bus, gdb);
    }
    addInto(mix, bus, dbToGain(gdb)); stems[name] = Math.round((m + gdb) * 10) / 10;
    bus.l = new Float32Array(0); bus.r = new Float32Array(0);   /* release before the next bus is built */
  };

  let vocalsOn = false, balance: VocalBalance | undefined;
  if (sung && stem === "vocals") {                   /* acapella: the singer alone */
    const vocalBus = await makeVocals();
    vocalsOn = peakDb(vocalBus) > -70;
    place("vocal", vocalBus, 0, 0.85);
  }
  const off = sung && stem === "full" ? { drums: -4.5, bass: -7.5, chords: -8, lead: -10, fx: -16 } : { drums: 0, bass: -5, chords: -0.6, lead: -1.6, fx: -10 };
  await tick();
  if (stem !== "vocals") {
  place("drums", await makeDrums(), off.drums);
  if (g.sidechain > 0 && kicks.length) {
    const bassBus = await makeBass();
    mulEnv(bassBus, sidechainEnv(kicks, total, sr, Math.min(0.65, g.sidechain * 0.7), 0.12));
    place("bass", bassBus, off.bass);
    const chordBus = await makeChords();
    mulEnv(chordBus, sidechainEnv(kicks, total, sr, g.sidechain * 0.85, 0.15));
    place("chords", chordBus, off.chords);
    const leadBus = await makeLead();
    mulEnv(leadBus, sidechainEnv(kicks, total, sr, g.sidechain * 0.45, 0.14));
    place("lead", leadBus, off.lead);
  } else {
    place("bass", await makeBass(), off.bass);
    place("chords", await makeChords(), off.chords);
    place("lead", await makeLead(), off.lead);
  }
  place("fx", await makeFx(), off.fx, 0.6);
  }
  if (together) {
    /* the singer goes in last: measured against everything else, then ridden to a fixed distance above the band */
    const vocalBus = await makeVocals();
    vocalsOn = peakDb(vocalBus) > -70;
    progress(0.8, "Balancing the vocal against the band");
    applyDynamics(vocalBus, plan, "vocal", sr, 0.85);
    const m = lf(vocalBus);
    if (vocalsOn && m > -69 && meters) {
      scaleInPlace(vocalBus, dbToGain(clamp(REF - m, -24, 12)));
      meters.speech.vocal.add(vocalBus); meters.clarity.vocal.add(vocalBus); meters.overall.vocal.add(vocalBus);
      /* ride: wherever the band would bury the lyric, lift the singer to TARGET dB over it (speech band); gentle trims when it is far above */
      const curve = vocalRideCurve(meters.speech, { targetDb: VOCAL_TARGET_DB, clarityTargetDb: VOCAL_CLARITY_DB, maxSpeechDb: VOCAL_TARGET_DB + 4, maxBoostDb: 12, maxCutDb: 4, headroomDb: 5 }, meters.clarity);
      applyRide(vocalBus, curve, sr);
      balance = vocalBalance(
        { vocal: rideEnergy(meters.speech.vocal, curve), back: meters.speech.back },
        { vocal: rideEnergy(meters.clarity.vocal, curve), back: meters.clarity.back },
        { vocal: rideEnergy(meters.overall.vocal, curve), back: meters.overall.back },
      );
      stems["vocal"] = Math.round(lf(vocalBus) * 10) / 10;
      addInto(mix, vocalBus, 1);
    } else stems["vocal"] = -99;
    vocalBus.l = new Float32Array(0); vocalBus.r = new Float32Array(0);
  }
  progress(0.88, "Mixing");
  await tick();

  /* ---- master: gentle glue, balanced spectrum, wide stereo, loudness target -------------------------------- */
  progress(0.92, "Mastering");
  applyDips(mix, preChorusDips(plan), sr);           /* stop-time breath right before each chorus lands */
  eqStereo(mix, [
    { type: "hp", f: 30, q: 0.8 }, { type: "hp", f: 30, q: 0.8 },
    { type: "peak", f: 58, q: 0.9, g: -1.6 }, { type: "ls", f: 120, g: -0.6 },          /* keep the low end tight */
    { type: "peak", f: 380, q: 0.9, g: -0.9 },
    { type: "peak", f: 3200, q: 0.8, g: 1.1 }, { type: "peak", f: 5200, q: 0.9, g: 0.9 }, /* presence */
    { type: "hs", f: 9000, g: 2.0 * (0.7 + 0.6 * g.bright) },                           /* air */
  ], sr);
  compress(mix, { thresh: -15, ratio: 1.45, attack: 34, release: 230, knee: 10, makeup: 0.9 }, sr);
  midSide(mix, 1.16, 220, sr);
  for (let i = 0; i < total; i++) { mix.l[i] = softClip(mix.l[i]!, 1.1); mix.r[i] = softClip(mix.r[i]!, 1.1); }
  const target = opts.targetLufs ?? -14;
  const fade = Math.floor(Math.min(2.5, tail * 0.7) * sr);
  for (let i = 0; i < fade; i++) { const k = (1 - i / fade) ** 1.5, j = total - fade + i; mix.l[j]! *= k; mix.r[j]! *= k; }
  const inFade = Math.floor(0.012 * sr);
  for (let i = 0; i < inFade; i++) { const k = i / inFade; mix.l[i]! *= k; mix.r[i]! *= k; }
  let cur = lf(mix);
  scaleInPlace(mix, dbToGain(target - cur + 0.6));
  limit(mix, -1.0, sr, 5, 140);
  cur = lf(mix);
  if (Math.abs(cur - target) > 0.3) { scaleInPlace(mix, dbToGain((target - cur) * 0.9)); limit(mix, -1.0, sr, 5, 140); cur = lf(mix); }
  const pk = peakDb(mix);
  progress(0.98, "Encoding");
  await tick();
  const wav = opts.skipWav ? new Uint8Array(0) : encodeWav16(mix, sr, new Rng(plan.seed));
  progress(1, "Done");
  /* waveform + short-term loudness contour for the UI */
  const bins = 720, waveform: number[] = [], hop = Math.max(1, Math.floor(total / bins));
  for (let b = 0; b < bins; b++) {
    let pkv = 0; const a = b * hop, e = Math.min(total, a + hop);
    for (let i = a; i < e; i += 3) { const v = Math.max(Math.abs(mix.l[i]!), Math.abs(mix.r[i]!)); if (v > pkv) pkv = v; }
    waveform.push(Math.min(255, Math.round(pkv * 255)));
  }
  const contour: number[] = [], win = Math.floor(3 * sr);
  for (let a = 0; a + win <= total; a += win) {
    let acc = 0;
    for (let i = a; i < a + win; i += 2) acc += mix.l[i]! * mix.l[i]! + mix.r[i]! * mix.r[i]!;
    contour.push(Math.round(10 * 10 * Math.log10(acc / (win / 2) / 2 + 1e-12)) / 10);
  }
  return {
    wav, pcm: { l: mix.l, r: mix.r, sampleRate: sr }, durationSec: total / sr,
    info: {
      bpm: plan.bpm, key: plan.key.name, genre: g.label, sections: plan.sections.map((sc) => ({ name: sc.name, start: Math.round(sc.startBar * plan.bar * 10) / 10, bars: sc.bars, kind: sc.kind })),
      lufs: Math.round(cur * 10) / 10, peakDb: Math.round(pk * 10) / 10, ms: Math.round(now() - t0), stems,
      lyrics: lyricTimeline(plan), waveform, contour, durationSec: Math.round((total / sr) * 10) / 10, sampleRate: sr, voice: plan.voice, vocalsRendered: vocalsOn,
      ...(balance ? { vocalBalance: balance } : {}),
    },
  };
}
