/**
 * Layout compiler. The model writes SEMANTIC scenes (layout, headline, stats, motif, motion level); this module turns each
 * into drawable elements with tested typography, safe areas, contrast-checked colours and choreography snapped to the beat.
 * Quality therefore no longer depends on whether a language model guessed pixel coordinates well.
 */
import { averageColor, clamp, contrast, iconName, mixColor, readableOn, shade, type IconName } from "./kit";
import type { Anim, Brand, CardEl, FontKind, Motion, Palette, StatEl, TextEl, Transition, VideoElement, VideoScene, VideoSpec, Visual } from "./types";

export type Measure = (text: string, sizePx: number, font: FontKind, weight: number, tracking: number, italic: boolean) => number;

/** Layout-free estimate of text width, used when no canvas exists (tests, server) - deliberately a little generous. */
export const approxMeasure: Measure = (text, sizePx, font, weight, tracking) => {
  const base = font === "mono" ? 0.6 : font === "serif" ? 0.5 : 0.54;
  const bold = 1 + Math.max(0, weight - 500) / 2400;
  return text.length * sizePx * (base * bold + tracking);
};

export type CompileCtx = {
  spec: VideoSpec; index: number; scene: VideoScene;
  /** the scene's start on the global timeline, ms */
  startMs: number; durMs: number;
  W: number; H: number;
  measure: Measure;
  beatMs: number;
  /** how this scene is entered / exited (the next scene's `transition` is how this one leaves) */
  inKind: Transition | undefined; outKind: Transition | undefined;
  isLast: boolean;
};

/* ------------------------------------------------------------------------------------------------------------------ */

export type Profile = { dur: number; stagger: number; ease: NonNullable<Anim["ease"]>; beat: number; chars: boolean; shake: number };
const PROFILES: Record<Motion, Profile> = {
  calm: { dur: 950, stagger: 70, ease: "outCubic", beat: 0.15, chars: false, shake: 0 },
  energetic: { dur: 700, stagger: 42, ease: "outExpo", beat: 0.55, chars: true, shake: 0 },
  explosive: { dur: 520, stagger: 28, ease: "spring", beat: 1, chars: true, shake: 1 },
};
export function motionOf(scene: VideoScene, index: number): Motion {
  if (scene.motion) return scene.motion;
  const l = scene.label.toLowerCase();
  if (/drop|climax|peak|punch|finale/.test(l)) return "explosive";
  if (/calm|quiet|breath|resolve|reflect/.test(l)) return "calm";
  return index === 0 || scene.layout === "kinetic" ? "energetic" : "energetic";
}
export const profileOf = (m: Motion): Profile => PROFILES[m];

const DEFAULT_VISUALS: Visual[] = ["aurora", "flow", "orbit", "ribbons", "grid", "topo", "mesh", "lightleak", "rings", "particles", "spotlight", "floor", "burst", "waves"];
const stripMarks = (s: string): string => s.replace(/\*/g, "");
const wordsOf = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

export type FontPlan = { head: FontKind; headWeight: number; headItalic: boolean; headUpper: boolean; headTracking: number; accentItalic: boolean; eyebrow: FontKind; num: FontKind; body: FontKind };
export function fontPlan(style: VideoSpec["fontStyle"]): FontPlan {
  switch (style) {
    case "editorial": return { head: "serif", headWeight: 700, headItalic: false, headUpper: false, headTracking: -0.015, accentItalic: true, eyebrow: "body", num: "serif", body: "body" };
    case "mono": return { head: "mono", headWeight: 700, headItalic: false, headUpper: false, headTracking: -0.03, accentItalic: false, eyebrow: "mono", num: "mono", body: "mono" };
    case "bold": return { head: "display", headWeight: 900, headItalic: false, headUpper: true, headTracking: -0.01, accentItalic: false, eyebrow: "mono", num: "display", body: "body" };
    default: return { head: "display", headWeight: 800, headItalic: false, headUpper: false, headTracking: -0.03, accentItalic: false, eyebrow: "mono", num: "display", body: "body" };
  }
}

/** Greedy word wrap to a pixel width. */
export function wrapLines(text: string, maxPx: number, sizePx: number, f: { font: FontKind; weight: number; tracking: number; italic: boolean; upper: boolean }, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const cand = line ? `${line} ${w}` : w;
      const txt = stripMarks(f.upper ? cand.toUpperCase() : cand);
      if (line && measure(txt, sizePx, f.font, f.weight, f.tracking, f.italic) > maxPx) { out.push(line); line = w; } else line = cand;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

export type Fit = { size: number; lines: string[]; blockH: number; /** balanced max width (% of frame width) that reproduces `lines` without widows */ wPct: number };
/** Largest size (<= start) at which the text fits `maxLines` lines inside `maxWpct` of the frame width. */
export function fitText(text: string, o: { W: number; H: number; startSize: number; minSize: number; maxLines: number; maxWpct: number; lineHeight: number; font: FontKind; weight: number; tracking: number; italic?: boolean; upper?: boolean }, measure: Measure): Fit {
  const maxPx = (o.maxWpct / 100) * o.W, f = { font: o.font, weight: o.weight, tracking: o.tracking, italic: !!o.italic, upper: !!o.upper };
  let size = o.startSize, lines = wrapLines(text, maxPx, (size / 100) * o.H, f, measure);
  while (size > o.minSize) {
    const px = (size / 100) * o.H;
    lines = wrapLines(text, maxPx, px, f, measure);
    const widest = Math.max(...lines.map((l) => measure(stripMarks(f.upper ? l.toUpperCase() : l), px, f.font, f.weight, f.tracking, f.italic)));
    if (lines.length <= o.maxLines && widest <= maxPx) break;
    size = Math.round((size - 0.4) * 10) / 10;
  }
  /* balance: the narrowest width that still wraps to the same number of lines, so no line ends with a lonely word */
  const px = (size / 100) * o.H;
  let lo = maxPx * 0.42, hi = maxPx;
  if (lines.length > 1) for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (wrapLines(text, mid, px, f, measure).length <= lines.length) hi = mid; else lo = mid; }
  const balanced = lines.length > 1 ? wrapLines(text, hi, px, f, measure) : lines;
  const wPct = Math.min(o.maxWpct, (hi / o.W) * 100 + 2.8);
  return { size, lines: balanced, blockH: balanced.length * size * o.lineHeight, wPct: lines.length > 1 ? wPct : o.maxWpct };
}

/* ------------------------------------------------------------------------------------------------------------------ */

type Pal = { bg: string; bgAvg: string; text: string; muted: string; accent: string; accent2: string; surface: string; dark: boolean };
export function paletteFor(spec: VideoSpec, scene: VideoScene): Pal {
  const p: Palette = spec.palette, bg = scene.background ?? p.bg, accent = scene.accent ?? p.accent;
  const bgAvg = averageColor([bg, shade(bg, 0.05)]);
  return {
    bg, bgAvg, accent: readableOn(bgAvg, accent, 3), accent2: readableOn(bgAvg, p.accent2, 3),
    text: readableOn(bgAvg, p.text, 7), muted: readableOn(bgAvg, p.muted, 4.5), surface: p.surface,
    dark: contrast(bgAvg, "#ffffff") > contrast(bgAvg, "#000000"),
  };
}

/**
 * Next point on the beat grid at or after `localMs` (scene-local), so entrances land ON the music without ever waiting a whole
 * beat: calm scenes snap to eighth notes, energetic and explosive ones to sixteenths.
 */
export function snapLocal(ctx: CompileCtx, localMs: number, maxMs = 2400): number {
  const calm = motionOf(ctx.scene, ctx.index) === "calm", grid = Math.max(110, ctx.beatMs / (calm ? 2 : 4)), off = ctx.spec.audio.beatOffsetMs ?? 0, g = ctx.startMs + localMs - off;
  const snapped = Math.ceil(g / grid - 1e-6) * grid + off;
  return clamp(Math.round(snapped - ctx.startMs), 0, Math.min(maxMs, Math.max(0, ctx.durMs - 800)));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Motifs                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

function motif(kind: Visual, P: Pal, prof: Profile, cx: number, cy: number, scale: number, seed: number, captions: boolean): VideoElement[] {
  const a = P.accent, b = P.accent2;
  switch (kind) {
    case "aurora": return [{ type: "backdrop", kind: "aurora", colors: [a, b, mixColor(a, b, 0.5)], opacity: P.dark ? 0.55 : 0.35, z: 1 }];
    case "mesh": return [{ type: "backdrop", kind: "mesh", colors: [a, b, shade(P.bg, P.dark ? 0.14 : -0.1)], opacity: P.dark ? 0.7 : 0.45, z: 1 }];
    case "spotlight": return [{ type: "backdrop", kind: "spotlight", colors: [a], opacity: 0.5, x: cx, y: 0, z: 1 }];
    case "flow": return [{ type: "backdrop", kind: "flow", colors: [a, b], opacity: P.dark ? 0.8 : 0.5, speed: 0.6 + prof.beat * 0.3, z: 1 }];
    case "topo": return [{ type: "backdrop", kind: "topo", colors: [a, b], opacity: P.dark ? 0.7 : 0.45, x: cx, y: cy, speed: 0.5, z: 1 }];
    case "ribbons": return [{ type: "backdrop", kind: "ribbons", colors: [a, b, mixColor(a, b, 0.5)], opacity: P.dark ? 0.75 : 0.5, speed: 0.7 + prof.beat * 0.3, z: 1 }];
    case "lightleak": return [{ type: "backdrop", kind: "lightleak", colors: [a, b], opacity: 0.9, speed: 0.6, z: 1 }];
    case "burst": return [{ type: "backdrop", kind: "rays", colors: [a, b], opacity: 0.4, x: cx, y: cy, speed: 0.35 + prof.beat * 0.25, z: 1 }, { type: "backdrop", kind: "glow", colors: [a], opacity: 0.6, x: cx, y: cy, z: 1 }];
    case "grid": return [{ type: "grid", kind: "lines", color: a, opacity: 0.2, spacing: 6, speed: 0.4, z: 1 }];
    case "floor": return [{ type: "backdrop", kind: "glow", colors: [b], opacity: 0.55, x: 50, y: 58, z: 1 }, { type: "grid", kind: "floor", color: a, opacity: 0.5, speed: 0.55 + prof.beat * 0.3, z: 1 }];
    case "particles": return [{ type: "particles", kind: P.dark ? "fireflies" : "dust", count: 70, color: a, color2: b, speed: 0.6, size: 1, opacity: 0.9, z: 2 }];
    case "waves": return [{ type: "wave", style: "bars", x: 50, y: captions ? 70 : 82, w: 78, h: 14, color: a, color2: b, count: 48, opacity: 0.55, z: 1, beat: 1 }];
    case "rings": return [
      { type: "shape", shape: "ring", x: cx, y: cy, w: 34 * scale, h: 34 * scale, stroke: a, strokeW: 0.35, progress: 1, opacity: 0.45, z: 1, anim: { in: "scale", delay: 100, dur: 1200, ease: "outExpo", loop: "pulse" }, beat: prof.beat },
      { type: "shape", shape: "ring", x: cx, y: cy, w: 52 * scale, h: 52 * scale, stroke: b, strokeW: 0.25, progress: 1, opacity: 0.3, z: 1, anim: { in: "scale", delay: 260, dur: 1400, ease: "outExpo", loop: "breathe" } },
      { type: "shape", shape: "ring", x: cx, y: cy, w: 72 * scale, h: 72 * scale, stroke: a, strokeW: 0.2, progress: 1, opacity: 0.18, z: 1, anim: { in: "scale", delay: 420, dur: 1500, ease: "outExpo" } },
    ];
    case "orbit": return [
      { type: "backdrop", kind: "glow", colors: [a], opacity: 0.45, x: cx, y: cy, z: 1 },
      { type: "shape", shape: "ring", x: cx, y: cy, w: 40 * scale, h: 40 * scale, stroke: a, strokeW: 0.3, progress: 1, opacity: 0.5, z: 1, anim: { in: "scale", dur: 1100, ease: "outExpo" } },
      { type: "orbit", x: cx, y: cy, radius: 20 * scale, count: 5, color: a, color2: b, tilt: 0.38, speed: 0.22 + prof.beat * 0.12, z: 2, opacity: 0.95 },
      { type: "orbit", x: cx, y: cy, radius: 31 * scale, count: 3, color: b, tilt: 0.3, speed: -0.14, z: 2, opacity: 0.7 },
    ];
    default: return [];
  }
}


/* ------------------------------------------------------------------------------------------------------------------ */
/*  Brand marks                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export const defaultBrand = (title: string): Brand => ({ name: title.replace(/\*/g, "").slice(0, 28) || "Brand", mark: "ring" });

/** An animated vector logo mark, built from primitives so it can be drawn, popped, orbited and pulsed on the beat. */
export function markElements(brand: Brand, cx: number, cy: number, size: number, P: { accent: string; accent2: string; text: string; dark: boolean; bg: string }, enter: (delay: number, kind: NonNullable<Anim["in"]>, extra?: Partial<Anim>) => Anim, beat: number, aspect = 16 / 9): VideoElement[] {
  const out: VideoElement[] = [], fill: [string, string] = [P.accent, P.accent2], ink = bestInk(P.accent, P.accent2);
  const mono = (brand.monogram || brand.name.trim()[0] || "Z").slice(0, 2).toUpperCase();
  /* rounded shapes take their width as a share of the frame WIDTH; `hPct` is a share of the frame HEIGHT, so convert with the aspect */
  const wOf = (hPct: number): number => hPct / aspect;
  out.push({ type: "backdrop", kind: "glow", colors: [P.accent], opacity: 0.55, x: cx, y: cy, z: 1 });
  out.push({ type: "shape", shape: "ring", x: cx, y: cy, w: size * 1.55, h: size * 1.55, stroke: P.accent, strokeW: 0.22, progress: 1, opacity: 0.4, z: 2, anim: enter(150, "scale", { dur: 1300, ease: "outExpo", loop: "breathe" }) });
  const monoEl = (sz: number): VideoElement => ({ type: "text", text: mono, x: cx, y: cy + sz * 0.02, size: sz, weight: 900, font: "display", color: ink, align: "center", tracking: -0.04, z: 7, anim: enter(620, "pop", { dur: 700, ease: "outBack" }) });
  switch (brand.mark) {
    case "square": out.push({ type: "shape", shape: "rounded", x: cx, y: cy, w: wOf(size * 0.56), h: size, fill, radius: size * 0.2, glow: P.accent, z: 6, beat, anim: enter(250, "pop", { dur: 800, ease: "outBack" }) }); out.push(monoEl(size * 0.52)); break;
    case "hex": out.push({ type: "shape", shape: "hex", x: cx, y: cy, w: size, h: size, fill, glow: P.accent, z: 6, beat, anim: enter(250, "pop", { dur: 800, ease: "outBack" }) }); out.push(monoEl(size * 0.46)); break;
    case "diamond": out.push({ type: "shape", shape: "diamond", x: cx, y: cy, w: size * 1.05, h: size * 1.05, fill, glow: P.accent, z: 6, beat, anim: enter(250, "pop", { dur: 800, ease: "outBack" }) }); out.push(monoEl(size * 0.4)); break;
    case "star": out.push({ type: "shape", shape: "star", x: cx, y: cy, w: size, h: size, fill, glow: P.accent, z: 6, beat, anim: enter(250, "pop", { dur: 900, ease: "outBack", loop: "spin" }) }); break;
    case "bolt": case "leaf": out.push({ type: "shape", shape: "rounded", x: cx, y: cy, w: wOf(size * 0.56), h: size, fill, radius: size * 0.2, glow: P.accent, z: 6, beat, anim: enter(250, "pop", { dur: 800, ease: "outBack" }) }); out.push({ type: "icon", name: brand.mark === "bolt" ? "bolt" : "leaf", x: cx, y: cy, size: size * 0.5, color: ink, strokeW: 1.5, z: 7, anim: enter(620, "pop", { dur: 700, ease: "outBack" }) }); break;
    case "orbit": out.push({ type: "shape", shape: "circle", x: cx, y: cy, w: size * 0.5, h: size * 0.5, fill, glow: P.accent, z: 6, beat, anim: enter(250, "pop", { dur: 800, ease: "outBack" }) }); out.push({ type: "orbit", x: cx, y: cy, radius: size * 0.62, count: 3, color: P.accent, color2: P.accent2, tilt: 0.42, speed: 0.3, z: 7, opacity: 1 }); break;
    default: out.push({ type: "shape", shape: "ring", x: cx, y: cy, w: size, h: size, stroke: P.accent, strokeW: size * 0.1, glow: P.accent, progress: 1, z: 6, beat, anim: enter(250, "scale", { dur: 1100, ease: "outBack" }) }); out.push({ type: "shape", shape: "circle", x: cx, y: cy, w: size * 0.36, h: size * 0.36, fill, glow: P.accent2, z: 7, anim: enter(620, "pop", { dur: 700, ease: "outBack" }) }); break;
  }
  return out;
}
/** White or near-black, whichever reads better on the blend of two brand colours. */
function bestInk(a: string, b: string): string { const m = mixColor(a, b, 0.5); return contrast(m, "#ffffff") >= contrast(m, "#0b0f19") ? "#ffffff" : "#0b0f19"; }

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Compiler                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export function compileScene(ctx: CompileCtx): VideoElement[] {
  const { spec, scene, W, H, measure, index } = ctx;
  const P = paletteFor(spec, scene), motion = motionOf(scene, index), prof = profileOf(motion), fp = fontPlan(spec.fontStyle);
  const captions = spec.captions && spec.audio.voiceoverLines.some((l) => l.startMs >= ctx.startMs && l.startMs < ctx.startMs + ctx.durMs);
  const yMin = 8, yMax = captions ? 78 : 92;
  /* hold the content until the next scene's transition (which covers the exit); only soft transitions get a visible exit */
  const exit: Anim["out"] = ctx.isLast ? "none" : ctx.outKind === "fade" || ctx.outKind === "dip" ? "fade" : "none";
  const outAt = Math.max(600, ctx.durMs - 340);
  const enter = (delay: number, kind: NonNullable<Anim["in"]>, extra: Partial<Anim> = {}): Anim => ({ in: kind, out: exit, outAt, delay: snapLocal(ctx, delay), dur: prof.dur, ease: prof.ease, stagger: prof.stagger, ...extra });
  const out: VideoElement[] = [];
  const lh = 1.08;

  /* ---- backdrop: always present, tinted, with the scene's motif on top ---- */
  out.push({ type: "backdrop", kind: "gradient", colors: [shade(P.bg, P.dark ? 0.045 : -0.03), P.bg, shade(P.bg, P.dark ? -0.04 : 0.03)], angle: 155 + index * 11, z: 0 });
  const visual: Visual = scene.visual ?? (scene.layout === "kinetic" ? "burst" : DEFAULT_VISUALS[(index + (spec.seed % 5)) % DEFAULT_VISUALS.length]!);
  const splitCx = scene.layout === "split" || scene.layout === "chart" ? 74 : scene.layout === "list" ? 86 : scene.layout === "statement" ? 82 : 50;
  const cy = 50;
  out.push(...motif(visual, P, prof, splitCx, cy, scene.layout === "hero" || scene.layout === "outro" ? 1.35 : 1, spec.seed + index, captions));

  const text = (o: Partial<TextEl> & Pick<TextEl, "text" | "x" | "y" | "size">): TextEl => ({ type: "text", color: P.text, accent: P.accent, font: fp.body, weight: 600, align: "center", z: 5, ...o });
  const head = (txt: string, o: { x: number; y?: number; align: "left" | "center"; start: number; min: number; maxLines: number; maxW: number; delay?: number; anchorTop?: number }): { el: TextEl; fit: Fit; top: number; bottom: number } => {
    const fit = fitText(txt, { W, H, startSize: o.start, minSize: o.min, maxLines: o.maxLines, maxWpct: o.maxW, lineHeight: lh, font: fp.head, weight: fp.headWeight, tracking: fp.headTracking, italic: fp.headItalic, upper: fp.headUpper }, measure);
    const yc = o.anchorTop !== undefined ? o.anchorTop + fit.blockH / 2 : o.y ?? 50;
    const long = stripMarks(txt).length > 26;
    const el = text({
      text: txt, x: o.x, y: yc, size: fit.size, font: fp.head, weight: fp.headWeight, align: o.align, maxW: fit.wPct, lineHeight: lh, tracking: fp.headTracking, upper: fp.headUpper, italic: fp.headItalic,
      beat: prof.beat * 0.5, shadow: P.dark,
      anim: enter(o.delay ?? 280, motion === "calm" ? "mask" : prof.chars && !long ? "chars" : "words", { stagger: prof.chars && !long ? prof.stagger * 0.7 : prof.stagger * 1.6 }),
    });
    return { el, fit, top: yc - fit.blockH / 2, bottom: yc + fit.blockH / 2 };
  };
  const eyebrow = (txt: string | undefined, x: number, y: number, align: "left" | "center", delay = 120): void => {
    if (!txt?.trim()) return;
    out.push(text({ text: txt.toUpperCase(), x, y, size: 2.5, weight: 700, color: P.accent, font: fp.eyebrow, tracking: 0.3, align, anim: enter(delay, "fade", { dur: 600 }) }));
  };
  const sub = (txt: string | undefined, x: number, y: number, align: "left" | "center", maxW: number, delay: number, size = 3.3): void => {
    if (!txt?.trim()) return;
    out.push(text({ text: txt, x, y, size, color: P.muted, align, maxW, lineHeight: 1.35, anim: enter(delay, "rise", { dur: 700, ease: "outCubic" }) }));
  };
  const rule = (x: number, y: number, w: number, align: "left" | "center", delay: number): void => {
    out.push({ type: "shape", shape: "rounded", x: align === "left" ? x + w / 2 : x, y, w, h: 0.55, fill: [P.accent, P.accent2], radius: 0.3, z: 5, anim: enter(delay, "wipe", { dur: 650 }) });
  };

  const headline = scene.headline?.trim() ?? "";
  switch (scene.layout) {
    case "hero": {
      const hasSub = !!scene.sub?.trim();
      const h = head(headline || scene.label, { x: 50, align: "center", start: 11.8, min: 5.2, maxLines: 3, maxW: 82, y: hasSub ? 46 : 50 });
      eyebrow(scene.eyebrow, 50, Math.max(yMin + 2, h.top - 5.5), "center");
      out.push(h.el);
      rule(50, h.bottom + 3.6, 9, "center", 900);
      sub(scene.sub, 50, h.bottom + 9, "center", 66, 1100);
      break;
    }
    case "statement": {
      const h = head(headline || scene.label, { x: 9.5, align: "left", start: 11.6, min: 5, maxLines: 4, maxW: 78, y: 50 });
      eyebrow(scene.eyebrow, 9.5, Math.max(yMin + 2, h.top - 5.5), "left");
      out.push({ type: "shape", shape: "rounded", x: 6.4, y: (h.top + h.bottom) / 2, w: 0.55, h: h.bottom - h.top + 3, fill: [P.accent, P.accent2], radius: 0.3, z: 5, anim: enter(120, "wipe", { dur: 800 }) });
      out.push(h.el);
      sub(scene.sub, 9.5, h.bottom + 7, "left", 62, 1100);
      break;
    }
    case "split": {
      const h = head(headline || scene.label, { x: 8, align: "left", start: 8.6, min: 4.6, maxLines: 4, maxW: 44, y: 46 });
      eyebrow(scene.eyebrow, 8, Math.max(yMin + 2, h.top - 5.5), "left");
      out.push(h.el);
      rule(8, h.bottom + 3.4, 8, "left", 900);
      sub(scene.sub, 8, h.bottom + 9, "left", 42, 1050);
      if (scene.chart) {
        out.push({ type: "chart", chart: scene.chart.type, data: scene.chart.data.slice(0, 6), colors: [P.accent, P.accent2], text: P.text, muted: P.muted, ...(scene.chart.unit ? { unit: scene.chart.unit } : {}), x: 73, y: 50, w: 40, h: 46, z: 5, anim: enter(600, "fade", { dur: 1100 }) });
      } else if (scene.items?.length) {
        const items = scene.items.slice(0, 3), rowH = 17;
        items.forEach((it, i) => out.push(card(P, it.title, it.body, it.icon, 73, 50 + (i - (items.length - 1) / 2) * rowH, 40, 14.5, enter(500 + i * 220, "slide-right", { dur: 700 }))));
      } else {
        const ic = iconName(scene.icon) ?? "sparkle";
        out.push({ type: "shape", shape: "circle", x: 73, y: 50, w: 30, h: 30, fill: [P.accent, P.accent2], opacity: 0.16, z: 3, anim: enter(300, "scale", { dur: 900 }) });
        out.push({ type: "icon", name: ic, x: 73, y: 50, size: 14, color: P.text, strokeW: 1.4, z: 6, anim: enter(700, "pop", { dur: 800, ease: "outBack", loop: "float" }), beat: prof.beat });
      }
      break;
    }
    case "stats": {
      const stats = (scene.stats ?? []).slice(0, 4);
      const h = head(headline || scene.label, { x: 50, align: "center", start: 6.6, min: 4.4, maxLines: 2, maxW: 80, y: 21 });
      eyebrow(scene.eyebrow, 50, Math.max(yMin + 1, h.top - 4.6), "center");
      out.push(h.el);
      if (stats.length === 1) {
        const s = stats[0]!;
        out.push(statEl(P, s, 50, 55, 21, fp.num, enter(500, "pop", { dur: 900, ease: "outBack" }), true));
        sub(scene.sub, 50, 79, "center", 60, 1500);
      } else {
        const n = Math.max(1, stats.length), cw = Math.min(24, 82 / n - 2), gap = 2.2, total = n * cw + (n - 1) * gap;
        stats.forEach((s, i) => {
          const cx = 50 - total / 2 + cw / 2 + i * (cw + gap);
          out.push(panel(P, cx, 57, cw, 32, enter(420 + i * 190, "pop", { dur: 750, ease: "outBack" })));
          out.push({ type: "shape", shape: "rounded", x: cx, y: 57 - 16 + 1.6, w: cw * 0.34, h: 0.75, fill: [P.accent, P.accent2], radius: 0.4, z: 6, anim: enter(560 + i * 190, "wipe", { dur: 600 }) });
          out.push(statEl(P, s, cx, 54.5, n >= 4 ? 9.6 : n === 3 ? 12 : 14, fp.num, enter(520 + i * 190, "fade", { dur: 600 }), false, cw - 2.4));
        });
        sub(scene.sub, 50, 80, "center", 64, 1500);
      }
      break;
    }
    case "list": {
      const items = (scene.items ?? []).slice(0, 4);
      const h = head(headline || scene.label, { x: 8, align: "left", start: 6.8, min: 4.4, maxLines: 2, maxW: 74, y: 21 });
      eyebrow(scene.eyebrow, 8, Math.max(yMin + 1, h.top - 4.6), "left");
      out.push(h.el);
      const top = 40, step = Math.min(15.5, (yMax - top - 2) / Math.max(1, items.length));
      items.forEach((it, i) => {
        const y = top + i * step + step / 2 - 1;
        out.push({ type: "shape", shape: "rounded", x: 8 + 40, y: y + step / 2 - 0.6, w: 80, h: 0.12, fill: P.muted, opacity: 0.25, z: 4, radius: 0.1, anim: enter(500 + i * 200, "wipe", { dur: 600 }) });
        out.push({ type: "icon", name: iconName(it.icon) ?? (["bolt", "target", "sparkle", "shield"] as IconName[])[i % 4]!, x: 11.2, y, size: 5.6, color: P.accent, tile: mixColor(P.bg, P.accent, 0.16), strokeW: 1.7, z: 6, anim: enter(500 + i * 200, "pop", { dur: 600, ease: "outBack" }) });
        out.push(text({ text: it.title, x: 17.2, y: y - (it.body ? 1.7 : 0), size: 4.3, weight: 750, font: fp.head === "serif" ? "serif" : "display", align: "left", maxW: 56, anim: enter(560 + i * 200, "slide-right", { dur: 650 }) }));
        if (it.body) out.push(text({ text: it.body, x: 17.2, y: y + 2.9, size: 3, color: P.muted, align: "left", maxW: 58, lineHeight: 1.3, anim: enter(640 + i * 200, "fade", { dur: 600 }) }));
      });
      break;
    }
    case "cards": {
      const items = (scene.items ?? []).slice(0, 4);
      const h = head(headline || scene.label, { x: 50, align: "center", start: 6.4, min: 4.4, maxLines: 2, maxW: 82, y: 21 });
      eyebrow(scene.eyebrow, 50, Math.max(yMin + 1, h.top - 4.6), "center");
      out.push(h.el);
      const n = Math.max(1, items.length), cw = Math.min(27, 84 / n - 2), gap = 2.4, total = n * cw + (n - 1) * gap;
      items.forEach((it, i) => {
        const cx = 50 - total / 2 + cw / 2 + i * (cw + gap);
        out.push(card(P, it.title, it.body, it.icon ?? (["bolt", "shield", "sparkle", "target"] as IconName[])[i % 4], cx, 58, cw, 40, enter(420 + i * 200, "pop", { dur: 800, ease: "outBack", loop: "float" }), true));
      });
      sub(scene.sub, 50, 84, "center", 64, 1600, 2.9);
      break;
    }
    case "quote": {
      const q = scene.quote?.text?.trim() || headline || scene.label;
      out.push(text({ text: "\u201C", x: 12, y: 27, size: 36, color: P.accent, font: "serif", weight: 700, opacity: 0.22, align: "center", z: 3, anim: enter(100, "scale", { dur: 1000 }) }));
      const fit = fitText(q, { W, H, startSize: 6.6, minSize: 3.8, maxLines: 5, maxWpct: 70, lineHeight: 1.22, font: "serif", weight: 600, tracking: -0.005, italic: true }, measure);
      const yc = 46;
      out.push(text({ text: q, x: 50, y: yc, size: fit.size, font: "serif", weight: 600, italic: true, align: "center", maxW: fit.wPct, lineHeight: 1.22, tracking: -0.005, anim: enter(300, "words", { stagger: prof.stagger * 1.7 }), shadow: P.dark }));
      const who = scene.quote?.who?.trim();
      if (who) out.push(text({ text: `\u2014 ${who}`.toUpperCase(), x: 50, y: yc + fit.blockH / 2 + 6.5, size: 2.5, weight: 700, color: P.accent, font: "mono", tracking: 0.25, anim: enter(1500, "fade", { dur: 700 }) }));
      eyebrow(scene.eyebrow, 50, Math.max(yMin + 2, yc - fit.blockH / 2 - 7), "center");
      break;
    }
    case "chart": {
      const chart = scene.chart ?? (scene.stats?.length ? { type: "bars" as const, data: scene.stats.map((s) => ({ label: s.label, value: s.value })) } : { type: "bars" as const, data: [{ label: "A", value: 40 }, { label: "B", value: 65 }, { label: "C", value: 90 }] });
      const h = head(headline || scene.label, { x: 8, align: "left", start: 7.6, min: 4.4, maxLines: 4, maxW: 36, y: 44 });
      eyebrow(scene.eyebrow, 8, Math.max(yMin + 2, h.top - 5.5), "left");
      out.push(h.el);
      sub(scene.sub, 8, h.bottom + 8, "left", 34, 1100);
      out.push({ type: "chart", chart: chart.type, data: chart.data.slice(0, 7), colors: [P.accent, P.accent2], text: P.text, muted: P.muted, ...(chart.unit ? { unit: chart.unit } : {}), x: 67, y: 50, w: 50, h: 54, z: 5, anim: enter(500, "fade", { dur: 1300 }) });
      break;
    }
    case "timeline": {
      const items = (scene.items ?? []).slice(0, 5);
      const h = head(headline || scene.label, { x: 50, align: "center", start: 6.4, min: 4.4, maxLines: 2, maxW: 80, y: 20 });
      eyebrow(scene.eyebrow, 50, Math.max(yMin + 1, h.top - 4.6), "center");
      out.push(h.el);
      const n = Math.max(2, items.length), x0 = 14, x1 = 86, ly = 56;
      out.push({ type: "shape", shape: "line", x: (x0 + x1) / 2, y: ly, w: x1 - x0, h: 0.4, stroke: P.muted, strokeW: 0.35, progress: 1, opacity: 0.55, z: 4, anim: enter(300, "wipe", { dur: 1300 }) });
      items.forEach((it, i) => {
        const x = x0 + ((x1 - x0) * i) / (n - 1), up = i % 2 === 0, d = 600 + i * 330;
        out.push({ type: "shape", shape: "circle", x, y: ly, w: 3.6, h: 3.6, fill: i === n - 1 ? P.accent2 : P.accent, glow: P.accent, z: 6, anim: enter(d, "pop", { dur: 500, ease: "outBack" }), beat: prof.beat });
        out.push(text({ text: it.title, x, y: ly + (up ? -11.5 : 10), size: 4, weight: 750, font: "display", maxW: 24, lineHeight: 1.1, anim: enter(d + 100, "rise", { dur: 600 }) }));
        if (it.body) out.push(text({ text: it.body, x, y: ly + (up ? -6 : 15.6), size: 2.8, color: P.muted, maxW: 22, lineHeight: 1.28, anim: enter(d + 200, "fade", { dur: 600 }) }));
      });
      break;
    }
    case "kinetic": {
      const words = (scene.words?.length ? scene.words : headline.split(/\s+/)).map((w) => w.trim()).filter(Boolean).slice(0, 10);
      if (!words.length) words.push(scene.label);
      const beat = Math.max(300, ctx.beatMs), avail = Math.max(900, ctx.durMs - 900);
      let slot = motion === "explosive" ? beat : motion === "energetic" ? beat * 1.5 : beat * 2;
      while (slot * words.length > avail && slot > beat / 2) slot -= beat / 4;
      slot = Math.max(beat / 2, slot);
      const start = snapLocal(ctx, 250), colors = [P.text, P.accent, P.text, P.accent2];
      words.forEach((w, k) => {
        const t0 = Math.round(start + k * slot), last = k === words.length - 1;
        const up = fp.head === "serif" ? w : w.toUpperCase();
        const fit = fitText(up, { W, H, startSize: 21, minSize: 7, maxLines: 1, maxWpct: 86, lineHeight: 1, font: "display", weight: 900, tracking: -0.035 }, measure);
        const yj = 50 + ((k * 37) % 7) - 3, rot = (k % 2 ? 1 : -1) * (1.2 + (k % 3) * 0.7), col = readableOn(P.bgAvg, colors[k % colors.length], 4.5);
        if (k % 3 === 1) out.push({ type: "shape", shape: "rect", x: 50, y: yj, w: 94, h: fit.size * 1.18, fill: [P.accent, P.accent2], rotate: rot * 0.6, z: 4, anim: { in: "slam", delay: t0, dur: 220, ease: "outExpo", ...(last ? {} : { out: "scale" as const, outAt: Math.round(t0 + slot - 50), outDur: 50 }) } });
        const onBand = k % 3 === 1, tcol = onBand ? readableOn(mixColor(P.accent, P.accent2, 0.5), "#ffffff", 4.5) : col;
        out.push(text({ text: up, x: 50, y: yj, size: fit.size, weight: 900, font: "display", tracking: -0.035, color: tcol, rotate: rot, z: 6, beat: 0.9, shadow: P.dark && !onBand, ...(onBand ? {} : { glow: P.accent }), anim: { in: "slam", delay: t0, dur: 260, ease: "outBack", ...(last ? { loop: "pulse" as const } : { out: "scale" as const, outAt: Math.round(t0 + slot - 60), outDur: 60 }) } }));
        if (motion !== "calm") out.push({ type: "flash", color: k % 2 ? P.accent : P.accent2, opacity: motion === "explosive" ? 0.3 : 0.16, z: 9, anim: { in: "fade", delay: t0, dur: 120 } });
      });
      if (scene.sub?.trim()) out.push(text({ text: scene.sub, x: 50, y: captions ? 70 : 80, size: 3.2, color: P.muted, maxW: 70, anim: enter(Math.round(start + words.length * slot * 0.8), "rise", { dur: 700 }) }));
      eyebrow(scene.eyebrow, 50, 12, "center", 100);
      break;
    }
    case "logo": {
      const brand = spec.brand ?? defaultBrand(headline || scene.label);
      out.push(...markElements(brand, 50, 33, 22, P, enter, prof.beat, W / H));
      const word = stripMarks(brand.name).slice(0, 28);
      const wm = fitText(word, { W, H, startSize: 9.4, minSize: 4.2, maxLines: 1, maxWpct: 80, lineHeight: 1.05, font: fp.head, weight: fp.headWeight, tracking: fp.headTracking, italic: fp.headItalic, upper: fp.headUpper }, measure);
      out.push(text({ text: word, x: 50, y: 58, size: wm.size, font: fp.head, weight: fp.headWeight, align: "center", maxW: 84, lineHeight: 1.05, tracking: fp.headTracking, upper: fp.headUpper, italic: fp.headItalic, shadow: P.dark, anim: enter(980, prof.chars ? "chars" : "words", { stagger: prof.stagger * 0.5 }) }));
      rule(50, 66.4, 10, "center", 1500);
      const tag = (scene.sub ?? brand.tagline ?? "").trim();
      if (tag) out.push(text({ text: tag, x: 50, y: 70.8, size: 3.1, color: P.muted, align: "center", maxW: 70, lineHeight: 1.3, anim: enter(1700, "rise", { dur: 700, ease: "outCubic" }) }));
      eyebrow(scene.eyebrow, 50, 13, "center", 200);
      break;
    }
    case "device": {
      const h = head(headline || scene.label, { x: 7.5, align: "left", start: 8.4, min: 4.6, maxLines: 3, maxW: 38, y: 40 });
      eyebrow(scene.eyebrow, 7.5, Math.max(yMin + 2, h.top - 5.5), "left");
      out.push(h.el);
      rule(7.5, h.bottom + 3.2, 8, "left", 900);
      sub(scene.sub, 7.5, h.bottom + 8, "left", 36, 1100);
      const phone = scene.device === "phone";
      const dw = phone ? 21 : 44, dh = phone ? 66 : 47, dx = phone ? 79 : 68, dy = 53;
      const screen = mixColor(P.bg, P.dark ? "#000000" : "#ffffff", P.dark ? 0.3 : 0.03), tile = mixColor(screen, P.accent, 0.13);
      const at = (fx: number, fy: number): [number, number] => [dx + fx * dw, dy + fy * dh];
      out.push({ type: "backdrop", kind: "glow", colors: [P.accent], opacity: 0.5, x: dx, y: dy, z: 1 });
      out.push({ type: "shape", shape: "rounded", x: dx, y: dy, w: dw, h: dh, radius: phone ? 4.2 : 2.4, fill: mixColor(P.bg, P.dark ? "#ffffff" : "#000000", 0.14), stroke: P.accent, strokeW: 0.14, shadow: true, glow: P.accent, z: 4, anim: enter(300, "rise", { dur: 900, ease: "outExpo" }) });
      out.push({ type: "shape", shape: "rounded", x: dx, y: dy + dh * 0.012, w: dw * 0.92, h: dh * 0.9, radius: phone ? 3.4 : 1.6, fill: screen, z: 4, anim: enter(360, "fade", { dur: 700 }) });
      const [dotX, dotY] = at(phone ? -0.3 : -0.4, -0.41);
      for (let i = 0; i < 3; i++) out.push({ type: "shape", shape: "circle", x: dotX + i * 1.6, y: dotY, w: 0.8, h: 0.8, fill: P.muted, opacity: 0.7, z: 5, anim: enter(480 + i * 60, "pop", { dur: 500, ease: "outBack" }) });
      const [pillX, pillY] = at(phone ? 0.12 : 0.02, -0.41);
      out.push({ type: "shape", shape: "rounded", x: pillX, y: pillY, w: dw * (phone ? 0.36 : 0.4), h: dh * 0.035, radius: 0.9, fill: tile, z: 5, anim: enter(520, "wipe", { dur: 700 }) });
      const data = (scene.chart?.data ?? (scene.stats?.length ? scene.stats.map((st) => ({ label: st.label.slice(0, 10), value: st.value })) : [{ label: "Mon", value: 40 }, { label: "Tue", value: 58 }, { label: "Wed", value: 52 }, { label: "Thu", value: 77 }, { label: "Fri", value: 70 }, { label: "Sat", value: 90 }])).slice(0, 6).map((d) => ({ label: d.label.slice(0, 3), value: d.value }));
      const [chX, chY] = phone ? at(0, -0.03) : at(-0.2, 0.06);
      out.push({ type: "chart", chart: scene.chart?.type ?? "bars", data, colors: [P.accent, P.accent2], text: P.text, muted: P.muted, x: chX, y: chY, w: dw * (phone ? 0.8 : 0.46), h: dh * (phone ? 0.36 : 0.56), z: 5, anim: enter(700, "fade", { dur: 1100 }) });
      const [prX, prY] = phone ? at(0, 0.27) : at(0, 0.43), railW = dw * (phone ? 0.8 : 0.84);
      out.push({ type: "shape", shape: "rounded", x: prX, y: prY, w: railW, h: dh * 0.028, radius: 0.5, fill: tile, z: 5, anim: enter(820, "fade", { dur: 600 }) });
      out.push({ type: "shape", shape: "rounded", x: prX - railW / 2 + railW * 0.36, y: prY, w: railW * 0.72, h: dh * 0.028, radius: 0.5, fill: [P.accent, P.accent2], z: 6, anim: enter(900, "wipe", { dur: 1100 }) });
      const icons: IconName[] = ["bolt", "chart", "shield"];
      const tiles: [number, number][] = phone ? [at(-0.23, 0.38), at(0.23, 0.38)] : [at(0.27, -0.19), at(0.27, 0.03), at(0.27, 0.25)];
      tiles.forEach(([tx, ty], i) => {
        const tw2 = dw * (phone ? 0.42 : 0.3), th2 = dh * (phone ? 0.16 : 0.18);
        out.push({ type: "shape", shape: "rounded", x: tx, y: ty, w: tw2, h: th2, radius: 1.1, fill: tile, z: 5, anim: enter(1000 + i * 180, "pop", { dur: 700, ease: "outBack" }) });
        const st = scene.stats?.[i], it = scene.items?.[i];
        const iconX = phone ? tx : tx - tw2 / 2 + 2.6;
        out.push({ type: "icon", name: it?.icon ?? icons[i]!, x: iconX, y: phone ? ty - th2 * 0.12 : ty, size: phone ? 2.8 : 3.2, color: P.accent, strokeW: 1.6, z: 6, anim: enter(1100 + i * 180, "pop", { dur: 600, ease: "outBack" }) });
        if (!phone && st) out.push(text({ text: `${st.prefix ?? ""}${st.decimals !== undefined ? st.value.toFixed(st.decimals) : st.value}${st.suffix ?? ""}`, x: iconX + 2.6, y: ty - th2 * 0.12, size: 3.2, weight: 800, font: "display", align: "left", z: 6, anim: enter(1200 + i * 180, "rise", { dur: 600 }) }));
        const label = st?.label ?? it?.title;
        if (!phone && label) out.push(text({ text: label, x: iconX + 2.6, y: ty + th2 * 0.3, size: 1.9, color: P.muted, align: "left", maxW: 26, z: 6, anim: enter(1260 + i * 180, "fade", { dur: 600 }) }));
      });
      break;
    }
    case "outro": {
      if (spec.brand) out.push(...markElements(spec.brand, 50, 24, 13, P, enter, prof.beat, W / H));
      else out.push({ type: "shape", shape: "ring", x: 50, y: 24, w: 13, h: 13, stroke: P.accent, strokeW: 0.9, glow: P.accent, progress: 1, z: 6, anim: enter(150, "scale", { dur: 1100, ease: "outBack", loop: "pulse" }), beat: prof.beat });
      if (!spec.brand) out.push({ type: "shape", shape: "circle", x: 50, y: 24, w: 3, h: 3, fill: P.accent2, glow: P.accent2, z: 6, anim: enter(500, "pop", { dur: 600, ease: "outBack" }) });
      const h = head(headline || scene.label, { x: 50, align: "center", start: 9.4, min: 4.8, maxLines: 2, maxW: 80, y: 47, delay: 500 });
      out.push(h.el);
      sub(scene.sub, 50, h.bottom + 7.5, "center", 64, 1500);
      const madeWith = /made with zeros/i.test(`${headline} ${scene.sub ?? ""}`);
      if (!madeWith) out.push(text({ text: "MADE WITH ZEROS", x: 50, y: captions ? 74 : 82, size: 2.7, weight: 800, color: P.accent, font: "mono", tracking: 0.42, anim: enter(2000, "fade", { dur: 800 }) }));
      out.push(text({ text: "a VsiStudio production", x: 50, y: captions ? 78.6 : 87, size: 2.5, color: P.muted, font: "body", tracking: 0.12, anim: enter(2300, "fade", { dur: 800 }) }));
      break;
    }
  }

  if (scene.elements?.length) for (const el of scene.elements) out.push(el);
  return out.sort((a, b) => (a.z ?? 5) - (b.z ?? 5));
}

/* ------------------------------------------------------------------------------------------------------------------ */

function panel(P: Pal, x: number, y: number, w: number, h: number, anim: Anim): VideoElement {
  return { type: "shape", shape: "rounded", x, y, w, h, fill: mixColor(P.bg, P.dark ? "#ffffff" : "#000000", 0.07), stroke: mixColor(P.bg, P.dark ? "#ffffff" : "#000000", 0.2), strokeW: 0.14, radius: 2.2, shadow: true, z: 4, anim };
}
function card(P: Pal, title: string, body: string | undefined, icon: IconName | undefined, x: number, y: number, w: number, h: number, anim: Anim, tall = false): CardEl {
  return { type: "card", x, y, w, h, title, ...(body ? { body } : {}), ...(icon ? { icon: iconName(icon) ?? "sparkle" } : {}), accent: P.accent, text: P.text, muted: P.muted, fill: mixColor(P.bg, P.dark ? "#ffffff" : "#000000", 0.07), z: 5, anim, ...(tall ? {} : {}) };
}
function statEl(P: Pal, s: { value: number; prefix?: string; suffix?: string; label: string; decimals?: number }, x: number, y: number, size: number, font: FontKind, anim: Anim, hero = false, maxWpct = 40): StatEl {
  void font; void maxWpct; void hero;
  return { type: "stat", x, y, size, value: s.value, ...(s.prefix ? { prefix: s.prefix } : {}), ...(s.suffix ? { suffix: s.suffix } : {}), decimals: s.decimals ?? (Number.isInteger(s.value) ? 0 : 1), label: s.label, color: P.text, labelColor: P.muted, z: 6, anim, beat: 0.4, ...(hero ? { w: 70 } : { w: maxWpct }) };
}
