import { ForgeRenderer, type ViewMode } from "./forge-render";
import type { ForgeMesh } from "./forge-client";

export type ViewState = { mode: ViewMode; phase: "empty" | "assembling" | "ready"; autoRotate: boolean };

/** Framework-free interactive viewer: orbit / zoom / auto-rotate, particle assembly animation, mode switching. */
export class ForgeView {
  private renderer: ForgeRenderer;
  private raf = 0;
  private yaw = 0.7; private pitch = 0.22; private dist = 3.5;
  private mode: ViewMode = "particles";
  private assemble = 0; private meshMix = 0; private t0 = 0; private startedAt = 0; private lastInteract = 0;
  private hasMesh = false; private autoRotate = true; private disposed = false;
  private pointers = new Map<number, { x: number; y: number }>(); private pinch = 0;
  private ro: ResizeObserver | null = null;
  onState?: (s: ViewState) => void;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new ForgeRenderer(canvas);
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", this.down); canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up); canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    if (typeof ResizeObserver !== "undefined" && canvas.parentElement) { this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(canvas.parentElement); }
    this.fit();
    this.t0 = performance.now();
    const loop = (now: number) => { if (this.disposed) return; this.tick(now); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  private fit(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = el.clientWidth || this.canvas.clientWidth || 640, h = el.clientHeight || this.canvas.clientHeight || 420;
    this.renderer.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
  }

  setMesh(mesh: ForgeMesh, opts: { animate?: boolean } = {}): void {
    this.renderer.setMesh(mesh);
    this.hasMesh = true;
    this.startedAt = performance.now();
    if (opts.animate === false) { this.assemble = 1; this.meshMix = 1; }
    else { this.assemble = 0; this.meshMix = 0; this.mode = "particles"; }
    this.emit();
  }

  replay(): void { if (!this.hasMesh) return; this.mode = "particles"; this.assemble = 0; this.meshMix = 0; this.startedAt = performance.now(); this.emit(); }
  setMode(m: ViewMode): void { this.mode = m; if (m === "particles" && this.assemble >= 1) this.meshMix = 0; this.emit(); }
  getMode(): ViewMode { return this.mode; }
  toggleAutoRotate(): void { this.autoRotate = !this.autoRotate; this.emit(); }

  private emit(): void {
    this.onState?.({ mode: this.mode, phase: !this.hasMesh ? "empty" : this.assemble < 1 || this.meshMix < 1 && this.mode === "particles" ? "assembling" : "ready", autoRotate: this.autoRotate });
  }

  private tick(now: number): void {
    if (!this.hasMesh) { this.renderer.render({ yaw: this.yaw, pitch: this.pitch, dist: this.dist, mode: "mesh", assemble: 0, time: (now - this.t0) / 1000, meshMix: 0 }); return; }
    const since = (now - this.startedAt) / 1000, was = this.assemble, wasMix = this.meshMix;
    if (this.assemble < 1) this.assemble = Math.min(1, since / 3.4);
    else if (this.mode === "particles" && this.meshMix < 1 && since > 4.2) this.meshMix = Math.min(1, (since - 4.2) / 1.1);
    if (this.autoRotate && now - this.lastInteract > 1800) this.yaw += 0.0028 * (1 + (this.assemble < 1 ? 1.6 : 0));
    if ((was < 1 && this.assemble >= 1) || (wasMix < 1 && this.meshMix >= 1)) this.emit();
    this.renderer.render({ yaw: this.yaw, pitch: this.pitch, dist: this.dist, mode: this.mode, assemble: this.assemble, time: (now - this.t0) / 1000, meshMix: this.meshMix });
  }

  private down = (e: PointerEvent): void => { this.canvas.setPointerCapture?.(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.lastInteract = performance.now(); this.pinch = this.pinchDist(); };
  private move = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; this.lastInteract = performance.now();
    if (this.pointers.size >= 2) { const d = this.pinchDist(); if (this.pinch > 0 && d > 0) this.dist = Math.min(9, Math.max(1.2, this.dist * (this.pinch / d))); this.pinch = d; }
    else { this.yaw -= dx * 0.008; this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + dy * 0.006)); }
  };
  private up = (e: PointerEvent): void => { this.pointers.delete(e.pointerId); this.pinch = this.pinchDist(); };
  private wheel = (e: WheelEvent): void => { e.preventDefault(); this.lastInteract = performance.now(); this.dist = Math.min(9, Math.max(1.2, this.dist * Math.exp(e.deltaY * 0.0012))); };
  private pinchDist(): number { const a = [...this.pointers.values()]; return a.length >= 2 ? Math.hypot(a[0]!.x - a[1]!.x, a[0]!.y - a[1]!.y) : 0; }

  /** Stills of the solid mesh from several angles (for the AI inspector). */
  captureViews(size = 448): { name: string; dataUrl: string }[] {
    const keep = { w: this.canvas.width, h: this.canvas.height };
    const views: [string, number, number][] = [["front three-quarter", 0.7, 0.25], ["left side", Math.PI / 2, 0.08], ["back three-quarter", Math.PI + 0.6, 0.3]];
    const out = views.map(([name, yaw, pitch]) => ({ name, dataUrl: this.renderer.capture(yaw, pitch, size) }));
    this.canvas.width = keep.w; this.canvas.height = keep.h;
    return out;
  }

  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.raf); this.ro?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.down); this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up); this.canvas.removeEventListener("pointercancel", this.up); this.canvas.removeEventListener("wheel", this.wheel);
    this.renderer.dispose();
  }
}
