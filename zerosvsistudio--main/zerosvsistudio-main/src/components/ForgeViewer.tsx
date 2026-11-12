import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Download, Layers, Loader2, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { forgeShape, type ForgeMesh } from "@/lib/forge/forge-client";
import { meshToGlb, meshToObj, meshToPly, meshToStl } from "@/lib/forge/forge-export";
import { ForgeView, type ViewState } from "@/lib/forge/forge-view";
import type { ViewMode } from "@/lib/forge/forge-render";

const cache = new Map<string, ForgeMesh>();
const remember = (code: string, mesh: ForgeMesh) => {
  cache.set(code, mesh);
  while (cache.size > 3) cache.delete(cache.keys().next().value as string);
};

/** Lets the chat page hand over the freshly built mesh so the viewer does not rebuild it. */
export function primeForgeCache(code: string, mesh: ForgeMesh): void {
  remember(code, mesh);
}

const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
const MODES: { id: ViewMode; label: string }[] = [
  { id: "particles", label: "Particles" },
  { id: "mesh", label: "Solid" },
  { id: "clay", label: "Clay" },
  { id: "wire", label: "Topology" },
];

function save(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
}

export default function ForgeViewer({ code, mesh: provided, name = "zeros-model", score }: { code: string; mesh?: ForgeMesh | undefined; name?: string; score?: number | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<ForgeView | null>(null);
  const shownRef = useRef(false);
  const [mesh, setMesh] = useState<ForgeMesh | null>(provided ?? cache.get(code) ?? null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [upgrading, setUpgrading] = useState(false);
  const [state, setState] = useState<ViewState>({ mode: "particles", phase: "empty", autoRotate: true });
  const [menu, setMenu] = useState(false);
  const [exportError, setExportError] = useState("");
  const safeName = useMemo(() => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "zeros-model", [name]);

  useEffect(() => { if (provided) { remember(code, provided); setMesh(provided); } }, [provided, code]);

  /* Rebuild from the saved program when the mesh is not in memory (e.g. after reloading the chat):
     a fast draft appears first, then the hyper-detail mesh swaps in without resetting the camera. */
  useEffect(() => {
    if (mesh || provided) return;
    let cancelled = false;
    setError(""); setProgress("Rebuilding from the shape program…");
    (async () => {
      try {
        const draft = await forgeShape(code, { quality: "draft", onProgress: (f, l) => !cancelled && setProgress(`${l}… ${Math.round(f * 100)}%`) });
        if (cancelled) return;
        setMesh(draft); setProgress("");
        setUpgrading(true);
        try {
          const hyper = await forgeShape(code, { quality: "hyper" });
          if (!cancelled) { remember(code, hyper); setMesh(hyper); }
        } catch { if (!cancelled) remember(code, draft); }
        if (!cancelled) setUpgrading(false);
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setProgress(""); setUpgrading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [code, mesh, provided]);

  /* one WebGL view for the lifetime of the component */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let view: ForgeView;
    try { view = new ForgeView(canvas); } catch (e) { setError(e instanceof Error ? e.message : "WebGL2 is not available."); return; }
    viewRef.current = view; view.onState = setState;
    return () => { view.dispose(); viewRef.current = null; shownRef.current = false; };
  }, []);

  /* push every new mesh into the view: the first one assembles from particles, later swaps keep the camera */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !mesh) return;
    view.setMesh(mesh, { animate: !shownRef.current });
    shownRef.current = true;
  }, [mesh]);

  const stats = mesh?.stats;
  const doExport = (fn: () => Blob, file: string) => {
    try { save(fn(), file); setExportError(""); } catch (e) { setExportError(e instanceof Error ? e.message : "Export failed."); }
    setMenu(false);
  };
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-[oklch(0.1_0.01_265)] shadow-2xl shadow-black/20">
      <div className="relative h-[24rem] w-full select-none">
        <canvas ref={canvasRef} className="absolute inset-0 block" aria-label="Interactive 3D model" />
        {!mesh && !error && <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-white/60"><Loader2 className="h-4 w-4 animate-spin" /> {progress || "Preparing…"}</div>}
        {error && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-amber-200">{error}</div>}
        {mesh && (
          <>
            <div className="absolute left-3 top-3 flex max-w-[70%] flex-wrap gap-1.5">
              {MODES.map((m) => (
                <button key={m.id} type="button" onClick={() => viewRef.current?.setMode(m.id)} className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold backdrop-blur transition ${state.mode === m.id ? "bg-white text-black" : "border border-white/20 bg-black/55 text-white hover:bg-black/75"}`}>
                  {m.label}
                </button>
              ))}
            </div>
            <div className="absolute right-3 top-3 flex gap-1.5">
              <button type="button" aria-label="Replay the particle assembly" onClick={() => viewRef.current?.replay()} className="rounded-lg border border-white/20 bg-black/55 p-1.5 text-white backdrop-blur hover:bg-black/75"><RotateCcw className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => viewRef.current?.toggleAutoRotate()} className="rounded-lg border border-white/20 bg-black/55 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur hover:bg-black/75">{state.autoRotate ? "Spin: on" : "Spin: off"}</button>
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 text-[11px] text-white/55">
              {upgrading && <Loader2 className="h-3 w-3 animate-spin" />}
              {upgrading ? "Adding hyper-detail…" : state.phase === "assembling" ? "Particles converging into one mesh…" : "Drag to orbit · scroll to zoom"}
            </div>
          </>
        )}
      </div>
      {stats && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 bg-black/30 px-3 py-2 text-[11px] text-white/70">
          <span className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3" /> {fmt(stats.particles)} particles</span>
          <span className="inline-flex items-center gap-1"><Box className="h-3 w-3" /> {fmt(stats.vertices)} verts · {fmt(stats.quads)} quads</span>
          <span className={`inline-flex items-center gap-1 ${stats.watertight ? "text-emerald-300" : "text-amber-300"}`}><ShieldCheck className="h-3 w-3" /> {stats.watertight ? "watertight" : `${stats.boundaryEdges + stats.nonManifoldEdges} open/bad edges`}</span>
          <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" /> {stats.pureQuad ? "pure quad" : "tri"} · {stats.regularPct}% regular</span>
          {stats.refineLevels > 0 && <span className="text-sky-300">hyper ×{4 ** stats.refineLevels}</span>}
          {typeof score === "number" && <span>QA {score}/100</span>}
          <span className="text-white/45">{(stats.ms / 1000).toFixed(1)}s</span>
          <div className="relative ml-auto">
            <button type="button" onClick={() => setMenu((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-semibold text-black hover:opacity-90"><Download className="h-3.5 w-3.5" /> Download</button>
            {menu && mesh && (
              <div className="absolute bottom-full right-0 z-10 mb-1 w-56 overflow-hidden rounded-xl border border-white/15 bg-[oklch(0.16_0.01_265)] text-xs shadow-xl">
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-white/10" onClick={() => doExport(() => meshToGlb(mesh, safeName), `${safeName}.glb`)}>GLB · PBR materials · web / Blender</button>
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-white/10" onClick={() => doExport(() => meshToObj(mesh, safeName), `${safeName}.obj`)}>OBJ · quads + vertex colours</button>
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-white/10" onClick={() => doExport(() => meshToPly(mesh, safeName), `${safeName}.ply`)}>PLY · binary, colours + normals</button>
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-white/10" onClick={() => doExport(() => meshToStl(mesh), `${safeName}.stl`)}>STL · 3D printing</button>
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-white/10" onClick={() => doExport(() => new Blob([code], { type: "text/javascript" }), `${safeName}.shape.js`)}>Shape code · .js (editable)</button>
              </div>
            )}
          </div>
          {exportError && <div className="w-full text-amber-300">{exportError}</div>}
        </div>
      )}
    </div>
  );
}
