import { Rng } from "./dsp";

export const NOTE_PC: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
export const PC_NAME = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

export type KeyInfo = { root: number; mode: string; scale: number[]; minor: boolean; name: string };

export function pcOf(name: string): number | undefined {
  const m = name.trim().match(/^([A-Ga-g])([#b♯♭]?)/);
  if (!m) return undefined;
  const k = m[1]!.toUpperCase() + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2] ?? "");
  return NOTE_PC[k];
}

export function parseKey(text: string | undefined, firstChord?: string): KeyInfo {
  let root: number | undefined;
  let mode = "major";
  if (text) {
    const t = text.trim();
    const m = t.match(/^(?:the\s+)?(?:key\s+of\s+)?([A-Ga-g][#b♯♭]?)(?![a-z])\s*(major|minor|maj|min|m\b|dorian|mixolydian|phrygian|lydian)?/i);
    if (m) {
      root = pcOf(m[1]!);
      const q = (m[2] ?? "").toLowerCase();
      if (q === "minor" || q === "min" || q === "m") mode = "minor";
      else if (SCALES[q]) mode = q;
      else if (/m$/.test(m[1]!) && !/maj/i.test(t)) mode = "major";
    }
  }
  if (root === undefined && firstChord) {
    const c = parseChord(firstChord);
    if (c) { root = c.root; mode = c.minor ? "minor" : "major"; }
  }
  if (root === undefined) root = 0;
  return { root, mode, scale: SCALES[mode] ?? SCALES["major"]!, minor: mode === "minor" || mode === "phrygian" || mode === "dorian", name: `${PC_NAME[root]} ${mode}` };
}

export type Chord = { root: number; bass: number; intervals: number[]; minor: boolean; sym: string };

const QUAL: [RegExp, number[]][] = [
  [/^maj13|^maj11|^maj9$/i, [0, 4, 7, 11, 14]], [/^(maj7|M7|Δ7?)$/, [0, 4, 7, 11]], [/^m7b5$|^ø$/, [0, 3, 6, 10]], [/^(m9|min9)$/, [0, 3, 7, 10, 14]],
  [/^(m11|min11)$/, [0, 3, 7, 10, 14]], [/^(m7|min7|-7)$/, [0, 3, 7, 10]], [/^(m6|min6)$/, [0, 3, 7, 9]], [/^(m|min|-)$/, [0, 3, 7]],
  [/^dim7$/, [0, 3, 6, 9]], [/^(dim|°)$/, [0, 3, 6]], [/^(aug|\+)$/, [0, 4, 8]], [/^7sus4$/, [0, 5, 7, 10]], [/^sus2$/, [0, 2, 7]], [/^(sus4|sus)$/, [0, 5, 7]],
  [/^add9$/, [0, 4, 7, 14]], [/^(9|11|13)$/, [0, 4, 7, 10, 14]], [/^7$/, [0, 4, 7, 10]], [/^6$/, [0, 4, 7, 9]], [/^5$/, [0, 7]], [/^(maj|M)?$/, [0, 4, 7]],
];

export function parseChord(sym: string): Chord | null {
  const m = sym.trim().match(/^([A-Ga-g][#b♯♭]?)([^/\s]*)(?:\/([A-Ga-g][#b♯♭]?))?$/);
  if (!m) return null;
  const root = pcOf(m[1]!);
  if (root === undefined) return null;
  const q = m[2] ?? "";
  let intervals: number[] | undefined;
  for (const [re, iv] of QUAL) if (re.test(q)) { intervals = iv; break; }
  if (!intervals) return null;
  const bass = m[3] ? (pcOf(m[3]) ?? root) : root;
  return { root, bass, intervals, minor: intervals[1] === 3, sym: sym.trim() };
}

export function chordFrom(rootPc: number, quality: string): Chord {
  return parseChord(`${PC_NAME[((rootPc % 12) + 12) % 12]}${quality}`)!;
}

/** Progression templates as [semitones above tonic, quality]. */
type Step = [number, string];
const P = (...s: Step[]): Step[] => s;
export const PROGS = {
  major: {
    verse: [P([0, ""], [7, ""], [9, "m"], [5, ""]), P([0, ""], [9, "m"], [5, ""], [7, ""]), P([0, ""], [5, ""], [9, "m"], [7, ""])],
    chorus: [P([5, ""], [0, ""], [7, ""], [9, "m"]), P([0, ""], [7, ""], [9, "m"], [5, ""]), P([5, ""], [7, ""], [4, "m"], [9, "m"])],
    pre: [P([9, "m"], [5, ""], [0, ""], [7, ""]), P([2, "m"], [5, ""], [9, "m"], [7, ""])],
    bridge: [P([9, "m"], [4, "m"], [5, ""], [7, ""]), P([5, ""], [0, ""], [7, ""], [7, ""])],
  },
  minor: {
    verse: [P([0, "m"], [8, ""], [3, ""], [10, ""]), P([0, "m"], [5, "m"], [8, ""], [7, ""]), P([0, "m"], [10, ""], [8, ""], [10, ""])],
    chorus: [P([8, ""], [10, ""], [0, "m"], [0, "m"]), P([0, "m"], [8, ""], [3, ""], [10, ""]), P([3, ""], [10, ""], [8, ""], [7, ""])],
    pre: [P([5, "m"], [8, ""], [10, ""], [7, ""]), P([8, ""], [3, ""], [10, ""], [7, ""])],
    bridge: [P([8, ""], [5, "m"], [0, "m"], [7, ""]), P([3, ""], [8, ""], [10, ""], [7, ""])],
  },
} as const;

export type SectionKind = "intro" | "verse" | "pre" | "chorus" | "bridge" | "break" | "outro";

export function progressionFor(key: KeyInfo, kind: SectionKind, variant: number, sevenths: boolean): Chord[] {
  const bank = PROGS[key.minor ? "minor" : "major"];
  const k = kind === "intro" || kind === "outro" ? "verse" : kind === "break" ? "chorus" : kind;
  const opts = bank[k] ?? bank.verse;
  const prog = opts[variant % opts.length]!;
  return prog.map(([off, q]) => {
    let quality = q;
    if (sevenths) quality = q === "m" ? "m7" : q === "" ? (off === 7 ? "7" : "maj7") : q;
    return chordFrom(key.root + off, quality);
  });
}

/** Closest-voicing: returns MIDI notes (ascending) for the chord around `center`, minimising motion from `prev`. */
export function voiceChord(c: Chord, center: number, prev?: number[], maxNotes = 4): number[] {
  const pcs = c.intervals.slice(0, maxNotes).map((i) => (c.root + i) % 12);
  let best: number[] = [];
  let bestCost = Infinity;
  for (let inv = 0; inv < pcs.length; inv++) {
    const ordered = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (let oct = -1; oct <= 1; oct++) {
      const notes: number[] = [];
      let last = -Infinity;
      for (const pc of ordered) {
        let m = Math.round((center - 6 - pc) / 12) * 12 + pc + oct * 12;
        while (m <= last) m += 12;
        notes.push(m);
        last = m;
      }
      const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
      let cost = Math.abs(mean - center) * 1.2;
      if (prev?.length) for (let i = 0; i < Math.min(prev.length, notes.length); i++) cost += Math.abs(notes[i]! - prev[i]!);
      if (cost < bestCost) { bestCost = cost; best = notes; }
    }
  }
  return best;
}

export const inScale = (midi: number, key: KeyInfo): boolean => key.scale.includes((((midi - key.root) % 12) + 12) % 12);

/** Nearest scale tone to `midi` (ties go up). */
export function snapToScale(midi: number, key: KeyInfo): number {
  for (let d = 0; d < 7; d++) {
    if (inScale(midi + d, key)) return midi + d;
    if (inScale(midi - d, key)) return midi - d;
  }
  return midi;
}

/** Scale-degree arithmetic: move `steps` scale tones from `midi` (which must be in scale). */
export function scaleStep(midi: number, steps: number, key: KeyInfo): number {
  let m = snapToScale(midi, key);
  const dir = steps >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(steps); i++) {
    do m += dir; while (!inScale(m, key));
  }
  return m;
}

export function chordTonesNear(c: Chord, midi: number): number[] {
  const out: number[] = [];
  for (const i of c.intervals) {
    const pc = (c.root + i) % 12;
    for (let o = -2; o <= 2; o++) { const m = Math.round((midi - pc) / 12 + o) * 12 + pc; if (Math.abs(m - midi) <= 9) out.push(m); }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export type Genre = {
  id: string; label: string; bpm: [number, number]; swing: number;
  drums: "four" | "backbeat" | "trap" | "boombap" | "lofi" | "dnb" | "dembow" | "afro" | "ballad" | "cinematic" | "synthwave" | "funk" | "halftime";
  bass: "sub" | "synth" | "808" | "electric" | "pluck" | "offbeat";
  chords: "pad" | "rhodes" | "piano" | "guitar" | "supersaw" | "strings" | "bell";
  lead: "saw" | "square" | "pluck" | "bell" | "strings" | "none";
  arp: boolean; sidechain: number; reverb: number; bright: number; sevenths: boolean; vinyl?: boolean; rap?: boolean; minorBias: number;
  progs?: number;
};

const G = (g: Genre): Genre => g;
export const GENRES: Genre[] = [
  G({ id: "pop", label: "Pop", bpm: [100, 124], swing: 0, drums: "backbeat", bass: "synth", chords: "piano", lead: "saw", arp: false, sidechain: 0.15, reverb: 0.5, bright: 0.6, sevenths: false, minorBias: 0.35 }),
  G({ id: "dance", label: "Dance / EDM", bpm: [120, 130], swing: 0, drums: "four", bass: "offbeat", chords: "supersaw", lead: "saw", arp: true, sidechain: 0.55, reverb: 0.5, bright: 0.8, sevenths: false, minorBias: 0.5 }),
  G({ id: "house", label: "House", bpm: [118, 126], swing: 0.05, drums: "four", bass: "offbeat", chords: "rhodes", lead: "pluck", arp: false, sidechain: 0.45, reverb: 0.4, bright: 0.65, sevenths: true, minorBias: 0.5 }),
  G({ id: "trap", label: "Trap", bpm: [130, 150], swing: 0, drums: "trap", bass: "808", chords: "bell", lead: "bell", arp: true, sidechain: 0, reverb: 0.4, bright: 0.55, sevenths: false, rap: true, minorBias: 0.9 }),
  G({ id: "hiphop", label: "Hip-hop", bpm: [82, 98], swing: 0.12, drums: "boombap", bass: "sub", chords: "rhodes", lead: "none", arp: false, sidechain: 0, reverb: 0.3, bright: 0.45, sevenths: true, rap: true, minorBias: 0.8 }),
  G({ id: "rnb", label: "R&B", bpm: [68, 92], swing: 0.1, drums: "halftime", bass: "sub", chords: "rhodes", lead: "none", arp: false, sidechain: 0, reverb: 0.55, bright: 0.45, sevenths: true, minorBias: 0.55 }),
  G({ id: "lofi", label: "Lo-fi", bpm: [70, 88], swing: 0.22, drums: "lofi", bass: "sub", chords: "rhodes", lead: "bell", arp: false, sidechain: 0, reverb: 0.4, bright: 0.25, sevenths: true, vinyl: true, minorBias: 0.6 }),
  G({ id: "rock", label: "Rock", bpm: [110, 150], swing: 0, drums: "backbeat", bass: "electric", chords: "guitar", lead: "square", arp: false, sidechain: 0, reverb: 0.3, bright: 0.7, sevenths: false, minorBias: 0.4 }),
  G({ id: "indie", label: "Indie", bpm: [100, 130], swing: 0.03, drums: "backbeat", bass: "electric", chords: "guitar", lead: "pluck", arp: false, sidechain: 0, reverb: 0.5, bright: 0.55, sevenths: false, minorBias: 0.4 }),
  G({ id: "acoustic", label: "Acoustic / Folk", bpm: [80, 112], swing: 0.04, drums: "ballad", bass: "electric", chords: "guitar", lead: "none", arp: false, sidechain: 0, reverb: 0.45, bright: 0.5, sevenths: false, minorBias: 0.3 }),
  G({ id: "ballad", label: "Ballad", bpm: [60, 80], swing: 0, drums: "ballad", bass: "sub", chords: "piano", lead: "strings", arp: false, sidechain: 0, reverb: 0.65, bright: 0.4, sevenths: false, minorBias: 0.45 }),
  G({ id: "cinematic", label: "Cinematic", bpm: [70, 100], swing: 0, drums: "cinematic", bass: "sub", chords: "strings", lead: "strings", arp: true, sidechain: 0, reverb: 0.85, bright: 0.5, sevenths: false, minorBias: 0.75 }),
  G({ id: "synthwave", label: "Synthwave", bpm: [96, 118], swing: 0, drums: "synthwave", bass: "synth", chords: "supersaw", lead: "saw", arp: true, sidechain: 0.2, reverb: 0.6, bright: 0.7, sevenths: false, minorBias: 0.75 }),
  G({ id: "dnb", label: "Drum & Bass", bpm: [168, 176], swing: 0, drums: "dnb", bass: "synth", chords: "pad", lead: "saw", arp: true, sidechain: 0.3, reverb: 0.5, bright: 0.65, sevenths: true, minorBias: 0.85 }),
  G({ id: "latin", label: "Reggaeton / Latin", bpm: [88, 100], swing: 0, drums: "dembow", bass: "808", chords: "guitar", lead: "pluck", arp: false, sidechain: 0.1, reverb: 0.35, bright: 0.6, sevenths: false, minorBias: 0.7 }),
  G({ id: "afro", label: "Afrobeats", bpm: [96, 112], swing: 0.06, drums: "afro", bass: "sub", chords: "guitar", lead: "pluck", arp: false, sidechain: 0.1, reverb: 0.4, bright: 0.6, sevenths: false, minorBias: 0.4 }),
  G({ id: "funk", label: "Funk / Disco", bpm: [105, 122], swing: 0.08, drums: "funk", bass: "electric", chords: "guitar", lead: "square", arp: false, sidechain: 0.1, reverb: 0.3, bright: 0.7, sevenths: true, minorBias: 0.5 }),
];

const KEYWORDS: [RegExp, string][] = [
  [/lo-?fi|chill ?hop|study/i, "lofi"], [/trap|drill|phonk|808/i, "trap"], [/hip[- ]?hop|rap|boom ?bap/i, "hiphop"], [/r&b|rnb|soul|neo-?soul/i, "rnb"],
  [/synth ?wave|retro ?wave|80s|outrun|vaporwave/i, "synthwave"], [/drum ?(&|and|n) ?bass|dnb|jungle/i, "dnb"], [/house|deep house|tech ?house/i, "house"],
  [/edm|dance|electro|club|festival|trance|progressive|future bass|dubstep/i, "dance"], [/cinematic|epic|orchestral|score|trailer|soundtrack|film/i, "cinematic"],
  [/reggaeton|latin|salsa|bachata|dembow|bossa/i, "latin"], [/afro|amapiano|highlife/i, "afro"], [/funk|disco|groove/i, "funk"],
  [/metal|punk|grunge|hard rock|rock/i, "rock"], [/indie|alt(ernative)?|dream ?pop|shoegaze/i, "indie"], [/acoustic|folk|country|singer-?songwriter|unplugged/i, "acoustic"],
  [/ballad|slow|piano|emotional|sad|heartbreak/i, "ballad"], [/pop|k-?pop|bollywood|hindi|punjabi/i, "pop"],
];

export function pickGenre(...texts: (string | undefined)[]): Genre {
  const blob = texts.filter(Boolean).join(" ");
  const ids = GENRES.map((g) => g.id);
  const direct = ids.find((id) => new RegExp(`\\b${id}\\b`, "i").test(blob));
  let id = direct;
  if (!id) for (const [re, g] of KEYWORDS) if (re.test(blob)) { id = g; break; }
  return GENRES.find((g) => g.id === id) ?? GENRES[0]!;
}

export function pickBpm(g: Genre, requested: number | undefined, rng: Rng): number {
  if (requested && requested >= 50 && requested <= 200) return Math.round(requested);
  return Math.round(g.bpm[0] + rng.next() * (g.bpm[1] - g.bpm[0]));
}
