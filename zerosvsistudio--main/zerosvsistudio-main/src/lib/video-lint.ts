/**
 * Pre-render checks for a VideoSpec. Everything here is measured, not guessed: text boxes are computed from real font
 * metrics (or a close estimate when no canvas exists), reading time from word counts, cuts from the beat grid.
 * Mechanical problems are FIXED automatically and reported; anything left over is returned for the director to repair.
 */
import { MAX_SCENE_MS, MIN_SCENE_MS, fitDurations, fixPalette } from "./video-spec";
import { approxMeasure, compileScene, fontPlan, wrapLines, type Measure } from "./video/layouts";
import { contrast } from "./video/kit";
import type { TextEl, VideoElement, VideoScene, VideoSpec } from "./video/types";
import { paletteFor } from "./video/layouts";

export type LintIssue = { severity: "error" | "warn" | "info"; code: string; scene?: number; message: string; fixed?: boolean };
export type LintStats = { scenes: number; cutsOnBeat: number; cuts: number; minTextSize: number; minContrast: number; maxWordsPerScene: number; textBoxes: number; overlaps: number; narrationLines: number; layouts: string[] };
export type LintResult = { spec: VideoSpec; issues: LintIssue[]; fixes: string[]; score: number; stats: LintStats };
export type LintOptions = { measure?: Measure; beatOffsetMs?: number };

/** Time a viewer needs to read the words on a scene: a fixed settle time plus ~220 words per minute. */
export const readNeedMs = (words: number): number => 1100 + words * 270;

export function wordsOnScene(s: VideoScene): number {
  const w = (t: string | undefined): number => (t ? t.replace(/\*/g, "").trim().split(/\s+/).filter(Boolean).length : 0);
  let n = w(s.headline) + w(s.sub) + w(s.quote?.text);
  for (const it of s.items ?? []) n += w(it.title) + w(it.body);
  for (const st of s.stats ?? []) n += w(st.label) + 1;
  if (s.layout === "kinetic") n = Math.min(n, 8);
  return n;
}

/** Estimated spoken length of a line: ~2.55 words per second plus a breath. */
export const speakMs = (text: string): number => Math.round((text.trim().split(/\s+/).length / 2.55 + 0.4) * 1000);

type Box = { x0: number; x1: number; y0: number; y1: number };
export function textBox(el: TextEl, W: number, H: number, measure: Measure): Box {
  const fp = fontPlan("modern");
  void fp;
  const px = (el.size / 100) * H, font = el.font ?? "body", weight = el.weight ?? 600, italic = !!el.italic, tracking = el.tracking ?? 0;
  const lines = wrapLines(el.text, ((el.maxW ?? 90) / 100) * W, px, { font, weight, tracking, italic, upper: !!el.upper }, measure);
  const widest = Math.max(...lines.map((l) => measure(l.replace(/\*/g, "").toUpperCase() === l.replace(/\*/g, "") || el.upper ? l.replace(/\*/g, "").toUpperCase() : l.replace(/\*/g, ""), px, font, weight, tracking, italic)));
  const w = (widest / W) * 100, h = lines.length * el.size * (el.lineHeight ?? 1.1);
  const align = el.align ?? "center";
  const x0 = align === "center" ? el.x - w / 2 : align === "left" ? el.x : el.x - w;
  return { x0, x1: x0 + w, y0: el.y - h / 2, y1: el.y + h / 2 };
}

const visibleWindow = (el: VideoElement, durMs: number): [number, number] => {
  const a = (el as { anim?: { delay?: number; out?: string; outAt?: number; outDur?: number } }).anim;
  const start = a?.delay ?? 0;
  const end = a?.out && a.out !== "none" ? (a.outAt ?? durMs - 320) + (a.outDur ?? 320) : durMs;
  return [start, end];
};
const area = (b: Box): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a: Box, b: Box): number => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Snaps scene boundaries to the beat grid (grid point = offset + k * beat), never breaking the minimum scene length. */
export function snapBoundariesToBeats(spec: VideoSpec, beatOffsetMs = 0): number {
  const beat = 60000 / spec.audio.bpm, sc = spec.scenes;
  let onBeat = 0;
  for (let i = 1; i < sc.length; i++) {
    const g = Math.round((sc[i]!.startMs - beatOffsetMs) / beat) * beat + beatOffsetMs, t = Math.round(g);
    const prevMin = sc[i - 1]!.startMs + MIN_SCENE_MS - 250, nextMax = (sc[i + 1]?.startMs ?? spec.durationSec * 1000) - MIN_SCENE_MS + 250;
    if (t >= prevMin && t <= nextMax) { sc[i]!.startMs = t; sc[i - 1]!.endMs = t; onBeat++; } else if (Math.abs(sc[i]!.startMs - g) < 8) onBeat++;
  }
  return onBeat;
}

function deepClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function lintVideoSpec(input: VideoSpec, opts: LintOptions = {}): LintResult {
  const spec = deepClone(input), measure = opts.measure ?? approxMeasure, issues: LintIssue[] = [], fixes: string[] = [];
  const add = (severity: LintIssue["severity"], code: string, message: string, scene?: number, fixed = false): void => { issues.push({ severity, code, message, ...(scene !== undefined ? { scene } : {}), ...(fixed ? { fixed } : {}) }); if (fixed) fixes.push(message); };
  const total = Math.round(spec.durationSec * 1000);

  /* ---- palette ---- */
  const fixedPal = fixPalette(spec.palette);
  if (JSON.stringify(fixedPal) !== JSON.stringify(spec.palette)) { spec.palette = fixedPal; add("info", "palette-contrast", "Adjusted palette colours to meet WCAG contrast (text 7:1, muted 4.5:1, accents 3:1).", undefined, true); }

  /* ---- timeline: contiguous, in range ---- */
  spec.scenes.sort((a, b) => a.startMs - b.startMs);
  let contiguous = spec.scenes[0]?.startMs === 0 && spec.scenes[spec.scenes.length - 1]?.endMs === total;
  for (let i = 1; i < spec.scenes.length && contiguous; i++) if (spec.scenes[i]!.startMs !== spec.scenes[i - 1]!.endMs) contiguous = false;
  const durs = spec.scenes.map((s) => s.endMs - s.startMs);
  if (!contiguous || durs.some((d) => d < MIN_SCENE_MS - 50 || d > MAX_SCENE_MS + 50)) {
    const fitted = fitDurations(durs.map((d) => Math.max(500, d)), total);
    let t = 0;
    spec.scenes.forEach((s, i) => { s.startMs = Math.round(t); t += fitted[i]!; s.endMs = i === spec.scenes.length - 1 ? total : Math.round(t); });
    add("info", "timeline", "Re-timed the scenes so they are contiguous and each lasts between 2.2 and 9 seconds.", undefined, true);
  }
  if (spec.durationSec < 20 || spec.durationSec > 45) add("warn", "duration", `The film is ${spec.durationSec}s; films run 20-45 seconds.`);
  const ideal = [Math.max(4, Math.floor(spec.durationSec / 9)), Math.ceil(spec.durationSec / 3.4)];
  if (spec.scenes.length < ideal[0]! || spec.scenes.length > ideal[1]!) add("warn", "scene-count", `${spec.scenes.length} scenes for ${spec.durationSec}s; ${ideal[0]}-${ideal[1]} keeps the pacing lively.`);

  /* ---- reading time: lend time from roomy scenes to crowded ones ---- */
  const have = (i: number): number => spec.scenes[i]!.endMs - spec.scenes[i]!.startMs - 900;
  const need = (i: number): number => (spec.scenes[i]!.layout === "kinetic" ? 0 : readNeedMs(wordsOnScene(spec.scenes[i]!)));
  let moved = false;
  for (let step = 0; step < 80; step++) {
    let worst = -1, worstDef = 0, best = -1, bestSlack = 0;
    spec.scenes.forEach((_, i) => { const slack = have(i) - need(i); if (slack < worstDef - 1) { worstDef = slack; worst = i; } const room = Math.min(slack, spec.scenes[i]!.endMs - spec.scenes[i]!.startMs - MIN_SCENE_MS); if (room > bestSlack + 1) { bestSlack = room; best = i; } });
    if (worst < 0 || best < 0 || bestSlack < 200) break;
    const amount = Math.min(150, bestSlack - 50, -worstDef);
    if (amount < 20) break;
    const d = spec.scenes.map((s) => s.endMs - s.startMs);
    d[worst]! += amount; d[best]! -= amount;
    let t = 0;
    spec.scenes.forEach((s, i) => { s.startMs = Math.round(t); t += d[i]!; s.endMs = i === spec.scenes.length - 1 ? total : Math.round(t); });
    moved = true;
  }
  if (moved) add("info", "reading-time", "Moved time from roomy scenes to text-heavy ones so every line can be read.", undefined, true);
  spec.scenes.forEach((s, i) => { const def = need(i) - have(i); if (def > 400) add("warn", "reading-time", `Scene ${i + 1} ("${s.label}") has ${wordsOnScene(s)} words but only ${((have(i)) / 1000).toFixed(1)}s to read them; shorten the copy.`, i); });

  /* ---- beat grid ---- */
  const beatMs = 60000 / spec.audio.bpm, offset = opts.beatOffsetMs ?? spec.audio.beatOffsetMs ?? 0;
  const before = spec.scenes.map((s) => s.startMs).join();
  snapBoundariesToBeats(spec, offset);
  if (before !== spec.scenes.map((s) => s.startMs).join()) add("info", "beat-snap", `Snapped scene cuts to the ${spec.audio.bpm} BPM beat grid so every cut lands on the music.`, undefined, true);
  let cutsOnBeat = 0;
  for (let i = 1; i < spec.scenes.length; i++) { const ph = ((spec.scenes[i]!.startMs - offset) % beatMs + beatMs) % beatMs; if (Math.min(ph, beatMs - ph) < 25) cutsOnBeat++; }

  /* ---- outro ---- */
  const last = spec.scenes[spec.scenes.length - 1]!;
  if (last.layout !== "outro") {
    if (["hero", "statement", "split", "quote"].includes(last.layout) && last.headline) { last.layout = "outro"; add("info", "outro", 'The final scene became an outro carrying the "Made with Zeros" sign-off.', spec.scenes.length - 1, true); }
    else add("warn", "outro", "The film does not end on an outro scene.", spec.scenes.length - 1);
  }

  /* ---- narration schedule ---- */
  let cursor = 0, trimmed = 0;
  const lines = spec.audio.voiceoverLines.slice().sort((a, b) => a.startMs - b.startMs), kept: typeof lines = [];
  for (const l of lines) {
    const sc = spec.scenes.find((s) => l.startMs >= s.startMs && l.startMs < s.endMs) ?? spec.scenes[0]!;
    if (l.startMs - sc.startMs < 650) l.startMs = sc.startMs + 380;
    if (l.startMs < cursor + 300) l.startMs = cursor + 300;
    const need2 = speakMs(l.text);
    if (l.startMs + need2 > total - 700) { trimmed++; continue; }
    cursor = l.startMs + need2; kept.push(l);
  }
  if (kept.length !== lines.length || lines.some((l, i) => l !== kept[i])) { spec.audio.voiceoverLines = kept; if (trimmed) add("warn", "narration", `Dropped ${trimmed} narration line(s) that could not finish before the film ends.`, undefined, true); else add("info", "narration", "Re-timed narration so no line overlaps another and each starts with its scene.", undefined, true); }
  spec.captions = spec.captions && spec.audio.voiceoverLines.length > 0;

  /* ---- compile + geometry ---- */
  const W = spec.width, H = spec.height, layoutsUsed: string[] = [];
  let minText = 99, minContrast = 99, textBoxes = 0, overlaps = 0, maxWords = 0;
  spec.scenes.forEach((s, i) => {
    layoutsUsed.push(s.layout);
    maxWords = Math.max(maxWords, wordsOnScene(s));
    const els = compileScene({ spec, index: i, scene: s, startMs: s.startMs, durMs: s.endMs - s.startMs, W, H, measure, beatMs, inKind: s.transition, outKind: spec.scenes[i + 1]?.transition, isLast: i === spec.scenes.length - 1 });
    const P = paletteFor(spec, s);
    minContrast = Math.min(minContrast, contrast(P.bgAvg, P.text), contrast(P.bgAvg, P.muted));
    const texts = els.filter((e): e is TextEl => e.type === "text");
    const boxes = texts.map((t) => ({ t, box: textBox(t, W, H, measure), win: visibleWindow(t, s.endMs - s.startMs) }));
    const captionsOn = spec.captions && spec.audio.voiceoverLines.some((l) => l.startMs >= s.startMs && l.startMs < s.endMs);
    for (const b of boxes) {
      textBoxes++; minText = Math.min(minText, b.t.size);
      if (b.t.size < 2.2) add("warn", "small-text", `Scene ${i + 1}: "${b.t.text.slice(0, 24)}" is only ${b.t.size}% of the frame height; too small to read on a phone.`, i);
      const rotated = Math.abs(b.t.rotate ?? 0) > 0.5;
      if (!rotated && (b.box.x0 < 2 || b.box.x1 > 98 || b.box.y0 < 2.5 || b.box.y1 > 97.5)) add("error", "out-of-frame", `Scene ${i + 1}: "${b.t.text.slice(0, 28)}" extends outside the frame.`, i);
      if (captionsOn && b.box.y1 > 80.5 && b.t.y < 95) add("warn", "caption-zone", `Scene ${i + 1}: text intrudes on the caption zone.`, i);
    }
    for (let a = 0; a < boxes.length; a++) for (let c = a + 1; c < boxes.length; c++) {
      const A = boxes[a]!, B = boxes[c]!;
      if (A.win[1] <= B.win[0] || B.win[1] <= A.win[0]) continue;
      const ov = inter(A.box, B.box), small = Math.min(area(A.box), area(B.box));
      if (small > 0 && ov / small > 0.14 && !((A.t.rotate ?? 0) || (B.t.rotate ?? 0))) { overlaps++; add("error", "text-overlap", `Scene ${i + 1}: "${A.t.text.slice(0, 20)}" overlaps "${B.t.text.slice(0, 20)}".`, i); }
    }
    if (i === 0) {
      const firstMotion = Math.min(...els.filter((e) => e.type !== "backdrop" && e.type !== "grid" && e.type !== "particles").map((e) => (e as { anim?: { delay?: number } }).anim?.delay ?? 0));
      if (firstMotion > 700) add("warn", "hook", `The first element only appears after ${Math.round(firstMotion)}ms; the hook should hit within 0.7s.`, 0);
    }
    if (s.layout !== "kinetic" && !(s.headline?.trim()) && s.layout !== "quote" && s.layout !== "chart") add("warn", "headline", `Scene ${i + 1} has no headline.`, i);
  });
  let run = 1;
  for (let i = 1; i < spec.scenes.length; i++) { run = spec.scenes[i]!.layout === spec.scenes[i - 1]!.layout ? run + 1 : 1; if (run >= 3) { add("warn", "variety", `Three scenes in a row use the "${spec.scenes[i]!.layout}" layout; vary the rhythm.`, i); break; } }
  if (spec.audio.bpm < 70 || spec.audio.bpm > 140) add("warn", "bpm", "BPM outside 70-140 makes cut-to-beat pacing awkward.");

  const errors = issues.filter((x) => x.severity === "error").length, warns = issues.filter((x) => x.severity === "warn").length;
  const score = Math.max(0, Math.min(100, 100 - errors * 12 - warns * 4));
  return { spec, issues, fixes, score, stats: { scenes: spec.scenes.length, cutsOnBeat, cuts: Math.max(0, spec.scenes.length - 1), minTextSize: minText === 99 ? 0 : minText, minContrast: minContrast === 99 ? 0 : Math.round(minContrast * 10) / 10, maxWordsPerScene: maxWords, textBoxes, overlaps, narrationLines: spec.audio.voiceoverLines.length, layouts: layoutsUsed } };
}
