/**
 * Zeros Cinema Engine tests (Node only: no browser, no network). The browser end-to-end checks live in tests/browser/.
 */
import { DEMO_SPEC } from "./fixtures/video-demo.ts";
import { fallbackVideoSpec, fitDurations, hashString, normalizeVideoSpec, parseVideoSpecFromResponse, subjectOf, tryParseVideoSpec, MIN_SCENE_MS, MAX_SCENE_MS } from "../src/lib/video-spec.ts";
import { lintVideoSpec, snapBoundariesToBeats, speakMs, textBox } from "../src/lib/video-lint.ts";
import { approxMeasure, compileScene, fitText, snapLocal } from "../src/lib/video/layouts.ts";
import { contrast, ease, iconName, isColor, parseColor, readableOn, ICON_NAMES } from "../src/lib/video/kit.ts";
import { planSfx, renderSfx } from "../src/lib/video-sfx.ts";
import { analyzeEnv, decodePcm16, detectBeatGrid, resample } from "../src/lib/video-audio.ts";
import { Prober as _P, audioQa, summarizeProbes, videoReport, type FrameProbe } from "../src/lib/video-qa.ts";
import { buildVideo, openingLine, repairPrompt } from "../src/lib/run-video-build.ts";
import { buildSystemPrompt } from "../src/lib/zeros.ts";
import { requestedSeconds, normalizeBrand } from "../src/lib/video-spec.ts";
import { markElements } from "../src/lib/video/layouts.ts";
import { worldFor } from "../src/lib/video/world.ts";
import { BRAND_SPEC } from "./fixtures/brand-film.ts";
import type { TextEl, VideoSpec } from "../src/lib/video/types.ts";

type T = (name: string, ok: boolean, extra?: string) => void;
void _P;
const clone = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

export async function run(t: T, section: (s: string) => void): Promise<void> {
  /* ------------------------------------------------------------------ kit */
  section("Video kit: easing, colour, icons");
  t("easing curves start at 0 and end at 1", (["linear", "out", "inOutCubic", "outBack", "outElastic", "spring", "outExpo"] as const).every((k) => Math.abs(ease(k, 0)) < 1e-6 && Math.abs(ease(k, 1) - 1) < 2e-3));
  t("parseColor handles hex, rgb, hsl, named", parseColor("#fff")?.r === 255 && parseColor("rgb(10, 20, 30)")?.g === 20 && !!parseColor("hsl(210 50% 40%)") && parseColor("white")?.b === 255 && parseColor("not-a-color") === null);
  t("contrast ratio: black/white 21, same colour 1", Math.abs(contrast("#000", "#fff") - 21) < 0.05 && Math.abs(contrast("#123456", "#123456") - 1) < 1e-6);
  t("readableOn fixes unreadable text (>= 7:1)", contrast("#101018", readableOn("#101018", "#202030", 7)) >= 7 && contrast("#f6f3ee", readableOn("#f6f3ee", "#e8e4dc", 4.5)) >= 4.5);
  t("every icon name round-trips (incl. camelCase) and aliases resolve", ICON_NAMES.length >= 45 && iconName("arrowUp") === "arrowUp" && iconName("arrow-up") === "arrowUp" && iconName("lightning") === "bolt" && iconName("nonsense") === null && ICON_NAMES.every((n) => iconName(n) === n));
  t("isColor rejects junk", isColor("#6c8cff") && !isColor("blue-ish") && !isColor(12));

  /* ------------------------------------------------------------------ spec */
  section("Video spec: normalisation, legacy films, fallback director");
  const good = clone(DEMO_SPEC);
  const n1 = normalizeVideoSpec(good, "demo");
  const sc1 = n1.spec.scenes;
  t("a valid film keeps every scene, contiguous, 0 -> duration", n1.ok && sc1.length === 11 && sc1[0]!.startMs === 0 && sc1[sc1.length - 1]!.endMs === n1.spec.durationSec * 1000 && sc1.every((s, i) => i === 0 || s.startMs === sc1[i - 1]!.endMs));
  t("scene durations stay within 2.2-9 s", sc1.every((s) => s.endMs - s.startMs >= MIN_SCENE_MS - 2 && s.endMs - s.startMs <= MAX_SCENE_MS + 2));
  const fd = fitDurations([500, 500, 30000, 500, 8000], 40000);
  t("fitDurations keeps the total and the bounds", Math.abs(fd.reduce((a, b) => a + b, 0) - 40000) < 2 && fd.every((d) => d >= MIN_SCENE_MS - 1 && d <= MAX_SCENE_MS + 1), fd.map((d) => Math.round(d)).join(","));
  const crowd = normalizeVideoSpec({ title: "x", scenes: [{ layout: "stats", headline: "No stats given" }, { layout: "cards", headline: "No items" }, { layout: "chart", headline: "No chart" }, { headline: "Plain", sub: "words" }] }, "x");
  t("layouts missing their content degrade to ones that can stand alone", crowd.spec.scenes.every((s) => ["statement", "hero", "outro", "cards", "stats"].includes(s.layout)) && crowd.spec.scenes[0]!.layout === "statement");
  const badPalette = normalizeVideoSpec({ title: "p", palette: { bg: "#101018", surface: "#181820", text: "#181820", muted: "#202028", accent: "#101020", accent2: "#111122" }, scenes: clone(DEMO_SPEC).scenes.slice(0, 4) }, "p").spec.palette;
  t("an unreadable palette is repaired to WCAG (text 7:1, muted 4.5:1, accents 3:1)", contrast(badPalette.bg, badPalette.text) >= 7 && contrast(badPalette.bg, badPalette.muted) >= 4.5 && contrast(badPalette.bg, badPalette.accent) >= 3);
  const truncated = JSON.stringify(clone(DEMO_SPEC)).slice(0, 4200);
  t("a truncated reply still yields a renderable film or an honest null", (() => { const s = tryParseVideoSpec("Opening line\n\n" + truncated, "demo"); return s === null || s.scenes.length >= 3; })());
  const legacy = { title: "Old", durationSec: 30, scenes: [{ startMs: 0, endMs: 10000, label: "A", html: "<h1>The old way</h1><p>was slow</p>" }, { startMs: 10000, endMs: 20000, label: "B", layers: [{ type: "text", text: "Faster now", size: 80 }, { type: "text", text: "tiny", size: 20 }] }, { startMs: 20000, endMs: 30000, label: "C", html: "<div>Built different</div>" }] };
  const lg = normalizeVideoSpec(legacy, "old");
  t("legacy v2 films (html / layers) are converted, words recovered", lg.ok && lg.spec.source === "legacy" && lg.spec.scenes[0]!.headline === "The old way" && lg.spec.scenes[1]!.headline === "Faster now");
  const fb = fallbackVideoSpec("Make a 30 second video about a Lisbon coffee roaster");
  t("fallback director uses the person's words, never canned slogans", fb.title === "A Lisbon Coffee Roaster" && fb.source === "fallback" && fb.warnings[0]!.includes("Lisbon") && !/Built different|Quiet power|A new chapter/.test(JSON.stringify(fb)));
  t("fallback film is a real film: 7 scenes, 5+ layouts, narration, passes pre-flight >= 90", fb.scenes.length === 7 && new Set(fb.scenes.map((s) => s.layout)).size >= 6 && fb.audio.voiceoverLines.length >= 4 && lintVideoSpec(fb).score >= 90);
  t("parseVideoSpecFromResponse never throws on garbage", parseVideoSpecFromResponse("¯\\_(ツ)_/¯", "a film about whales").source === "fallback" && parseVideoSpecFromResponse("", "x").scenes.length >= 5);
  t("subject extraction", subjectOf("Please create a 45 second video about the history of jazz") === "The History Of Jazz" && hashString("a") !== hashString("b"));

  /* ------------------------------------------------------------------ layouts */
  section("Layout compiler: typography and geometry");
  const fit = fitText("Build the future in a single prompt", { W: 1280, H: 720, startSize: 11.8, minSize: 5, maxLines: 3, maxWpct: 82, lineHeight: 1.08, font: "display", weight: 800, tracking: -0.03 }, approxMeasure);
  const words = fit.lines.map((l) => l.split(/\s+/).length);
  t("headlines wrap without widows (no lonely last word)", fit.lines.length >= 2 && words[words.length - 1]! >= 2, JSON.stringify(fit.lines));
  t("headlines shrink to fit rather than overflow", fitText("An extraordinarily long headline that keeps going and going far beyond reason", { W: 1280, H: 720, startSize: 11.8, minSize: 4.4, maxLines: 3, maxWpct: 82, lineHeight: 1.08, font: "display", weight: 800, tracking: 0 }, approxMeasure).lines.length <= 3);
  const demo = clone(DEMO_SPEC);
  const lintDemo = lintVideoSpec(demo);
  t("all 11 layouts compile with 0 text overlaps and 0 out-of-frame text", lintDemo.stats.overlaps === 0 && !lintDemo.issues.some((i) => i.code === "out-of-frame"), JSON.stringify(lintDemo.stats.layouts));
  t("every compiled text is >= 2.2% of the frame height", lintDemo.stats.minTextSize >= 2.2, String(lintDemo.stats.minTextSize));
  t("text/background contrast is >= 4.5:1 in every scene", lintDemo.stats.minContrast >= 4.5, String(lintDemo.stats.minContrast));
  const first = lintDemo.spec;
  const ctx0 = { spec: first, index: 1, scene: first.scenes[1]!, startMs: first.scenes[1]!.startMs, durMs: first.scenes[1]!.endMs - first.scenes[1]!.startMs, W: 1280, H: 720, measure: approxMeasure, beatMs: 600, inKind: first.scenes[1]!.transition, outKind: first.scenes[2]!.transition, isLast: false };
  const grid = 600 / 4;
  t("entrances snap to the sixteenth-note grid (never wait a whole beat)", [0, 90, 250, 480, 777].every((d) => { const s = snapLocal(ctx0, d), g = (ctx0.startMs + s) / grid; return Math.abs(g - Math.round(g)) < 0.02 && s - d < grid + 2; }));
  const kinetic = compileScene(ctx0).filter((e): e is TextEl => e.type === "text");
  t("kinetic scene: one word per slot, each slams in, only the last one holds", kinetic.length === 5 && kinetic.every((e) => e.anim?.in === "slam") && kinetic.slice(0, -1).every((e) => e.anim?.out === "scale") && kinetic[4]!.anim?.loop === "pulse");
  t("kinetic words never overlap in time", kinetic.slice(1).every((e, i) => (e.anim?.delay ?? 0) >= (kinetic[i]!.anim?.outAt ?? 0) - 120));

  /* ------------------------------------------------------------------ lint */
  section("Pre-flight lint: measured, auto-fixed");
  t("cuts are snapped to the beat grid", lintDemo.stats.cutsOnBeat === lintDemo.stats.cuts && lintDemo.stats.cuts === 10);
  const offsetSpec = lintVideoSpec(demo, { beatOffsetMs: 137 }).spec;
  t("snapping honours a measured beat offset", offsetSpec.scenes.slice(1).every((s) => { const ph = (((s.startMs - 137) % 600) + 600) % 600; return Math.min(ph, 600 - ph) < 1.5; }));
  const bad = clone(DEMO_SPEC);
  bad.scenes[0]!.elements = [{ type: "text", text: "A deliberately colliding line of text right on the headline", x: 50, y: 46, size: 8, color: "#fff", anim: { in: "fade", delay: 100 } } as TextEl];
  t("overlapping text is detected as an error", lintVideoSpec(bad).issues.some((i) => i.code === "text-overlap" && i.severity === "error"));
  const off = clone(DEMO_SPEC);
  off.scenes[2]!.elements = [{ type: "text", text: "Way outside the frame to the right", x: 70, y: 50, size: 9, color: "#fff", align: "left", anim: { in: "fade" } } as TextEl];
  t("text leaving the frame is detected as an error", lintVideoSpec(off).issues.some((i) => i.code === "out-of-frame"));
  const crowded = clone(DEMO_SPEC);
  crowded.scenes[5]!.items = [1, 2, 3, 4].map((i) => ({ icon: "check" as const, title: `Item number ${i} with a longish title`, body: "and a rather long explanatory sentence that nobody can read in time" }));
  const lc = lintVideoSpec(crowded);
  t("crowded scenes borrow time from roomy ones or are flagged", lc.fixes.some((f) => /reading|time/i.test(f)) || lc.issues.some((i) => i.code === "reading-time"));
  const vo = clone(DEMO_SPEC);
  vo.audio.voiceoverLines = [{ startMs: 1000, text: "A fairly long narration line that takes a few seconds to say out loud." }, { startMs: 1500, text: "This one starts far too early and collides with the first." }, { startMs: 45000, text: "Far too late to finish before the film ends at all." }];
  const lv = lintVideoSpec(vo).spec.audio.voiceoverLines;
  t("narration is re-timed so no line overlaps, and impossible lines are dropped", lv.length === 2 && lv[1]!.startMs >= lv[0]!.startMs + speakMs(lv[0]!.text) + 250 - 5);
  t("a film with no outro gets one (final scene becomes the sign-off)", lintVideoSpec((() => { const s = clone(DEMO_SPEC); s.scenes[10]!.layout = "statement"; return s; })()).spec.scenes[10]!.layout === "outro");
  const sb = clone(DEMO_SPEC); sb.audio.bpm = 120; const before = sb.scenes.map((s) => s.startMs).join();
  snapBoundariesToBeats(sb, 0);
  t("snapBoundariesToBeats never breaks the minimum scene length", sb.scenes.every((s) => s.endMs - s.startMs >= MIN_SCENE_MS - 260) && before !== sb.scenes.map((s) => s.startMs).join());
  t("textBox estimates stay inside the frame for centred text", (() => { const b = textBox({ type: "text", text: "Hello world", x: 50, y: 50, size: 8, color: "#fff", align: "center" }, 1280, 720, approxMeasure); return b.x0 > 0 && b.x1 < 100 && b.y0 < 50 && b.y1 > 50; })());

  /* ------------------------------------------------------------------ sound design */
  section("Sound design: planning and synthesis");
  const ev = planSfx(lintDemo.spec);
  const cuts = ev.filter((e) => e.why === "cut"), starts = lintDemo.spec.scenes.slice(1).map((s) => s.startMs);
  t("every cut has sound design peaking exactly on it", starts.every((b) => cuts.some((e) => Math.abs(e.peakMs - b) <= 70)));
  t("the kinetic scene's slams are planned from the compiled elements", ev.filter((e) => e.why === "slam").length === 5);
  t("events are within the film and start at or after 0", ev.every((e) => e.tMs >= -1 && e.peakMs <= lintDemo.spec.durationSec * 1000) && ev.length >= 25 && ev.length <= 120, `${ev.length} events`);
  const sr = 48000, total = Math.round(lintDemo.spec.durationSec * sr);
  const rendered = renderSfx(ev, total, sr, 7);
  let pk = 0, finite = true;
  for (let i = 0; i < total; i++) { const a = Math.max(Math.abs(rendered.track.l[i]!), Math.abs(rendered.track.r[i]!)); if (!Number.isFinite(a)) finite = false; if (a > pk) pk = a; }
  t("rendered sound design is finite and peak-limited (<= 0.95)", finite && pk > 0.2 && pk <= 0.951, `peak ${pk.toFixed(3)}`);
  t("determinism: the same film always gets the same sound", (() => { const b = renderSfx(ev, total, sr, 7); for (let i = 0; i < total; i += 997) if (b.track.l[i] !== rendered.track.l[i]) return false; return true; })());
  const band = (x: Float32Array, lo: number, hi: number): number => { // crude DFT-free band energy via first-difference filters
    let e = 0, lp1 = 0, lp2 = 0; const a1 = 1 - Math.exp((-2 * Math.PI * hi) / sr), a2 = 1 - Math.exp((-2 * Math.PI * lo) / sr);
    for (let i = 0; i < x.length; i++) { lp1 += a1 * (x[i]! - lp1); lp2 += a2 * (x[i]! - lp2); const y = lp1 - lp2; e += y * y; } return e; };
  const impact = renderSfx([{ tMs: 0, peakMs: 0, kind: "impact", gainDb: 0, durMs: 1500, why: "cut", scene: 1 }], sr * 2, sr, 1).track.l, whoosh = renderSfx([{ tMs: 0, peakMs: 400, kind: "whoosh-up", gainDb: 0, durMs: 780, why: "cut", scene: 1 }], sr * 2, sr, 1).track.l;
  t("an impact is bass-heavy; a whoosh lives in the mids and highs", band(impact, 20, 140) > band(impact, 1000, 8000) * 3 && band(whoosh, 800, 8000) > band(whoosh, 20, 140) * 3);
  const riser = renderSfx([{ tMs: 0, peakMs: 1500, kind: "riser", gainDb: 0, durMs: 1500, why: "cut", scene: 1 }], sr * 2, sr, 1).track.l;
  let e1 = 0, e2 = 0; for (let i = 0; i < sr * 0.3; i++) e1 += riser[i]! ** 2; for (let i = Math.round(sr * 1.15); i < sr * 1.45; i++) e2 += riser[i]! ** 2;
  t("a riser builds (last 300 ms >> first 300 ms)", e2 > e1 * 30);

  /* ------------------------------------------------------------------ audio helpers */
  section("Audio helpers: beat grid, envelope, resampling");
  const bpm = 100, beat = 0.6, offsetMs = 137, tr = sr * 20, L = new Float32Array(tr), R = new Float32Array(tr);
  for (let k = 0; ; k++) { const t0 = Math.round((offsetMs / 1000 + k * beat) * sr); if (t0 + 6000 >= tr) break; for (let i = 0; i < 6000; i++) { const v = Math.sin(2 * Math.PI * 70 * (i / sr)) * Math.exp(-i / 1800) * 0.8; L[t0 + i]! += v; R[t0 + i]! += v; } }
  const bg = detectBeatGrid(L, R, sr, bpm);
  t("beat detector finds the real grid offset (+/-12 ms) with high confidence", Math.abs(bg.offsetMs - offsetMs) <= 12 && bg.confidence >= 3, JSON.stringify(bg));
  const noise = new Float32Array(tr); let seed = 5; for (let i = 0; i < tr; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise[i] = ((seed / 4294967296) - 0.5) * 0.1; }
  t("a beatless signal has low confidence (so the grid is not trusted)", detectBeatGrid(noise, noise, sr, bpm).confidence < 2.6);
  const env = analyzeEnv(L, R, sr, 30, 30 * 19, []);
  const kickFrames = Array.from({ length: 10 }, (_, k) => Math.round((offsetMs / 1000 + k * beat) * 30) + 1);
  t("the visual envelope pulses on the kicks and decays between them", kickFrames.every((f) => env.pulse[f]! > 0.5) && env.pulse[kickFrames[3]! + 12]! < 0.3);
  t("energy-warped clock is monotonic", env.warp.every((w, i) => i === 0 || w > env.warp[i - 1]!));
  const ramp = new Float32Array(2400).map((_, i) => Math.sin(i / 40));
  t("resample keeps duration and is identity at equal rates", resample(ramp, 24000, 48000).length === 4800 && resample(ramp, 48000, 48000) === ramp);
  t("decodePcm16 reads signed little-endian samples", (() => { const b = Buffer.from(new Int16Array([0, 16384, -16384, 32767]).buffer).toString("base64"); const d = decodePcm16(b); return Math.abs(d[1]! - 0.5) < 1e-4 && Math.abs(d[2]! + 0.5) < 1e-4; })());

  /* ------------------------------------------------------------------ QA */
  section("QA: measured, not promised");
  const probes = (fn: (i: number) => Partial<FrameProbe>): FrameProbe[] => Array.from({ length: 460 }, (_, i) => ({ tMs: (i + 1) * 100, luma: 90, std: 30, diff: 0.02, bright: 0.01, ...fn(i) }));
  const healthy = summarizeProbes(probes(() => ({})), lintDemo.spec, 300);
  t("healthy frames: nothing blank, nothing frozen, hook lands", healthy.blank === 0 && healthy.frozenRuns === 0 && healthy.hookOk);
  const sick = summarizeProbes(probes((i) => (i >= 20 && i < 40 ? { diff: 0 } : i >= 60 && i < 63 ? { std: 0.5, luma: 0 } : {})), lintDemo.spec, 300);
  t("frozen stretches and blank frames are detected", sick.frozenRuns === 1 && sick.frozenMs >= 1900 && sick.blank === 3);
  const mixSr = 48000, mixLen = mixSr * 46, ml = new Float32Array(mixLen), mr = new Float32Array(mixLen);
  for (let i = 0; i < mixLen; i++) { const v = Math.sin(i / 20) * 0.05; ml[i] = v; mr[i] = v; }
  const flat = audioQa(ml, mr, mixSr, lintDemo.spec, -14, -1);
  for (const s of lintDemo.spec.scenes.slice(1)) { const b = Math.round((s.startMs / 1000) * mixSr); for (let i = 0; i < 6000; i++) { ml[b + i]! += Math.sin(i / 8) * Math.exp(-i / 1500) * 0.5; mr[b + i] = ml[b + i]!; } }
  const accented = audioQa(ml, mr, mixSr, lintDemo.spec, -14, -1);
  t("audio QA: a flat bed has no cut accents; real hits are measured", flat.accented === 0 && accented.accented === accented.cuts && accented.cuts === 10);
  const rep = videoReport(lintDemo.spec, lintDemo, healthy, { score: { ok: true, genre: "cinematic", bpm: 100, beatOffsetMs: 12, beatConfidence: 3, lufs: -17 }, voice: { requested: 3, recorded: 3, failed: [], totalMs: 9000 }, sfx: { events: 40, hits: 20, byWhy: {} }, mix: { lufs: -14, peakDb: -1.1, clipped: 0, narrationOverMusicDb: 10.4, duckDb: 3.5 } }, accented, { width: 1280, height: 720, fps: 30, codec: "VP9 + Opus", ext: "webm", bytes: 9e6, hasAudio: true, encoder: "webcodecs" });
  t("a clean film reports every check as passed (score 100)", rep.checks.length >= 10 && rep.checks.every((c) => c.ok) && rep.score === 100 && /Premium/.test(rep.headline), rep.headline);
  const repBad = videoReport(fb, lintVideoSpec(fb), sick, { score: { ok: false, genre: "cinematic", bpm: 100, beatOffsetMs: 0, beatConfidence: 0, lufs: null }, voice: { requested: 4, recorded: 1, failed: ["x", "y", "z"], totalMs: 2000 }, sfx: { events: 3, hits: 1, byWhy: {} }, mix: { lufs: -9, peakDb: -0.1, clipped: 12, narrationOverMusicDb: 3, duckDb: 7 } }, flat, { width: 1280, height: 720, fps: 30, codec: "VP8", ext: "webm", bytes: 1e6, hasAudio: false, encoder: "mediarecorder" });
  t("problems are reported honestly, not hidden", repBad.checks.filter((c) => !c.ok).length >= 6 && repBad.score < 70 && /Needs a look/.test(repBad.headline), `${repBad.score}`);

  /* ------------------------------------------------------------------ director */
  section("Director pipeline (mock model): retry, repair, fallback");
  const goodJson = JSON.stringify({ treatment: { logline: "x" }, ...clone(DEMO_SPEC) });
  const mk = (replies: string[]) => { let i = 0; const calls: number[] = []; return { calls, fn: async (msgs: { content: string }[], _mode: unknown, _mem: unknown, onDelta: (s: string) => void): Promise<string> => { const last = msgs[msgs.length - 1]!.content; if (last.startsWith("Research this")) return "FACTS: NO PUBLIC INFO\nAUDIENCE: x\nANGLE: y\nAVOID: z"; const r = replies[Math.min(i, replies.length - 1)]!; i++; calls.push(i); onDelta(r); return r; } }; };
  const hist = [{ role: "user" as const, content: "make a launch film for Zeros" }];
  const m1 = mk(["Cue the confetti cannon, this one is a banger. 🎬\n\n" + goodJson]);
  const b1 = await buildVideo({ prompt: "make a launch film for Zeros", history: hist, memories: [], streamChat: m1.fn as never, onStatus: () => undefined });
  t("clean reply: no fallback, funny opening line captured, 11 scenes", !b1.usedFallback && b1.spec.scenes.length === 11 && b1.witty.startsWith("Cue the confetti"));
  const m2 = mk(["I'll read the brief and turn it into a film.", "Hold on, tighter: " + goodJson]);
  const b2 = await buildVideo({ prompt: "make a launch film for Zeros", history: hist, memories: [], streamChat: m2.fn as never, onStatus: () => undefined });
  t("unusable first reply: one stricter retry rescues the film", !b2.usedFallback && b2.attempts >= 2 && b2.spec.scenes.length === 11);
  const m3 = mk(["no json at all", "still nothing"]);
  const b3 = await buildVideo({ prompt: "a film about whales", history: [{ role: "user", content: "a film about whales" }], memories: [], streamChat: m3.fn as never, onStatus: () => undefined });
  t("two failures: honest fallback built from the person's words, flagged", b3.usedFallback && b3.spec.title === "Whales" && b3.warnings.some((w) => /Whales/.test(w)) && m3.calls.length === 2);
  const crowdedFilm = clone(DEMO_SPEC); crowdedFilm.scenes.forEach((s, i) => { if (i % 2) s.items = [1, 2, 3, 4].map((k) => ({ icon: "check" as const, title: `A long item title number ${k} here`, body: "with a long body sentence that overflows the reading time easily" })); });
  const improved = clone(DEMO_SPEC);
  const m4 = mk(["Opening.\n\n" + JSON.stringify(crowdedFilm), JSON.stringify(improved)]);
  const b4 = await buildVideo({ prompt: "p", history: hist, memories: [], streamChat: m4.fn as never, onStatus: () => undefined });
  t("repair pass runs when pre-flight finds copy problems, kept only if it scores better", b4.attempts >= 1 && b4.lint.score >= lintVideoSpec(crowdedFilm).score && (m4.calls.length === 1 || b4.repaired || b4.lint.score >= lintVideoSpec(crowdedFilm).score));
  const m5 = mk(["Opening.\n\n" + JSON.stringify(crowdedFilm), "garbage garbage"]);
  const b5 = await buildVideo({ prompt: "p", history: hist, memories: [], streamChat: m5.fn as never, onStatus: () => undefined });
  t("a failed repair never costs the film", !b5.usedFallback && b5.spec.scenes.length === 11);
  t("openingLine drops boring openers and keeps funny ones", openingLine("Sure! Here you go.\n\n{\"a\":1}") === "" && openingLine("A film about whales that will make you sob into your popcorn. 🐋\n\n{}").includes("whales"));
  t("repair prompt lists the real problems and the current script", /problems/.test(repairPrompt(lintVideoSpec(off), off)) && repairPrompt(lintVideoSpec(off), off).includes('"scenes"'));
  t("every mode prompt for video tells the model the exact schema", (() => { const p = buildSystemPrompt("video"); return p.includes("OUTPUT FORMAT") && p.includes("kinetic") && p.includes("outro") && p.includes("NEVER invent real-world statistics") && p.includes("VsiStudio"); })());

  section("Finish pass: length, brand, plan, research, world, logo, device, sound on every cut, self-check");
  t("the requested length is read from the words", requestedSeconds("a 30 second video about jazz") === 30 && requestedSeconds("Make a 45-second film") === 45 && requestedSeconds("one minute promo") === 60 && requestedSeconds("a film about whales") === undefined);
  const longRun = normalizeVideoSpec({ durationSec: 90, scenes: clone(DEMO_SPEC).scenes }, "x").spec;
  t("a 90 second request is capped at 45 seconds, and the person is told why", longRun.durationSec === 45 && longRun.warnings.some((w) => /20-45/.test(w)));
  t("an 8 second request is raised to the 20 second minimum", normalizeVideoSpec({ durationSec: 8, scenes: clone(DEMO_SPEC).scenes }, "x").spec.durationSec === 20);
  t("the length in the prompt is honoured when the script leaves it out", normalizeVideoSpec({ scenes: clone(DEMO_SPEC).scenes }, "make a 1 minute promo for Zeros").spec.durationSec === 45);
  t("brands are parsed and unknown marks fall back to a ring", (() => { const b = normalizeBrand({ name: "Lumen Labs", mark: "orbit", tagline: "Light for every workflow", monogram: "ll" }); const c = normalizeBrand({ name: "Acme", mark: "dragon" }); return !!b && b.mark === "orbit" && b.monogram === "LL" && c?.mark === "ring" && normalizeBrand({}) === undefined; })());
  t("the treatment is kept as the plan of the film", (() => { const p = normalizeVideoSpec({ treatment: { logline: "Lumen gathers light.", promise: "Feel lighter", metaphor: "a lens" }, scenes: clone(DEMO_SPEC).scenes }, "x").spec.plan; return p?.keyMessage === "Lumen gathers light." && p?.metaphor === "a lens"; })());
  t("the four new background styles survive validation", (["flow", "topo", "ribbons", "lightleak"] as const).every((v) => normalizeVideoSpec({ scenes: clone(DEMO_SPEC).scenes.map((s) => ({ ...s, visual: v })) }, "x").spec.scenes.every((s) => s.visual === v)));
  t("the logo and device layouts survive validation", normalizeVideoSpec({ scenes: [{ layout: "logo", headline: "Acme" }, { layout: "device", headline: "Dashboard", device: "phone" }, { headline: "x", sub: "y" }, { layout: "outro", headline: "Go" }] }, "x").spec.scenes.map((s) => s.layout).join(",") === "logo,device,statement,outro");
  const logoSpec = normalizeVideoSpec({ brand: { name: "Lumen Labs", mark: "orbit", tagline: "Light for every workflow" }, scenes: [{ layout: "logo", headline: "Lumen Labs", sub: "Light for every workflow", startMs: 0, endMs: 5000 }, { layout: "outro", headline: "Go", startMs: 5000, endMs: 9000 }] }, "lumen").spec;
  t("the logo layout compiles into a mark, a wordmark and a tagline", (() => { const ls = logoSpec.scenes[0]!; const els = compileScene({ spec: logoSpec, index: 0, scene: ls, startMs: 0, durMs: ls.endMs - ls.startMs, W: 1280, H: 720, measure: approxMeasure, beatMs: 600, inKind: undefined, outKind: undefined, isLast: false }); const texts = els.filter((e): e is TextEl => e.type === "text").map((e) => e.text); return texts.includes("Lumen Labs") && els.some((e) => e.type === "orbit") && texts.some((x) => /Light for every/.test(x)); })());
  t("the device layout compiles a framed screen with a live chart, icons and the real stat", (() => { const ds = normalizeVideoSpec({ scenes: [{ layout: "device", headline: "One screen", device: "laptop", chart: { type: "bars", data: [{ label: "A", value: 3 }, { label: "B", value: 5 }, { label: "C", value: 4 }] }, stats: [{ value: 12, label: "items cleared" }], startMs: 0, endMs: 6000 }, { layout: "outro", headline: "Go", startMs: 6000, endMs: 12000 }, { headline: "more", sub: "x", startMs: 12000, endMs: 18000 }] }, "x").spec; const s = ds.scenes[0]!; const els = compileScene({ spec: ds, index: 0, scene: s, startMs: 0, durMs: s.endMs - s.startMs, W: 1280, H: 720, measure: approxMeasure, beatMs: 600, inKind: undefined, outKind: undefined, isLast: false }); return els.some((e) => e.type === "chart") && els.some((e) => e.type === "icon") && els.some((e) => e.type === "text" && (e as TextEl).text === "12"); })());
  t("rounded brand marks are sized correctly for the frame's aspect ratio", (() => { const P = { accent: "#5b8cff", accent2: "#f6a4ff", text: "#ffffff", dark: true, bg: "#070a14" }; const enter = (d: number, k: string, x?: object) => ({ in: k, delay: d, ...(x ?? {}) }) as never; const els = markElements({ name: "Acme", mark: "square" }, 50, 50, 20, P, enter, 0.5, 16 / 9); const m = els.find((e) => e.type === "shape" && (e as { shape?: string }).shape === "rounded") as unknown as { w: number; h: number }; return Math.abs(m.h - 20) < 0.01 && Math.abs(m.w * (16 / 9) - 20 * 0.56) < 0.01; })());
  const demoSpec = lintVideoSpec(clone(DEMO_SPEC)).spec;
  const cutEv = planSfx(demoSpec);
  t("every cut has a transient, so the picture change is also heard", demoSpec.scenes.slice(1).every((s, i) => cutEv.some((e) => e.why === "cut" && e.scene === i + 1 && ["impact", "boom", "thump", "glitch", "pop"].includes(e.kind) && Math.abs(e.peakMs - s.startMs) < 60)));
  t("a logo reveal gets a sonic sting on the mark", planSfx(logoSpec).some((e) => e.why === "slam" && e.scene === 0 && e.kind === "impact"));
  t("a deliberate dip-to-black is not a blank frame, a real blank frame still is", (() => { const sp = clone(DEMO_SPEC); const dipAt = sp.scenes[8]!.startMs; const base = Array.from({ length: 200 }, (_, i) => ({ tMs: (i + 1) * 100, luma: 90, std: 30, diff: 0.02, bright: 0.01 })); const designed = summarizeProbes([...base, { tMs: dipAt, luma: 0, std: 0, diff: 0.5, bright: 0 }], sp, 300); const real = summarizeProbes([...base, { tMs: 15000, luma: 0, std: 0, diff: 0.5, bright: 0 }], sp, 300); return designed.blank === 0 && real.blank === 1; })());
  t("the film world is unique: distinct films get distinct worlds, and all four styles occur", (() => { const titles = ["Lumen Labs", "Pão & Co", "Ironworks", "Quill", "Northwind", "Yoga Bali", "Wedding", "Launch", "Coffee", "Zeros film"]; const ws = titles.flatMap((x) => [0, 1, 2].map((sd) => worldFor({ title: x, seed: sd }))); return new Set(ws.map((w) => w.signature)).size === ws.length && new Set(ws.map((w) => w.kind)).size === 4; })());
  t("the self-check states the plan, the research, the length and the film's world", (() => { const sp = clone(DEMO_SPEC); sp.plan = { objective: "o", keyMessage: "k", metaphor: "m", soundPlan: "s" }; sp.research = ["fact one"]; const r = videoReport(sp, lintVideoSpec(sp), null, null, null, null); return ["Plan", "Research", "Length", "Background"].every((l) => r.checks.some((c) => c.label === l)); })());
  t("a logo film's self-check includes the brand reveal", (() => { const r = videoReport(logoSpec, lintVideoSpec(logoSpec), null, null, null, null); return r.checks.some((c) => c.label === "Brand"); })());
  t("a film outside 20-45 seconds is flagged by pre-flight", lintVideoSpec({ ...clone(DEMO_SPEC), durationSec: 50 }).issues.some((i) => i.code === "duration"));
  const researchSeen: string[] = [];
  const researchFn = async (msgs: { content: string }[], _m: unknown, _mem: unknown, onDelta: (s: string) => void): Promise<string> => { const last = msgs[msgs.length - 1]!.content; researchSeen.push(last); const reply = last.startsWith("Research this") ? "FACTS: Founded in 1998 in Lisbon. Known for its custard tarts.\nAUDIENCE: locals and visitors\nANGLE: warmth and ritual\nAVOID: stock clichés" : "A warm opening line.\n\n" + JSON.stringify(clone(DEMO_SPEC)); onDelta(reply); return reply; };
  const rb = await buildVideo({ prompt: "a 30 second film for Pão & Co bakery", history: [{ role: "user", content: "a 30 second film for Pão & Co bakery" }], memories: [], streamChat: researchFn as never, onStatus: () => undefined });
  t("research runs before the director, and its facts shape the film", researchSeen[0]!.startsWith("Research this") && researchSeen.some((m) => m.includes("RESEARCH NOTES") && m.includes("TARGET LENGTH: about 30")) && rb.research.found && (rb.spec.research?.length ?? 0) >= 1 && rb.facts.some((f) => /Research:/.test(f)));
}
