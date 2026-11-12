import { useMemo, useState } from "react";
import { Captions, Clapperboard, Download, FileJson, ShieldCheck } from "lucide-react";
import type { VideoSpec } from "@/lib/video-spec";
import type { VideoReport } from "@/lib/video-qa";

const LAYOUT_LABEL: Record<string, string> = { hero: "Hero", kinetic: "Kinetic", statement: "Statement", stats: "Stats", cards: "Cards", list: "List", split: "Split", chart: "Chart", timeline: "Timeline", quote: "Quote", outro: "Outro" };
const mmss = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const slug = (s: string): string => (s || "zeros-film").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "zeros-film";

function saveText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The film player: video, a storyboard strip (tap a scene to jump), a measured QA report (same idea as songs) and downloads
 * for the film, its captions (WebVTT) and its script (JSON, so it can be edited and re-rendered).
 */
export function VideoPreview({ spec, url, format = "webm", audio, report, vtt }: {
  spec: VideoSpec;
  url?: string | undefined;
  format?: "mp4" | "webm";
  /** true = soundtrack present, false = silent, undefined = unknown (older message) */
  audio?: boolean | undefined;
  report?: VideoReport | undefined;
  vtt?: string | undefined;
}) {
  const [showReport, setShowReport] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [now, setNow] = useState(0);
  const name = slug(spec.title), ext = format === "mp4" ? "mp4" : "webm";
  const scenes = spec.scenes ?? [];
  const total = Math.max(1, Math.round((spec.durationSec || 0) * 1000));
  const active = useMemo(() => Math.max(0, scenes.findIndex((s) => now * 1000 >= s.startMs && now * 1000 < s.endMs)), [now, scenes]);
  const resLabel = (spec.width || 1280) >= 1920 ? "1080p" : "720p";

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card/50">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
        <h3 className="text-sm font-bold">{spec.title}</h3>
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {mmss(total)} · {spec.fps || 30}fps · {resLabel}{audio === true ? " · score + sound design" : audio === false ? " · silent" : ""} · {ext}
        </span>
      </div>

      {url ? (
        <>
          <video ref={setVideo} controls src={url} className="mt-3 aspect-video w-full bg-black" preload="metadata" playsInline onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />

          {scenes.length > 1 && (
            <div className="px-4 pt-3" aria-label="Storyboard">
              <div className="flex h-9 w-full gap-[2px] overflow-hidden rounded-lg">
                {scenes.map((s, i) => (
                  <button
                    key={`${s.startMs}-${i}`} type="button"
                    onClick={() => { if (video) { video.currentTime = s.startMs / 1000 + 0.05; void video.play().catch(() => undefined); } }}
                    title={`${s.label} · ${LAYOUT_LABEL[s.layout] ?? s.layout} · ${mmss(s.startMs)}`}
                    style={{ flexGrow: Math.max(1, s.endMs - s.startMs) }}
                    className={`relative min-w-0 overflow-hidden px-1.5 text-left text-[10px] font-semibold leading-9 transition ${i === active ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground hover:bg-muted"}`}
                  >
                    <span className="block truncate">{s.label}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">{scenes.length} scenes · {new Set(scenes.map((s) => s.layout)).size} layouts · tap a scene to jump</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-3">
            <a href={url} download={`${name}.${ext}`} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
              <Download className="h-3.5 w-3.5" /> Download {ext.toUpperCase()}
            </a>
            {vtt ? (
              <button type="button" onClick={() => saveText(`${name}.vtt`, vtt, "text/vtt")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold hover:bg-muted">
                <Captions className="h-3.5 w-3.5" /> Captions
              </button>
            ) : null}
            <button type="button" onClick={() => saveText(`${name}-script.json`, JSON.stringify(spec, null, 2), "application/json")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold hover:bg-muted">
              <FileJson className="h-3.5 w-3.5" /> Script
            </button>
            {report && (
              <button type="button" onClick={() => setShowReport((v) => !v)} aria-expanded={showReport} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ${report.checks.every((c) => c.ok || c.note) ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                <ShieldCheck className="h-3.5 w-3.5" /> QA {report.score}/100
              </button>
            )}
          </div>

          {report && showReport && (
            <ul className="mx-4 mb-4 space-y-1.5 rounded-xl border border-border bg-black/30 p-3 text-[11px] leading-snug">
              <li className="mb-1 flex items-center gap-1.5 font-semibold text-white"><Clapperboard className="h-3.5 w-3.5" /> {report.headline}</li>
              {report.checks.map((c) => (
                <li key={c.label} className="flex gap-2">
                  <span className={`mt-[1px] shrink-0 font-bold ${c.ok ? "text-emerald-400" : c.note ? "text-sky-300" : "text-amber-400"}`} aria-hidden>{c.ok ? "✓" : c.note ? "i" : "!"}</span>
                  <span><b className="text-white">{c.label}.</b> <span className="text-muted-foreground">{c.value}</span></span>
                </li>
              ))}
              {spec.warnings.length > 0 && spec.warnings.map((w) => (
                <li key={w} className="flex gap-2 text-sky-300"><span className="shrink-0 font-bold" aria-hidden>i</span><span>{w}</span></li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="px-4 py-6 text-xs text-muted-foreground">{report ? "Restoring your film…" : "Directing scenes, composing the score, designing the sound and rendering frames…"}</p>
      )}
    </div>
  );
}
