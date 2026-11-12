/**
 * Zeros Cinema Engine - element renderer. Every element is a PURE FUNCTION OF TIME (scene-local ms + audio envelope), so
 * a film renders identically on any device, in any order, at any resolution; frames can be re-drawn for posters and QA.
 */
import { ICONS, clamp, clamp01, ease, hash01, lerp, mixColor, parseColor, rgba, shade, type IconName } from "./kit";
import type { Anim, BackdropEl, CardEl, ChartEl, FlashEl, FontKind, GridEl, IconEl, OrbitEl, ParticlesEl, ShapeEl, StatEl, TextEl, VideoElement, WaveEl } from "./types";
import type { Measure } from "./layouts";

export type Env = {
  W: number; H: number;
  /** scene-local time, ms (may be < 0 before the scene starts, > dur while it is the outgoing half of a transition) */
  local: number; dur: number;
  /** global time in seconds, plus an energy-warped clock for audio-reactive drift */
  t: number; tw: number;
  /** audio reaction: pulse (beat/kick envelope 0..1), energy (loudness 0..1) */
  pulse: number; energy: number;
  seed: number;
  /** global alpha multiplier for the whole scene (used by crossfades) */
  alpha: number;
};

const STACKS: Record<FontKind, string> = {
  display: `"Inter Tight","Inter","SF Pro Display","Segoe UI","Helvetica Neue",Arial,system-ui,sans-serif`,
  serif: `"Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,"Times New Roman",serif`,
  mono: `ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace`,
  body: `"Inter","SF Pro Text","Segoe UI","Helvetica Neue",Arial,system-ui,sans-serif`,
};
export const fontCss = (font: FontKind, weight: number, italic: boolean, px: number): string => `${italic ? "italic " : ""}${weight} ${px.toFixed(2)}px ${STACKS[font]}`;

export function makeMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, sizePx, font, weight, tracking, italic) => {
    ctx.font = fontCss(font, weight, italic, sizePx);
    return ctx.measureText(text).width + Math.max(0, text.length - 1) * tracking * sizePx;
  };
}

const TAU = Math.PI * 2;
const frac = (v: number): number => v - Math.floor(v);

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Animation phase                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

type Phase = { pIn: number; pOut: number; alpha: number; visible: boolean };
export function phaseOf(anim: Anim | undefined, e: Env): Phase {
  if (!anim) return { pIn: 1, pOut: 0, alpha: 1, visible: true };
  const kind = anim.in ?? "fade", delay = anim.delay ?? 0, d = Math.max(1, anim.dur ?? 700);
  const raw = kind === "none" ? 1 : clamp01((e.local - delay) / d);
  const out = anim.out && anim.out !== "none" ? clamp01((e.local - (anim.outAt ?? e.dur - 320)) / Math.max(1, anim.outDur ?? 320)) : 0;
  /* per-unit entrances (chars / words / mask / typewriter / wipe) reveal themselves unit by unit, so the element itself is simply "on" from its delay */
  const perUnit = kind === "chars" || kind === "words" || kind === "mask" || kind === "typewriter" || kind === "wipe";
  const base = kind === "none" ? 1 : perUnit ? (e.local >= delay ? 1 : 0) : kind === "slam" || kind === "pop" || kind === "scale" ? clamp01(raw * 3) : raw > 0 ? ease("outCubic", Math.min(1, raw * 1.6)) : 0;
  const alpha = base * (1 - out);
  return { pIn: raw, pOut: out, alpha, visible: alpha > 0.002 };
}
const enterEase = (anim: Anim | undefined, p: number): number => ease(anim?.ease ?? "outCubic", p);

function loopXform(anim: Anim | undefined, e: Env, salt: number): { dy: number; s: number; rot: number } {
  const l = anim?.loop ?? "none", t = e.t;
  if (l === "float") return { dy: Math.sin(t * 1.5 + salt) * 0.9, s: 1, rot: 0 };
  if (l === "pulse") return { dy: 0, s: 1 + 0.03 * Math.sin(t * 4.2 + salt) + 0.05 * e.pulse, rot: 0 };
  if (l === "breathe") return { dy: 0, s: 1 + 0.018 * Math.sin(t * 1.4 + salt), rot: 0 };
  if (l === "spin") return { dy: 0, s: 1, rot: t * 0.6 };
  if (l === "sway") return { dy: 0, s: 1, rot: Math.sin(t * 1.1 + salt) * 0.02 };
  return { dy: 0, s: 1, rot: 0 };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Text                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

type Word = { t: string; accent: boolean; x: number; w: number; cx: number[] };
type Line = { words: Word[]; width: number };
type TextLayout = { key: string; lines: Line[]; px: number; lineH: number; font: string; fontItalic: string; blockW: number; blockH: number; chars: number };
const layouts = new WeakMap<TextEl, TextLayout>();

function layoutText(ctx: CanvasRenderingContext2D, el: TextEl, e: Env): TextLayout {
  const key = `${e.W}x${e.H}`, hit = layouts.get(el);
  if (hit && hit.key === key) return hit;
  const px = (el.size / 100) * e.H, weight = el.weight ?? 600, font = el.font ?? "body", italic = !!el.italic, track = (el.tracking ?? 0) * px;
  const fontStr = fontCss(font, weight, italic, px), fontItalic = fontCss(font, weight, true, px);
  const maxW = ((el.maxW ?? 90) / 100) * e.W;
  /* tokenise per CHARACTER so punctuation glued to an accent span ("*word*.") stays attached to its word */
  const pieces = el.text.split(/(\*[^*]+\*)/).filter(Boolean);
  const tokens: { t: string; accent: boolean }[] = [];
  let buf = "", accentChars = 0;
  const flush = (): void => { if (buf) { tokens.push({ t: el.upper ? buf.toUpperCase() : buf, accent: accentChars * 2 >= buf.length }); buf = ""; accentChars = 0; } };
  for (const piece of pieces) {
    const accent = piece.startsWith("*") && piece.endsWith("*") && piece.length > 2;
    for (const ch of accent ? piece.slice(1, -1) : piece) {
      if (ch === "\n") { flush(); tokens.push({ t: "\n", accent: false }); }
      else if (/\s/.test(ch)) flush();
      else { buf += ch; if (accent) accentChars++; }
    }
  }
  flush();
  ctx.save();
  const meas = (s: string, ital: boolean): number => { ctx.font = ital ? fontItalic : fontStr; return ctx.measureText(s).width + Math.max(0, s.length - 1) * track; };
  const space = (() => { ctx.font = fontStr; return ctx.measureText(" ").width + track; })();
  const lines: Line[] = [];
  let cur: Word[] = [], curW = 0, chars = 0;
  const push = (): void => { if (cur.length) { lines.push({ words: cur, width: curW }); } cur = []; curW = 0; };
  for (const tk of tokens) {
    if (tk.t === "\n") { push(); continue; }
    const ital = italic || (tk.accent && font === "serif");
    const w = meas(tk.t, ital);
    if (cur.length && curW + space + w > maxW) push();
    const x = curW + (cur.length ? space : 0);
    const cx: number[] = [];
    ctx.font = ital ? fontItalic : fontStr;
    for (let i = 0; i <= tk.t.length; i++) cx.push(ctx.measureText(tk.t.slice(0, i)).width + i * track);
    cur.push({ t: tk.t, accent: tk.accent, x, w, cx });
    curW = x + w; chars += tk.t.length;
  }
  push();
  ctx.restore();
  const lineH = px * (el.lineHeight ?? 1.1);
  const out: TextLayout = { key, lines, px, lineH, font: fontStr, fontItalic, blockW: Math.max(0, ...lines.map((l) => l.width)), blockH: lines.length * lineH, chars };
  layouts.set(el, out);
  return out;
}

function drawText(ctx: CanvasRenderingContext2D, el: TextEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const lay = layoutText(ctx, el, e), anim = el.anim, kind = anim?.in ?? "none", p = ph.pIn, ep = enterEase(anim, p);
  const px = lay.px, cxPx = (el.x / 100) * e.W, cyPx = (el.y / 100) * e.H;
  const lp = loopXform(anim, e, el.x * 0.37);
  const punch = 1 + 0.05 * (el.beat ?? 0) * e.pulse;
  let sc = (el.scale ?? 1) * lp.s * punch, rot = (el.rotate ?? 0) * (Math.PI / 180) + lp.rot, dx = 0, dy = lp.dy * (e.H / 100) * 0.4;
  let alpha = ph.alpha * (el.opacity ?? 1) * e.alpha;
  const outK = anim?.out ?? "none", po = ph.pOut;
  if (outK === "rise") dy -= po * px * 0.6; else if (outK === "drop") dy += po * px * 0.6; else if (outK === "scale") sc *= 1 - po * 0.12; else if (outK === "slide-left") dx -= po * e.W * 0.05; else if (outK === "slide-right") dx += po * e.W * 0.05;
  if (kind === "rise") dy += (1 - ep) * px * 0.9; else if (kind === "drop") dy -= (1 - ep) * px * 0.9;
  else if (kind === "slide-left") dx += (1 - ep) * e.W * 0.06; else if (kind === "slide-right") dx -= (1 - ep) * e.W * 0.06;
  else if (kind === "scale") sc *= lerp(0.7, 1, ep); else if (kind === "pop") sc *= lerp(0.55, 1, ease("outBack", p));
  else if (kind === "slam") { sc *= lerp(1.7, 1, ease("outBack", p)); alpha *= 1; }
  const align = el.align ?? "center";
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  if (el.blend) ctx.globalCompositeOperation = el.blend;
  ctx.translate(cxPx + dx, cyPx + dy); ctx.rotate(rot); ctx.scale(sc, sc);
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  const top = -lay.blockH / 2;
  /* marker highlight sweeping in behind the block */
  if (el.highlight) {
    const hp = ease("outCubic", clamp01((e.local - (anim?.delay ?? 0) - 300) / 700));
    ctx.fillStyle = rgba(el.highlight, 0.9);
    lay.lines.forEach((ln, i) => {
      const x0 = align === "center" ? -ln.width / 2 : align === "right" ? -ln.width : 0, y0 = top + i * lay.lineH + lay.lineH * 0.12;
      ctx.fillRect(x0 - px * 0.18, y0, (ln.width + px * 0.36) * hp, lay.lineH * 0.82);
    });
  }
  if (el.shadow) { ctx.shadowColor = "rgba(0,0,0,0.42)"; ctx.shadowBlur = px * 0.35; ctx.shadowOffsetY = px * 0.08; }
  if (el.glow) { ctx.shadowColor = rgba(el.glow, 0.85); ctx.shadowBlur = px * (0.45 + 0.5 * e.pulse * (el.beat ?? 0)); ctx.shadowOffsetY = 0; }
  const stag = anim?.stagger ?? 40, delay = anim?.delay ?? 0, dur = Math.max(1, anim?.dur ?? 700);
  let charIndex = 0;
  const wordsTotal = lay.lines.reduce((s, l) => s + l.words.length, 0);
  let wordIndex = 0;
  lay.lines.forEach((ln, li) => {
    const x0 = align === "center" ? -ln.width / 2 : align === "right" ? -ln.width : 0, base = top + li * lay.lineH + lay.lineH * 0.82;
    /* masked line reveal: the text slides up from behind its own baseline */
    if (kind === "mask") {
      const lp2 = clamp01((e.local - delay - li * stag * 2.2) / dur), me = ease("outExpo", lp2);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0 - px, base - lay.lineH * 0.95, ln.width + px * 2, lay.lineH * 1.15); ctx.clip();
      ctx.translate(0, (1 - me) * lay.lineH * 1.05);
      for (const w of ln.words) paintWord(ctx, el, lay, w, x0 + w.x, base, 1, 0);
      ctx.restore();
      wordIndex += ln.words.length; return;
    }
    for (const w of ln.words) {
      if (kind === "chars" || kind === "typewriter") {
        if (kind === "typewriter") {
          const shown = Math.floor(clamp01((e.local - delay) / (dur + w.t.length * 0)) * lay.chars);
          const chars = Math.max(0, Math.min(w.t.length, shown - charIndex));
          if (chars > 0) paintWord(ctx, el, lay, { ...w, t: w.t.slice(0, chars) }, x0 + w.x, base, 1, 0);
          charIndex += w.t.length; wordIndex++; continue;
        }
        for (let i = 0; i < w.t.length; i++) {
          const cp = clamp01((e.local - delay - (charIndex + i) * stag) / (dur * 0.85)), ce = ease(anim?.ease ?? "spring", cp);
          if (cp <= 0) continue;
          const ch = w.t[i]!, gx = x0 + w.x + (w.cx[i] ?? 0);
          ctx.save();
          ctx.globalAlpha = clamp01(alpha * clamp01(cp * 3));
          ctx.translate(gx, base + (1 - ce) * px * 0.55); ctx.rotate((1 - ce) * 0.18 * (i % 2 ? 1 : -1)); ctx.scale(lerp(0.6, 1, ce), lerp(0.6, 1, ce));
          ctx.font = w.accent && el.font === "serif" ? lay.fontItalic : lay.font;
          ctx.fillStyle = w.accent ? el.accent ?? el.color : el.color;
          if (el.outline) { ctx.strokeStyle = el.outline; ctx.lineWidth = px * 0.04; ctx.strokeText(ch, 0, 0); }
          ctx.fillText(ch, 0, 0);
          ctx.restore();
        }
        charIndex += w.t.length; wordIndex++;
        continue;
      }
      if (kind === "words") {
        const wp = clamp01((e.local - delay - wordIndex * stag * 1.5) / (dur * 0.9)), we = ease(anim?.ease ?? "outExpo", wp);
        if (wp > 0) paintWord(ctx, el, lay, w, x0 + w.x, base + (1 - we) * px * 0.7, clamp01(wp * 2.5), 0);
        wordIndex++; continue;
      }
      if (kind === "blur" && p < 1) { paintWord(ctx, el, lay, w, x0 + w.x - (1 - ep) * px * 0.1, base, 0.35 * ep, 0); paintWord(ctx, el, lay, w, x0 + w.x + (1 - ep) * px * 0.1, base, 0.35 * ep, 0); }
      if (kind === "wipe") { ctx.save(); ctx.beginPath(); ctx.rect(x0 - px, top - px, (ln.width + px * 2) * ep, lay.blockH + px * 2); ctx.clip(); paintWord(ctx, el, lay, w, x0 + w.x, base, 1, 0); ctx.restore(); continue; }
      paintWord(ctx, el, lay, w, x0 + w.x, base, 1, 0);
      wordIndex++;
    }
  });
  void wordsTotal;
  if (kind === "typewriter" && p < 1) {
    ctx.shadowColor = "transparent"; ctx.fillStyle = el.accent ?? el.color;
    if (Math.floor(e.t * 3) % 2 === 0) ctx.fillRect(lay.blockW / 2 * (align === "center" ? 1 : 0) + px * 0.1, top + lay.lineH * 0.1, px * 0.08, lay.lineH * 0.8);
  }
  ctx.restore();
}

function paintWord(ctx: CanvasRenderingContext2D, el: TextEl, lay: TextLayout, w: Word, x: number, y: number, a: number, _unused: number): void {
  void _unused;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * a;
  ctx.font = w.accent && el.font === "serif" ? lay.fontItalic : lay.font;
  if (el.outline) { ctx.strokeStyle = el.outline; ctx.lineWidth = lay.px * 0.04; ctx.strokeText(w.t, x, y); }
  ctx.fillStyle = w.accent ? el.accent ?? el.color : el.color;
  const tr = (el.tracking ?? 0) * lay.px;
  if (Math.abs(tr) < 0.01) ctx.fillText(w.t, x, y);
  else { let cx = x; for (const ch of w.t) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + tr; } }
  ctx.globalAlpha = prev;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Shapes, icons, cards, stats, charts                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath(); ctx.moveTo(x + k, y); ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k); ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath();
}
function gradFill(ctx: CanvasRenderingContext2D, fill: string | [string, string], x0: number, y0: number, x1: number, y1: number): string | CanvasGradient {
  if (typeof fill === "string") return fill;
  const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, fill[0]); g.addColorStop(1, fill[1]); return g;
}
function polygon(ctx: CanvasRenderingContext2D, n: number, r: number, rot: number, inner = 1): void {
  ctx.beginPath();
  const pts = inner < 1 ? n * 2 : n;
  for (let i = 0; i < pts; i++) { const rad = inner < 1 && i % 2 ? r * inner : r, a = rot + (i / pts) * TAU; const px = Math.cos(a) * rad, py = Math.sin(a) * rad; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
  ctx.closePath();
}

function drawShape(ctx: CanvasRenderingContext2D, el: ShapeEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const anim = el.anim, kind = anim?.in ?? "none", p = ph.pIn, ep = enterEase(anim, p), lp = loopXform(anim, e, el.x);
  const radial = el.shape === "circle" || el.shape === "ring" || el.shape === "arc" || el.shape === "hex" || el.shape === "star" || el.shape === "diamond" || el.shape === "triangle" || el.shape === "blob";
  const wpx = radial ? ((el.w ?? 10) / 100) * e.H : ((el.w ?? 10) / 100) * e.W, hpx = ((el.h ?? el.w ?? 10) / 100) * e.H;
  const cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H + lp.dy * (e.H / 100) * 0.4;
  let sc = (el.scale ?? 1) * lp.s * (1 + 0.04 * (el.beat ?? 0) * e.pulse), draw = el.progress ?? 1;
  if (kind === "scale") sc *= lerp(0.55, 1, ep); else if (kind === "pop") sc *= lerp(0.4, 1, ease("outBack", p)); else if (kind === "slam") sc *= lerp(1.25, 1, ease("outExpo", p));
  ctx.save();
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  if (el.blend) ctx.globalCompositeOperation = el.blend;
  ctx.translate(cx, cy); ctx.rotate(((el.rotate ?? 0) * Math.PI) / 180 + lp.rot); ctx.scale(sc, sc);
  if (kind === "wipe") { ctx.beginPath(); ctx.rect(-wpx / 2 - 4, -hpx / 2 - 4, (wpx + 8) * ep, hpx + 8); ctx.clip(); }
  if (el.shadow) { ctx.shadowColor = "rgba(0,0,0,0.38)"; ctx.shadowBlur = e.H * 0.03; ctx.shadowOffsetY = e.H * 0.012; }
  if (el.glow) { ctx.shadowColor = rgba(el.glow, 0.9); ctx.shadowBlur = e.H * (0.02 + 0.03 * e.pulse * (el.beat ?? 0)); }
  const fill = el.fill ? gradFill(ctx, el.fill, -wpx / 2, -hpx / 2, wpx / 2, hpx / 2) : null;
  const strokeW = ((el.strokeW ?? 0.3) / 100) * e.H;
  const finish = (): void => {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (el.stroke) { ctx.shadowColor = el.glow ? ctx.shadowColor : "transparent"; ctx.strokeStyle = el.stroke; ctx.lineWidth = strokeW; if (el.dash) ctx.setLineDash([strokeW * 3, strokeW * 3]); ctx.stroke(); }
  };
  switch (el.shape) {
    case "rect": ctx.beginPath(); ctx.rect(-wpx / 2, -hpx / 2, wpx, hpx); finish(); break;
    case "rounded": rrect(ctx, -wpx / 2, -hpx / 2, wpx, hpx, ((el.radius ?? 1.5) / 100) * e.H); finish(); break;
    case "pill": rrect(ctx, -wpx / 2, -hpx / 2, wpx, hpx, hpx / 2); finish(); break;
    case "circle": ctx.beginPath(); ctx.ellipse(0, 0, wpx / 2, hpx / 2, 0, 0, TAU); finish(); break;
    case "ring": case "arc": {
      ctx.beginPath();
      const a0 = -Math.PI / 2, a1 = a0 + TAU * clamp01(draw);
      ctx.ellipse(0, 0, wpx / 2, hpx / 2, 0, a0, el.shape === "ring" && draw >= 0.999 ? a0 + TAU : a1);
      if (fill && el.shape === "ring") { ctx.fillStyle = fill; ctx.fill(); }
      ctx.strokeStyle = el.stroke ?? (typeof el.fill === "string" ? el.fill : "#fff"); ctx.lineWidth = strokeW; ctx.lineCap = "round"; if (el.dash) ctx.setLineDash([strokeW * 2.5, strokeW * 3]); ctx.stroke();
      break;
    }
    case "line": ctx.beginPath(); ctx.moveTo(-wpx / 2, 0); ctx.lineTo(-wpx / 2 + wpx * clamp01(draw), 0); ctx.strokeStyle = el.stroke ?? "#fff"; ctx.lineWidth = strokeW; ctx.lineCap = "round"; if (el.dash) ctx.setLineDash([strokeW * 3, strokeW * 3]); ctx.stroke(); break;
    case "triangle": polygon(ctx, 3, wpx / 2, -Math.PI / 2); finish(); break;
    case "diamond": polygon(ctx, 4, wpx / 2, 0); finish(); break;
    case "hex": polygon(ctx, 6, wpx / 2, 0); finish(); break;
    case "star": polygon(ctx, 5, wpx / 2, -Math.PI / 2, 0.45); finish(); break;
    case "blob": {
      ctx.beginPath();
      const n = 9;
      for (let i = 0; i <= n; i++) { const a = (i / n) * TAU, r = 1 + 0.12 * Math.sin(a * 3 + e.t * 0.9) + 0.08 * Math.sin(a * 2 - e.t * 0.6); const x = Math.cos(a) * (wpx / 2) * r, y = Math.sin(a) * (hpx / 2) * r; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.closePath(); finish(); break;
    }
  }
  ctx.restore();
}

const iconPaths = new Map<string, Path2D>();
function drawIconGlyph(ctx: CanvasRenderingContext2D, name: IconName, cx: number, cy: number, sizePx: number, color: string, strokeScale: number): void {
  let path = iconPaths.get(name);
  if (!path) { path = new Path2D(ICONS[name]); iconPaths.set(name, path); }
  ctx.save();
  ctx.translate(cx - sizePx / 2, cy - sizePx / 2); ctx.scale(sizePx / 24, sizePx / 24);
  ctx.strokeStyle = color; ctx.lineWidth = 1.7 * strokeScale; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

function drawIcon(ctx: CanvasRenderingContext2D, el: IconEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const kind = el.anim?.in ?? "none", p = ph.pIn, lp = loopXform(el.anim, e, el.x);
  const size = (el.size / 100) * e.H, cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H + lp.dy * (e.H / 100) * 0.4;
  let sc = (el.scale ?? 1) * lp.s * (1 + 0.05 * (el.beat ?? 0) * e.pulse);
  if (kind === "pop") sc *= lerp(0.3, 1, ease("outBack", p)); else if (kind === "scale") sc *= lerp(0.6, 1, ease("outCubic", p));
  ctx.save();
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.rotate(lp.rot);
  if (el.tile) { const t = size * 1.75; rrect(ctx, -t / 2, -t / 2, t, t, t * 0.28); ctx.fillStyle = el.tile; ctx.fill(); }
  drawIconGlyph(ctx, el.name, 0, 0, size, el.color, el.strokeW ?? 1);
  ctx.restore();
}

function wrapPx(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string[] {
  const out: string[] = []; let line = "";
  for (const w of text.split(/\s+/)) { const c = line ? `${line} ${w}` : w; if (line && ctx.measureText(c).width > maxPx) { out.push(line); line = w; } else line = c; }
  if (line) out.push(line);
  return out;
}

function drawCard(ctx: CanvasRenderingContext2D, el: CardEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const kind = el.anim?.in ?? "none", p = ph.pIn, lp = loopXform(el.anim, e, el.x);
  const w = ((el.w ?? 26) / 100) * e.W, h = ((el.h ?? 36) / 100) * e.H, cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H + lp.dy * (e.H / 100) * 0.6;
  let sc = (el.scale ?? 1) * (1 + 0.025 * (el.beat ?? 0) * e.pulse), dx = 0;
  if (kind === "pop") sc *= lerp(0.6, 1, ease("outBack", p)); else if (kind === "scale") sc *= lerp(0.8, 1, ease("outCubic", p)); else if (kind === "slide-right") dx = (1 - ease("outCubic", p)) * e.W * 0.05; else if (kind === "rise") sc *= 1;
  const R = e.H * 0.026, pad = e.H * 0.028;
  ctx.save();
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  ctx.translate(cx + dx, cy); ctx.scale(sc, sc);
  ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = e.H * 0.05; ctx.shadowOffsetY = e.H * 0.018;
  rrect(ctx, -w / 2, -h / 2, w, h, R); ctx.fillStyle = el.fill ?? "rgba(255,255,255,0.07)"; ctx.fill();
  ctx.shadowColor = "transparent";
  const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2); g.addColorStop(0, "rgba(255,255,255,0.10)"); g.addColorStop(0.5, "rgba(255,255,255,0.0)"); g.addColorStop(1, "rgba(255,255,255,0.03)");
  rrect(ctx, -w / 2, -h / 2, w, h, R); ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = Math.max(1, e.H * 0.0018); ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.stroke();
  const horizontal = w > h * 1.9;
  let tx = -w / 2 + pad, ty = -h / 2 + pad;
  const tile = e.H * 0.08;
  if (el.icon) {
    const ix = horizontal ? -w / 2 + pad + tile / 2 : -w / 2 + pad + tile / 2, iy = horizontal ? 0 : -h / 2 + pad + tile / 2;
    rrect(ctx, ix - tile / 2, iy - tile / 2, tile, tile, tile * 0.3); ctx.fillStyle = rgba(el.accent, 0.16); ctx.fill();
    drawIconGlyph(ctx, el.icon, ix, iy, tile * 0.52, el.accent, 1.05);
    if (horizontal) tx = ix + tile / 2 + pad * 0.9; else ty = iy + tile / 2 + pad * 0.9;
  }
  const textW = horizontal ? w / 2 - pad - tx : w - pad * 2;
  ctx.textBaseline = "top"; ctx.textAlign = "left";
  const tpx = e.H * 0.04, bpx = e.H * 0.029;
  ctx.font = fontCss("display", 750, false, tpx);
  const tLines = el.title ? wrapPx(ctx, el.title, textW) : [];
  ctx.font = fontCss("body", 500, false, bpx);
  const bLines = el.body ? wrapPx(ctx, el.body, textW).slice(0, horizontal ? 2 : 5) : [];
  const blockH = tLines.length * tpx * 1.15 + (bLines.length ? bpx * 0.5 + bLines.length * bpx * 1.35 : 0);
  if (horizontal) ty = -blockH / 2;
  ctx.fillStyle = el.text; ctx.font = fontCss("display", 750, false, tpx);
  tLines.forEach((l, i) => ctx.fillText(l, tx, ty + i * tpx * 1.15));
  ctx.fillStyle = el.muted; ctx.font = fontCss("body", 500, false, bpx);
  bLines.forEach((l, i) => ctx.fillText(l, tx, ty + tLines.length * tpx * 1.15 + bpx * 0.5 + i * bpx * 1.35));
  ctx.restore();
}

function fmtNum(v: number, decimals: number): string {
  const s = Math.abs(v).toFixed(decimals), [i, d] = s.split("."), withSep = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (v < 0 ? "-" : "") + withSep + (d ? "." + d : "");
}

function drawStat(ctx: CanvasRenderingContext2D, el: StatEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const kind = el.anim?.in ?? "none", p = ph.pIn, count = ease("outExpo", clamp01((e.local - (el.anim?.delay ?? 0)) / Math.max(900, (el.anim?.dur ?? 700) * 1.8)));
  const val = lerp(el.from ?? 0, el.value, count), dec = el.decimals ?? 0;
  const txt = `${el.prefix ?? ""}${fmtNum(val, dec)}${el.suffix ?? ""}`;
  let px = (el.size / 100) * e.H;
  ctx.save();
  ctx.font = fontCss("display", 800, false, px);
  const maxW = ((el.w ?? 40) / 100) * e.W;
  const widest = ctx.measureText(`${el.prefix ?? ""}${fmtNum(el.value, dec)}${el.suffix ?? ""}`).width;
  if (widest > maxW) px *= maxW / widest;
  const cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H;
  let sc = (el.scale ?? 1) * (1 + 0.045 * (el.beat ?? 0) * e.pulse);
  if (kind === "pop") sc *= lerp(0.6, 1, ease("outBack", p));
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  ctx.translate(cx, cy); ctx.scale(sc, sc);
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.font = fontCss("display", 800, false, px);
  ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = px * 0.25; ctx.shadowOffsetY = px * 0.05;
  ctx.fillStyle = el.color; ctx.fillText(txt, 0, px * 0.34);
  ctx.shadowColor = "transparent";
  if (el.label) { ctx.font = fontCss("body", 600, false, Math.max(e.H * 0.026, px * 0.27)); ctx.fillStyle = el.labelColor; ctx.fillText(el.label, 0, px * 0.34 + Math.max(e.H * 0.026, px * 0.27) * 1.9); }
  ctx.restore();
}

function drawChart(ctx: CanvasRenderingContext2D, el: ChartEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const w = ((el.w ?? 50) / 100) * e.W, h = ((el.h ?? 50) / 100) * e.H, cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H;
  const delay = el.anim?.delay ?? 0, n = el.data.length, max = Math.max(1, ...el.data.map((d) => d.value));
  const grow = (i: number, span = 1100): number => ease("outExpo", clamp01((e.local - delay - 150 - i * 110) / span));
  const [c1, c2] = [el.colors[0] ?? "#6cf", el.colors[1] ?? el.colors[0] ?? "#c6f"];
  const lab = e.H * 0.027;
  ctx.save();
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  ctx.translate(cx - w / 2, cy - h / 2);
  ctx.textBaseline = "alphabetic";
  const unit = el.unit ?? "";
  if (el.chart === "bars") {
    const base = h * 0.86, slot = w / n, bw = Math.min(slot * 0.58, e.W * 0.07);
    ctx.strokeStyle = rgba(el.muted, 0.35); ctx.lineWidth = Math.max(1, e.H * 0.0016); ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(w, base); ctx.stroke();
    el.data.forEach((d, i) => {
      const g = grow(i), bh = (d.value / max) * (base - lab * 2.8) * g, x = slot * i + (slot - bw) / 2, top = base - bh;
      const grad = ctx.createLinearGradient(0, top, 0, base); grad.addColorStop(0, d.value === max ? c2 : c1); grad.addColorStop(1, rgba(d.value === max ? c2 : c1, 0.35));
      rrect(ctx, x, top, bw, Math.max(1, bh), Math.min(bw * 0.28, e.H * 0.012)); ctx.fillStyle = grad; ctx.fill();
      ctx.textAlign = "center"; ctx.font = fontCss("display", 700, false, lab * 1.12); ctx.fillStyle = el.text; ctx.globalAlpha = clamp01(ph.alpha * g * e.alpha);
      ctx.fillText(`${fmtNum(d.value * g, Number.isInteger(d.value) ? 0 : 1)}${unit}`, x + bw / 2, top - lab * 0.55);
      ctx.globalAlpha = clamp01(ph.alpha * e.alpha); ctx.font = fontCss("body", 500, false, lab); ctx.fillStyle = el.muted; ctx.fillText(d.label.slice(0, 12), x + bw / 2, base + lab * 1.9);
    });
  } else if (el.chart === "line") {
    const base = h * 0.84, top0 = lab * 3, pts = el.data.map((d, i) => ({ x: n === 1 ? w / 2 : (w * i) / (n - 1), y: base - ((d.value / max) * (base - top0)) }));
    const reveal = ease("outCubic", clamp01((e.local - delay - 150) / 1500));
    ctx.save(); ctx.beginPath(); ctx.rect(-10, -10, (w + 20) * reveal, h + 20); ctx.clip();
    const path = new Path2D(); pts.forEach((p, i) => { if (!i) path.moveTo(p.x, p.y); else { const q = pts[i - 1]!, mx = (q.x + p.x) / 2; path.bezierCurveTo(mx, q.y, mx, p.y, p.x, p.y); } });
    const area = new Path2D(path); area.lineTo(pts[pts.length - 1]!.x, base); area.lineTo(pts[0]!.x, base); area.closePath();
    const ag = ctx.createLinearGradient(0, top0, 0, base); ag.addColorStop(0, rgba(c1, 0.38)); ag.addColorStop(1, rgba(c1, 0));
    ctx.fillStyle = ag; ctx.fill(area);
    const lg = ctx.createLinearGradient(0, 0, w, 0); lg.addColorStop(0, c1); lg.addColorStop(1, c2);
    ctx.strokeStyle = lg; ctx.lineWidth = e.H * 0.0075; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.shadowColor = rgba(c1, 0.7); ctx.shadowBlur = e.H * 0.02; ctx.stroke(path);
    ctx.restore();
    pts.forEach((p, i) => {
      const g = clamp01((reveal * (n - 1) - i + 0.4) / 0.6); if (g <= 0) return;
      ctx.beginPath(); ctx.arc(p.x, p.y, e.H * 0.0125 * ease("outBack", g), 0, TAU); ctx.fillStyle = i === n - 1 ? c2 : el.text; ctx.fill();
      ctx.textAlign = "center"; ctx.font = fontCss("body", 500, false, lab); ctx.fillStyle = el.muted; ctx.globalAlpha = clamp01(ph.alpha * g * e.alpha); ctx.fillText(el.data[i]!.label.slice(0, 10), p.x, base + lab * 2.2);
      ctx.globalAlpha = clamp01(ph.alpha * e.alpha);
    });
  } else if (el.chart === "donut") {
    const total = el.data.reduce((s, d) => s + d.value, 0) || 1, r = Math.min(w, h) * 0.42, ccx = w / 2, ccy = h / 2, lw = r * 0.26;
    let a = -Math.PI / 2;
    el.data.forEach((d, i) => {
      const g = grow(i, 1200), sweep = (d.value / total) * TAU * g;
      ctx.beginPath(); ctx.arc(ccx, ccy, r, a, a + Math.max(0.001, sweep - 0.04)); ctx.lineWidth = lw; ctx.lineCap = "round";
      ctx.strokeStyle = mixColor(c1, c2, n === 1 ? 0 : i / (n - 1)); ctx.stroke(); a += (d.value / total) * TAU;
    });
    ctx.textAlign = "center"; ctx.fillStyle = el.text; ctx.font = fontCss("display", 800, false, r * 0.46);
    const top = el.data.reduce((m, d) => (d.value > m.value ? d : m), el.data[0]!);
    ctx.fillText(`${fmtNum((top.value / total) * 100 * grow(0, 1200), 0)}%`, ccx, ccy + r * 0.12);
    ctx.fillStyle = el.muted; ctx.font = fontCss("body", 600, false, r * 0.17); ctx.fillText(top.label.slice(0, 16), ccx, ccy + r * 0.42);
  } else {
    const rowH = h / Math.max(1, n), trackW = w * 0.62, bh = Math.min(rowH * 0.3, e.H * 0.022);
    el.data.forEach((d, i) => {
      const y = rowH * i + rowH / 2, g = grow(i, 1200);
      ctx.textAlign = "left"; ctx.font = fontCss("body", 600, false, lab * 1.1); ctx.fillStyle = el.text; ctx.fillText(d.label.slice(0, 18), 0, y - bh * 0.9);
      rrect(ctx, 0, y - bh / 2 + bh * 0.4, trackW, bh, bh / 2); ctx.fillStyle = rgba(el.muted, 0.2); ctx.fill();
      const fillW = Math.max(bh, (d.value / max) * trackW * g);
      const gg = ctx.createLinearGradient(0, 0, trackW, 0); gg.addColorStop(0, c1); gg.addColorStop(1, c2);
      rrect(ctx, 0, y - bh / 2 + bh * 0.4, fillW, bh, bh / 2); ctx.fillStyle = gg; ctx.fill();
      ctx.textAlign = "right"; ctx.fillStyle = el.text; ctx.font = fontCss("display", 750, false, lab * 1.2); ctx.fillText(`${fmtNum(d.value * g, Number.isInteger(d.value) ? 0 : 1)}${unit}`, w, y + bh * 0.9);
    });
  }
  ctx.restore();
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Ambient: backdrops, particles, grids, waves, orbits                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

function drawBackdrop(ctx: CanvasRenderingContext2D, el: BackdropEl, e: Env): void {
  const { W, H } = e, op = (el.opacity ?? 1) * e.alpha, tw = e.tw * (el.speed ?? 1), cols = el.colors.length ? el.colors : ["#223"];
  ctx.save();
  if (el.blend) ctx.globalCompositeOperation = el.blend;
  const px = ((el.x ?? 50) / 100) * W, py = ((el.y ?? 50) / 100) * H;
  switch (el.kind) {
    case "gradient": {
      const a = ((el.angle ?? 160) * Math.PI) / 180, r = Math.hypot(W, H) / 2, dx = Math.sin(a) * r, dy = -Math.cos(a) * r;
      const g = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
      cols.forEach((c, i) => g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), c));
      ctx.globalAlpha = op; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
    }
    case "mesh": {
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 4; i++) {
        const c = cols[i % cols.length]!, x = W * (0.5 + 0.38 * Math.sin(tw * 0.21 + i * 1.9)), y = H * (0.5 + 0.34 * Math.cos(tw * 0.17 + i * 2.7)), r = H * (0.62 + 0.12 * Math.sin(tw * 0.4 + i));
        const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(c, 0.55 * op)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case "aurora": {
      ctx.globalCompositeOperation = "lighter";
      for (let b = 0; b < 3; b++) {
        const c = cols[b % cols.length]!, base = H * (0.34 + b * 0.17), amp = H * (0.07 + b * 0.02), ph = tw * (0.35 + b * 0.12) + b * 2.1, thick = H * 0.2;
        ctx.beginPath();
        for (let x = 0; x <= W; x += W / 40) { const y = base + Math.sin(x / W * (3.2 + b * 0.5) + ph) * amp + Math.sin(x / W * 7 - ph * 1.3) * amp * 0.35; if (x === 0) ctx.moveTo(x, y - thick); else ctx.lineTo(x, y - thick); }
        for (let x = W; x >= 0; x -= W / 40) { const y = base + Math.sin(x / W * (3.2 + b * 0.5) + ph) * amp + Math.sin(x / W * 7 - ph * 1.3) * amp * 0.35; ctx.lineTo(x, y + thick); }
        ctx.closePath();
        const g = ctx.createLinearGradient(0, base - thick, 0, base + thick); g.addColorStop(0, rgba(c, 0)); g.addColorStop(0.5, rgba(c, 0.5 * op)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g; ctx.fill();
      }
      break;
    }
    case "spotlight": {
      ctx.globalCompositeOperation = "lighter";
      const c = cols[0]!, spread = W * 0.28, g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgba(c, 0.5 * op)); g.addColorStop(1, rgba(c, 0));
      ctx.beginPath(); ctx.moveTo(px - W * 0.02, 0); ctx.lineTo(px + W * 0.02, 0); ctx.lineTo(px + spread * (1 + 0.04 * Math.sin(tw)), H); ctx.lineTo(px - spread * (1 + 0.04 * Math.sin(tw)), H); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      const f = ctx.createRadialGradient(px, H * 0.95, 0, px, H * 0.95, W * 0.34); f.addColorStop(0, rgba(c, 0.35 * op)); f.addColorStop(1, rgba(c, 0)); ctx.fillStyle = f; ctx.fillRect(0, 0, W, H);
      break;
    }
    case "rays": {
      ctx.globalCompositeOperation = "lighter";
      const n = 16, R = Math.hypot(W, H);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU + tw * 0.4, a1 = a0 + (TAU / n) * 0.42, c = cols[i % cols.length]!;
        const g = ctx.createRadialGradient(px, py, 0, px, py, R * 0.7); g.addColorStop(0, rgba(c, 0.5 * op * (0.7 + 0.5 * e.pulse))); g.addColorStop(1, rgba(c, 0));
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a0) * R, py + Math.sin(a0) * R); ctx.lineTo(px + Math.cos(a1) * R, py + Math.sin(a1) * R); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
      break;
    }
    case "flow": {
      /* a field of flowing strokes: every line is a sine-displaced path whose phase drifts with time */
      ctx.globalCompositeOperation = "lighter";
      const lines = 26, steps = 56, amp = H * 0.045;
      for (let k = 0; k < lines; k++) {
        const c = cols[k % cols.length]!, base = (k / (lines - 1)) * H * 1.15 - H * 0.08;
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, rgba(c, 0)); g.addColorStop(0.5, rgba(c, 0.55 * op)); g.addColorStop(1, rgba(c, 0));
        ctx.strokeStyle = g; ctx.lineWidth = Math.max(1, H * (0.0012 + 0.0008 * Math.sin(k)));
        ctx.beginPath();
        for (let s2 = 0; s2 <= steps; s2++) {
          const x = (s2 / steps) * W;
          const y = base + Math.sin((x / W) * 3.1 + tw * 0.9 + k * 0.42) * amp + Math.sin((x / W) * 7.3 - tw * 0.6 + k) * amp * 0.35;
          if (s2) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case "topo": {
      /* contour rings around a focal point, warped by slow noise and pushed outward on the beat */
      ctx.globalCompositeOperation = "source-over";
      const rings = 16, R = Math.hypot(W, H) * 0.55;
      for (let k = 0; k < rings; k++) {
        const c = cols[k % cols.length]!, t = k / rings, r0 = R * t * (1 + 0.04 * e.pulse);
        ctx.beginPath();
        for (let a = 0; a <= 64; a++) {
          const th = (a / 64) * TAU;
          const warp = 1 + 0.07 * Math.sin(th * 3 + tw * 0.7 + k * 0.5) + 0.04 * Math.sin(th * 5 - tw * 0.4 + k);
          const x = px + Math.cos(th) * r0 * warp, y = py + Math.sin(th) * r0 * warp * 0.82;
          if (a) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.strokeStyle = rgba(c, op * (0.12 + 0.2 * (1 - t))); ctx.lineWidth = Math.max(1, H * 0.0017);
        ctx.stroke();
      }
      break;
    }
    case "ribbons": {
      /* three filled ribbons whose edges follow travelling sine curves; the colour gradient slides along them */
      ctx.globalCompositeOperation = "lighter";
      for (let b = 0; b < 3; b++) {
        const c = cols[b % cols.length]!, c2 = cols[(b + 1) % cols.length]!, baseY = H * (0.3 + b * 0.2), amp = H * (0.11 + 0.03 * b);
        const phase = tw * (0.5 + b * 0.17) + b * 1.7, thick = H * (0.07 + 0.02 * (2 - b));
        const topY = (x: number): number => baseY + Math.sin((x / W) * 2.6 + phase) * amp;
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, rgba(c, 0)); g.addColorStop(0.45, rgba(c, 0.5 * op)); g.addColorStop(0.7, rgba(c2, 0.42 * op)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, topY(0) - thick);
        for (let s2 = 1; s2 <= 48; s2++) { const x = (s2 / 48) * W; ctx.lineTo(x, topY(x) - thick * (0.6 + 0.4 * Math.sin((x / W) * 4 + phase))); }
        for (let s2 = 48; s2 >= 0; s2--) { const x = (s2 / 48) * W; ctx.lineTo(x, topY(x) + thick); }
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case "lightleak": {
      /* warm light bleeding across the frame: large soft blobs on slow Lissajous paths, screened together */
      ctx.globalCompositeOperation = "screen";
      for (let i = 0; i < 4; i++) {
        const c = cols[i % cols.length]!;
        const x = W * (0.5 + 0.42 * Math.sin(tw * (0.13 + i * 0.05) + i * 2.3));
        const y = H * (0.5 + 0.38 * Math.sin(tw * (0.11 + i * 0.07) * 1.3 + i));
        const r = H * (0.5 + 0.12 * Math.sin(tw * 0.3 + i));
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(c, 0.5 * op)); g.addColorStop(0.55, rgba(c, 0.14 * op)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case "glow": {
      ctx.globalCompositeOperation = "lighter";
      const c = cols[0]!, r = H * (0.55 + 0.05 * Math.sin(tw * 1.2) + 0.06 * e.pulse), g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, rgba(c, 0.5 * op)); g.addColorStop(1, rgba(c, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
    }
  }
  ctx.restore();
}

function drawParticles(ctx: CanvasRenderingContext2D, el: ParticlesEl, e: Env): void {
  const { W, H } = e, n = Math.min(160, el.count), sp = el.speed ?? 1, sz = el.size ?? 1, c1 = el.color, c2 = el.color2 ?? el.color, tw = e.tw * sp, seed = e.seed * 7 + 13;
  ctx.save();
  ctx.globalAlpha = clamp01((el.opacity ?? 1) * e.alpha);
  const additive = el.kind === "embers" || el.kind === "stars" || el.kind === "fireflies" || el.kind === "bokeh" || el.kind === "dust";
  if (additive) ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < n; i++) {
    const r0 = hash01(seed, i * 5), r1 = hash01(seed, i * 5 + 1), r2 = hash01(seed, i * 5 + 2), r3 = hash01(seed, i * 5 + 3), r4 = hash01(seed, i * 5 + 4);
    const col = r4 > 0.5 ? c1 : c2;
    let x = 0, y = 0, rad = 0, a = 1;
    switch (el.kind) {
      case "dust": x = frac(r0 + tw * 0.012 * (r2 - 0.3)) * W; y = frac(r1 + tw * 0.006 * (r3 - 0.5)) * H; rad = (0.12 + r2 * 0.32) * sz * (H / 100); a = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(tw * (0.8 + r3) + i)); break;
      case "embers": { const life = frac(r1 + tw * (0.04 + r2 * 0.05)); x = (r0 + Math.sin(tw * 0.7 + i) * 0.03 * life) * W; y = (1 - life) * H * 1.05; rad = (0.12 + r3 * 0.3) * sz * (H / 100) * (1 - life * 0.6); a = Math.min(1, life * 6) * (1 - life); break; }
      case "snow": { const life = frac(r1 + tw * (0.02 + r2 * 0.03)); x = frac(r0 + Math.sin(tw * 0.5 + i) * 0.02) * W; y = life * H; rad = (0.14 + r3 * 0.34) * sz * (H / 100); a = 0.55 + 0.4 * r3; break; }
      case "stars": x = r0 * W; y = r1 * H; rad = (0.08 + r2 * 0.22) * sz * (H / 100); a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(tw * (0.7 + r3 * 2) + i * 1.7)); break;
      case "rain": { const life = frac(r1 + tw * (0.5 + r2 * 0.4)); x = frac(r0 + life * 0.05) * W; y = life * H * 1.2 - H * 0.1; a = 0.3 + 0.3 * r3; ctx.strokeStyle = rgba(col, a); ctx.lineWidth = Math.max(1, (H / 100) * 0.1 * sz); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - H * 0.01, y + H * (0.03 + r3 * 0.03)); ctx.stroke(); continue; }
      case "bokeh": x = frac(r0 + tw * 0.004 * (r2 - 0.5)) * W; y = frac(r1 + tw * 0.003 * (r3 - 0.5)) * H; rad = (2.2 + r2 * 5.5) * sz * (H / 100); a = 0.05 + 0.1 * (0.5 + 0.5 * Math.sin(tw * 0.5 + i)); { const g = ctx.createRadialGradient(x, y, 0, x, y, rad); g.addColorStop(0, rgba(col, a * 1.6)); g.addColorStop(0.7, rgba(col, a)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill(); } continue;
      case "confetti": { const life = frac(r1 + tw * (0.06 + r2 * 0.05)); x = frac(r0 + Math.sin(tw * 1.2 + i) * 0.03) * W; y = life * H * 1.1 - H * 0.05; const ccol = [c1, c2, "#ffffff", "#ffd54a"][i % 4]!; ctx.save(); ctx.translate(x, y); ctx.rotate(tw * (1 + r3 * 3) + i); ctx.scale(1, Math.cos(tw * (2 + r2 * 3) + i)); ctx.fillStyle = ccol; ctx.fillRect(-H * 0.006 * sz, -H * 0.003 * sz, H * 0.012 * sz, H * 0.006 * sz); ctx.restore(); continue; }
      case "fireflies": x = (r0 + Math.sin(tw * (0.15 + r2 * 0.2) + i) * 0.06) * W; y = (r1 + Math.cos(tw * (0.12 + r3 * 0.2) + i * 1.3) * 0.06) * H; rad = (0.2 + r2 * 0.34) * sz * (H / 100); a = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(tw * (0.9 + r3) + i * 2), 2); break;
      case "bubbles": { const life = frac(r1 + tw * (0.02 + r2 * 0.03)); x = (r0 + Math.sin(tw * 0.6 + i) * 0.02) * W; y = (1 - life) * H * 1.1; rad = (0.5 + r3 * 1.6) * sz * (H / 100); ctx.strokeStyle = rgba(col, 0.55 * (1 - life * 0.6)); ctx.lineWidth = Math.max(1, H * 0.0015); ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.stroke(); continue; }
    }
    if (rad <= 0) continue;
    if (el.kind === "fireflies" || el.kind === "embers") { const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 5); g.addColorStop(0, rgba(col, 0.9 * a)); g.addColorStop(0.25, rgba(col, 0.35 * a)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad * 5, 0, TAU); ctx.fill(); }
    else { ctx.fillStyle = rgba(col, a); ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, el: GridEl, e: Env): void {
  const { W, H } = e, op = (el.opacity ?? 1) * e.alpha, tw = e.tw * (el.speed ?? 1), col = el.color;
  ctx.save();
  ctx.globalAlpha = clamp01(op);
  if (el.kind === "lines") {
    const sp = ((el.spacing ?? 6) / 100) * H, off = (tw * sp * 0.6) % sp;
    ctx.lineWidth = Math.max(1, H * 0.0013);
    for (let x = -off; x < W; x += sp) { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, 0.8)); g.addColorStop(1, rgba(col, 0)); ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = -off; y < H; y += sp) { const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, 0.8)); g.addColorStop(1, rgba(col, 0)); ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  } else if (el.kind === "dots") {
    const sp = ((el.spacing ?? 5) / 100) * H;
    for (let y = sp / 2; y < H; y += sp) for (let x = sp / 2; x < W; x += sp) { const d = Math.hypot(x - W / 2, y - H / 2) / H; const a = 0.5 + 0.5 * Math.sin(tw * 1.5 - d * 6); ctx.fillStyle = rgba(col, 0.15 + 0.6 * a * (1 - Math.min(1, d))); ctx.beginPath(); ctx.arc(x, y, H * 0.0028 * (0.6 + a), 0, TAU); ctx.fill(); }
  } else {
    const hz = H * 0.58, vx = W / 2;
    ctx.lineWidth = Math.max(1, H * 0.0016);
    const lines = 14, off = frac(tw * 0.35);
    for (let i = 0; i < lines; i++) { const z = (i + off) / lines, y = hz + (H - hz) * z * z; ctx.strokeStyle = rgba(col, 0.15 + 0.7 * z); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let k = -14; k <= 14; k++) { ctx.strokeStyle = rgba(col, 0.3); ctx.beginPath(); ctx.moveTo(vx + k * W * 0.012, hz); ctx.lineTo(vx + k * W * 0.13, H); ctx.stroke(); }
    const g = ctx.createLinearGradient(0, hz - H * 0.04, 0, hz + H * 0.06); g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, 0.55 + 0.3 * e.pulse)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.fillRect(0, hz - H * 0.04, W, H * 0.1);
  }
  ctx.restore();
}

function drawWave(ctx: CanvasRenderingContext2D, el: WaveEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const w = ((el.w ?? 70) / 100) * e.W, h = ((el.h ?? 14) / 100) * e.H, cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H, n = el.count ?? 40, t = e.tw;
  ctx.save();
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  ctx.translate(cx, cy);
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0); g.addColorStop(0, el.color); g.addColorStop(1, el.color2 ?? el.color);
  const amp = 0.28 + 0.72 * e.energy + 0.35 * e.pulse;
  if (el.style === "circle") {
    const r = h * 1.2; ctx.strokeStyle = g; ctx.lineWidth = e.H * 0.004; ctx.lineCap = "round";
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU, v = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 3 + i * 0.9) * Math.sin(t * 1.7 + i * 0.4))) * amp; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(Math.cos(a) * (r + h * v), Math.sin(a) * (r + h * v)); ctx.stroke(); }
  } else if (el.style === "line") {
    ctx.strokeStyle = g; ctx.lineWidth = e.H * 0.005; ctx.lineCap = "round"; ctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = -w / 2 + (w * i) / n, y = Math.sin(t * 2.4 + i * 0.35) * h * 0.35 * amp + Math.sin(t * 4.1 - i * 0.2) * h * 0.2 * amp; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
  } else {
    const bw = (w / n) * 0.56;
    ctx.fillStyle = g;
    for (let i = 0; i < n; i++) {
      const v = (0.2 + 0.8 * (0.5 + 0.5 * Math.sin(t * 3.1 + i * 0.7) * Math.sin(t * 1.9 + i * 1.3))) * amp, bh = Math.max(e.H * 0.004, h * v), x = -w / 2 + (w * (i + 0.5)) / n;
      rrect(ctx, x - bw / 2, -bh / 2, bw, bh, bw / 2); ctx.fill();
    }
  }
  ctx.restore();
}

function drawOrbit(ctx: CanvasRenderingContext2D, el: OrbitEl, e: Env): void {
  const ph = phaseOf(el.anim, e);
  if (!ph.visible) return;
  const cx = (el.x / 100) * e.W, cy = (el.y / 100) * e.H, R = (el.radius / 100) * e.H, ry = R * (el.tilt ?? 0.4), n = el.count, spd = el.speed ?? 0.2;
  ctx.save();
  ctx.globalAlpha = clamp01(ph.alpha * (el.opacity ?? 1) * e.alpha);
  ctx.translate(cx, cy); ctx.rotate(((el.rotate ?? -18) * Math.PI) / 180);
  ctx.strokeStyle = rgba(el.color, 0.22); ctx.lineWidth = Math.max(1, e.H * 0.0015); ctx.beginPath(); ctx.ellipse(0, 0, R, ry, 0, 0, TAU); ctx.stroke();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + e.tw * spd * TAU * 0.5, x = Math.cos(a) * R, y = Math.sin(a) * ry, depth = 0.55 + 0.45 * Math.sin(a), r = e.H * 0.011 * (0.7 + depth * 0.7) * (1 + 0.5 * e.pulse), col = i % 2 ? el.color2 ?? el.color : el.color;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4); g.addColorStop(0, rgba(col, 0.95)); g.addColorStop(0.3, rgba(col, 0.4)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawFlash(ctx: CanvasRenderingContext2D, el: FlashEl, e: Env): void {
  const d = e.local - (el.anim?.delay ?? 0), span = Math.max(60, el.anim?.dur ?? 160);
  if (d < 0 || d > span) return;
  const a = Math.pow(1 - d / span, 2) * (el.opacity ?? 0.3) * e.alpha;
  ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = clamp01(a); ctx.fillStyle = el.color; ctx.fillRect(0, 0, e.W, e.H); ctx.restore();
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function drawElement(ctx: CanvasRenderingContext2D, el: VideoElement, e: Env): void {
  switch (el.type) {
    case "text": return drawText(ctx, el, e);
    case "shape": return drawShape(ctx, el, e);
    case "icon": return drawIcon(ctx, el, e);
    case "card": return drawCard(ctx, el, e);
    case "stat": return drawStat(ctx, el, e);
    case "chart": return drawChart(ctx, el, e);
    case "backdrop": return drawBackdrop(ctx, el, e);
    case "particles": return drawParticles(ctx, el, e);
    case "grid": return drawGrid(ctx, el, e);
    case "wave": return drawWave(ctx, el, e);
    case "orbit": return drawOrbit(ctx, el, e);
    case "flash": return drawFlash(ctx, el, e);
  }
}

/** Helpers the stage / QA use for shading without importing kit twice. */
export const _kit = { clamp, shade, parseColor };
