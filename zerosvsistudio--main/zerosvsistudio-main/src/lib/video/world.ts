/**
 * Each film's own cinematic world: the premium backdrop that sits under every scene. Its kind, geometry, hue and depth come from
 * the film's title and seed, so two films built from the same palette still look like different films. It moves with a depth
 * parallax (far layers drift less than the content), and it is graded like a finished frame: a light leak from one corner and
 * lifted shadows in the film's own colour. Light palettes get a much softer world, so text keeps its contrast.
 */
import { clamp01, hash01, hsl2rgb, luminance, parseColor, rgb2hsl, rgba, toHex } from "./kit";
import type { Palette, VideoSpec } from "./types";

export type WorldKind = "nebula" | "horizon" | "prism" | "contour";
export type World = { kind: WorldKind; seed: number; hueShift: number; cx: number; cy: number; angle: number; count: number; depth: number; leak: { x: number; y: number }; name: string; signature: string };

function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Derives this film's world. Same title and seed always give the same world; different films give different ones. */
export function worldFor(spec: Pick<VideoSpec, "title" | "seed">): World {
  const h = fnv(`${spec.title}|${spec.seed}`), r = (k: number): number => hash01(h, k);
  const kinds: WorldKind[] = ["nebula", "horizon", "prism", "contour"];
  const kind = kinds[Math.floor(r(1) * kinds.length)]!;
  const hueShift = Math.round((r(2) - 0.5) * 72);
  const cx = 0.25 + r(3) * 0.5, cy = 0.3 + r(4) * 0.4, angle = (r(5) - 0.5) * 60;
  const count = 4 + Math.floor(r(6) * 6), depth = 3 + Math.floor(r(7) * 3);
  const leak = { x: r(8) < 0.5 ? 0.04 : 0.96, y: 0.05 + r(9) * 0.3 };
  const name = `${kind} world, ${hueShift >= 0 ? "+" : ""}${hueShift}° hue, ${depth} depth layers`;
  return { kind, seed: h, hueShift, cx, cy, angle, count, depth, leak, name, signature: h.toString(16).padStart(8, "0") };
}

function shiftHue(color: string, deg: number): string {
  const c = parseColor(color) ?? { r: 128, g: 128, b: 128, a: 1 }, hsl = rgb2hsl(c);
  return toHex(hsl2rgb((hsl.h + deg + 720) % 360, hsl.s, hsl.l));
}

/** Draws the film's world into the current transform. Pure function of time, so it renders identically every time. */
export function drawWorld(ctx: CanvasRenderingContext2D, w: World, p: Palette, W: number, H: number, t: number, pulse: number, sceneIndex: number, alpha: number): void {
  const dark = luminance(p.bg) < 0.4, gain = dark ? 1 : 0.42;
  const a = shiftHue(p.accent, w.hueShift + sceneIndex * 7), b = shiftHue(p.accent2, -w.hueShift * 0.6 - sceneIndex * 5);
  const r = (k: number): number => hash01(w.seed, k);
  const A = (col: string, x: number): string => rgba(col, Math.min(1, x * gain));
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  switch (w.kind) {
    case "nebula": {
      /* far haze: slow glowing clouds that drift on their own paths */
      for (let i = 0; i < w.count; i++) {
        const ph = t * (0.05 + r(20 + i) * 0.06) + i * 1.7;
        const x = W * (w.cx + 0.32 * Math.sin(ph + r(30 + i) * 6)), y = H * (w.cy + 0.26 * Math.cos(ph * 0.8 + r(40 + i) * 6));
        const rad = H * (0.32 + r(50 + i) * 0.34) * (1 + 0.05 * pulse), col = i % 2 ? a : b;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, A(col, 0.34)); g.addColorStop(0.6, A(col, 0.1)); g.addColorStop(1, A(col, 0));
        ctx.globalCompositeOperation = "screen"; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      /* a faint, twinkling starfield */
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 70; i++) {
        const x = r(100 + i) * W, y = r(200 + i) * H, twinkle = 0.35 + 0.65 * Math.abs(Math.sin(t * (0.6 + r(300 + i)) + i));
        ctx.fillStyle = A("#ffffff", 0.18 * twinkle * (0.4 + r(400 + i)));
        ctx.beginPath(); ctx.arc(x, y, H * (0.0009 + r(500 + i) * 0.0013), 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case "horizon": {
      /* a glowing horizon over a reflective floor, with perspective lines sliding toward the viewer */
      const hy = H * (0.58 + (w.cy - 0.5) * 0.25), vx = W * w.cx;
      const sky = ctx.createRadialGradient(vx, hy, 0, vx, hy, W * 0.7);
      sky.addColorStop(0, A(a, 0.42)); sky.addColorStop(0.5, A(b, 0.12)); sky.addColorStop(1, A(a, 0));
      ctx.globalCompositeOperation = "screen"; ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      const floor = ctx.createLinearGradient(0, hy, 0, H);
      floor.addColorStop(0, A(a, 0.22)); floor.addColorStop(1, rgba(p.bg, 0.85));
      ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = floor; ctx.fillRect(0, hy, W, H - hy);
      ctx.globalCompositeOperation = "screen"; ctx.lineWidth = Math.max(1, H * 0.0015);
      const n = w.count + 6, off = (t * 0.22) % 1, spread = Math.cos((w.angle * Math.PI) / 180);
      ctx.strokeStyle = A(a, 0.2);
      for (let i = -n; i <= n; i++) { ctx.beginPath(); ctx.moveTo(vx, hy); ctx.lineTo(vx + (i / n) * W * 1.6 * spread, H); ctx.stroke(); }
      for (let k = 0; k < 9; k++) {
        const z = (k + off) / 9, y = hy + (H - hy) * z * z;
        ctx.strokeStyle = A(a, 0.08 + 0.2 * z); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.fillStyle = A(a, 0.5); ctx.fillRect(0, hy - H * 0.0015, W, H * 0.003);
      break;
    }
    case "prism": {
      /* long diagonal beams of light drifting across the frame */
      const beams = Math.min(7, w.count);
      for (let i = 0; i < beams; i++) {
        const ang = ((w.angle + 70 + (i - 3) * 9) * Math.PI) / 180;
        const shift = ((t * (0.04 + 0.02 * r(60 + i)) + r(70 + i)) % 1.4) - 0.2;
        const len = Math.hypot(W, H) * 1.1, th = H * (0.04 + r(80 + i) * 0.1), col = i % 2 ? a : b;
        ctx.save();
        ctx.translate(W * shift, H * 0.5); ctx.rotate(ang);
        const g = ctx.createLinearGradient(0, -th, 0, th);
        g.addColorStop(0, A(col, 0)); g.addColorStop(0.5, A(col, 0.22)); g.addColorStop(1, A(col, 0));
        ctx.globalCompositeOperation = "screen"; ctx.fillStyle = g; ctx.fillRect(-len / 2, -th, len, th * 2);
        ctx.restore();
      }
      break;
    }
    case "contour": {
      /* soft concentric rings, breathing slowly, centred off-axis: depth without a hard grid */
      const rings = w.count + 4;
      ctx.globalCompositeOperation = "screen"; ctx.lineWidth = Math.max(1, H * 0.0014);
      for (let k = 0; k < rings; k++) {
        const rad = H * (0.12 + k * 0.075) * (1 + 0.03 * Math.sin(t * 0.7 + k) + 0.04 * pulse);
        ctx.beginPath(); ctx.ellipse(W * w.cx, H * w.cy, rad * 1.7, rad, (w.angle * Math.PI) / 180 * 0.2, 0, Math.PI * 2);
        ctx.strokeStyle = A(k % 2 ? b : a, 0.08 + 0.12 * (1 - k / rings)); ctx.stroke();
      }
      break;
    }
  }
  /* the grade: a light leak from one corner and lifted shadows in the film's own colour */
  const lx = W * w.leak.x, ly = H * w.leak.y, leak = ctx.createRadialGradient(lx, ly, 0, lx, ly, W * 0.55);
  leak.addColorStop(0, A(a, 0.16)); leak.addColorStop(1, A(a, 0));
  ctx.globalCompositeOperation = "screen"; ctx.fillStyle = leak; ctx.fillRect(0, 0, W, H);
  const lift = ctx.createLinearGradient(0, 0, 0, H);
  lift.addColorStop(0, A(b, 0.2)); lift.addColorStop(1, A(a, 0.1));
  ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = lift; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
