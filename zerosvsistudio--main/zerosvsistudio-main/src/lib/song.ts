import { renderZerosSong, type RenderInfo } from "@/lib/zeros-music/engine";
import { canEncodeOpus, encodeOpusWebm } from "@/lib/audio-encode";

export type SongSpec = {
  title: string;
  bpm: number;
  durationSec: number;
  style?: string;
  voice?: string;
  vocalStyle?: string;
  /** pop | dance | house | trap | hiphop | rnb | lofi | rock | indie | acoustic | ballad | cinematic | synthwave | dnb | latin | afro | funk */
  genre?: string;
  /** e.g. "A minor", "F# major", "D dorian" */
  key?: string;
  instrumental?: boolean;
  /** `ph` = ARPAbet pronunciation per line, words separated by "|" (written by the model; guessed when missing). */
  lyrics: { section: string; lines: string[]; ph?: string[] }[];
  /** One chord-symbol progression per lyric section, e.g. [["Am","F","C","G"], ...]. Optional. */
  chords?: string[][];
  /** Legacy fields from the old synth. Ignored by the Zeros Music engine, kept so saved songs still load. */
  melody?: { note: string; start: number; dur: number }[];
  drums?: { kick?: number[]; snare?: number[]; hat?: number[] };
  arrangement?: {
    seed?: number;
    drumStyle?: string;
    bassStyle?: string;
    leadStyle?: string;
    textureStyle?: string;
    swing?: number;
  };
};

export type SongInfoLite = Pick<RenderInfo, "bpm" | "key" | "genre" | "lufs" | "peakDb" | "lyrics" | "waveform" | "contour" | "sections" | "durationSec" | "voice" | "vocalsRendered" | "vocalBalance">;

export type SongRender = {
  /** lossless master (16-bit WAV) */
  blob: Blob;
  /** Opus-in-WebM master (about 10x smaller) when this browser can encode it, else null */
  compressed: Blob | null;
  info: RenderInfo;
};

/** Keeps the rendered-audio details that must survive a page reload (lyric timings, waveform) small enough to store with the message. */
export function liteInfo(info: RenderInfo): SongInfoLite {
  return { bpm: info.bpm, key: info.key, genre: info.genre, lufs: info.lufs, peakDb: info.peakDb, lyrics: info.lyrics, waveform: info.waveform, contour: info.contour, sections: info.sections, durationSec: info.durationSec, voice: info.voice, vocalsRendered: info.vocalsRendered, ...(info.vocalBalance ? { vocalBalance: info.vocalBalance } : {}) };
}

/**
 * A 4-minute stereo master is ~85 MB per buffer at 44.1 kHz. Phones and small laptops render long songs at 32 kHz
 * (content above 16 kHz is barely audible in a mix) so the render never runs out of memory.
 */
export function songSampleRate(durationSec: number): number {
  if (typeof navigator === "undefined") return 44100;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), mem = nav.deviceMemory ?? (mobile ? 3 : 8);
  if ((mobile || mem <= 4) && durationSec > 150) return 32000;
  if (mem <= 2) return 32000;
  return 44100;
}

/**
 * Zeros Music: Zeros composes, arranges, plays, sings and masters the track itself, entirely in the browser.
 * No external music model and no API key. onProgress receives 0..1 and a stage label.
 */
export async function renderSongDetailed(spec: SongSpec, onProgress?: (fraction: number, label: string) => void, opts: { compress?: boolean; sampleRate?: number; stem?: "full" | "instrumental" | "vocals" } = {}): Promise<SongRender> {
  const input = {
    title: spec.title,
    bpm: spec.bpm,
    durationSec: spec.durationSec,
    ...(spec.style ? { style: spec.style } : {}),
    ...(spec.voice ? { voice: spec.voice } : {}),
    ...(spec.vocalStyle ? { vocalStyle: spec.vocalStyle } : {}),
    ...(spec.genre ? { genre: spec.genre } : {}),
    ...(spec.key ? { key: spec.key } : {}),
    ...(spec.instrumental ? { instrumental: true } : {}),
    lyrics: spec.lyrics,
    ...(spec.chords ? { chords: spec.chords } : {}),
    ...(spec.arrangement ? { arrangement: { ...(spec.arrangement.seed !== undefined ? { seed: spec.arrangement.seed } : {}), ...(spec.arrangement.swing !== undefined ? { swing: spec.arrangement.swing } : {}) } } : {}),
  };
  const scaled = (a: number, b: number) => (f: number, label: string) => onProgress?.(a + (b - a) * f, label);
  const sampleRate = opts.sampleRate ?? songSampleRate(spec.durationSec);
  const result = await renderZerosSong(input, { sampleRate, stem: opts.stem ?? "full", onProgress: scaled(0, opts.compress === false ? 1 : 0.93) });
  const blob = new Blob([result.wav as BlobPart], { type: "audio/wav" });
  let compressed: Blob | null = null;
  if (opts.compress !== false && canEncodeOpus()) {
    try { compressed = await encodeOpusWebm(result.pcm, { kbps: 160, onProgress: (f) => onProgress?.(0.93 + 0.07 * f, "Compressing the master") }); } catch { compressed = null; }
  }
  onProgress?.(1, "Done");
  return { blob, compressed, info: result.info };
}

export async function renderSong(spec: SongSpec, onProgress?: (fraction: number, label: string) => void): Promise<Blob> {
  return (await renderSongDetailed(spec, onProgress, { compress: false })).blob;
}

export function noteToFreq(note: string): number {
  const m = note.match(/^([A-Ga-g])([#b]?)(-?\d)$/);
  if (!m) return 440;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const semis = (base[m[1]!.toUpperCase()] ?? 9) + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * Math.pow(2, (semis - 69) / 12);
}
