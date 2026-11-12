import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, Download, ExternalLink, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { assembleWebProject, buildStandaloneHost, downloadProjectZip, type WebProject } from "@/lib/web-project";
import { liteReport, runSiteChecks, type SiteReport, type SiteReportLite } from "@/lib/site-verifier";

type RuntimeIssue = { kind: string; value: string };
type PreviewMsg = { source?: string; type?: string; kind?: string; value?: string; path?: string; anchor?: string; id?: string; dataUrl?: string; error?: string };

const SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox";
const SEV_STYLE: Record<string, string> = {
  blocker: "bg-red-500/15 text-red-200 border-red-400/30",
  major: "bg-amber-500/15 text-amber-200 border-amber-400/30",
  minor: "bg-white/5 text-white/60 border-white/10",
};

export default function WebPreview({
  project,
  name = "zeros-site",
  brief = "",
  report: initialReport = null,
}: {
  project: WebProject;
  name?: string;
  brief?: string;
  report?: SiteReportLite | null;
}) {
  const pages = useMemo(() => Object.keys(project.files).filter((f) => /\.html?$/i.test(f)), [project.files]);
  const home = pages.includes("index.html") ? "index.html" : (pages[0] ?? "index.html");
  const [entry, setEntry] = useState(home);
  const [anchor, setAnchor] = useState("");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [openFile, setOpenFile] = useState(home);
  const [issues, setIssues] = useState<RuntimeIssue[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [shotError, setShotError] = useState("");
  const [check, setCheck] = useState<{ running: boolean; status: string; full: SiteReport | null }>({ running: false, status: "", full: null });
  const [lite, setLite] = useState<SiteReportLite | null>(initialReport);
  const [showReport, setShowReport] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shotId = useRef("");

  // Reset when a different project arrives.
  useEffect(() => {
    setEntry(home);
    setAnchor("");
    setOpenFile(home);
    setIssues([]);
    setShot(null);
    setLoaded(false);
  }, [home, pages.join("|")]);

  const html = useMemo(() => assembleWebProject(project, entry, { anchor }), [project, entry, anchor]);
  const [src, setSrc] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    setSrc(url);
    setLoaded(false);
    setIssues([]);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<PreviewMsg>) => {
      const m = event.data;
      if (!m || m.source !== "zeros-preview" || event.source !== frameRef.current?.contentWindow) return;
      if (m.type === "navigate-request" && m.path) {
        setEntry(m.path);
        setAnchor(m.anchor ?? "");
        setOpenFile(m.path);
      } else if (m.type === "runtime") {
        if (m.kind === "loaded") setLoaded(true);
        else if (m.kind === "error" || m.kind === "console" || m.kind === "asset" || m.kind === "link") {
          setIssues((prev) => [...prev.slice(-9), { kind: m.kind!, value: String(m.value ?? "") }]);
        }
      } else if (m.type === "screenshot" && m.id === shotId.current) {
        setShotBusy(false);
        if (m.dataUrl) {
          setShot(m.dataUrl);
          setShotError("");
        } else setShotError(m.error || "The browser refused to capture this page.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const takeScreenshot = () => {
    setShotBusy(true);
    setShotError("");
    shotId.current = `shot-${Date.now()}`;
    frameRef.current?.contentWindow?.postMessage({ source: "zeros-preview-host", type: "screenshot", id: shotId.current, opts: { slices: 3, maxWidth: 1000, quality: 0.82 } }, "*");
    window.setTimeout(() => setShotBusy(false), 20000);
  };

  const runVerify = useCallback(async () => {
    if (check.running) return;
    setCheck({ running: true, status: "Warming up the QA lab…", full: null });
    setShowReport(true);
    try {
      const full = await runSiteChecks(project, {
        brief,
        onStatus: (status) => setCheck((c) => ({ ...c, status })),
      });
      setCheck({ running: false, status: "", full });
      setLite(liteReport(full));
    } catch (e) {
      setCheck({ running: false, status: "", full: null });
      setIssues((prev) => [...prev, { kind: "error", value: `Verify failed: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }, [brief, check.running, project]);

  const openFull = () => {
    const url = URL.createObjectURL(new Blob([buildStandaloneHost(project, entry, name)], { type: "text/html;charset=utf-8" }));
    if (!window.open(url, "_blank")) URL.revokeObjectURL(url);
    else window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  };

  const full = check.full;
  const verifiedOk = full ? full.ok : lite?.ok;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card/30 shadow-2xl shadow-black/10">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
        {(["preview", "code"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition ${tab === t ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}>
            {t}
          </button>
        ))}
        {tab === "preview" && pages.length > 1 && (
          <select
            value={entry}
            onChange={(e) => { setEntry(e.target.value); setAnchor(""); }}
            className="rounded-lg border border-border bg-transparent px-2 py-1.5 text-xs"
            aria-label="Page"
          >
            {pages.map((p) => <option key={p} value={p} className="bg-card">{p}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {verifiedOk === true && <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />}
          {verifiedOk === false && <XCircle className="h-3.5 w-3.5 text-amber-300" />}
          {verifiedOk === undefined && (loaded ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />)}
          <button type="button" onClick={() => lite || full ? setShowReport((v) => !v) : void runVerify()} className="hover:underline">
            {verifiedOk === true ? "Verified by Zeros" : verifiedOk === false ? "Zeros found issues" : issues.length ? `${issues.length} log entr${issues.length === 1 ? "y" : "ies"}` : "Live"}
          </button>
        </div>
      </div>

      {tab === "preview" ? (
        <div className="relative">
          <iframe
            ref={frameRef}
            title="Zeros website preview"
            src={src || undefined}
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
            allow="fullscreen *; autoplay *; clipboard-write *"
            allowFullScreen
            className="h-[30rem] w-full bg-white"
            onLoad={() => setLoaded(true)}
          />
          <div className="pointer-events-none absolute bottom-3 right-3 flex gap-1.5">
            <button onClick={() => void runVerify()} disabled={check.running} className="pointer-events-auto inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-black/75 px-3 py-2 text-[11px] font-semibold text-white backdrop-blur hover:bg-black/90 disabled:opacity-60">
              {check.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} {check.running ? "Verifying…" : "Verify"}
            </button>
            <button onClick={takeScreenshot} disabled={shotBusy} className="pointer-events-auto inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-black/75 px-3 py-2 text-[11px] font-semibold text-white backdrop-blur hover:bg-black/90 disabled:opacity-60">
              <Camera className="h-3.5 w-3.5" /> {shotBusy ? "Capturing…" : "Screenshot"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex h-[30rem]">
          <ul className="w-40 shrink-0 overflow-auto border-r border-border bg-card/40 text-xs">
            {Object.keys(project.files).map((f) => (
              <li key={f}>
                <button onClick={() => setOpenFile(f)} className={`block w-full truncate px-2 py-1.5 text-left ${openFile === f ? "bg-primary/20 text-primary" : "text-muted-foreground"}`}>{f}</button>
              </li>
            ))}
          </ul>
          <pre className="flex-1 overflow-auto bg-[oklch(0.06_0.008_265)] p-3 text-[11px] leading-relaxed"><code>{project.files[openFile] ?? project.files["index.html"]}</code></pre>
        </div>
      )}

      {tab === "preview" && (check.running || showReport) && (check.running || full || lite) && (
        <div className="border-t border-border bg-card/40 p-3 text-xs">
          {check.running ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {check.status || "Checking…"}</div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
                {verifiedOk ? <ShieldCheck className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-amber-300" />}
                <span>{full?.headline ?? lite?.headline}</span>
              </div>
              {full?.ai?.summary && <p className="mb-2 text-muted-foreground">🎨 {full.ai.summary}</p>}
              {lite?.checks && lite.checks.length > 0 && (
                <ul className="mb-3 space-y-1 rounded-lg border border-border bg-black/20 p-2.5" aria-label="Static verification">
                  {lite.checks.map((c) => (
                    <li key={c.label} className="flex gap-2 leading-snug">
                      <span className={`shrink-0 font-bold ${c.ok ? "text-emerald-400" : "text-amber-400"}`} aria-hidden>{c.ok ? "✓" : "!"}</span>
                      <span><b className="text-foreground">{c.label}.</b> <span className="text-muted-foreground">{c.value}</span></span>
                    </li>
                  ))}
                </ul>
              )}
              {lite?.notes?.map((n) => <p key={n} className="mb-2 text-sky-300/90">ℹ {n}</p>)}
              {lite?.thumbs && lite.thumbs.length > 0 && (
                <div className="mb-3">
                  <p className="mb-1.5 font-semibold text-foreground">What Zeros saw</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {lite.thumbs.map((t, n) => (
                      <figure key={`${t.page}-${t.viewport}-${n}`} className="overflow-hidden rounded-lg border border-border bg-black/30">
                        <img src={t.dataUrl} alt={`Screenshot of ${t.page} on ${t.viewport}`} className="block h-auto w-full" loading="lazy" />
                        <figcaption className="px-2 py-1 text-[10px] text-muted-foreground">{t.page} · {t.viewport}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
              {(full?.issues ?? lite?.issues ?? []).length === 0 ? (
                <p className="text-emerald-300/90">No issues found. Every link resolves, every button reacts, nothing overflows 🎉</p>
              ) : (
                <ul className="space-y-1">
                  {(full?.issues ?? lite?.issues ?? []).slice(0, 10).map((i, n) => (
                    <li key={n} className={`rounded-lg border px-2 py-1 ${SEV_STYLE[i.severity] ?? SEV_STYLE["minor"]}`}>
                      <span className="mr-1 font-semibold uppercase">{i.severity}</span>
                      <span className="opacity-70">{i.page}</span> · {i.problem}
                    </li>
                  ))}
                </ul>
              )}
              {full && full.shots.length > 0 && (
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {full.shots.map((s, n) => (
                    <a key={n} href={s.dataUrl} target="_blank" rel="noreferrer" className="shrink-0">
                      <img src={s.dataUrl} alt={`${s.page} ${s.viewport} screenshot`} className="h-28 rounded-lg border border-border object-cover object-top" />
                      <div className="mt-0.5 text-center text-[10px] text-muted-foreground">{s.page} · {s.viewport}</div>
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {(shot || shotError) && tab === "preview" && (
        <div className="border-t border-border bg-card/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold">
            <span>{shot ? "Screenshot 📸" : "Screenshot failed"}</span>
            {shot && (
              <a href={shot} download={`${name}-${entry.replace(/[^a-z0-9]+/gi, "-")}.jpg`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 hover:bg-muted">
                <Download className="h-3.5 w-3.5" /> Save
              </a>
            )}
          </div>
          {shot ? <img src={shot} alt="Screenshot of the generated website" className="max-h-80 w-full rounded-xl border border-border object-contain" /> : <p className="text-xs text-amber-200">{shotError}</p>}
        </div>
      )}

      {issues.length > 0 && tab === "preview" && (
        <div className="border-t border-border bg-destructive/5 px-3 py-2 text-[11px] text-muted-foreground">
          <div className="font-semibold text-foreground">Live console</div>
          {issues.slice(-5).map((issue, index) => <div key={`${issue.kind}-${index}`} className="truncate">{issue.kind}: {issue.value}</div>)}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border bg-card/60 px-3 py-2">
        <span className="text-xs text-muted-foreground">{Object.keys(project.files).length} files · {pages.length} pages</span>
        <div className="flex gap-2">
          <button onClick={openFull} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted">
            <ExternalLink className="h-3.5 w-3.5" /> Open full
          </button>
          <button onClick={() => void downloadProjectZip(project, name)} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">
            <Download className="h-3.5 w-3.5" /> Download .zip
          </button>
        </div>
      </div>
    </div>
  );
}
