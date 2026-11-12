import { Rng, hashString, clamp } from "./dsp";
import {
  parseChord, parseKey, pickBpm, pickGenre, progressionFor, scaleStep, snapToScale, chordTonesNear, voiceChord, inScale,
  type Chord, type Genre, type KeyInfo, type SectionKind,
} from "./theory";
import { lineToSyllables, type LyricSyl } from "./lyrics";
import type { DrumEv, DrumName, NoteEv } from "./instruments";
import type { SungNote } from "./vocal";

/* ------------------------------------------------------------------ input */
export type SongInput = {
  title?: string; bpm?: number; durationSec?: number; style?: string; voice?: string; vocalStyle?: string; genre?: string; key?: string; instrumental?: boolean;
  lyrics?: { section: string; lines: string[]; ph?: string[] }[];
  chords?: string[][];
  arrangement?: { seed?: number; swing?: number };
};

export type PlanLine = { text: string; syl: LyricSyl[]; startBar: number; bars: number };
export type PlanSection = { idx: number; name: string; kind: SectionKind; bars: number; startBar: number; energy: number; chords: Chord[]; lines: PlanLine[]; variant: number; last?: boolean };
export type Plan = {
  bpm: number; beat: number; bar: number; swing: number; key: KeyInfo; genre: Genre; sections: PlanSection[]; totalBars: number; totalSec: number; seed: number;
  rap: boolean; voice: "male" | "female" | "duet"; instrumental: boolean; rng: Rng; title: string;
};

function classify(name: string): SectionKind {
  const n = name.toLowerCase();
  if (/intro/.test(n)) return "intro";
  if (/pre[- ]?chorus|build|lift/.test(n)) return "pre";
  if (/chorus|hook|refrain|drop/.test(n)) return "chorus";
  if (/bridge|middle|breakdown/.test(n)) return "bridge";
  if (/outro|ending|coda|tag/.test(n)) return "outro";
  if (/solo|instrumental|break|interlude/.test(n)) return "break";
  return "verse";
}

const ENERGY: Record<SectionKind, number> = { intro: 0.3, verse: 0.45, pre: 0.65, chorus: 0.92, bridge: 0.5, break: 0.75, outro: 0.32 };

export function buildPlan(spec: SongInput): Plan {
  const seed = (spec.arrangement?.seed ?? hashString(`${spec.title ?? ""}|${spec.style ?? ""}|${(spec.lyrics ?? []).map((s) => s.lines.join("/")).join("|").slice(0, 400)}`)) >>> 0;
  const rng = new Rng(seed);
  const genre = pickGenre(spec.genre, spec.style, spec.title, spec.vocalStyle);
  const bpm = pickBpm(genre, spec.bpm, rng);
  const beat = 60 / bpm, bar = beat * 4;
  /* a song asked to be under 45 seconds keeps shorter sections (2-bar minimum, 1 bar a line, 2-bar intro and outro) */
  const shortSong = (spec.durationSec ?? 150) < 45;
  const firstChord = spec.chords?.[0]?.[0];
  const hasKey = !!spec.key || !!firstChord;
  let key = parseKey(spec.key, firstChord);
  if (!hasKey) key = parseKey(`${["C", "D", "E", "F", "G", "A"][rng.int(0, 5)]} ${rng.chance(genre.minorBias) ? "minor" : "major"}`);
  const voiceText = `${spec.voice ?? ""} ${spec.vocalStyle ?? ""} ${spec.style ?? ""}`.toLowerCase();
  const voice: Plan["voice"] = /duet|duo|male and female|both/.test(voiceText) ? "duet" : /\b(female|woman|girl|she|her|soprano|alto)\b/.test(voiceText) ? "female" : /\b(male|man|boy|he|his|tenor|baritone|bass)\b/.test(voiceText) ? "male" : rng.chance(0.5) ? "female" : "male";
  const rap = !!genre.rap && /rap|hip|trap|drill|flow/.test(`${voiceText} ${genre.id}`) || /\brap(per)?\b/.test(voiceText);

  const lyrics = (spec.lyrics ?? []).filter((s) => s.lines?.some((l) => l.trim()));
  // a repeated line (chorus) only needs its phonemes written once
  const phByLine = new Map<string, string>();
  const lineKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  for (const sec of lyrics) sec.lines.forEach((l, i) => { const ph = sec.ph?.[i]; if (ph && ph.trim().length > 1 && !phByLine.has(lineKey(l))) phByLine.set(lineKey(l), ph); });
  for (const sec of lyrics) sec.ph = sec.lines.map((l, i) => sec.ph?.[i] && sec.ph[i]!.trim().length > 1 ? sec.ph[i]! : (phByLine.get(lineKey(l)) ?? ""));
  const isInstrumental = !!spec.instrumental || lyrics.length === 0;
  const sections: PlanSection[] = [];
  const kindCount: Record<string, number> = {};
  const layout = (lines: { text: string; syl: LyricSyl[] }[], bars: number): PlanLine[] => {
    const n = lines.length, per = bars / Math.max(1, n);
    return lines.map((l, i) => {
      const startBar = Math.round(i * per * 2) / 2;
      const endBar = i === n - 1 ? bars : Math.round((i + 1) * per * 2) / 2;
      return { text: l.text, syl: l.syl, startBar, bars: Math.max(1, endBar - startBar) };
    });
  };
  /** Re-times a section so its lines take `perLine` bars each (1.5 = tighter flow, 2 = relaxed). */
  const retime = (sec: PlanSection, perLine: number): void => {
    if (!sec.lines.length) return;
    const bars = Math.max(shortSong ? 2 : 4, Math.ceil((sec.lines.length * perLine) / 2) * 2);
    sec.bars = bars;
    sec.lines = layout(sec.lines, bars);
  };
  const addSection = (name: string, kind: SectionKind, bars: number, lines: { text: string; ph?: string }[]) => {
    const variant = kindCount[kind] ?? 0;
    kindCount[kind] = variant + 1;
    sections.push({ idx: sections.length, name, kind, bars, startBar: 0, energy: ENERGY[kind], chords: [], lines: [], variant });
    const sec = sections[sections.length - 1]!;
    if (lines.length) sec.lines = layout(lines.map((l) => ({ text: l.text, syl: lineToSyllables(l.text, l.ph) })), bars);
  };

  const hasIntro = lyrics.some((s) => classify(s.section) === "intro");
  if (!hasIntro) addSection("Intro", "intro", shortSong ? 2 : 4, []);
  const body = isInstrumental
    ? ((): { section: string; lines: string[] }[] => {
        // an instrumental has no lyrics, so the melody is written over placeholder syllables ("la") that give it a singable rhythm
        const themeA = ["la la la la la la", "la la la la la la la", "la la la la la la", "la la la la la la la la"], themeB = ["la la la la la la la la", "la la la la la la", "la la la la la la la la", "la la la la la la"];
        const plan: [string, string[]][] = [["Theme A", themeA], ["Theme B", themeB], ["Theme A", themeA], ["Theme B", themeB], ["Bridge", ["la la la la la la", "la la la la la la la"]], ["Final Theme", themeB]];
        const need = Math.max(3, Math.round((clamp(spec.durationSec ?? 100, 45, 240) / bar - 8) / 8));
        return plan.slice(0, Math.min(plan.length, need)).map(([section, lines]) => ({ section, lines }));
      })()
    : lyrics;
  body.forEach((sec, si) => {
    const kind = isInstrumental ? (sec.section.startsWith("Theme B") || sec.section === "Final Theme" ? "chorus" : sec.section === "Bridge" ? "bridge" : "verse") : classify(sec.section);
    const lines = sec.lines.map((t, i) => { const ph = (sec as { ph?: string[] }).ph?.[i]; return ph ? { text: t.trim(), ph } : { text: t.trim() }; }).filter((l) => l.text);
    if (!lines.length && kind !== "intro" && kind !== "outro" && kind !== "break") return;
    const bars = isInstrumental ? 8 : kind === "intro" || kind === "outro" || kind === "break" ? (lines.length ? Math.max(4, Math.ceil(lines.length * 2 / 4) * 4) : 4) : kind === "pre" ? Math.max(4, Math.min(8, Math.ceil(lines.length * 2 / 4) * 4)) : clamp(Math.ceil((lines.length * 2) / 4) * 4, 4, 16);
    void si;
    addSection(sec.section, kind, bars, lines);
  });
  const hasOutro = sections.some((s) => s.kind === "outro");
  if (!hasOutro) addSection("Outro", "outro", shortSong ? 2 : 4, []);
  if (shortSong) for (const s of sections) if (s.lines.length && s.kind !== "intro" && s.kind !== "outro") retime(s, 1);
  if (!sections.some((s) => s.kind === "chorus") && sections.filter((s) => s.kind === "verse").length >= 2) sections.filter((s) => s.kind === "verse").forEach((s, i) => { if (i % 2 === 1) { s.kind = "chorus"; s.energy = ENERGY.chorus; } });

  // length fitting: tighten pacing before cutting anything, then extend with real musical sections until the song reaches its target
  const CAP = 240;
  const target = clamp(spec.durationSec ?? 150, shortSong ? 15 : 45, CAP);
  const secOf = () => sections.reduce((a, s) => a + s.bars, 0) * bar;
  for (const kinds of [["verse"], ["pre", "bridge"], ["chorus"]] as SectionKind[][]) {
    if (secOf() <= CAP) break;
    for (const s of sections) if (kinds.includes(s.kind) && s.lines.length >= 2) retime(s, 1.5);
  }
  const keepFirst = (s: PlanSection, i: number): boolean => {
    const firstChorus = sections.findIndex((x) => x.kind === "chorus"), lastChorus = sections.map((x) => x.kind).lastIndexOf("chorus");
    return s.kind === "intro" || s.kind === "outro" || (s.kind === "verse" && s.variant === 0) || i === firstChorus || i === lastChorus;
  };
  const dropRank = (s: PlanSection): number => (s.kind === "break" ? 0 : s.kind === "pre" && s.variant >= 1 ? 1 : s.kind === "bridge" ? 2 : s.kind === "verse" && s.variant >= 2 ? 3 : s.kind === "chorus" ? 4 : s.kind === "verse" ? 5 : 9);
  while (secOf() > CAP && sections.length > 4) {
    const cand = sections.map((s, i) => ({ s, i, r: dropRank(s) })).filter(({ s, i, r }) => r < 9 && !keepFirst(s, i)).sort((a, b) => a.r - b.r || b.i - a.i)[0];
    if (!cand) break;
    sections.splice(cand.i, 1);
  }
  /* still over the cap with only protected sections left: sing faster (1 bar per line), then trim the longest sections' tail lines */
  for (const kinds of [["verse"], ["pre", "bridge"], ["chorus"]] as SectionKind[][]) {
    if (secOf() <= CAP) break;
    for (const s of sections) if (kinds.includes(s.kind) && s.lines.length >= 2) retime(s, 1);
  }
  for (let guardTrim = 0; secOf() > CAP && guardTrim < 80; guardTrim++) {
    const longest = sections.filter((s) => s.lines.length > 4).sort((a, b) => b.bars - a.bars)[0];
    if (!longest) break;
    longest.lines = longest.lines.slice(0, -1);
    retime(longest, 1);
  }
  const room = (extraBars: number): boolean => secOf() + extraBars * bar <= Math.min(CAP, target * 1.06 + 1);
  for (let guard = 0; guard < 10 && secOf() < target * 0.94; guard++) {
    const intro = sections.find((s) => s.kind === "intro"), outro = sections.find((s) => s.kind === "outro");
    const lastChorusAt = sections.map((s) => s.kind).lastIndexOf("chorus"), lastChorus = lastChorusAt >= 0 ? sections[lastChorusAt] : undefined;
    if (intro && !intro.lines.length && intro.bars < 8 && room(4)) { intro.bars += 4; continue; }
    if (lastChorus && !sections.some((s) => s.kind === "break") && room(8)) {
      sections.splice(lastChorusAt, 0, { idx: 0, name: "Instrumental break", kind: "break", bars: 8, startBar: 0, energy: ENERGY.break, chords: [], lines: [], variant: 0 });
      continue;
    }
    if (outro && !outro.lines.length && outro.bars < 8 && room(4)) { outro.bars += 4; continue; }
    if (lastChorus && sections.filter((s) => s.name === "Final Chorus" || s.name === "Double Chorus").length < 2 && room(lastChorus.bars)) {
      sections.splice(lastChorusAt + 1, 0, { ...lastChorus, idx: 0, name: lastChorus.name === "Final Chorus" ? "Double Chorus" : "Final Chorus", lines: lastChorus.lines.map((l) => ({ ...l })), chords: [] });
      continue;
    }
    const prev = lastChorusAt > 0 ? sections[lastChorusAt - 1] : undefined;
    if (lastChorus && prev && prev.kind !== "pre" && prev.kind !== "break" && room(4)) {
      sections.splice(lastChorusAt, 0, { idx: 0, name: "Build", kind: "pre", bars: 4, startBar: 0, energy: ENERGY.pre, chords: [], lines: [], variant: 1 });
      continue;
    }
    break;
  }

  let startBar = 0;
  const lastChorusIdx = sections.map((s) => s.kind).lastIndexOf("chorus");
  sections.forEach((s, i) => {
    s.idx = i; s.startBar = startBar; startBar += s.bars;
    if (i === lastChorusIdx) { s.last = true; s.energy = 1; }
    if (s.kind === "verse" && s.variant > 0) s.energy += 0.1;
    // chords: LLM-supplied (per lyric section) when valid, else template
    const supplied = spec.chords?.[Math.min(i - (hasIntro ? 0 : 1), (spec.chords?.length ?? 1) - 1)]?.map((c) => parseChord(String(c))).filter((c): c is Chord => !!c);
    const base = supplied && supplied.length >= 2 ? supplied : progressionFor(key, s.kind, s.kind === "chorus" ? 0 : s.variant, genre.sevenths);
    s.chords = Array.from({ length: s.bars }, (_, b) => base[b % base.length]!);
  });
  const totalBars = startBar;
  return { bpm, beat, bar, swing: spec.arrangement?.swing ?? genre.swing, key, genre, sections, totalBars, totalSec: totalBars * bar, seed, rap: rap && !isInstrumental, voice, instrumental: isInstrumental, rng, title: spec.title ?? "Zeros Track" };
}

/* ----------------------------------------------------------------- drums */
const row = (s: string): number[] => s.replace(/\s+/g, "").split("").map((c) => Number(c) / 9);
type Pat = { kick: string; snare?: string; clap?: string; hat?: string; open?: string; ride?: string; shaker?: string; rim?: string; tom?: string; kick2?: string };
const PATTERNS: Record<Genre["drums"], Pat> = {
  backbeat: { kick: "9000 0010 9000 0100", kick2: "9000 0000 9010 0000", snare: "0000 9000 0000 9000", hat: "7060 7060 7060 7060", open: "0000 0000 0000 0003" },
  four: { kick: "9000 9000 9000 9000", clap: "0000 9000 0000 9000", hat: "4040 4040 4040 4040", open: "0030 0030 0030 0030", shaker: "0504 0504 0504 0504" },
  trap: { kick: "9000 0001 0090 0010", snare: "0000 0000 9000 0000", clap: "0000 0000 8000 0000", hat: "7070 7070 7070 7777", open: "0000 0000 0000 0200" },
  boombap: { kick: "9000 0090 0090 0000", kick2: "9000 0000 0990 0000", snare: "0000 9000 0000 9000", hat: "7060 7060 7060 7060" },
  lofi: { kick: "8000 0080 0070 0000", snare: "0000 7000 0000 7000", rim: "0000 0000 0000 0003", hat: "5030 5030 5030 5030", shaker: "0300 0300 0300 0300" },
  halftime: { kick: "9000 0000 0090 0000", snare: "0000 0000 9000 0000", clap: "0000 0000 6000 0000", hat: "5353 5353 5353 5353" },
  dnb: { kick: "9000 0000 0090 0000", snare: "0000 9000 0000 9000", hat: "7373 7373 7373 7373", open: "0000 0030 0000 0030" },
  dembow: { kick: "9000 9000 9000 9000", snare: "0009 0090 0009 0090", rim: "0000 0000 0000 0000", hat: "0030 0030 0030 0030", shaker: "5454 5454 5454 5454" },
  afro: { kick: "9000 0090 0090 0000", rim: "0009 0009 0009 0900", hat: "0030 0030 0030 0030", shaker: "6464 6464 6464 6464", snare: "0000 0000 0000 0000" },
  ballad: { kick: "9000 0000 6000 0000", snare: "0000 6000 0000 6000", ride: "5040 5040 5040 5040" },
  cinematic: { kick: "0000 0000 0000 0000", tom: "9000 0000 8000 0000" },
  synthwave: { kick: "9000 0000 9000 0090", snare: "0000 9000 0000 9000", hat: "6050 6050 6050 6050", open: "0000 0000 0000 0003" },
  funk: { kick: "9000 0100 0090 0010", snare: "0000 9000 0100 9001", hat: "7353 7353 7353 7353", open: "0000 0000 0000 0005" },
};

export function drumEvents(plan: Plan): DrumEv[] {
  const ev: DrumEv[] = [], rng = new Rng(plan.seed ^ 0xd7a3), g = plan.genre, pat = PATTERNS[g.drums], stepDur = plan.beat / 4;
  const kickName: DrumName = g.drums === "lofi" ? "kickSoft" : g.drums === "ballad" || g.drums === "cinematic" || g.drums === "trap" || g.drums === "halftime" ? "kickDeep" : "kick";
  const snareName: DrumName = g.drums === "lofi" || g.drums === "ballad" ? "rim" : g.drums === "synthwave" || g.drums === "dnb" || g.drums === "funk" ? "snareTight" : "snare";
  const swingShift = (step: number): number => (plan.swing > 0 ? (step % 4 === 2 ? plan.swing * plan.beat * 0.3 : step % 2 === 1 ? plan.swing * plan.beat * 0.12 : 0) : 0);
  const add = (t: number, drum: DrumName, vel: number, jitter: number, pan = 0) => ev.push({ t: Math.max(0, t + (rng.next() - 0.5) * 2 * jitter), drum, vel: clamp(vel * (0.92 + rng.next() * 0.16), 0.05, 1.1), pan });
  const kick = row(pat.kick), kick2 = pat.kick2 ? row(pat.kick2) : kick, snare = row(pat.snare ?? "0".repeat(16)), clap = row(pat.clap ?? "0".repeat(16)), hat = row(pat.hat ?? "0".repeat(16)), open = row(pat.open ?? "0".repeat(16));
  const ride = row(pat.ride ?? "0".repeat(16)), shaker = row(pat.shaker ?? "0".repeat(16)), rim = row(pat.rim ?? "0".repeat(16)), tom = row(pat.tom ?? "0".repeat(16));
  plan.sections.forEach((sec, si) => {
    const e = sec.energy;
    const next = plan.sections[si + 1];
    for (let b = 0; b < sec.bars; b++) {
      const t0 = (sec.startBar + b) * plan.bar, last = b === sec.bars - 1, firstBar = b === 0;
      const fill = last && next && (next.energy > e + 0.12 || sec.kind === "pre" || sec.kind === "bridge") && b > 0 && g.drums !== "cinematic";
      const kpat = b % 4 === 3 ? kick2 : kick;
      const breakdown = sec.kind === "bridge" && b < 2;
      for (let st = 0; st < 16; st++) {
        const t = t0 + st * stepDur + swingShift(st);
        const inFill = fill && st >= 12;
        if (e >= 0.35 && !breakdown && !(inFill && g.drums !== "four") && kpat[st]! > 0 && !(sec.kind === "intro" && e < 0.4 && st > 0 && b < 2)) add(t, kickName, kpat[st]! * (0.75 + 0.25 * e), 0.003);
        if (e >= 0.55 && !breakdown && !inFill) {
          if (snare[st]! > 0) add(t, snareName, snare[st]! * (0.8 + 0.2 * e), 0.004, 0);
          if (clap[st]! > 0) add(t, "clap", clap[st]! * (0.8 + 0.2 * e), 0.004, 0);
          if (rim[st]! > 0) add(t, "rim", rim[st]! * 0.8, 0.004, 0.2);
        }
        if (e >= 0.3 && hat[st]! > 0 && !inFill) add(t, "hatC", hat[st]! * (0.55 + 0.45 * e), 0.006, 0.18 * (st % 8 < 4 ? 1 : -1));
        if (e >= 0.8 && open[st]! > 0) add(t, "hatO", open[st]! * 0.9, 0.004, -0.15);
        if (e >= 0.4 && ride[st]! > 0 && !inFill) add(t, "ride", ride[st]! * 0.6, 0.006, 0.3);
        if (e >= 0.45 && shaker[st]! > 0) add(t, "shaker", shaker[st]! * 0.8, 0.006, 0.25 * (st % 2 ? 1 : -1));
        if (tom[st]! > 0 && e >= 0.5) add(t, "tomL", tom[st]! * (0.6 + 0.4 * e), 0.003);
      }
      if (fill) {
        const style = (si + b) % 3;
        for (let k = 0; k < 4; k++) {
          const t = t0 + (12 + k) * stepDur;
          if (style === 0) add(t, k < 2 ? "tomH" : "tomM", 0.55 + k * 0.1, 0.002, -0.2 + k * 0.15);
          else add(t, snareName === "rim" ? "snare" : snareName, 0.45 + k * 0.14, 0.002);
        }
        add(t0 + 12 * stepDur, kickName, 0.8, 0.002);
      }
      if (firstBar && (sec.kind === "chorus" || (sec.kind === "break" && e > 0.6)) && g.drums !== "lofi") add(t0, "crash", sec.last ? 1 : 0.8, 0.002, 0.1);
      if (firstBar && g.drums === "cinematic" && e >= 0.6) { add(t0, "tomL", 1, 0.002); add(t0, "crash", 0.7, 0.002); }
    }
  });
  return ev.sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------------ bass */
export function bassEvents(plan: Plan): { notes: NoteEv[]; kind: Genre["bass"] } {
  const rng = new Rng(plan.seed ^ 0xba55), g = plan.genre, out: NoteEv[] = [], stepDur = plan.beat / 4;
  const place = (c: Chord): number => { let m = 28 + ((c.bass - 28) % 12 + 12) % 12; if (m < 29) m += 12; if (m > 41) m -= 12; return m; };
  const kickRow = row(PATTERNS[g.drums].kick);
  plan.sections.forEach((sec) => {
    if (sec.energy < 0.3 || (sec.kind === "intro" && g.bass !== "sub" && sec.energy < 0.35)) return;
    for (let b = 0; b < sec.bars; b++) {
      const c = sec.chords[b]!, root = place(c), fifth = root + 7, t0 = (sec.startBar + b) * plan.bar;
      const nextC = sec.chords[b + 1] ?? plan.sections[sec.idx + 1]?.chords[0] ?? c, approach = place(nextC);
      const hit = (st: number, lenSteps: number, midi: number, vel: number, glideFrom?: number) => out.push({ t: t0 + st * stepDur, dur: Math.max(0.05, lenSteps * stepDur * 0.92), midi, vel: vel * (0.8 + 0.2 * sec.energy), ...(glideFrom ? { glideFrom } : {}) });
      const low = sec.energy < 0.5;
      switch (g.bass) {
        case "offbeat": for (const st of [2, 6, 10, 14]) hit(st, 1.6, root, 0.85); break;
        case "808": {
          const steps = kickRow.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
          const use = sec.energy < 0.6 ? [0, ...(steps.includes(10) ? [10] : [])] : steps.length ? steps : [0];
          use.forEach((st, i) => { const nxt = use[i + 1] ?? 16; hit(st, Math.min(14, nxt - st + (i === use.length - 1 ? -0.5 : 0)), st === 14 || (i > 0 && rng.chance(0.2)) ? fifth - 12 + 12 : root, 0.95, i > 0 && rng.chance(0.25) ? root : undefined); });
          break;
        }
        case "sub": if (low || g.drums === "ballad" || g.drums === "cinematic") { hit(0, 14, root, 0.8); } else { for (const st of [0, 6, 8, 11]) hit(st, st === 0 ? 5 : 2.5, st === 11 ? fifth - 12 + 12 : root, 0.85); } break;
        case "electric": case "pluck": for (let st = 0; st < 16; st += 2) hit(st, 1.7, st === 14 && b % 2 === 1 ? approach : st % 8 === 6 ? root + 12 : st === 12 && rng.chance(0.4) ? fifth : root, st % 4 === 0 ? 0.95 : 0.7); break;
        case "synth": default: {
          const pat = b % 2 === 0 ? [0, 3, 6, 8, 11, 14] : [0, 2, 6, 8, 10, 14];
          pat.forEach((st) => hit(st, st === 0 || st === 8 ? 2.6 : 1.8, st === 14 ? approach : st === 11 && rng.chance(0.5) ? fifth : root, st % 8 === 0 ? 0.95 : 0.75));
        }
      }
    }
  });
  return { notes: out.sort((a, b) => a.t - b.t), kind: g.bass };
}

/* ---------------------------------------------------------- chord tracks */
export type ChordTrack = { kind: Genre["chords"]; notes: NoteEv[]; strums: { t: number; notes: number[]; dir: 1 | -1; vel: number; dur: number; spread: number }[]; layerPad: NoteEv[] };

export function chordEvents(plan: Plan): ChordTrack {
  const rng = new Rng(plan.seed ^ 0xc40d), g = plan.genre, stepDur = plan.beat / 4;
  const notes: NoteEv[] = [], strums: ChordTrack["strums"] = [], layerPad: NoteEv[] = [];
  let prev: number[] | undefined;
  plan.sections.forEach((sec) => {
    if (sec.energy < 0.2) return;
    for (let b = 0; b < sec.bars; b++) {
      const c = sec.chords[b]!, t0 = (sec.startBar + b) * plan.bar, e = sec.energy;
      const center = g.chords === "strings" ? 62 : g.chords === "pad" || g.chords === "supersaw" ? 60 : g.chords === "bell" ? 72 : 58;
      const v = voiceChord(c, center, prev, g.chords === "rhodes" || g.chords === "piano" ? 4 : 3);
      prev = v;
      const push = (st: number, len: number, midis: number[], vel: number, extra: Partial<NoteEv> = {}) => midis.forEach((m, i) => notes.push({ t: t0 + st * stepDur + i * 0.004 * (g.chords === "piano" ? 1 : 0), dur: len * stepDur, midi: m, vel: vel * (0.8 + 0.2 * e), ...extra }));
      switch (g.chords) {
        case "pad": case "strings": push(0, 16, v, 0.7); if (g.chords === "strings" && e > 0.8) push(0, 16, [v[0]! - 12], 0.6); break;
        case "supersaw": {
          if (e < 0.5) push(0, 16, v, 0.55); else { for (const st of [0, 3, 6, 10, 12]) push(st, 1.6, v, 0.8); layerPad.push(...v.map((m) => ({ t: t0, dur: plan.bar, midi: m - 12, vel: 0.5 }))); }
          break;
        }
        case "bell": for (let st = 0; st < 16; st += 2) if (rng.chance(0.55 + 0.3 * e)) notes.push({ t: t0 + st * stepDur, dur: 3 * stepDur, midi: v[(st / 2 + b) % v.length]! + 12, vel: 0.5 + 0.2 * rng.next() }); layerPad.push(...v.map((m) => ({ t: t0, dur: plan.bar, midi: m, vel: 0.35 }))); break;
        case "rhodes": case "piano": {
          if (g.drums === "ballad" || g.drums === "cinematic" || e < 0.4) {
            const arp = [0, 1, 2, 3, 2, 1, 2, 3];
            arp.forEach((ai, k) => notes.push({ t: t0 + k * 2 * stepDur, dur: 3 * stepDur, midi: v[ai % v.length]! + (ai === 3 ? 12 : 0), vel: 0.55 + 0.25 * (k % 4 === 0 ? 1 : 0) }));
            notes.push({ t: t0, dur: plan.bar, midi: v[0]! - 12, vel: 0.5 });
          } else if (e < 0.8 || g.id === "lofi") { for (const st of [0, 6, 10]) push(st, st === 0 ? 5 : 3.5, v, st === 0 ? 0.85 : 0.65); }
          else { push(0, 6, v, 0.9); for (const st of [8, 10, 12, 14]) push(st, 1.8, v.slice(1), 0.7); }
          break;
        }
        case "guitar": {
          const gv = voiceChord(c, 52, undefined, 5), bassNote = ((c.bass - 40) % 12 + 12) % 12 + 40;
          const shape = [bassNote, ...gv.filter((m) => m > bassNote + 2).slice(0, 4)];
          if (g.drums === "ballad" || e < 0.4) {
            const order = [0, 2, 3, 2, 1, 2, 3, 2];
            order.forEach((oi, k) => strums.push({ t: t0 + k * 2 * stepDur, notes: [shape[oi % shape.length]!], dir: 1, vel: 0.55 + (k % 4 === 0 ? 0.2 : 0), dur: 4 * stepDur, spread: 0 }));
          } else {
            const pat: [number, 1 | -1, number][] = e > 0.8 ? [[0, 1, 0.95], [4, 1, 0.7], [6, -1, 0.6], [8, 1, 0.9], [10, -1, 0.65], [12, 1, 0.75], [14, -1, 0.6]] : [[0, 1, 0.9], [6, -1, 0.6], [8, 1, 0.8], [10, -1, 0.6], [14, -1, 0.55]];
            for (const [st, dir, vel] of pat) strums.push({ t: t0 + st * stepDur + swingStep(plan, st, stepDur), notes: shape, dir, vel, dur: st === 0 || st === 8 ? 5 * stepDur : 2.5 * stepDur, spread: 0.011 });
          }
          break;
        }
      }
    }
  });
  return { kind: g.chords, notes, strums, layerPad };
}
const swingStep = (plan: Plan, st: number, stepDur: number): number => (plan.swing > 0 ? (st % 4 === 2 ? plan.swing * plan.beat * 0.3 : st % 2 === 1 ? plan.swing * stepDur * 0.5 : 0) : 0);

export function arpEvents(plan: Plan): NoteEv[] {
  if (!plan.genre.arp) return [];
  const out: NoteEv[] = [], stepDur = plan.beat / 4, rng = new Rng(plan.seed ^ 0xa49);
  plan.sections.forEach((sec) => {
    if (sec.energy < (plan.genre.id === "cinematic" ? 0.5 : 0.45)) return;
    for (let b = 0; b < sec.bars; b++) {
      const c = sec.chords[b]!, tones = voiceChord(c, 72, undefined, 4), t0 = (sec.startBar + b) * plan.bar;
      const up = [0, 1, 2, 3, 2, 1, 2, 1];
      for (let st = 0; st < 16; st++) { if (plan.genre.id === "trap" && !rng.chance(0.6)) continue; const k = up[st % 8]!; out.push({ t: t0 + st * stepDur + swingStep(plan, st, stepDur), dur: stepDur * 0.8, midi: tones[k % tones.length]! + (st % 8 === 7 ? 12 : 0), vel: st % 4 === 0 ? 0.85 : 0.55, pan: Math.sin(st) * 0.4 }); }
    }
  });
  return out;
}

/* ------------------------------------------------------------ vocal melody */
type Contour = number[]; // scale-step offsets over normalised line time
const CONTOURS: Record<string, Contour> = {
  arch: [0, 1, 2, 3, 3, 2, 1, 0], descend: [4, 3, 3, 2, 1, 1, 0, -1], ascend: [-1, 0, 0, 1, 2, 3, 3, 4], plateau: [2, 2, 3, 2, 1, 2, 3, 1], wave: [0, 1, 2, 1, 0, 1, 2, 2],
  hook: [2, 4, 4, 3, 4, 5, 4, 2], low: [0, -1, 0, 1, 0, -1, 0, 0], question: [0, 1, 1, 2, 3, 2, 3, 4],
};

export type LyricTiming = { t: number; dur: number; text: string; section: string; kind: SectionKind };

/** Every sung line with its start time and length in seconds (drives karaoke highlighting and .lrc export). */
export function lyricTimeline(plan: Plan): LyricTiming[] {
  const out: LyricTiming[] = [];
  for (const sec of plan.sections) for (const line of sec.lines) {
    out.push({ t: (sec.startBar + line.startBar) * plan.bar, dur: line.bars * plan.bar, text: line.text, section: sec.name, kind: sec.kind });
  }
  return out;
}

export type VocalPlan = { lead: SungNote[]; dbl: SungNote[]; harm: SungNote[]; oct: SungNote[]; ooh: { t: number; dur: number; midi: number }[]; breaths: number[]; hook: NoteEv[]; range: [number, number] };

export function vocalEvents(plan: Plan): VocalPlan {
  const rng = new Rng(plan.seed ^ 0x70ca1);
  const lead: SungNote[] = [], dbl: SungNote[] = [], harm: SungNote[] = [], oct: SungNote[] = [], ooh: VocalPlan["ooh"] = [], breaths: number[] = [], hook: NoteEv[] = [];
  const female = plan.voice !== "male", rap = plan.rap;
  const lo = female ? 57 : 45, hi = female ? 76 : 66, baseCenter = female ? 64 : 55;
  const motifs = new Map<string, Contour[]>();
  const contourOrder: Record<SectionKind, string[]> = {
    verse: ["plateau", "wave", "plateau", "question"], pre: ["ascend", "ascend", "hook", "ascend"], chorus: ["hook", "arch", "hook", "descend"], bridge: ["low", "wave", "ascend", "arch"], intro: ["arch"], outro: ["descend", "arch"], break: ["arch"],
  };
  let lastPitch = baseCenter;
  plan.sections.forEach((sec) => {
    if (!sec.lines.length) return;
    const key = sec.kind;
    const lift = sec.kind === "chorus" ? 3.5 : sec.kind === "pre" ? 1.5 : sec.kind === "bridge" ? 1 : 0, finalLift = sec.last ? 2 : 0;
    const centerBase = baseCenter + lift + finalLift - (sec.kind === "verse" && sec.variant === 0 ? 1 : 0);
    const seen = motifs.get(key) ?? [];
    sec.lines.forEach((line, li) => {
      const syl = line.syl;
      if (!syl.length) return;
      const secT = sec.startBar * plan.bar, lineT = secT + line.startBar * plan.bar, lineLen = line.bars * plan.bar;
      const slotDur = plan.beat / 2;
      const totalSlots = Math.round(lineLen / slotDur);
      const tail = rap ? 1 : totalSlots >= 12 ? 2 : totalSlots >= 8 ? 1 : 0;
      let mul = 1;
      while (syl.length > (totalSlots - tail) * mul && mul < 4) mul *= 2;
      const slots = (totalSlots - tail) * mul, sd = slotDur / mul;
      // onsets: evenly spread, then pull stressed syllables onto strong slots
      let pos = syl.map((_, i) => Math.round((i * slots) / syl.length));
      for (let i = 1; i < pos.length; i++) if (pos[i]! <= pos[i - 1]!) pos[i] = pos[i - 1]! + 1;
      const strong = (p: number) => p % (2 * mul) === 0;
      if (!rap) for (let i = 0; i < syl.length; i++) {
        if (syl[i]!.stress >= 1 && !strong(pos[i]!)) {
          const cand = pos[i]! + (((pos[i]! % (2 * mul)) <= mul) ? -(pos[i]! % (2 * mul)) : (2 * mul - (pos[i]! % (2 * mul))));
          const free = (i === 0 || cand > pos[i - 1]!) && (i === syl.length - 1 || cand < pos[i + 1]!);
          if (free && Math.abs(cand - pos[i]!) <= mul) pos[i] = cand;
        }
      }
      if (sec.kind === "chorus" && li % 2 === 1 && syl.length > 4 && !rap && rng.chance(0.6)) pos = pos.map((p, i) => (i > 0 && i % 3 === 2 && p - 1 > pos[i - 1]! ? p - 1 : p)); // anticipation
      const endSlot = slots + (tail > 0 && (sec.kind === "chorus" || li === sec.lines.length - 1) ? 1 : 0) * mul;
      // contour (shared across repeats of this section kind)
      const contourName = contourOrder[sec.kind]?.[li % (contourOrder[sec.kind]?.length ?? 1)] ?? "arch";
      let contour: Contour = seen[li] ?? CONTOURS[contourName]!;
      if (sec.kind === "chorus" && li === 2 && seen[0]) contour = seen[0]!;
      seen[li] = contour; motifs.set(key, seen);
      const center = clamp(centerBase, lo + 3, hi - 3);
      let pitch = snapToScale(Math.round(clamp(lastPitch * 0.35 + center * 0.65, lo, hi)), plan.key);
      if (Math.abs(centerBase - lastPitch) > 9) pitch = snapToScale(Math.round(lastPitch + clamp(centerBase - lastPitch, -9, 9) * 0.65), plan.key);
      let prevM: number | undefined = undefined, prevPrev: number | undefined = undefined;
      const notesThisLine: SungNote[] = [];
      const bars = sec.chords;
      for (let i = 0; i < syl.length; i++) {
        const tn = i / Math.max(1, syl.length - 1);
        const t = lineT + pos[i]! * sd;
        const nextPos = i + 1 < syl.length ? pos[i + 1]! : endSlot;
        const durSlots = Math.max(1, nextPos - pos[i]!);
        const dur = durSlots * sd;
        const barIdx = clamp(Math.floor((t - secT) / plan.bar), 0, sec.bars - 1), chord = bars[barIdx]!;
        let target: number;
        if (rap) target = center - 3 + (syl[i]!.stress ? 1 : 0) * 1.5 + 2.5 * (1 - tn) * (li % 2 ? 0.5 : 1);
        else {
          const x = tn * (contour.length - 1), i0 = Math.floor(x), f = x - i0;
          const off = contour[i0]! * (1 - f) + (contour[Math.min(contour.length - 1, i0 + 1)] ?? contour[i0]!) * f;
          const base = scaleStep(snapToScale(Math.round(center), plan.key), Math.round(off), plan.key);
          target = base;
        }
        const longNote = dur >= plan.beat * 0.95 || (strong(pos[i]!) && syl[i]!.stress >= 1);
        let m = rap ? Math.round(target) : (longNote || i === syl.length - 1) ? nearest(chordTonesNear(chord, target), target) : snapToScale(Math.round(target), plan.key);
        if (!rap && prevM !== undefined && !longNote && i !== syl.length - 1 && syl[i]!.stress === 0) {
          // passing / neighbour tone: step from the previous pitch toward where the line is heading
          const dir = target > prevM + 0.5 ? 1 : target < prevM - 0.5 ? -1 : (i % 2 ? 1 : -1);
          m = scaleStep(prevM, dir, plan.key);
        }
        if (!rap && prevM !== undefined && prevPrev !== undefined && m === prevM && prevM === prevPrev) m = scaleStep(m, target >= m ? 1 : -1, plan.key);
        if (i === syl.length - 1 && !rap) {
          const open = sec.kind === "verse" && li % 2 === 0;
          m = open ? scaleStep(nearest(chordTonesNear(chord, target), target), 1, plan.key) : nearest(chordTonesNear(chord, target), target);
        }
        // limit leaps and stay in range
        if (prevM !== undefined && !rap) { while (m - prevM > 7) m -= 12; while (prevM - m > 7) m += 12; if (Math.abs(m - prevM) > 5 && Math.abs(m - prevM) <= 7 && rng.chance(0.5)) m = scaleStep(prevM, m > prevM ? 3 : -3, plan.key); }
        while (m > hi) m -= 12; while (m < lo) m += 12;
        pitch = m; prevPrev = prevM;
        const gap = i > 0 ? t - (notesThisLine[i - 1]!.t + notesThisLine[i - 1]!.dur) : 1;
        const sn: SungNote = {
          t, dur: dur * (rap ? 0.8 : i === syl.length - 1 ? 0.97 : 0.94), midi: m, vel: (0.62 + 0.38 * (syl[i]!.stress ? 1 : 0.55)) * (0.8 + 0.2 * sec.energy) * (sec.last ? 1.08 : 1),
          syl: syl[i]!, ...(prevM !== undefined ? { prevMidi: prevM } : {}), legato: !rap && i > 0 && gap < 0.03, scoop: i === 0 && !rap, vib: rap ? 0 : dur > plan.beat * 0.9 ? 1 : 0.3, breath: sec.kind === "bridge" ? 1.8 : sec.kind === "chorus" ? 0.8 : 1.1,
        };
        notesThisLine.push(sn);
        prevM = m;
      }
      // vowel / onset timing so consonants never collide
      notesThisLine.forEach((n, i) => {
        const nxt = notesThisLine[i + 1];
        const codaLen = n.syl.coda.length ? Math.min(0.2, 0.06 * n.syl.coda.length + 0.03) : 0;
        let vEnd = n.t + n.dur - codaLen;
        if (nxt) {
          const onsetLen = Math.min(0.14, nxt.syl.onset.length * 0.055);
          vEnd = Math.min(vEnd, nxt.t - onsetLen - codaLen);
          n.onsetStart = n.t - Math.min(0.16, n.syl.onset.length * 0.06 + 0.01);
        } else n.onsetStart = n.t - Math.min(0.16, n.syl.onset.length * 0.06 + 0.01);
        n.vowelEnd = Math.max(n.t + 0.07, vEnd);
      });
      breaths.push(lineT - 0.16);
      lead.push(...notesThisLine);
      lastPitch = pitch;
    });

    // backing layers
    const secNotes = lead.filter((n) => n.t >= sec.startBar * plan.bar && n.t < (sec.startBar + sec.bars) * plan.bar);
    if (!rap || sec.kind === "chorus") for (const n of secNotes) dbl.push({ ...n });
    if (sec.kind === "chorus" || sec.kind === "bridge" || sec.kind === "pre") for (const n of secNotes) if (n.dur > 0.3 && !rap) {
      const chord = sec.chords[clamp(Math.floor((n.t - sec.startBar * plan.bar) / plan.bar), 0, sec.bars - 1)]!;
      let h = scaleStep(n.midi, 2, plan.key); if (!chordTonesNear(chord, h).includes(h) && !inScale(h, plan.key)) h = n.midi + 4;
      harm.push((({ prevMidi: _p, ...rest }) => ({ ...rest, midi: h, legato: false, vel: n.vel * 0.9 }))(n));
      if (sec.kind === "chorus") oct.push((({ prevMidi, ...rest }) => ({ ...rest, midi: n.midi + (female ? -12 : 12), ...(prevMidi !== undefined ? { prevMidi: prevMidi + (female ? -12 : 12) } : {}), vel: n.vel * 0.8 }))(n));
    }
  });
  // sustained "ooh" pad in bridge / outro / pre-chorus tails
  plan.sections.forEach((sec) => {
    if (sec.kind === "bridge" || sec.kind === "outro" || sec.last) for (let b = 0; b < sec.bars; b += 2) {
      const c = sec.chords[b]!, v = voiceChord(c, female ? 66 : 57, undefined, 3);
      if (sec.kind === "outro" || b % 4 === 0) v.forEach((m) => ooh.push({ t: (sec.startBar + b) * plan.bar, dur: plan.bar * 2 * 0.98, midi: m }));
    }
  });
  // instrumental hook = first two chorus lines reused as a lead riff
  const chorus = plan.sections.find((s) => s.kind === "chorus");
  if (chorus) {
    const t0 = chorus.startBar * plan.bar;
    for (const n of lead.filter((x) => x.t >= t0 && x.t < t0 + 2 * plan.bar * 2)) hook.push({ t: n.t - t0, dur: n.dur, midi: n.midi + (female ? 0 : 12), vel: n.vel });
  }
  return { lead, dbl, harm, oct, ooh, breaths, hook, range: [lo, hi] };
}

function nearest(list: number[], target: number): number {
  if (!list.length) return Math.round(target);
  return list.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

export function leadHookEvents(plan: Plan, hook: NoteEv[]): NoteEv[] {
  if (!hook.length || plan.genre.lead === "none") return [];
  const out: NoteEv[] = [];
  plan.sections.forEach((sec, i) => {
    const reuse = sec.kind === "break" || (sec.kind === "intro" && sec.bars >= 4 && plan.sections[i + 1]?.kind !== undefined && (plan.genre.id !== "ballad")) || (sec.kind === "outro" && sec.bars >= 4) || (sec.kind === "pre" && false);
    if (!reuse) return;
    const start = sec.kind === "intro" ? Math.max(0, sec.bars - 4) : 0, reps = sec.kind === "break" ? 2 : 1;
    for (let r = 0; r < reps; r++) for (const n of hook) out.push({ ...n, t: (sec.startBar + start + r * 4) * plan.bar + n.t, vel: n.vel * (sec.kind === "outro" ? 0.7 : 0.9) });
  });
  return out.filter((n) => n.t < plan.totalSec);
}

/** Riser + impact positions in seconds. */
export function fxEvents(plan: Plan): { risers: { t: number; dur: number }[]; impacts: number[] } {
  const risers: { t: number; dur: number }[] = [], impacts: number[] = [];
  plan.sections.forEach((sec, i) => {
    const nx = plan.sections[i + 1];
    if (nx && nx.kind === "chorus" && (sec.kind === "pre" || sec.kind === "verse" || sec.kind === "bridge" || sec.kind === "break") && plan.genre.drums !== "lofi") {
      const dur = Math.min(2 * plan.bar, 6);
      risers.push({ t: (sec.startBar + sec.bars) * plan.bar - dur, dur });
    }
    if (sec.kind === "chorus" && sec.variant === 0 && plan.genre.id !== "lofi") impacts.push(sec.startBar * plan.bar);
    if (sec.last) impacts.push(sec.startBar * plan.bar);
  });
  return { risers, impacts };
}
