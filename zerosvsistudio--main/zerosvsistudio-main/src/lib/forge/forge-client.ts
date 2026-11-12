import { FORGE_WORKER_SOURCE } from "./worker-source";

export type ForgeStats = {
  vertices: number; quads: number; triangles: number; particles: number; samples: number; components: number; keptComponents: number;
  boundaryEdges: number; nonManifoldEdges: number; watertight: boolean; resolution: number; voxel: number; ms: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  refineLevels: number; creaseVertices: number; ambiguityFixes: number; displaced: boolean; edgeLength: number;
  regularPct: number; quadAspect: number; badQuadPct: number; surfaceArea: number; volume: number;
  eulerCharacteristic: number; genus: number; pureQuad: boolean;
};

export type ForgeMesh = {
  positions: Float32Array; normals: Float32Array; colors: Uint8Array;
  /** per vertex: metallic, roughness, emissive (0-255 each; emissive 255 = intensity 2.0) */
  mats: Uint8Array;
  quads: Uint32Array;
  points: Float32Array; pointColors: Uint8Array;
  material: { metallic: number; roughness: number };
  stats: ForgeStats;
};

export type ForgeQuality = "draft" | "hyper";

export type ForgeOptions = {
  /** "draft" is fast (QA + first look); "hyper" adds a high-res field and quad refinement. Default: hyper. */
  quality?: ForgeQuality;
  resolution?: number;
  refine?: number;
  particles?: number;
  budgetMs?: number;
  timeoutMs?: number;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
};

export type DeviceProfile = { mobile: boolean; cores: number; memGb: number };

export function deviceProfile(): DeviceProfile {
  if (typeof navigator === "undefined") return { mobile: false, cores: 4, memGb: 8 };
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
    cores: navigator.hardwareConcurrency || 4,
    memGb: nav.deviceMemory ?? 4,
  };
}

export function defaultParticleCount(): number {
  const d = deviceProfile();
  if (d.mobile || d.memGb <= 2) return 450_000;
  if (d.cores >= 8 && d.memGb >= 8) return 2_000_000;
  if (d.cores >= 6) return 1_500_000;
  return 900_000;
}

export function defaultResolution(quality: ForgeQuality = "hyper"): number {
  const d = deviceProfile();
  if (quality === "draft") return d.mobile ? 104 : d.cores >= 6 ? 140 : 124;
  if (d.mobile) return d.memGb <= 3 ? 120 : 138;
  return d.cores >= 8 && d.memGb >= 8 ? 196 : d.cores >= 6 ? 178 : 154;
}

export type ForgePreset = { resolution: number; refine: number; particles: number; budgetMs: number; timeoutMs: number; maxCells: number; vertexBudget: number; mobile: boolean };

export function qualityPreset(quality: ForgeQuality = "hyper"): ForgePreset {
  const d = deviceProfile();
  if (quality === "draft") {
    return { resolution: defaultResolution("draft"), refine: 0, particles: d.mobile ? 200_000 : 500_000, budgetMs: 20_000, timeoutMs: 120_000, maxCells: d.mobile ? 6e6 : 14e6, vertexBudget: 400_000, mobile: d.mobile };
  }
  return {
    resolution: defaultResolution("hyper"), refine: 2, particles: defaultParticleCount(), budgetMs: d.mobile ? 30_000 : 45_000, timeoutMs: 300_000,
    maxCells: d.mobile ? 9e6 : d.memGb >= 8 ? 30e6 : 22e6, vertexBudget: d.mobile ? 330_000 : d.memGb >= 8 ? 1_100_000 : 800_000, mobile: d.mobile,
  };
}

/** Runs the model-written shape program in a sandboxed worker and returns the fused mesh + particle cloud. */
export function forgeShape(code: string, opts: ForgeOptions = {}): Promise<ForgeMesh> {
  const preset = qualityPreset(opts.quality ?? "hyper");
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new Error("Cancelled.")); return; }
    let worker: Worker;
    let url = "";
    try {
      url = URL.createObjectURL(new Blob([FORGE_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      reject(new Error(`This browser blocked the 3D worker (${e instanceof Error ? e.message : String(e)}).`));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("Cancelled.")));
    const timer = setTimeout(() => finish(() => reject(new Error("The shape code ran too long and was stopped (possible endless loop)."))), opts.timeoutMs ?? preset.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort);
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type: string; fraction?: number; label?: string; message?: string } & Partial<ForgeMesh>;
      if (m.type === "progress") opts.onProgress?.(m.fraction ?? 0, m.label ?? "");
      else if (m.type === "error") finish(() => reject(new Error(m.message || "The shape code failed.")));
      else if (m.type === "done") {
        finish(() =>
          resolve({
            positions: m.positions!, normals: m.normals!, colors: m.colors!, mats: m.mats ?? new Uint8Array((m.positions!.length / 3) * 3),
            quads: m.quads!, points: m.points!, pointColors: m.pointColors!,
            material: m.material ?? { metallic: 0.15, roughness: 0.55 }, stats: m.stats!,
          }),
        );
      }
    };
    worker.onerror = (e) => finish(() => reject(new Error(e.message || "The 3D worker crashed.")));
    worker.postMessage({
      code, id: 1, resolution: opts.resolution ?? preset.resolution, refine: opts.refine ?? preset.refine, particles: opts.particles ?? preset.particles,
      budgetMs: opts.budgetMs ?? preset.budgetMs, maxCells: preset.maxCells, vertexBudget: preset.vertexBudget, mobile: preset.mobile,
    });
  });
}
