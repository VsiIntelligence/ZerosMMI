import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Download, FileText, Loader2, Music2, Pause, Play, RotateCcw, ShieldCheck } from "lucide-react";
import type { SongInfoLite, SongSpec } from "@/lib/song";
import { buildLrc, buildLyricsText } from "@/lib/parse-song-response";
import { clock, songReport, type SongReport } from "@/lib/song-report";
import { makeSongCover } from "@/lib/song-cover";

export type SongStem = "instrumental" | "vocals";
export type SongUrls = { play: string; wav?: string | undefined; opus?: string | undefined; instrumental?: string | undefined; vocals?: string | undefined };

const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 48) || "zeros-song";

function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
}

/** Peak-envelope waveform with section markers and a draggable playhead. */
function Waveform({ peaks, sections, duration, time, onSeek }: { peaks: number[]; sections: SongInfoLite["sections"]; duration: number; time: number; onSeek: (sec: number) => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = Math.floor(W * dpr); c.height = Math.floor(H * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const n = peaks.length, bw = W / n, mid = H / 2, frac = duration > 0 ? time / duration : 0;
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, (peaks[i]! / 255) * (H - 6)), played = i / n < frac;
      g.fillStyle = played ? "rgba(34,211,238,0.95)" : "rgba(255,255,255,0.28)";
      g.fillRect(i * bw + 0.5, mid - h / 2, Math.max(1, bw - 1), h);
    }
    g.fillStyle = "rgba(255,255,255,0.35)";
    for (const s of sections) { if (s.start > 0.5 && duration > 0) g.fillRect((s.start / duration) * W, 0, 1, 5); }
    g.fillStyle = "#fff"; g.fillRect(Math.max(0, frac * W - 1), 0, 2, H);
  }, [peaks, sections, duration, time]);
  const seekFrom = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };
  return (
    <canvas
      ref={ref} className="h-14 w-full cursor-pointer touch-none rounded-lg" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekFrom(e); }}
      onPointerMove={(e) => { if (dragging.current) seekFrom(e); }}
      onPointerUp={() => { dragging.current = false; }}
    />
  );
}

export function SongBlock({
  spec, urls, info, report: reportProp, onRebuild, rebuilding, onStem, stemBusy,
}: {
  spec?: SongSpec | null;
  urls?: SongUrls | undefined;
  info?: SongInfoLite | null | undefined;
  report?: SongReport | null | undefined;
  /** re-renders the audio from the song blueprint (deterministic) - shown when the stored audio cannot be played */
  onRebuild?: (() => void) | undefined;
  rebuilding?: boolean | undefined;
  /** renders a stem on demand (instrumental karaoke / vocals-only) from the same blueprint */
  onStem?: ((stem: SongStem) => void) | undefined;
  stemBusy?: SongStem | null | undefined;
}) {
  const title = spec?.title || "Zeros track";
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lyricsRef = useRef<HTMLDivElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(info?.durationSec ?? 0);
  const [audioError, setAudioError] = useState(false);
  const [cover, setCover] = useState("");
  const [showReport, setShowReport] = useState(false);
  const genre = info?.genre ?? spec?.genre ?? "pop";

  useEffect(() => { setCover(makeSongCover(title, genre)); }, [title, genre]);
  useEffect(() => { setAudioError(false); }, [urls?.play]);
  useEffect(() => { if (info?.durationSec) setDuration(info.durationSec); }, [info?.durationSec]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setAudioError(true)); else a.pause();
  }, []);
  const seek = useCallback((sec: number) => { const a = audioRef.current; if (a) { a.currentTime = sec; setTime(sec); } }, []);

  const lines = info?.lyrics ?? [];
  const activeIdx = useMemo(() => {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid]!.t <= time + 0.15) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }, [lines, time]);

  /* keep the current line centred inside the lyric panel (never scrolls the page) */
  useEffect(() => {
    const box = lyricsRef.current, el = box?.querySelector<HTMLElement>(`[data-line="${activeIdx}"]`);
    if (!box || !el || !playing) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [activeIdx, playing]);

  const report = useMemo(() => reportProp ?? (spec && info ? songReport(spec, info) : null), [reportProp, spec, info]);

  const exportLrc = () => { if (info) saveBlob(new Blob([buildLrc(title, info.lyrics, info.durationSec)], { type: "text/plain;charset=utf-8" }), `${slug(title)}.lrc`); };
  const exportTxt = () => { if (spec) saveBlob(new Blob([buildLyricsText(spec)], { type: "text/plain;charset=utf-8" }), `${slug(title)}-lyrics.txt`); };

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.07] to-black/50 shadow-xl shadow-black/30 backdrop-blur-md">
      <div className="flex gap-3 p-4">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-white/10">
          {cover ? <img src={cover} alt={`${title} cover art`} className="h-full w-full object-cover" /> : <Music2 className="absolute inset-0 m-auto h-8 w-8 text-white/40" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold text-white">{title}</h3>
          <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-cyan-300/80">Zeros by VsiStudio</p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-white/75">
            <span className="rounded-md bg-white/10 px-2 py-0.5">{genre}</span>
            <span className="rounded-md bg-white/10 px-2 py-0.5">{info?.bpm ?? spec?.bpm ?? 120} BPM</span>
            {(info?.key ?? spec?.key) && <span className="rounded-md bg-white/10 px-2 py-0.5">{info?.key ?? spec?.key}</span>}
            {duration > 0 && <span className="rounded-md bg-white/10 px-2 py-0.5">{clock(duration)}</span>}
            {info?.vocalsRendered && <span className="rounded-md bg-fuchsia-400/20 px-2 py-0.5 text-fuchsia-200">vocals · {info.voice}</span>}
          </div>
        </div>
      </div>

      {urls?.play ? (
        <div className="px-4 pb-3">
          <audio
            ref={audioRef} src={urls.play} preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(d); }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setTime(0); }}
            onError={() => setAudioError(true)}
          />
          {info?.waveform?.length ? <Waveform peaks={info.waveform} sections={info.sections} duration={duration} time={time} onSeek={seek} /> : (
            <input type="range" min={0} max={Math.max(1, duration)} step={0.1} value={time} onChange={(e) => seek(Number(e.target.value))} className="w-full accent-cyan-400" aria-label="Seek" />
          )}
          <div className="mt-2 flex items-center gap-3">
            <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black shadow-lg transition active:scale-95">
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-px" />}
            </button>
            <span className="font-mono text-xs tabular-nums text-white/70">{clock(time)} / {clock(duration)}</span>
            {info?.sections?.length ? <span className="ml-auto truncate text-[11px] text-white/50">{[...info.sections].reverse().find((s) => s.start <= time)?.name ?? info.sections[0]!.name}</span> : null}
          </div>
          {audioError && (
            <div className="mt-2 rounded-lg border border-amber-300/30 bg-amber-300/10 p-2.5 text-xs text-amber-100">
              This browser could not play the saved audio.{" "}
              {onRebuild ? (
                <button type="button" onClick={onRebuild} disabled={rebuilding} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 disabled:opacity-60">
                  {rebuilding ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Rebuild it from the song blueprint
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-2 px-4 pb-3 text-xs text-white/55"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Recording the track…</p>
      )}

      {lines.length ? (
        <div ref={lyricsRef} className="mx-4 mb-3 max-h-60 overflow-y-auto scroll-smooth rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-center">
          {lines.map((l, i) => (
            <div key={i} data-line={i}>
              {(i === 0 || lines[i - 1]!.section !== l.section) && <p className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/70 first:mt-0">{l.section}</p>}
              <button
                type="button" onClick={() => seek(l.t)}
                className={`block w-full rounded-md px-1 py-0.5 text-[15px] leading-snug transition-all duration-200 ${i === activeIdx ? "scale-[1.03] font-semibold text-white" : i < activeIdx ? "text-white/35" : "text-white/60"} hover:text-white`}
              >
                {l.text}
              </button>
            </div>
          ))}
        </div>
      ) : spec?.lyrics?.length ? (
        <div className="mx-4 mb-3 max-h-60 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/80">
          {spec.lyrics.map((s, i) => (
            <div key={`${s.section}-${i}`} className="mb-3 last:mb-0">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/70">{s.section}</p>
              {s.lines.map((l, li) => <p key={li}>{l}</p>)}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/30 px-4 py-3">
        {urls?.wav && <button type="button" onClick={() => { const a = document.createElement("a"); a.href = urls.wav!; a.download = `${slug(title)}.wav`; document.body.appendChild(a); a.click(); a.remove(); }} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90"><Download className="h-3.5 w-3.5" /> WAV · lossless</button>}
        {urls?.opus && <a href={urls.opus} download={`${slug(title)}.webm`} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90"><Download className="h-3.5 w-3.5" /> {urls.wav ? "Opus · small" : "Audio · .webm"}</a>}
        {!urls?.wav && urls?.play && onRebuild && <button type="button" onClick={onRebuild} disabled={rebuilding} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-60">{rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Render lossless WAV</button>}
        {info && lines.length > 0 && <button type="button" onClick={exportLrc} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10"><FileText className="h-3.5 w-3.5" /> Synced .lrc</button>}
        {spec?.lyrics?.length ? <button type="button" onClick={exportTxt} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10"><FileText className="h-3.5 w-3.5" /> Lyrics</button> : null}
        {spec && !spec.instrumental && onStem && (["instrumental", "vocals"] as const).map((st) => {
          const href = urls?.[st], busy = stemBusy === st, label = st === "instrumental" ? "Karaoke · no vocals" : "Acapella · vocals only";
          return href ? (
            <a key={st} href={href} download={`${slug(title)}-${st}.wav`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10"><Download className="h-3.5 w-3.5" /> {label}</a>
          ) : (
            <button key={st} type="button" disabled={!!stemBusy} onClick={() => onStem(st)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-60">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Music2 className="h-3.5 w-3.5" />} {busy ? "Rendering…" : label}
            </button>
          );
        })}
        {report && (
          <button type="button" onClick={() => setShowReport((v) => !v)} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ${report.score >= 85 ? "bg-emerald-400/15 text-emerald-200" : "bg-amber-400/15 text-amber-200"}`}>
            <ShieldCheck className="h-3.5 w-3.5" /> QA {report.score}/100
          </button>
        )}
      </div>
      {report && showReport && (
        <ul className="space-y-1 border-t border-white/10 bg-black/40 px-4 py-3 text-[11px] text-white/75">
          <li className="mb-1 font-semibold text-white">{report.headline}</li>
          {report.checks.map((c) => (
            <li key={c.label} className="flex items-baseline gap-2"><span className={c.ok ? "text-emerald-300" : "text-amber-300"}>{c.ok ? "✓" : "!"}</span><span className="w-20 shrink-0 text-white/55">{c.label}</span><span>{c.value}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
