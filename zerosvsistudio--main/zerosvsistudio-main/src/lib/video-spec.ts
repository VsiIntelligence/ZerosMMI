/**
 * VideoSpec v3 - the contract between the director (language model) and the Cinema Engine.
 *
 * The model writes SEMANTIC scenes (layout, headline, stats, motif, motion level, narration). This module validates and
 * repairs them into a spec the engine can always render, converts legacy v2 films, and provides an honest fallback director
 * that builds a coherent film from the person's own words if the model is unavailable.
 */
import { extractJsonObject } from "./json-repair";
import { GENRES, pickGenre } from "./zeros-music/theory";
import { ICON_NAMES, averageColor, hsl2rgb, iconName, isColor, mixColor, readableOn, shade, toHex, type IconName } from "./video/kit";
import type { Brand, Camera, FontStyle, Layout, Motion, Palette, Transition, VideoAudio, VideoChart, VideoItem, VideoScene, VideoSpec, VideoStat, Visual, VoiceLine } from "./video/types";

export type { VideoSpec, VideoScene, VideoElement, Palette, Layout, Visual, Motion, Camera, Transition, VideoAudio, VoiceLine, VideoItem, VideoStat, VideoChart, FontStyle } from "./video/types";

export const MIN_SCENE_MS = 2200;
export const MAX_SCENE_MS = 9000;
const LAYOUTS: readonly Layout[] = ["hero", "statement", "split", "stats", "list", "cards", "quote", "chart", "timeline", "kinetic", "outro", "logo", "device"];
const VISUALS: readonly Visual[] = ["none", "orbit", "grid", "aurora", "rings", "burst", "waves", "particles", "spotlight", "floor", "mesh", "flow", "topo", "ribbons", "lightleak"];
const MOTIONS: readonly Motion[] = ["calm", "energetic", "explosive"];
const CAMERAS: readonly Camera[] = ["push", "pull", "pan-left", "pan-right", "drift", "static", "tilt-up", "tilt-down"];
const TRANSITIONS: readonly Transition[] = ["cut", "dip", "flash", "fade", "wipe", "push", "zoom", "glitch", "iris"];
const MOODS: readonly VideoAudio["mood"][] = ["cinematic", "upbeat", "ambient", "playful", "tense", "warm"];
const FONTS: readonly FontStyle[] = ["modern", "editorial", "mono", "bold"];
const LAYOUT_ALIASES: Record<string, Layout> = { brand: "logo", mark: "logo", logotype: "logo", identity: "logo", product: "device", screen: "device", app: "device", mockup: "device", dashboard: "device", title: "hero", intro: "hero", cover: "hero", opening: "hero", "big-text": "statement", text: "statement", headline: "statement", bigtext: "statement", numbers: "stats", metrics: "stats", kpi: "stats", features: "cards", benefits: "cards", grid: "cards", steps: "list", bullets: "list", checklist: "list", testimonial: "quote", "case-study": "quote", graph: "chart", data: "chart", roadmap: "timeline", process: "timeline", slam: "kinetic", words: "kinetic", typography: "kinetic", cta: "outro", end: "outro", closing: "outro", final: "outro", credits: "outro" };

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Palettes                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

type Preset = { id: string; match: RegExp; p: Palette; font: FontStyle };
export const PRESETS: Preset[] = [
  { id: "midnight", match: /tech|ai|software|app|startup|code|saas|product|launch/i, font: "modern", p: { bg: "#090b1a", surface: "#12162e", text: "#f4f6ff", muted: "#9aa3c7", accent: "#6c8cff", accent2: "#ff7ad9" } },
  { id: "ember", match: /fire|energy|sport|bold|warm|passion|coffee|food|bakery|restaurant|fitness|gym/i, font: "bold", p: { bg: "#120a08", surface: "#1f1310", text: "#fff4ec", muted: "#c9a898", accent: "#ff7a3d", accent2: "#ffd24a" } },
  { id: "mint", match: /nature|eco|green|health|wellness|calm|garden|plant|organic|yoga|medit/i, font: "modern", p: { bg: "#06130f", surface: "#0d211b", text: "#effff8", muted: "#9bc7b8", accent: "#34e0a1", accent2: "#7cf0ff" } },
  { id: "royal", match: /luxury|fashion|premium|gold|elegant|jewel|wedding|perfume|hotel|art/i, font: "editorial", p: { bg: "#0d0a14", surface: "#17121f", text: "#faf6ff", muted: "#b8aacb", accent: "#d9a441", accent2: "#f3e3b0" } },
  { id: "ocean", match: /ocean|water|travel|sky|finance|bank|trust|insurance|aviation|sea|beach/i, font: "modern", p: { bg: "#06121f", surface: "#0c1e33", text: "#eef7ff", muted: "#9db8d1", accent: "#38bdf8", accent2: "#818cf8" } },
  { id: "neon", match: /cyber|neon|synth|retro|game|gaming|arcade|futur|space|scifi|sci-fi|robot/i, font: "mono", p: { bg: "#07040f", surface: "#120a24", text: "#f6f0ff", muted: "#a99bc9", accent: "#00f0ff", accent2: "#ff2bd6" } },
  { id: "paper", match: /minimal|light|clean|paper|magazine|white|education|school|book|story/i, font: "editorial", p: { bg: "#f6f3ee", surface: "#ffffff", text: "#14120f", muted: "#5f594f", accent: "#d9482b", accent2: "#2457d6" } },
];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Brings any palette to legible values: text 7:1, muted 4.5:1, accents 3:1 against the background. */
export function fixPalette(p: Palette): Palette {
  const bg = p.bg, avg = averageColor([bg, shade(bg, 0.04)]);
  return { bg, surface: p.surface, text: readableOn(avg, p.text, 7), muted: readableOn(avg, p.muted, 4.5), accent: readableOn(avg, p.accent, 3), accent2: readableOn(avg, p.accent2, 3) };
}

function paletteFrom(raw: unknown, hint: string, seed: number): { palette: Palette; font: FontStyle } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const preset = PRESETS.find((x) => x.match.test(hint)) ?? PRESETS[seed % (PRESETS.length - 1)]!;
  const pick = (k: keyof Palette): string => (isColor(o[k]) ? (o[k] as string) : preset.p[k]);
  const given = isColor(o["bg"]) && isColor(o["accent"]);
  const base: Palette = given
    ? { bg: pick("bg"), surface: isColor(o["surface"]) ? (o["surface"] as string) : mixColor(pick("bg"), "#ffffff", 0.06), text: pick("text"), muted: pick("muted"), accent: pick("accent"), accent2: isColor(o["accent2"]) ? (o["accent2"] as string) : shade(pick("accent"), 0.12) }
    : preset.p;
  return { palette: fixPalette(base), font: preset.font };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Small validators                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

const clampN = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length <= max ? t : t.slice(0, max - 1).replace(/[\s,;:.\-\u2013\u2014]+\S*$/, "").trim() + "\u2026";
};
const numOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : undefined);
function oneOf<T extends string>(v: unknown, allowed: readonly T[], aliases?: Record<string, T>): T | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.trim().toLowerCase().replace(/_/g, "-");
  return (allowed as readonly string[]).includes(k) ? (k as T) : aliases?.[k];
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const stripTags = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** seconds-or-milliseconds field reader: `startMs: 4200` and `start: 4.2` both work */
const msOf = (o: Record<string, unknown>, msKey: string, secKey: string): number | undefined => {
  const ms = numOf(o[msKey]);
  if (ms !== undefined) return ms;
  const s = numOf(o[secKey]);
  return s !== undefined ? s * 1000 : undefined;
};

function cleanItems(v: unknown, max: number): VideoItem[] | undefined {
  const items = arr(v).map((x): VideoItem | null => {
    if (typeof x === "string") { const t = str(x, 34); return t ? { title: t } : null; }
    const o = rec(x), title = str(o["title"] ?? o["label"] ?? o["name"] ?? o["heading"], 34);
    if (!title) return null;
    const body = str(o["body"] ?? o["text"] ?? o["description"] ?? o["desc"] ?? o["sub"], 74), icon = iconName(o["icon"]);
    return { title, ...(body ? { body } : {}), ...(icon ? { icon } : {}) };
  }).filter((x): x is VideoItem => !!x).slice(0, max);
  return items.length ? items : undefined;
}
function cleanStats(v: unknown): VideoStat[] | undefined {
  const s = arr(v).map((x): VideoStat | null => {
    const o = rec(x), value = numOf(o["value"] ?? o["number"] ?? o["n"]), label = str(o["label"] ?? o["title"] ?? o["name"], 30);
    if (value === undefined || !label) return null;
    const prefix = str(o["prefix"], 4), suffix = str(o["suffix"] ?? o["unit"], 6), dec = numOf(o["decimals"]);
    return { value, label, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}), ...(dec !== undefined ? { decimals: clampN(Math.round(dec), 0, 2) } : {}) };
  }).filter((x): x is VideoStat => !!x).slice(0, 4);
  return s.length ? s : undefined;
}
function cleanChart(v: unknown): VideoChart | undefined {
  const o = rec(v);
  const type = oneOf(o["type"] ?? o["style"], ["bars", "line", "donut", "progress"] as const, { bar: "bars", column: "bars", columns: "bars", pie: "donut", ring: "donut", lines: "line", area: "line" });
  const data = arr(o["data"] ?? o["points"] ?? o["values"]).map((x) => { const d = rec(x), value = numOf(d["value"] ?? d["y"] ?? d["n"]), label = str(d["label"] ?? d["x"] ?? d["name"], 14); return value !== undefined && label ? { label, value: Math.max(0, value) } : null; }).filter((x): x is { label: string; value: number } => !!x).slice(0, 7);
  if (!type || data.length < 2) return undefined;
  const unit = str(o["unit"], 5);
  return { type, data, ...(unit ? { unit } : {}) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Timing                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Films run 20-45 seconds: long enough to tell a story, short enough to hold attention. */
export const MIN_FILM_SEC = 20;
export const MAX_FILM_SEC = 45;

/** Seconds the person asked for ("a 30 second video", "a 1 minute promo"), or undefined when they did not say. */
export function requestedSeconds(prompt: string): number | undefined {
  const sec = /(\d{1,3})\s*-?\s*(?:seconds?|secs?)\b/i.exec(prompt);
  if (sec) return +sec[1]!;
  const min = /(\d{1,2})\s*-?\s*(?:minutes?|mins?)\b/i.exec(prompt);
  if (min) return +min[1]! * 60;
  if (/\b(?:a|one)\s+minute\b/i.test(prompt)) return 60;
  return undefined;
}

const MARKS = ["ring", "square", "hex", "diamond", "bolt", "orbit", "leaf", "star"] as const;
/** The brand a film is about: drives the logo reveal and the closing lockup. Returns undefined when there is no brand. */
export function normalizeBrand(raw: unknown): Brand | undefined {
  const o = rec(raw);
  const name = str(o["name"] ?? o["brand"] ?? o["company"], 28);
  if (!name) return undefined;
  const mark = oneOf(o["mark"] ?? o["logo"] ?? o["shape"], MARKS, { circle: "ring", rounded: "square", hexagon: "hex", gem: "diamond", lightning: "bolt", spark: "star", planet: "orbit", eco: "leaf" }) ?? "ring";
  const tagline = str(o["tagline"] ?? o["slogan"], 60), monogram = str(o["monogram"] ?? o["initials"], 2);
  return { name, mark, ...(tagline ? { tagline } : {}), ...(monogram ? { monogram: monogram.toUpperCase() } : {}) };
}

/** Scales scene durations to `total` and keeps every scene within [min, max] by moving time from long scenes to short ones. */
export function fitDurations(ds: number[], total: number, min = MIN_SCENE_MS, max = MAX_SCENE_MS): number[] {
  const n = ds.length;
  if (!n) return [];
  const lo = Math.min(min, total / n), hi = Math.max(max, total / n);
  const sum = ds.reduce((a, b) => a + b, 0) || n;
  let out = ds.map((d) => (d / sum) * total);
  for (let pass = 0; pass < 10; pass++) {
    let deficit = 0;
    out = out.map((d) => { if (d < lo) { deficit += lo - d; return lo; } if (d > hi) { deficit -= d - hi; return hi; } return d; });
    if (Math.abs(deficit) < 1) break;
    if (deficit > 0) { const room = out.reduce((a, d) => a + (d > lo ? d - lo : 0), 0) || 1, r = Math.min(1, deficit / room); out = out.map((d) => (d > lo ? d - (d - lo) * r : d)); }
    else { const grow = out.filter((d) => d < hi).length || 1; out = out.map((d) => (d < hi ? d - deficit / grow : d)); }
  }
  out[n - 1]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Scene normalisation                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

function inferLayout(o: Record<string, unknown>, index: number, count: number, hasText: boolean): Layout {
  if (o["device"] !== undefined) return "device";
  if (arr(o["words"]).length >= 2) return "kinetic";
  if (cleanStats(o["stats"])) return "stats";
  if (cleanChart(o["chart"])) return "chart";
  if (rec(o["quote"])["text"] || typeof o["quote"] === "string") return "quote";
  const items = cleanItems(o["items"], 5);
  if (items) return items.length >= 5 ? "timeline" : items.some((i) => i.icon) || items.length <= 3 ? "cards" : "list";
  if (index === count - 1) return "outro";
  if (index === 0) return "hero";
  return hasText ? "statement" : "hero";
}

function normalizeScene(raw: unknown, index: number, count: number): VideoScene | null {
  const o = rec(raw);
  let headline = str(o["headline"] ?? o["title"] ?? o["heading"] ?? o["text"], 92);
  let sub = str(o["sub"] ?? o["subtitle"] ?? o["subheadline"] ?? o["body"] ?? o["caption"], 150);
  /* legacy v2 scenes carried HTML or text layers: recover their words so old films still render properly */
  if (!headline && typeof o["html"] === "string") {
    const m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(o["html"]), t = m ? stripTags(m[1]!) : stripTags(o["html"]).slice(0, 120);
    headline = str(t, 92);
    if (!sub) sub = str(stripTags(o["html"]).replace(t, "").trim(), 150);
  }
  if (!headline && Array.isArray(o["layers"])) {
    const texts = (o["layers"] as unknown[]).map(rec).filter((l) => typeof l["text"] === "string").sort((a, b) => (numOf(b["size"]) ?? 0) - (numOf(a["size"]) ?? 0));
    headline = str(texts[0]?.["text"], 92);
    if (!sub) sub = str(texts[1]?.["text"], 150);
  }
  const label = str(o["label"] ?? o["name"] ?? o["beat"], 28) ?? headline?.slice(0, 24) ?? `Scene ${index + 1}`;
  const words = arr(o["words"]).map((w) => str(w, 14)).filter((w): w is string => !!w).slice(0, 10);
  const quoteRaw = o["quote"];
  const quote = typeof quoteRaw === "string" ? { text: str(quoteRaw, 170), who: undefined } : { text: str(rec(quoteRaw)["text"], 170), who: str(rec(quoteRaw)["who"] ?? rec(quoteRaw)["by"] ?? rec(quoteRaw)["author"], 40) };
  const layout = oneOf(o["layout"], LAYOUTS, LAYOUT_ALIASES) ?? inferLayout(o, index, count, !!headline);
  const items = cleanItems(o["items"] ?? o["points"] ?? o["cards"], layout === "timeline" ? 5 : layout === "split" ? 3 : 4);
  const stats = cleanStats(o["stats"] ?? o["numbers"]), chart = cleanChart(o["chart"]);
  const eyebrow = str(o["eyebrow"] ?? o["kicker"] ?? o["tag"], 34);
  const icon = iconName(o["icon"]), visual = oneOf(o["visual"] ?? o["motif"], VISUALS);
  const motion = oneOf(o["motion"] ?? o["energy"], MOTIONS, { low: "calm", medium: "energetic", high: "explosive", slow: "calm", fast: "energetic", intense: "explosive" });
  const camera = oneOf(o["camera"], CAMERAS);
  const transition = oneOf(o["transition"], TRANSITIONS, { crossfade: "fade", dissolve: "fade", slide: "push", whip: "push", black: "dip", "fade-black": "dip", white: "flash", light: "flash" });
  const device = oneOf(o["device"] ?? o["frame"], ["laptop", "phone"] as const, { mobile: "phone", iphone: "phone", tablet: "laptop", desktop: "laptop", computer: "laptop", macbook: "laptop" });
  const bg = isColor(o["background"]) ? (o["background"] as string) : undefined, accent = isColor(o["accent"]) ? (o["accent"] as string) : undefined;
  const imagePrompt = str(o["imagePrompt"] ?? o["image"], 220);
  /* a layout whose content is missing falls back to one that can stand alone */
  let finalLayout: Layout = layout;
  if (layout === "stats" && !stats) finalLayout = items ? "cards" : "statement";
  if ((layout === "cards" || layout === "list" || layout === "timeline") && !items) finalLayout = stats ? "stats" : "statement";
  if (layout === "timeline" && items && items.length < 2) finalLayout = "cards";
  if (layout === "chart" && !chart) finalLayout = stats ? "stats" : "statement";
  if (layout === "quote" && !quote.text) finalLayout = "statement";
  if (layout === "kinetic" && words.length < 2 && !headline) finalLayout = "hero";
  if (!headline && !words.length && !items && !stats && !chart && !quote.text) return null;
  const s: VideoScene = { startMs: 0, endMs: 0, label, layout: finalLayout };
  const set = <K extends keyof VideoScene>(k: K, v: VideoScene[K] | undefined): void => { if (v !== undefined) s[k] = v; };
  set("eyebrow", eyebrow); set("headline", headline); set("sub", sub); set("items", items); set("stats", stats); set("chart", chart);
  if (quote.text) s.quote = { text: quote.text, ...(quote.who ? { who: quote.who } : {}) };
  if (words.length) s.words = words;
  set("icon", icon ?? undefined); set("visual", visual); set("motion", motion); set("camera", camera); set("transition", transition);
  set("background", bg); set("accent", accent);
  if (device) s.device = device;
  if (imagePrompt) { s.imagePrompt = imagePrompt; if (o["plate"] === true) s.plate = true; }
  return s;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Spec normalisation                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

function normalizeAudio(raw: unknown, ctx: { style: string; prompt: string; durationMs: number; scenes: VideoScene[] }): VideoAudio {
  const a = rec(raw);
  const mood = oneOf(a["mood"], MOODS, { epic: "cinematic", dramatic: "cinematic", energetic: "upbeat", happy: "upbeat", chill: "ambient", calm: "ambient", fun: "playful", dark: "tense", emotional: "warm", friendly: "warm" }) ?? "cinematic";
  const genreRaw = typeof a["genre"] === "string" ? a["genre"].toLowerCase().trim() : "";
  const genre = GENRES.find((g) => g.id === genreRaw)?.id ?? pickGenre(genreRaw, mood, ctx.style, ctx.prompt).id;
  const bpm = Math.round(clampN(numOf(a["bpm"]) ?? GENRES.find((g) => g.id === genre)?.bpm[0] ?? 100, 70, 140));
  const key = typeof a["key"] === "string" && /^[A-G][#b]?\s*(major|minor)$/i.test(a["key"].trim()) ? a["key"].trim() : "A minor";
  const voice: "female" | "male" = a["voice"] === "male" ? "male" : "female";
  const lines: VoiceLine[] = [];
  arr(a["voiceoverLines"] ?? a["voiceover"] ?? a["narration"] ?? a["lines"]).forEach((l, i) => {
    if (typeof l === "string") { const t = str(l, 150); if (t) lines.push({ startMs: -1 - i, text: t }); return; }
    const o = rec(l), t = str(o["text"] ?? o["line"] ?? o["say"], 150);
    const at = msOf(o, "startMs", "start") ?? msOf(o, "atMs", "at") ?? msOf(o, "ms", "time");
    if (t) lines.push({ startMs: at ?? -1 - i, text: t });
  });
  /* lines without a time are spread over the scenes that are not pure typography slams */
  const slots = ctx.scenes.filter((s) => s.layout !== "kinetic");
  lines.forEach((l, i) => { if (l.startMs < 0) { const slot = slots[Math.min(slots.length - 1, Math.floor((i / Math.max(1, lines.length)) * slots.length))]; l.startMs = (slot?.startMs ?? 0) + 500; } });
  const kept = lines.map((l) => ({ ...l, startMs: Math.round(clampN(l.startMs, 300, Math.max(600, ctx.durationMs - 1800))) })).sort((x, y) => x.startMs - y.startMs).slice(0, 12);
  return { mood, genre, bpm, key, voice, voiceoverLines: kept, sfx: a["sfx"] !== false };
}

export function normalizeVideoSpec(raw: unknown, prompt: string): { spec: VideoSpec; ok: boolean } {
  const o = rec(raw);
  const rawScenes = arr(o["scenes"]);
  const seed = Math.round(numOf(o["seed"]) ?? hashString(prompt || "zeros")) % 1000003;
  const style = str(o["style"], 60) ?? "cinematic";
  const { palette, font } = paletteFrom(o["palette"], `${style} ${prompt} ${str(o["title"], 80) ?? ""}`, seed);
  const fontStyle = oneOf(o["fontStyle"] ?? o["font"] ?? o["typography"], FONTS, { sans: "modern", clean: "modern", serif: "editorial", elegant: "editorial", code: "mono", monospace: "mono", heavy: "bold", impact: "bold" }) ?? font;
  const scenes: VideoScene[] = [], hints: { s: number; e: number; d: number }[] = [];
  rawScenes.slice(0, 14).forEach((r, i) => {
    const s = normalizeScene(r, i, Math.min(14, rawScenes.length));
    if (!s) return;
    const ro = rec(r), start = msOf(ro, "startMs", "start"), end = msOf(ro, "endMs", "end"), dur = msOf(ro, "durationMs", "durationSec");
    hints.push({ s: start ?? -1, e: end ?? -1, d: dur ?? -1 });
    scenes.push(s);
  });
  const ds = hints.map((h) => (h.s >= 0 && h.e > h.s ? h.e - h.s : h.d > 0 ? h.d : 4500));
  const naturalSec = ds.reduce((a, b) => a + b, 0) / 1000;
  const asked = numOf(o["durationSec"]) ?? requestedSeconds(prompt);
  const durationSec = Math.round(clampN(asked ?? (naturalSec >= MIN_FILM_SEC ? naturalSec : 30), MIN_FILM_SEC, MAX_FILM_SEC));
  const lengthNote = asked !== undefined && (asked < MIN_FILM_SEC || asked > MAX_FILM_SEC) ? [`Films run ${MIN_FILM_SEC}-${MAX_FILM_SEC} seconds, so this one is ${durationSec} seconds long.`] : [];
  const fitted = fitDurations(ds, durationSec * 1000);
  let t = 0;
  scenes.forEach((s, i) => { s.startMs = Math.round(t); t += fitted[i]!; s.endMs = i === scenes.length - 1 ? durationSec * 1000 : Math.round(t); });
  const audio = normalizeAudio(o["audio"], { style, prompt, durationMs: durationSec * 1000, scenes });
  const warnings = [...lengthNote, ...arr(o["warnings"]).map((w) => str(w, 200)).filter((w): w is string => !!w)];
  const brand = normalizeBrand(o["brand"]);
  const tr = rec(o["treatment"]);
  const plan = { objective: str(tr["promise"] ?? tr["objective"], 200) ?? "", keyMessage: str(tr["logline"] ?? tr["keyMessage"], 200) ?? "", metaphor: str(tr["metaphor"], 160) ?? "", soundPlan: str(tr["sound"] ?? tr["soundPlan"], 160) ?? "" };
  const hasPlan = Object.values(plan).some(Boolean);
  const legacy = rawScenes.length > 0 && rawScenes.some((r) => typeof rec(r)["html"] === "string" || Array.isArray(rec(r)["layers"])) && !rawScenes.some((r) => typeof rec(r)["layout"] === "string");
  const spec: VideoSpec = {
    title: str(o["title"], 80) ?? str(prompt, 60) ?? "Untitled film", durationSec, fps: 30, width: 1280, height: 720,
    script: str(o["script"] ?? o["logline"], 600) ?? "", style, background: palette.bg, seed, palette, fontStyle,
    captions: typeof o["captions"] === "boolean" ? o["captions"] : audio.voiceoverLines.length > 0,
    scenes, audio, source: legacy ? "legacy" : "model", warnings,
    ...(brand ? { brand } : {}), ...(hasPlan ? { plan } : {}),
  };
  return { spec, ok: scenes.length >= 3 };
}

/** Parses a model reply into a spec, or null when it cannot be rescued (the caller decides: retry or fall back). */
export function tryParseVideoSpec(text: string, prompt: string): VideoSpec | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const { spec, ok } = normalizeVideoSpec(obj, prompt);
  return ok ? spec : null;
}

/** Always returns a renderable spec; falls back to the studio template (honestly flagged) when the reply is unusable. */
export function parseVideoSpecFromResponse(text: string, prompt: string): VideoSpec {
  return tryParseVideoSpec(text, prompt) ?? fallbackVideoSpec(prompt);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Fallback director                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

const STOP = new Set("a an the of for to and or in on at with about make create generate build me my our your video film clip movie animation promo second seconds minute minutes short long please can you i want need that this it is are be from by as into using use".split(" "));
export function subjectOf(prompt: string): string {
  const cleaned = prompt
    .replace(/\b(please|can you|could you|i want|i need|i'd like|make|create|generate|produce|build)\b/gi, " ")
    .replace(/\b(?:a|an|the|my|our)?\s*(?:\d+\s*-?\s*(?:second|sec|minute|min)s?\s*)?(?:short\s+|cinematic\s+|promo\s+)*(?:video|film|clip|movie|animation|promo|trailer|ad|advert|reel)\b\s*(?:about|of|for|on|showing|that)?/gi, " ")
    .replace(/\b\d+\s*-?\s*(?:second|sec|minute|min)s?\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  const base = cleaned || prompt.trim() || "your idea";
  const cut = base.length > 44 ? base.slice(0, 44).replace(/\s+\S*$/, "") : base;
  return cut.replace(/^(about|of|for|on)\s+/i, "").replace(/[.,;:!?]+$/, "").replace(/\b\w/g, (c) => c.toUpperCase()) || "Your Idea";
}
export function keywordsOf(prompt: string, n = 5): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const w of prompt.toLowerCase().match(/[a-z\u00c0-\u024f][a-z\u00c0-\u024f'-]{2,}/g) ?? []) { if (STOP.has(w) || seen.has(w)) continue; seen.add(w); out.push(w); if (out.length >= n) break; }
  return out;
}

export function fallbackVideoSpec(prompt: string, reason?: string): VideoSpec {
  const subject = subjectOf(prompt), kw = keywordsOf(prompt, 5), seed = hashString(prompt || "zeros") % 1000003;
  const matched = PRESETS.find((x) => x.match.test(prompt));
  const h = seed % 360, c = (hh: number, s: number, l: number): string => toHex(hsl2rgb(hh, s, l));
  const auto: Palette = { bg: c(h, 0.5, 0.07), surface: c(h, 0.4, 0.12), text: "#f5f7ff", muted: c(h, 0.2, 0.74), accent: c(h, 0.9, 0.66), accent2: c((h + 48) % 360, 0.9, 0.7) };
  const palette = fixPalette(matched ? matched.p : auto), font: FontStyle = matched ? matched.font : "modern";
  const T = (k: number, d: string): string => (kw[k] ?? d).replace(/\b\w/g, (ch) => ch.toUpperCase());
  const words = (kw.length >= 3 ? kw.slice(0, 5) : ["imagine", "shape", "share"]).map((w) => w.toUpperCase());
  // The template is laid out for 45 seconds. Scaling it to another length leaves text that cannot be read in time, so it keeps its
  // length and says so (the film is still a complete, readable film).
  const dur = 45, cuts = [0, 6000, 12000, 19000, 27000, 35000, 40500, dur * 1000];
  const draft: Omit<VideoScene, "startMs" | "endMs">[] = [
    { label: "Hook", layout: "hero", eyebrow: "A Zeros film", headline: `*${subject}*`, sub: "A short film directed by Zeros", visual: "aurora", motion: "energetic", camera: "push" },
    { label: "Drop", layout: "kinetic", words, visual: "burst", motion: "explosive", transition: "flash" },
    { label: "Why", layout: "statement", eyebrow: "Why it matters", headline: "Every big idea starts as a few *honest words*.", visual: "grid", motion: "calm", transition: "wipe" },
    { label: "Three ideas", layout: "cards", headline: "Three things worth *holding on to*", items: [{ icon: "sparkle", title: T(0, "Imagine"), body: "Start with what you care about." }, { icon: "target", title: T(1, "Focus"), body: "Make it clear, make it simple." }, { icon: "heart", title: T(2, "Share"), body: "Let it move the people who see it." }], visual: "particles", transition: "push" },
    { label: "Path", layout: "timeline", headline: "From idea to *reality*", items: [{ title: "Imagine", body: "See it first" }, { title: "Shape", body: "Give it form" }, { title: "Refine", body: "Cut the noise" }, { title: "Share", body: "Let it travel" }], visual: "spotlight", transition: "zoom" },
    { label: "Quote", layout: "quote", quote: { text: "Small ideas, told well, travel the furthest.", who: "Zeros" }, visual: "aurora", motion: "calm", transition: "dip" },
    { label: "Outro", layout: "outro", headline: "Now it's *your turn*", sub: subject, visual: "rings", motion: "calm", transition: "flash" },
  ];
  const scenes: VideoScene[] = draft.map((s, i) => ({ ...s, startMs: cuts[i]!, endMs: cuts[i + 1]! }));
  return {
    title: subject, durationSec: dur, fps: 30, width: 1280, height: 720, script: `A short film about ${subject.toLowerCase()}.`, style: "cinematic", background: palette.bg, seed,
    palette, fontStyle: font, captions: true, scenes, source: "fallback",
    audio: { mood: "cinematic", genre: "cinematic", bpm: 100, key: "A minor", voice: "female", sfx: true, voiceoverLines: [
      { startMs: 700, text: `This is ${subject}.` }, { startMs: 12600, text: "Every big idea starts as a few honest words." }, { startMs: 19600, text: "From the first spark to the finished thing." }, { startMs: 35400, text: "Small ideas, told well, travel the furthest." }, { startMs: 41000, text: "Now it's your turn." },
    ] },
    warnings: [
      reason ?? `The AI director was unavailable, so Zeros built this film from its studio template using your words ("${subject}"). Ask again for a fully custom film.`,
      ...(requestedSeconds(prompt) !== undefined && requestedSeconds(prompt) !== dur ? [`The studio template runs ${dur} seconds, so the ${requestedSeconds(prompt)}-second length you asked for was not used. Ask again for a custom film to get that length.`] : []),
    ],
  };
}

/** Legacy name still used by older call sites. */
export const defaultVideoSpec = (prompt: string): VideoSpec => fallbackVideoSpec(prompt);

/** The icon vocabulary the director may use. */
export { ICON_NAMES };
export type { IconName };
