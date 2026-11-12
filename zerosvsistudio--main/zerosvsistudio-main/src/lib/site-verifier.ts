import { assembleWebProject, type WebProject } from "@/lib/web-project";
import { preflightWebProject } from "@/lib/web-project-qa";
import { authHeaders } from "@/lib/auth-token";

/* ------------------------------------------------------------------ types */

export type SiteIssue = {
  severity: "blocker" | "major" | "minor";
  source: "static" | "runtime" | "ai";
  page: string;
  problem: string;
  fix?: string;
};

export type VerifyReport = {
  page?: string;
  title?: string;
  ok?: boolean;
  missing?: string[];
  brokenLocalLinks?: string[];
  missingLocalAssets?: string[];
  nonFunctionalButtons?: string[];
  unnamedButtons?: number;
  imagesWithoutAlt?: number;
  horizontalOverflow?: boolean;
  overflowCulprits?: string[];
  clippedText?: string[];
  textLength?: number;
  sections?: number;
  tinyText?: number;
  headings?: string[];
  contrast?: { sampled: number; low: { el: string; ratio: number }[]; lowCount: number; borderline: number };
  errors?: { kind: string; value: string }[];
  docHeight?: number;
};

export type SmokeReport = { tested: number; dead: string[]; newErrors: string[] };
export type Shot = { page: string; viewport: "desktop" | "mobile"; dataUrl: string };

export type AiReview = {
  score: number;
  verdict: "pass" | "fix";
  summary: string;
  issues: { severity: "blocker" | "major" | "minor"; page?: string; problem: string; fix?: string }[];
  strengths?: string[];
};

export type SiteReport = {
  /** small previews of the screenshots Zeros took, kept with the chat message */
  thumbs?: Shot[];
  ok: boolean;
  checkedAt: string;
  ms: number;
  pagesChecked: number;
  issues: SiteIssue[];
  ai: AiReview | null;
  shots: Shot[];
  /** One line for the chat bubble. */
  headline: string;
};

/** What we persist with the chat message (no screenshots — those are big). */
export type SiteReportLite = {
  /** compact previews of what Zeros saw, so the user can check the site before the result */
  thumbs?: { page: string; viewport: "desktop" | "mobile"; dataUrl: string }[];
  ok: boolean;
  checkedAt: string;
  pagesChecked: number;
  headline: string;
  score?: number;
  issues: { severity: SiteIssue["severity"]; page: string; problem: string }[];
  /** the static verification ledger (files, design system, links, structure, accessibility, buttons, CSS, JS, content) */
  checks?: { label: string; value: string; ok: boolean }[];
  /** notes from the build (research, template fallbacks) */
  notes?: string[];
};

export function liteReport(r: SiteReport): SiteReportLite {
  return {
    ok: r.ok,
    checkedAt: r.checkedAt,
    pagesChecked: r.pagesChecked,
    headline: r.headline,
    ...(r.ai ? { score: r.ai.score } : {}),
    issues: r.issues.slice(0, 12).map((i) => ({ severity: i.severity, page: i.page, problem: i.problem.slice(0, 180) })),
    ...(r.thumbs?.length ? { thumbs: r.thumbs.slice(0, 3).map((t) => ({ page: t.page, viewport: t.viewport, dataUrl: t.dataUrl })) } : {}),
  };
}

/** Downscales a screenshot to a small JPEG preview (browser only). Returns "" when the browser cannot do it. */
export async function makeThumb(dataUrl: string, maxW: number, quality = 0.7): Promise<string> {
  try {
    if (typeof document === "undefined" || typeof Image === "undefined") return "";
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, maxW / Math.max(1, img.naturalWidth)), canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------- iframe sessions */

type Msg = { source?: string; type?: string; kind?: string; id?: string; [k: string]: unknown };

const SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A hidden, sandboxed (opaque-origin) iframe we drive with postMessage. It is kept ON-screen at ~0 opacity
 * because browsers throttle hidden / off-screen frames, which freezes transitions and IntersectionObservers.
 */
export class FrameSession {
  readonly frame: HTMLIFrameElement;
  private url = "";
  private seen: Msg[] = [];
  private waiters: { match: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private seq = 0;
  private readonly onMessage = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow) return;
    const m = e.data as Msg | null;
    if (!m || m.source !== "zeros-preview") return;
    this.seen.push(m);
    for (const w of this.waiters.slice()) {
      if (w.match(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };

  constructor(width: number, height: number) {
    this.frame = document.createElement("iframe");
    this.frame.setAttribute("sandbox", SANDBOX);
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.tabIndex = -1;
    this.frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;background:#fff;opacity:0.01;pointer-events:none;z-index:-1`;
    window.addEventListener("message", this.onMessage);
    document.body.appendChild(this.frame);
  }

  private wait(match: (m: Msg) => boolean, timeoutMs: number): Promise<Msg | null> {
    const hit = this.seen.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const waiter = { match, resolve: (m: Msg) => resolve(m) };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  async load(html: string, timeoutMs = 15000): Promise<boolean> {
    if (this.url) URL.revokeObjectURL(this.url);
    this.seen = [];
    this.url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    this.frame.src = this.url;
    const loaded = await this.wait((m) => m.type === "runtime" && m.kind === "loaded", timeoutMs);
    return !!loaded;
  }

  /** Runtime messages (errors, console, asset failures) received so far. */
  runtimeLog(): { kind: string; value: string }[] {
    return this.seen
      .filter((m) => m.type === "runtime" && (m.kind === "error" || m.kind === "console" || m.kind === "asset"))
      .map((m) => ({ kind: String(m.kind), value: String(m["value"] ?? "") }));
  }

  async request<T>(type: "verify" | "smoke" | "screenshot", opts: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T | null> {
    const id = `${type}-${++this.seq}`;
    const expect = type === "verify" ? "verification" : type;
    this.frame.contentWindow?.postMessage({ source: "zeros-preview-host", type, id, opts }, "*");
    const reply = await this.wait((m) => m.type === expect && m.id === id, timeoutMs);
    return (reply as unknown as T) ?? null;
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    if (this.url) URL.revokeObjectURL(this.url);
    this.frame.remove();
  }
}

/* --------------------------------------------------------- issue mapping */

function mapReport(page: string, viewport: "desktop" | "mobile", r: VerifyReport, smoke: SmokeReport | null): SiteIssue[] {
  const out: SiteIssue[] = [];
  const tag = viewport === "mobile" ? " (mobile 390px)" : "";
  const add = (severity: SiteIssue["severity"], problem: string, fix?: string) =>
    out.push({ severity, source: "runtime", page, problem: problem + tag, ...(fix ? { fix } : {}) });

  for (const e of r.errors ?? []) {
    if (e.kind === "console" && /favicon|Failed to load resource/i.test(e.value)) continue;
    add(e.kind === "console" ? "major" : "blocker", `${e.kind === "asset" ? "Asset failed" : "JavaScript error"}: ${e.value}`, "Fix the cause in the script or the referenced file/path.");
  }
  for (const l of r.brokenLocalLinks ?? []) add("blocker", `Broken link: ${l}`, "Point it to a page/anchor that exists in the project (or create that page).");
  for (const a of r.missingLocalAssets ?? [])
    if (!(r.errors ?? []).some((e) => e.value.includes(a.slice(0, 40)))) add("blocker", `Missing image/asset: ${a}`, "Use an inline SVG, a CSS gradient, or an inline data URI instead of a file that does not exist.");
  if (r.horizontalOverflow)
    add("blocker", `Page scrolls sideways${r.overflowCulprits?.length ? ` - ${r.overflowCulprits.join("; ")}` : ""}`, "Constrain the widest element (max-width:100%, overflow-x:clip, or fix the fixed pixel width) and check flex/grid children with min-width:0.");
  if ((r.textLength ?? 999) < 120) add("blocker", "Page has almost no visible text (looks empty)", "Add real headline, body copy and sections.");

  const deadConfirmed = (r.nonFunctionalButtons ?? []).filter((b) => !smoke || smoke.dead.includes(b));
  for (const b of deadConfirmed.slice(0, 6)) add("major", `Button does nothing when clicked: ${b}`, "Attach a click handler (or make it a real link/submit button).");
  for (const err of smoke?.newErrors ?? []) add("blocker", `Error while clicking around: ${err}`, "Fix the failing handler.");

  const low = r.contrast?.lowCount ?? 0;
  if (low >= 1)
    add(low >= 4 ? "major" : "minor", `Low text contrast on ${low} element(s): ${(r.contrast?.low ?? []).slice(0, 3).map((c) => `${c.el} (${c.ratio}:1)`).join("; ")}`, "Raise contrast to at least 4.5:1 for body text (3:1 for large text).");
  if ((r.clippedText ?? []).length) add("minor", `Text is clipped: ${(r.clippedText ?? []).join("; ")}`, "Allow wrapping or increase the container size.");
  if ((r.tinyText ?? 0) > 3) add("minor", `${r.tinyText} text elements are smaller than 12px`, "Use at least 14px for body text.");
  if ((r.imagesWithoutAlt ?? 0) > 0) add("minor", `${r.imagesWithoutAlt} image(s) without alt text`, 'Add alt="" for decoration or a real description.');
  if ((r.unnamedButtons ?? 0) > 0) add("minor", `${r.unnamedButtons} button/link(s) have no accessible name`, "Add visible text or aria-label.");
  for (const m of r.missing ?? []) {
    const isMobile = m === "viewport meta";
    add(isMobile ? "major" : "minor", `Missing ${m}`, isMobile ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : undefined);
  }
  return out;
}

/* --------------------------------------------------------------- main run */

export type CheckOptions = {
  brief?: string;
  screenshots?: boolean;
  ai?: boolean;
  maxPages?: number;
  onStatus?: (s: string) => void;
  signal?: AbortSignal;
};

async function askAi(brief: string, issues: SiteIssue[], shots: Shot[], project: WebProject): Promise<AiReview | null> {
  if (!shots.length) return null;
  try {
    const res = await fetch("/api/verify-site", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        brief: brief.slice(0, 1500),
        files: Object.entries(project.files).map(([p, c]) => `${p} (${c.length} chars)`).slice(0, 30),
        automated: issues.slice(0, 20).map((i) => `${i.severity.toUpperCase()} ${i.page}: ${i.problem}`),
        screenshots: shots.slice(0, 4),
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<AiReview> | null;
    if (!j || typeof j.score !== "number") return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(j.score))),
      verdict: j.verdict === "pass" ? "pass" : "fix",
      summary: String(j.summary ?? "").slice(0, 400),
      issues: (Array.isArray(j.issues) ? j.issues : []).slice(0, 10).map((i) => ({
        severity: i.severity === "blocker" || i.severity === "major" ? i.severity : "minor",
        ...(i.page ? { page: String(i.page) } : {}),
        problem: String(i.problem ?? "").slice(0, 300),
        ...(i.fix ? { fix: String(i.fix).slice(0, 300) } : {}),
      })),
      ...(Array.isArray(j.strengths) ? { strengths: j.strengths.map(String).slice(0, 4) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Zeros' real verification pass:
 *   1. static preflight   2. each page is loaded in a hidden browser frame and inspected
 *   3. buttons are clicked (smoke)   4. screenshots are taken   5. a vision model reviews the screenshots.
 * Never throws - a failed step becomes an issue or is skipped.
 */
export async function runSiteChecks(project: WebProject, opts: CheckOptions = {}): Promise<SiteReport> {
  const started = performance.now();
  const status = opts.onStatus ?? (() => {});
  const issues: SiteIssue[] = [];
  const shots: Shot[] = [];
  const pages = Object.keys(project.files).filter((f) => /\.html?$/i.test(f));
  const toCheck = pages.slice(0, opts.maxPages ?? 6);
  const wantShots = opts.screenshots !== false;

  status("Static checks…");
  const pre = preflightWebProject(project);
  pre.errors.forEach((e) => issues.push({ severity: "blocker", source: "static", page: "project", problem: e }));
  pre.warnings.forEach((w) => issues.push({ severity: "minor", source: "static", page: "project", problem: w }));

  let checked = 0;
  for (let i = 0; i < toCheck.length; i++) {
    if (opts.signal?.aborted) break;
    const page = toCheck[i]!;
    status(`Opening ${page} in a real browser frame… (${i + 1}/${toCheck.length})`);
    const session = new FrameSession(1280, 800);
    try {
      const html = assembleWebProject(project, page, { mode: "verify" });
      const loaded = await session.load(html);
      if (!loaded) {
        issues.push({ source: "runtime", severity: "blocker", page, problem: "Page never finished loading (a script may be stuck in a loop or crashed early)." });
        continue;
      }
      await sleep(700);
      const report = await session.request<VerifyReport>("verify");
      status(`Clicking buttons on ${page}…`);
      const smoke = await session.request<SmokeReport>("smoke", {}, 20000);
      if (report) {
        const log = session.runtimeLog();
        const merged: VerifyReport = {
          ...report,
          errors: [...(report.errors ?? []), ...log.filter((l) => !(report.errors ?? []).some((e) => e.value === l.value))].slice(0, 12),
        };
        issues.push(...mapReport(page, "desktop", merged, smoke));
        checked++;
      } else {
        issues.push({ source: "runtime", severity: "major", page, problem: "The page did not answer the verification request." });
      }
      if (wantShots && (i < 3 || page === "index.html")) {
        status(`Taking a screenshot of ${page}…`);
        const shot = await session.request<{ dataUrl?: string }>("screenshot", { slices: 3, maxWidth: 1000, quality: 0.72 }, 30000);
        if (shot?.dataUrl) shots.push({ page, viewport: "desktop", dataUrl: shot.dataUrl });
      }
    } finally {
      session.dispose();
    }
  }

  // Mobile pass on the home page: overflow and cramped layouts show up here first.
  const home = toCheck.includes("index.html") ? "index.html" : toCheck[0];
  if (home && !opts.signal?.aborted) {
    status("Checking the phone layout…");
    const session = new FrameSession(390, 844);
    try {
      if (await session.load(assembleWebProject(project, home, { mode: "verify" }))) {
        await sleep(600);
        const report = await session.request<VerifyReport>("verify");
        if (report) {
          const mobileIssues = mapReport(home, "mobile", report, null).filter((i) => /scrolls sideways|clipped|smaller than 12px/.test(i.problem));
          issues.push(...mobileIssues);
        }
        if (wantShots) {
          const shot = await session.request<{ dataUrl?: string }>("screenshot", { slices: 2, maxWidth: 390, quality: 0.72 }, 30000);
          if (shot?.dataUrl) shots.push({ page: home, viewport: "mobile", dataUrl: shot.dataUrl });
        }
      }
    } finally {
      session.dispose();
    }
  }

  // De-duplicate (same problem on several pages keeps the first)
  const seen = new Set<string>();
  const unique = issues.filter((i) => {
    const key = `${i.source}|${i.severity}|${i.problem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let ai: AiReview | null = null;
  if (opts.ai !== false && shots.length) {
    status("Zeros is looking at the screenshots…");
    ai = await askAi(opts.brief ?? "", unique, shots, project);
    if (ai) {
      for (const i of ai.issues) {
        if (i.severity === "minor") continue;
        unique.push({ source: "ai", severity: i.severity, page: i.page ?? "site", problem: i.problem, ...(i.fix ? { fix: i.fix } : {}) });
      }
    }
  }

  /* small previews of what Zeros saw: the desktop home page and the phone layout */
  const thumbs: Shot[] = [];
  for (const sh of shots.slice(0, 3)) {
    const dataUrl = await makeThumb(sh.dataUrl, sh.viewport === "mobile" ? 260 : 560, 0.72);
    if (dataUrl) thumbs.push({ page: sh.page, viewport: sh.viewport, dataUrl });
  }

  const blockers = unique.filter((i) => i.severity === "blocker").length;
  const majors = unique.filter((i) => i.severity === "major").length;
  const ok = blockers === 0 && (!ai || ai.verdict === "pass" || ai.score >= 72);
  const headline = ok
    ? `Verified by Zeros - ${checked} page${checked === 1 ? "" : "s"} opened in a real browser frame, buttons clicked, screenshots reviewed${ai ? ` (design score ${ai.score}/100)` : ""}.`
    : `Zeros found ${blockers} blocking and ${majors} major issue${blockers + majors === 1 ? "" : "s"}.`;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    ms: Math.round(performance.now() - started),
    pagesChecked: checked,
    issues: unique,
    ai,
    shots,
    thumbs,
    headline,
  };
}

/** Issues worth sending back to the model for a repair round, most severe first. */
export function issuesForRepair(report: SiteReport, limit = 14): SiteIssue[] {
  const rank = { blocker: 0, major: 1, minor: 2 } as const;
  return [...report.issues]
    .filter((i) => i.severity !== "minor" || i.source === "ai")
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, limit);
}
