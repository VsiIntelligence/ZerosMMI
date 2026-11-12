/**
 * Zeros Cinema Engine - the stage. Turns a VideoSpec into frames: compiles each scene's layout once, then draws any frame as a
 * pure function of time (parallax camera, impact shake, eight transitions, bloom, grain, vignette, burned-in captions).
 */
import { clamp, clamp01, ease, rng, rgba } from "./kit";
import { compileScene, motionOf } from "./layouts";
import { drawElement, makeMeasure, type Env } from "./draw";
import { drawWorld, worldFor, type World } from "./world";
import type { Camera, Transition, VideoElement, VideoScene, VideoSpec } from "./types";

export type AudioEnv = {
  fps: number;
  /** per-frame loudness 0..1 */
  energy: Float32Array;
  /** per-frame beat / kick envelope 0..1 (attack on onsets, exponential decay) */
  pulse: Float32Array;
  /** energy-warped clock in seconds, so particles speed up with the music */
  warp: Float32Array;
};
export type CaptionClip = { startMs: number; endMs: number; text: string };
export type StageOptions = { spec: VideoSpec; canvas: HTMLCanvasElement | OffscreenCanvas; audio?: AudioEnv | null; captions?: CaptionClip[]; plates?: (CanvasImageSource | null)[] };

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const TRANSITION_MS: Record<Transition, number> = { cut: 0, flash: 420, glitch: 360, fade: 560, dip: 680, wipe: 560, push: 600, zoom: 600, iris: 680 };
export const transitionMs = (k: Transition | undefined): number => TRANSITION_MS[k ?? "cut"] ?? 0;
const CAMERAS: Camera[] = ["push", "drift", "pan-right", "pull", "pan-left", "drift"];

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}
const ctxOf = (c: AnyCanvas, opts?: CanvasRenderingContext2DSettings): Ctx2D => {
  const x = c.getContext("2d", opts) as Ctx2D | null;
  if (!x) throw new Error("Canvas 2D is unavailable in this browser.");
  return x;
};

export class Stage {
  readonly W: number; readonly H: number; readonly fps: number; readonly spec: VideoSpec;
  readonly compiled: VideoElement[][];
  readonly canvas: AnyCanvas;
  private readonly ctx: Ctx2D;
  private readonly A: AnyCanvas; private readonly B: AnyCanvas; private readonly actx: Ctx2D; private readonly bctx: Ctx2D;
  private readonly scratch: AnyCanvas; private readonly sctx: Ctx2D;
  private readonly bloom: AnyCanvas; private readonly bloomCtx: Ctx2D; private readonly bloom2: AnyCanvas; private readonly bloom2Ctx: Ctx2D;
  private readonly vignette: AnyCanvas; private readonly grain: AnyCanvas;
  private readonly audio: AudioEnv | null; private readonly captions: CaptionClip[]; private readonly plates: (CanvasImageSource | null)[];
  private readonly beatMs: number;
  /** this film's own cinematic world, unique to its title and seed */
  readonly world: World;

  constructor(o: StageOptions) {
    this.spec = o.spec; this.W = o.spec.width; this.H = o.spec.height; this.fps = o.spec.fps;
    this.canvas = o.canvas; this.audio = o.audio ?? null; this.captions = o.captions ?? []; this.plates = o.plates ?? [];
    this.beatMs = 60000 / clamp(o.spec.audio.bpm || 100, 50, 180);
    this.world = worldFor(o.spec);
    this.ctx = ctxOf(this.canvas, { alpha: false });
    this.A = makeCanvas(this.W, this.H); this.B = makeCanvas(this.W, this.H); this.actx = ctxOf(this.A); this.bctx = ctxOf(this.B);
    this.scratch = makeCanvas(this.W, this.H); this.sctx = ctxOf(this.scratch);
    const bw = Math.round(this.W / 4), bh = Math.round(this.H / 4);
    this.bloom = makeCanvas(bw, bh); this.bloomCtx = ctxOf(this.bloom); this.bloom2 = makeCanvas(Math.round(bw / 2), Math.round(bh / 2)); this.bloom2Ctx = ctxOf(this.bloom2);
    this.vignette = this.makeVignette(); this.grain = this.makeGrain(o.spec.seed);
    const measure = makeMeasure(this.ctx as CanvasRenderingContext2D);
    const scenes = o.spec.scenes;
    this.compiled = scenes.map((scene, i) => compileScene({
      spec: o.spec, index: i, scene, startMs: scene.startMs, durMs: scene.endMs - scene.startMs, W: this.W, H: this.H, measure, beatMs: this.beatMs,
      inKind: scene.transition, outKind: scenes[i + 1]?.transition, isLast: i === scenes.length - 1,
    }));
  }

  /* ------------------------------------------------------------------ helpers ------------------------------------------------------------------ */

  private makeVignette(): AnyCanvas {
    const c = makeCanvas(this.W, this.H), x = ctxOf(c), g = x.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.72, this.W / 2, this.H / 2, Math.hypot(this.W, this.H) * 0.64);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.3)"); x.fillStyle = g; x.fillRect(0, 0, this.W, this.H);
    return c;
  }
  private makeGrain(seed: number): AnyCanvas {
    const s = 160, c = makeCanvas(s, s), x = ctxOf(c), img = x.createImageData(s, s), r = rng(seed + 99);
    for (let i = 0; i < s * s; i++) { const v = 100 + Math.floor(r() * 110); img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    x.putImageData(img, 0, 0);
    return c;
  }

  sceneIndexAt(tMs: number): number {
    const sc = this.spec.scenes;
    for (let i = 0; i < sc.length; i++) if (tMs >= sc[i]!.startMs && tMs < sc[i]!.endMs) return i;
    return tMs < (sc[0]?.startMs ?? 0) ? 0 : sc.length - 1;
  }

  private envAt(frame: number, tMs: number): { pulse: number; energy: number; tw: number } {
    const a = this.audio;
    if (a && frame >= 0 && frame < a.pulse.length) return { pulse: a.pulse[frame]!, energy: a.energy[frame]!, tw: a.warp[frame]! };
    /* no analysed audio: a beat-grid pulse keeps the picture musical anyway */
    const ph = (tMs % this.beatMs) / this.beatMs, bar = Math.floor(tMs / this.beatMs) % 4 === 0 ? 1 : 0.6;
    return { pulse: Math.exp(-ph * 5.5) * bar, energy: 0.5 + 0.15 * Math.sin(tMs / 900), tw: tMs / 1000 };
  }

  /* ------------------------------------------------------------------ scene ------------------------------------------------------------------ */

  private cameraFor(scene: VideoScene, index: number, p: number, t: number): { z: number; px: number; py: number } {
    const kind = scene.camera ?? CAMERAS[index % CAMERAS.length]!, W = this.W, H = this.H, e = ease("inOut", p);
    switch (kind) {
      case "push": return { z: 1 + 0.085 * e, px: 0, py: 0 };
      case "pull": return { z: 1.085 - 0.085 * e, px: 0, py: 0 };
      case "pan-left": return { z: 1.07, px: (0.5 - e) * 0.045 * W, py: 0 };
      case "pan-right": return { z: 1.07, px: (e - 0.5) * 0.045 * W, py: 0 };
      case "tilt-up": return { z: 1.07, px: 0, py: (0.5 - e) * 0.05 * H };
      case "tilt-down": return { z: 1.07, px: 0, py: (e - 0.5) * 0.05 * H };
      case "drift": return { z: 1.04 + 0.014 * Math.sin(t * 0.5), px: Math.sin(t * 0.42) * 0.014 * W, py: Math.cos(t * 0.33) * 0.01 * H };
      default: return { z: 1, px: 0, py: 0 };
    }
  }

  /** Draws one scene at scene-local time `local` (ms) into `ctx`. */
  private renderScene(ctx: Ctx2D, index: number, local: number, frame: number, tMs: number, alpha = 1, shake = 0): void {
    const scene = this.spec.scenes[index]!, W = this.W, H = this.H, dur = scene.endMs - scene.startMs;
    const { pulse, energy, tw } = this.envAt(frame, tMs);
    const env: Env = { W, H, local, dur, t: tMs / 1000, tw, pulse, energy, seed: this.spec.seed + index * 101, alpha };
    const cam = this.cameraFor(scene, index, clamp01(local / Math.max(1, dur)), tMs / 1000);
    const c2 = ctx as CanvasRenderingContext2D;
    c2.save();
    c2.globalCompositeOperation = "source-over"; c2.globalAlpha = 1;
    c2.fillStyle = scene.background ?? this.spec.palette.bg; c2.fillRect(0, 0, W, H);
    const shx = shake ? (Math.sin(tMs * 0.21) + Math.sin(tMs * 0.37)) * 0.5 * shake * H * 0.012 : 0, shy = shake ? (Math.cos(tMs * 0.29) + Math.sin(tMs * 0.17)) * 0.5 * shake * H * 0.012 : 0;
    const place = (parallax: number): void => {
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.translate(W / 2 + cam.px * parallax + shx * parallax, H / 2 + cam.py * parallax + shy * parallax);
      const z = 1 + (cam.z - 1) * parallax; c2.scale(z, z); c2.translate(-W / 2, -H / 2);
    };
    const plate = scene.plate ? this.plates[index] ?? null : null;
    let plateDone = !plate, layer = -1, worldDone = false;
    for (const el of this.compiled[index]!) {
      const z = el.z ?? 5, group = z <= 2 ? 0 : 1;
      /* the film's world sits above the scene's base colour and below its content, and moves with a far (depth) parallax */
      if (!worldDone && z >= 1) { place(0.35); drawWorld(c2, this.world, this.spec.palette, W, H, tMs / 1000, pulse, index, alpha); worldDone = true; layer = -1; }
      if (!plateDone && z >= 1) { this.drawPlate(c2, plate!, local / Math.max(1, dur), alpha); plateDone = true; }
      if (group !== layer) { place(group === 0 ? 0.5 : 1); layer = group; }
      c2.globalAlpha = 1; c2.globalCompositeOperation = "source-over";
      c2.shadowColor = "transparent"; c2.shadowBlur = 0; c2.setLineDash([]);
      drawElement(c2, el, env);
    }
    c2.restore();
  }

  private drawPlate(ctx: CanvasRenderingContext2D, img: CanvasImageSource, p: number, alpha: number): void {
    const W = this.W, H = this.H, iw = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width || W, ih = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height || H;
    const s = Math.max(W / iw, H / ih) * (1.06 + 0.08 * p), w = iw * s, h = ih * s;
    ctx.save(); ctx.globalAlpha = 0.55 * alpha; ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "rgba(0,0,0,0.35)"); g.addColorStop(1, "rgba(0,0,0,0.6)"); ctx.globalAlpha = alpha; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ transitions ------------------------------------------------------------------ */

  private composite(kind: Transition, pr: number, seed: number): void {
    const ctx = this.ctx as CanvasRenderingContext2D, W = this.W, H = this.H, A = this.A as CanvasImageSource, B = this.B as CanvasImageSource, p = ease("inOutCubic", pr);
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    switch (kind) {
      case "fade": ctx.drawImage(A, 0, 0); ctx.globalAlpha = p; ctx.drawImage(B, 0, 0); break;
      case "dip": ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = clamp01(1 - p * 2); ctx.drawImage(A, 0, 0); ctx.globalAlpha = clamp01(p * 2 - 1); ctx.drawImage(B, 0, 0); break;
      case "flash": {
        ctx.drawImage(pr < 0.5 ? A : B, 0, 0);
        const f = Math.pow(1 - Math.abs(pr * 2 - 1), 1.6); ctx.globalAlpha = f * 0.92; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
        const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, H * 0.9); g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)"); ctx.globalAlpha = f * 0.6; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
      }
      case "wipe": {
        ctx.drawImage(A, 0, 0);
        const x = p * (W + H * 0.2) - H * 0.1;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, Math.max(0, x), H); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
        const g = ctx.createLinearGradient(x - H * 0.12, 0, x + H * 0.02, 0); g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(255,255,255,0.35)"); ctx.fillStyle = g; ctx.fillRect(x - H * 0.12, 0, H * 0.14, H); break;
      }
      case "push": ctx.drawImage(A, -p * W, 0); ctx.drawImage(B, (1 - p) * W, 0); ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.globalAlpha = (1 - p) * 0.6; ctx.fillRect(0, 0, W, H); break;
      case "zoom": {
        ctx.globalAlpha = 1 - p; const s1 = 1 + 0.35 * p; ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s1, s1); ctx.drawImage(A, -W / 2, -H / 2); ctx.restore();
        ctx.globalAlpha = p; const s2 = 0.86 + 0.14 * p; ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s2, s2); ctx.drawImage(B, -W / 2, -H / 2); ctx.restore(); break;
      }
      case "iris": {
        ctx.drawImage(A, 0, 0);
        const r = p * Math.hypot(W, H) * 0.56; ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = H * 0.004; ctx.globalAlpha = 1 - p; ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.stroke(); break;
      }
      case "glitch": {
        const intensity = Math.sin(Math.PI * pr), r = rng(seed + Math.floor(pr * 40));
        ctx.drawImage(pr < 0.5 ? A : B, 0, 0);
        const src = (pr < 0.5 ? A : B);
        for (let k = 0; k < 9; k++) {
          const y = Math.floor(r() * H), h = Math.floor(H * (0.02 + r() * 0.09)), dx = (r() - 0.5) * W * 0.14 * intensity;
          ctx.drawImage(src, 0, y, W, h, dx, y, W, h);
        }
        ctx.globalAlpha = 0.18 * intensity; ctx.fillStyle = r() > 0.5 ? "#22d3ee" : "#f0abfc"; ctx.fillRect(0, Math.floor(r() * H), W, Math.floor(H * 0.02));
        break;
      }
      default: ctx.drawImage(B, 0, 0);
    }
    ctx.restore();
    if (kind === "glitch") this.chromatic(Math.sin(Math.PI * pr) * this.H * 0.011);
  }

  /** RGB channel split around the centre: only used on glitch frames and big impacts. */
  private chromatic(amount: number): void {
    if (amount < 0.6) return;
    const ctx = this.ctx as CanvasRenderingContext2D, s = this.sctx as CanvasRenderingContext2D, W = this.W, H = this.H;
    s.save(); s.globalCompositeOperation = "copy"; s.drawImage(this.canvas as CanvasImageSource, 0, 0); s.restore();
    const A = this.actx as CanvasRenderingContext2D;
    ctx.save(); ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    for (const [col, dx] of [["#ff0000", -amount], ["#00ff00", 0], ["#0000ff", amount]] as const) {
      A.save(); A.globalCompositeOperation = "copy"; A.drawImage(this.scratch as CanvasImageSource, 0, 0); A.globalCompositeOperation = "multiply"; A.fillStyle = col; A.fillRect(0, 0, W, H); A.restore();
      ctx.globalCompositeOperation = "lighter"; ctx.drawImage(this.A as CanvasImageSource, dx, 0);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ post + captions ------------------------------------------------------------------ */

  private post(frame: number, pulse: number, bloomAmt: number): void {
    const ctx = this.ctx as CanvasRenderingContext2D, W = this.W, H = this.H;
    /* bloom: two downscales give a cheap, cross-browser soft glow (no ctx.filter needed) */
    const b = this.bloomCtx as CanvasRenderingContext2D, b2 = this.bloom2Ctx as CanvasRenderingContext2D;
    b.globalCompositeOperation = "copy"; b.drawImage(this.canvas as CanvasImageSource, 0, 0, this.bloom.width, this.bloom.height);
    b2.globalCompositeOperation = "copy"; b2.drawImage(this.bloom as CanvasImageSource, 0, 0, this.bloom2.width, this.bloom2.height);
    b.globalCompositeOperation = "copy"; b.drawImage(this.bloom2 as CanvasImageSource, 0, 0, this.bloom.width, this.bloom.height);
    ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = bloomAmt + 0.1 * pulse; ctx.imageSmoothingEnabled = true; ctx.drawImage(this.bloom as CanvasImageSource, 0, 0, W, H); ctx.restore();
    ctx.save(); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.drawImage(this.vignette as CanvasImageSource, 0, 0); ctx.restore();
    /* film grain: a tiled noise patch jumping around every frame */
    const r = rng(this.spec.seed * 3 + frame), ox = Math.floor(r() * 160), oy = Math.floor(r() * 160);
    ctx.save(); ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = 0.045;
    for (let y = -oy; y < H; y += 160) for (let x = -ox; x < W; x += 160) ctx.drawImage(this.grain as CanvasImageSource, x, y);
    ctx.restore();
  }

  private drawCaption(tMs: number): void {
    const clip = this.captions.find((c) => tMs >= c.startMs - 120 && tMs <= c.endMs + 200);
    if (!clip) return;
    const ctx = this.ctx as CanvasRenderingContext2D, W = this.W, H = this.H, px = H * 0.036;
    const fade = clamp01(Math.min((tMs - (clip.startMs - 120)) / 160, (clip.endMs + 200 - tMs) / 200));
    const words = clip.text.trim().split(/\s+/), prog = clamp01((tMs - clip.startMs) / Math.max(400, clip.endMs - clip.startMs));
    ctx.save();
    ctx.font = `700 ${px}px "Inter","SF Pro Text","Segoe UI",system-ui,sans-serif`; ctx.textBaseline = "middle";
    const maxW = W * 0.74, lines: string[][] = [[]]; let lw = 0; const sp = ctx.measureText(" ").width;
    for (const w of words) { const ww = ctx.measureText(w).width; if (lines[lines.length - 1]!.length && lw + sp + ww > maxW) { lines.push([]); lw = 0; } lines[lines.length - 1]!.push(w); lw += ww + sp; }
    const lh = px * 1.32, boxH = lines.length * lh + px * 0.9, y0 = H * 0.9 - boxH;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l.join(" ")).width));
    ctx.globalAlpha = fade * 0.62; ctx.fillStyle = "#05070d"; ctx.beginPath();
    const bx = (W - widest) / 2 - px * 0.9, bw = widest + px * 1.8, r = px * 0.7;
    ctx.moveTo(bx + r, y0); ctx.arcTo(bx + bw, y0, bx + bw, y0 + boxH, r); ctx.arcTo(bx + bw, y0 + boxH, bx, y0 + boxH, r); ctx.arcTo(bx, y0 + boxH, bx, y0, r); ctx.arcTo(bx, y0, bx + bw, y0, r); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = fade; let idx = 0;
    lines.forEach((ln, li) => {
      const total = ctx.measureText(ln.join(" ")).width; let x = (W - total) / 2;
      ln.forEach((w) => { const lit = (idx + 0.5) / words.length <= prog + 0.04; ctx.fillStyle = lit ? "#ffffff" : "rgba(255,255,255,0.55)"; ctx.textAlign = "left"; ctx.fillText(w, x, y0 + px * 0.45 + lh * (li + 0.5)); x += ctx.measureText(w).width + sp; idx++; });
    });
    ctx.restore();
  }

  /* ------------------------------------------------------------------ the frame ------------------------------------------------------------------ */

  drawFrame(frame: number): void {
    const tMs = (frame / this.fps) * 1000, sc = this.spec.scenes;
    const idx = this.sceneIndexAt(tMs), { pulse } = this.envAt(frame, tMs);
    let bloomAmt = 0.16, handled = false;
    /* impact shake: the first ~220 ms after a cut into an explosive scene punches the camera */
    const startOf = (i: number): number => sc[i]!.startMs;
    const shakeFor = (i: number, t: number): number => { const m = motionOf(sc[i]!, i); if (m === "calm") return 0; const d = t - startOf(i); return d >= 0 && d < 260 ? Math.pow(1 - d / 260, 2) * (m === "explosive" ? 1 : 0.35) : 0; };
    for (let i = 1; i < sc.length && !handled; i++) {
      const kind = sc[i]!.transition ?? "cut", d = transitionMs(kind);
      if (d <= 0) continue;
      const b = startOf(i), lo = b - d / 2, hi = b + d / 2;
      if (tMs >= lo && tMs <= hi) {
        this.renderScene(this.actx, i - 1, tMs - startOf(i - 1), frame, tMs, 1, 0);
        this.renderScene(this.bctx, i, tMs - b, frame, tMs, 1, shakeFor(i, tMs));
        this.composite(kind, (tMs - lo) / d, this.spec.seed + i * 17);
        bloomAmt = 0.2; handled = true;
      }
    }
    if (!handled) this.renderScene(this.ctx, idx, tMs - startOf(idx), frame, tMs, 1, shakeFor(idx, tMs));
    /* a hard cut has no blend, so it gets a one-frame flash and an RGB kick instead */
    if (!handled && idx > 0 && (sc[idx]!.transition ?? "cut") === "cut") {
      const d = tMs - startOf(idx);
      if (d >= 0 && d < 90) { const c = this.ctx as CanvasRenderingContext2D; c.save(); c.globalAlpha = (1 - d / 90) * 0.28; c.fillStyle = "#fff"; c.fillRect(0, 0, this.W, this.H); c.restore(); if (motionOf(sc[idx]!, idx) === "explosive") this.chromatic((1 - d / 90) * this.H * 0.008); }
    }
    this.post(frame, pulse, bloomAmt);
    this.drawCaption(tMs);
  }

  /** The frame that makes the best poster: the first scene once its headline has landed. */
  posterFrame(): number {
    const first = this.spec.scenes[0];
    return Math.round(((first ? Math.min(first.endMs - 200, first.startMs + 1700) : 1200) / 1000) * this.fps);
  }
}
export { rgba as _rgba };
