import type { SongSpec } from "@/lib/song";
import { extractJsonObject } from "@/lib/json-repair";

const MAX_SECONDS = 240;

const asString = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const asNumber = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Removes stage directions, section tags and markdown the model sometimes leaves inside a lyric line. */
export function cleanLyricLine(raw: string): string {
  return raw
    .replace(/\[[^\]]{0,40}\]/g, " ")          /* [Chorus] [x2] [Verse 1] */
    .replace(/\((?:x\d+|repeat[^)]*|chorus|verse[^)]*|bridge|instrumental)\)/gi, " ")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLyrics(raw: unknown): { section: string; lines: string[]; ph?: string[] }[] {
  if (!Array.isArray(raw)) return [];
  const out: { section: string; lines: string[]; ph?: string[] }[] = [];
  raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .slice(0, 26)
    .forEach((s, i) => {
      const lines: string[] = [], ph: string[] = [];
      const rawLines = Array.isArray(s["lines"]) ? (s["lines"] as unknown[]) : typeof s["lines"] === "string" ? String(s["lines"]).split(/\r?\n/) : [];
      const rawPh = Array.isArray(s["ph"]) ? (s["ph"] as unknown[]) : [];
      rawLines.forEach((l, li) => {
        if (typeof l !== "string") return;
        const t = cleanLyricLine(l);
        if (t.length < 2 || !/[\p{L}]/u.test(t)) return;
        lines.push(t.slice(0, 120));
        ph.push(typeof rawPh[li] === "string" ? (rawPh[li] as string).trim() : "");
      });
      if (lines.length) out.push({ section: asString(s["section"], `Section ${i + 1}`).slice(0, 40), lines: lines.slice(0, 16), ...(ph.some(Boolean) ? { ph: ph.slice(0, 16) } : {}) });
    });
  return out;
}

const normalizeChords = (raw: unknown): string[][] =>
  Array.isArray(raw)
    ? raw.filter((c): c is unknown[] => Array.isArray(c)).map((c) => c.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, 8)).filter((c) => c.length > 0).slice(0, 26)
    : [];

/** Seconds one 2-bar line takes at this tempo (the composer's default pacing). */
export const secondsPerLine = (bpm: number): number => 480 / Math.max(40, bpm);

/** How many sung lines fit the target duration (leaving ~14 s for intro, outro and breaks). */
/** The length a person asked for ("a 30 second song", "one minute", "2 minute"), kept within the song limits. */
export function requestedSongSeconds(prompt: string): number | undefined {
  const clamp = (v: number): number => Math.min(MAX_SECONDS, Math.max(15, Math.round(v)));
  const sec = /(\d{1,3})\s*-?\s*(?:seconds?|secs?)\b/i.exec(prompt);
  if (sec) return clamp(Number(sec[1]));
  const min = /(\d{1,2})\s*-?\s*(?:minutes?|mins?)\b/i.exec(prompt);
  if (min) return clamp(Number(min[1]) * 60);
  if (/\b(?:a|one)\s+minute\b/i.test(prompt)) return 60;
  return undefined;
}

/**
 * Makes a song fit the length the person asked for. The lyric is shortened to the lines that length can sing: a verse excerpt, then
 * the hook (the chorus), so a 30-second song still ends on its hook. Instrumentals only take the new length.
 */
export function shapeSongForRequest(spec: SongSpec, asked: number | undefined): SongSpec {
  if (asked === undefined) return spec;
  if (spec.instrumental) return { ...spec, durationSec: asked };
  const budget = lyricBudget(spec.bpm, asked);
  const sections = spec.lyrics.map((section, index) => ({ section, index })).filter((x) => x.section.lines.length > 0);
  const total = sections.reduce((n, x) => n + x.section.lines.length, 0);
  if (total <= budget) return { ...spec, durationSec: asked };
  const hook = sections.find((x) => /chorus|hook/i.test(x.section.section));
  const verse = sections.find((x) => x !== hook && /verse/i.test(x.section.section));
  let picked: { index: number; take: number }[];
  if (hook && verse) {
    const hookTake = Math.min(hook.section.lines.length, Math.max(2, Math.floor(budget / 2)));
    const verseTake = Math.max(1, Math.min(verse.section.lines.length, budget - hookTake));
    picked = [{ index: verse.index, take: verseTake }, { index: hook.index, take: hookTake }];
  } else {
    let left = budget;
    picked = [];
    for (const x of sections) {
      if (left <= 0) break;
      const take = Math.min(x.section.lines.length, left);
      picked.push({ index: x.index, take });
      left -= take;
    }
  }
  picked.sort((a, b) => a.index - b.index);
  const lyrics = picked.map(({ index, take }) => {
    const section = spec.lyrics[index]!;
    return { ...section, lines: section.lines.slice(0, take), ...(section.ph ? { ph: section.ph.slice(0, take) } : {}) };
  });
  return {
    ...spec,
    durationSec: asked,
    lyrics,
    ...(spec.chords ? { chords: picked.map(({ index }) => spec.chords?.[index] ?? []) } : {}),
  };
}

export function lyricBudget(bpm: number, durationSec: number): number {
  return Math.max(8, Math.floor((durationSec - 14) / secondsPerLine(bpm)));
}

export const countLines = (spec: Pick<SongSpec, "lyrics">): number => spec.lyrics.reduce((n, s) => n + s.lines.length, 0);

export type LyricIssue = { severity: "major" | "minor"; problem: string };

/** Static songwriting checks. A "major" issue triggers one automatic rewrite pass. */
export function lyricIssues(spec: SongSpec): LyricIssue[] {
  if (spec.instrumental) return [];
  const out: LyricIssue[] = [];
  const total = countLines(spec), budget = lyricBudget(spec.bpm, spec.durationSec);
  const names = spec.lyrics.map((s) => s.section.toLowerCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (spec.durationSec >= 150 && total < budget * 0.62) out.push({ severity: "major", problem: `Only ${total} sung lines for a ${Math.round(spec.durationSec)} s song at ${spec.bpm} bpm - it needs about ${budget} (two bars per line). Add a full second verse, a longer final chorus and a bridge.` });
  if (!has(/chorus|hook|refrain/)) out.push({ severity: "major", problem: "There is no Chorus section - every song needs a repeated, singable hook." });
  if (spec.durationSec >= 150 && !has(/verse/)) out.push({ severity: "major", problem: "There is no Verse section." });
  if (spec.durationSec >= 180 && !has(/bridge|middle|breakdown/)) out.push({ severity: "minor", problem: "A song this long needs a Bridge that changes perspective or intensity." });
  const all = spec.lyrics.flatMap((s) => s.lines.map((l) => l.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim()));
  const unique = new Set(all).size;
  if (all.length >= 12 && unique / all.length < 0.45) out.push({ severity: "minor", problem: "Too much of the lyric is repeated lines - write fresh imagery in the verses." });
  const generic = /\b(this is our sound|turn it up higher|take me higher)\b/i;
  if (all.some((l) => generic.test(l))) out.push({ severity: "major", problem: "The lyric is the generic placeholder text. Write real, specific lyrics about the user's topic." });
  return out;
}

const words = (prompt: string): string[] => prompt.replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|about|that|this|make|write|create|song|music|sing|please|want|need|can|you|give|some|minute|minutes|min|long)$/i.test(w));
const titleCase = (s: string): string => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Last-resort lyric built from the user's own words (only used when the model returned nothing usable). */
export function promptSpec(prompt?: string): SongSpec {
  const w = words(prompt ?? "");
  const topic = (w.slice(0, 3).join(" ") || "tonight").toLowerCase();
  const title = titleCase(w.slice(0, 4).join(" ") || "Zeros Track").slice(0, 48);
  const hook = [`${titleCase(topic)}, ${topic}, say it loud`, `Every heartbeat knows the way`, `${titleCase(topic)}, ${topic}, don't let go`, `We were born to feel this day`];
  return {
    title, bpm: 104, durationSec: 180, style: "modern cinematic pop", voice: "female", vocalStyle: "airy and powerful", genre: "pop", key: "A minor",
    lyrics: [
      { section: "Verse 1", lines: [`I keep thinking about ${topic}`, "Like a song I can't unhear", "Every street is telling stories", "Every shadow draws me near", "I was lost inside the static", "Now the signal's coming through", "Every step I'm getting closer", "Every road leads back to you"] },
      { section: "Pre-Chorus", lines: ["Hold on, the night is turning", "Feel the fire start to climb"] },
      { section: "Chorus", lines: [...hook, "Hold it close and hold it tight", "Let it carry us tonight"] },
      { section: "Verse 2", lines: ["Morning breaks across the skyline", "Gold on every window pane", "All the things I used to run from", "Now I'm dancing in the rain", "Every doubt becomes a doorway", "Every scar becomes a song", "I was never really broken", "I was learning where I belong"] },
      { section: "Pre-Chorus", lines: ["Hold on, the night is turning", "Feel the fire start to climb"] },
      { section: "Chorus", lines: [...hook, "Hold it close and hold it tight", "Let it carry us tonight"] },
      { section: "Bridge", lines: ["And if the world goes quiet", "I will sing it twice as loud", "Out of every broken moment", "I will build a crown"] },
      { section: "Final Chorus", lines: [...hook, "Hold it close and hold it tight", "Let it carry us tonight", `${titleCase(topic)}, ${topic}`, "Take me home tonight"] },
    ],
    arrangement: { seed: Math.floor(Math.random() * 1e9) },
  };
}

export type ParsedSong = { spec: SongSpec; fromFallback: boolean; witty: string };

/**
 * Parses the model's song reply: fenced / bare / truncated JSON all work (every complete section is salvaged).
 * `fromFallback` is true only when nothing usable came back, so the caller can retry instead of shipping filler.
 */
export function parseSong(full: string, prompt?: string): ParsedSong {
  const witty = (full.split("{")[0] ?? "").replace(/```[a-z]*/gi, "").replace(/\s+/g, " ").trim().slice(0, 220);
  const parsed = extractJsonObject(full);
  const lyrics = parsed ? normalizeLyrics(parsed["lyrics"]) : [];
  const instrumentalAsked = /\b(instrumental|no vocals?|without vocals?|purely instrumental|beat only|just a beat)\b/i.test(prompt ?? "");
  if (!parsed || (!lyrics.length && !(parsed["instrumental"] === true && instrumentalAsked))) return { spec: promptSpec(prompt), fromFallback: true, witty };

  const chords = normalizeChords(parsed["chords"]);
  const arr = parsed["arrangement"] && typeof parsed["arrangement"] === "object" ? (parsed["arrangement"] as Record<string, unknown>) : {};
  const bpm = asNumber(parsed["bpm"], 104, 55, 178);
  const spec: SongSpec = {
    title: asString(parsed["title"], prompt?.slice(0, 48) || "Zeros Track").slice(0, 60),
    bpm,
    durationSec: asNumber(parsed["durationSec"], instrumentalAsked ? 150 : 200, 45, MAX_SECONDS),
    ...(typeof parsed["genre"] === "string" && parsed["genre"].trim() ? { genre: parsed["genre"].trim().slice(0, 40) } : {}),
    ...(typeof parsed["key"] === "string" && parsed["key"].trim() ? { key: parsed["key"].trim().slice(0, 24) } : {}),
    ...(parsed["instrumental"] === true && instrumentalAsked ? { instrumental: true } : {}),
    style: asString(parsed["style"], "modern pop").slice(0, 200),
    voice: asString(parsed["voice"], "female").slice(0, 60),
    vocalStyle: asString(parsed["vocalStyle"], "airy and powerful").slice(0, 120),
    lyrics,
    ...(chords.length ? { chords } : {}),
    arrangement: { seed: asNumber(arr["seed"], Math.floor(Math.random() * 1e9), 0, 2_147_483_647), swing: asNumber(arr["swing"], 0, 0, 0.35) },
  };
  return { spec, fromFallback: false, witty };
}

/** Backwards-compatible entry point. */
export function parseSongSpecFromResponse(full: string, prompt?: string): SongSpec {
  return parseSong(full, prompt).spec;
}

/* ------------------------------------------------------------------ lyric exports */

const stamp = (sec: number): string => {
  const s = Math.max(0, sec), m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
};

/** Synced-lyrics (.lrc) file: works in most music players. */
export function buildLrc(title: string, lyrics: { t: number; dur: number; text: string }[], durationSec: number): string {
  const head = [`[ti:${title}]`, "[ar:Zeros by VsiStudio]", "[al:Zeros Originals]", "[by:Zeros - VsiStudio]", `[length:${stamp(durationSec).slice(0, 5)}]`];
  const body: string[] = [];
  lyrics.forEach((l, i) => {
    body.push(`[${stamp(l.t)}]${l.text}`);
    const next = lyrics[i + 1];
    if (!next || next.t - (l.t + l.dur) > 3) body.push(`[${stamp(l.t + l.dur)}]`); /* clear the line during instrumental gaps */
  });
  return [...head, ...body].join("\n") + "\n";
}

/** Plain lyric sheet with section headings. */
export function buildLyricsText(spec: Pick<SongSpec, "title" | "lyrics">): string {
  return `${spec.title}\nZeros by VsiStudio\n\n` + spec.lyrics.map((s) => `[${s.section}]\n${s.lines.join("\n")}`).join("\n\n") + "\n";
}
