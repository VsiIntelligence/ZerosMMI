/**
 * Zeros regression suite (no browser, no network, no API keys).
 *   npx tsx tests/run-all.mts
 * Covers: JSON repair, song parsing + lyric budget + LRC, voice guard (boring openers), the lyric dictionary,
 * the song planner on edge cases (4:00 cap, nothing silently dropped when it fits), and the Forge v2 3D pipeline
 * (watertight, manifold, pure-quad, PBR GLB structure).
 */
import vm from "node:vm";
import { run as runVideo } from "./video.mts";
import { run as runWeb } from "./web.mts";
import { extractJsonObject } from "../src/lib/json-repair.ts";
import { buildLrc, cleanLyricLine, countLines, lyricBudget, lyricIssues, parseSong, promptSpec } from "../src/lib/parse-song-response.ts";
import { displayText, isBoringLine, stripBoringOpener } from "../src/lib/voice-guard.ts";
import { fallbackCommentary } from "../src/lib/commentary.ts";
import { EXTRA_DICT } from "../src/lib/zeros-music/lyrics-dict.ts";
import { PHONEMES } from "../src/lib/zeros-music/vocal.ts";
import { buildPlan } from "../src/lib/zeros-music/composer.ts";
import { FORGE_WORKER_SOURCE } from "../src/lib/forge/worker-source.ts";
import { FORGE_EXAMPLE_CAR, FORGE_EXAMPLE_FOX, FORGE_EXAMPLE_SWORD, FORGE_EXAMPLE_QUEEN, extractForgeCode, parseForgePlan } from "../src/lib/forge/forge-prompt.ts";
import { meshToGlb, meshToObj, meshToPly, planMaterials } from "../src/lib/forge/forge-export.ts";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

/* ---------------------------------------------------------------- json repair */
section("JSON repair");
const full = { title: "T", lyrics: [{ section: "Verse 1", lines: ["a b c", "d e f", "g h i"] }, { section: "Chorus", lines: ["hook one", "hook two"] }], chords: [["Am", "F"], ["C", "G"]] };
const js = JSON.stringify(full);
t("valid json", JSON.stringify(extractJsonObject(js)) === js);
t("fenced with prose", JSON.stringify(extractJsonObject("Wow ✨\n```json\n" + js + "\n```\nbye")) === js);
let allCuts = true;
for (let cut = 40; cut < js.length - 2; cut += 5) if (!extractJsonObject(js.slice(0, cut))) { allCuts = false; break; }
t("every truncation point still parses", allCuts);
t("truncated mid-string keeps earlier sections", ((extractJsonObject(js.slice(0, js.indexOf("hook one") + 4)) as any)?.lyrics?.[0]?.lines?.length) === 3);
t("garbage is null", extractJsonObject("nothing here") === null);

/* ---------------------------------------------------------------- songs */
section("Song parsing, lyric budget, LRC");
const lines = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p} line ${i + 1} goes here`);
const longSpec = { title: "Neon Rain", bpm: 104, durationSec: 235, genre: "pop", key: "A minor", voice: "female", lyrics: [
  { section: "Verse 1", lines: lines(8, "v1") }, { section: "Pre-Chorus", lines: lines(3, "pre") }, { section: "Chorus", lines: lines(7, "ch") }, { section: "Verse 2", lines: lines(8, "v2") },
  { section: "Pre-Chorus", lines: lines(3, "pre") }, { section: "Chorus", lines: lines(7, "ch") }, { section: "Bridge", lines: lines(6, "br") }, { section: "Final Chorus", lines: lines(9, "fc") }, { section: "Outro", lines: lines(2, "out") } ],
  chords: [["Am", "F", "C", "G"]], arrangement: { seed: 1 } };
const parsed = parseSong("Hook line 🌧️\n```json\n" + JSON.stringify(longSpec) + "\n```", "a song about rain");
t("parses a fenced song", !parsed.fromFallback && parsed.spec.lyrics.length === 9 && parsed.spec.durationSec === 235);
t("truncated reply keeps real lyrics", !parseSong(("x\n```json\n" + JSON.stringify(longSpec)).slice(0, 2600), "x").fromFallback);
t("unusable reply is flagged as fallback", parseSong("sorry, no", "ocean at dawn").fromFallback && /ocean|dawn/i.test(promptSpec("ocean at dawn").title));
t("line budget at 104 bpm / 235 s is 47", lyricBudget(104, 235) === 47);
t("a full-length lyric has no major issue", lyricIssues(parsed.spec).every((i) => i.severity !== "major"));
t("a thin lyric is flagged for expansion", lyricIssues({ ...parsed.spec, lyrics: parsed.spec.lyrics.slice(0, 2) }).some((i) => i.severity === "major"));
t("lyric lines are cleaned", cleanLyricLine("[Chorus] **Hold on** (x2)") === "Hold on");
t("LRC has timestamps, header and gap clears", /\[ti:T\]/.test(buildLrc("T", [{ t: 9.2, dur: 4, text: "A" }, { t: 60, dur: 4, text: "B" }], 90)) && buildLrc("T", [{ t: 9.2, dur: 4, text: "A" }, { t: 60, dur: 4, text: "B" }], 90).includes("[00:13.20]"));

/* ---------------------------------------------------------------- voice */
section("Voice guard");
const body = "Photosynthesis is basically a plant running a tiny solar-powered kitchen. Here is the long version of how that kitchen works, with jokes for flavour.";
t("strips \"I'll read the brief and turn it into...\"", stripBoringOpener("I'll read the brief and turn it into a fully responsive website. " + body).startsWith("Photosynthesis"));
t("strips \"Sure! Here is...\" and stacked filler", stripBoringOpener("Sure! Here is a quick explanation. " + body).startsWith("Photosynthesis") && stripBoringOpener("Great question! Let me explain. " + body).startsWith("Photosynthesis"));
t("keeps real answers and witty hooks", stripBoringOpener("Here's the short answer: 42 is it. " + body).startsWith("Here's") && stripBoringOpener("Plot twist: plants cook. " + body).startsWith("Plot twist"));
t("streaming holds back half-written boring openers", displayText("I'll rea") === "" && displayText("Photosynthesis is").startsWith("Photo"));
t("a contentful sentence is not boring", !isBoringLine("The answer is 42 because of the derivative."));
t("fallback commentary is long and in voice", fallbackCommentary("music", "rain song", ["a fact", "another fact"], ["a caveat"]).length > 900);

/* ---------------------------------------------------------------- lyric dictionary */
section("Lyric dictionary");
let badWords = 0;
for (const [w, ph] of Object.entries(EXTRA_DICT)) { const syms = ph.split(/\s+/).map((x) => x.replace(/[0-9]/g, "")); if (syms.some((x) => !(x in PHONEMES))) { badWords++; console.log("  invalid phoneme in", w, ph); } }
t(`${Object.keys(EXTRA_DICT).length} dictionary entries use only valid phonemes`, badWords === 0);

/* ---------------------------------------------------------------- song planner */
section("Song planner (length, sections, edge cases)");
const planSec = (spec: any) => { const p = buildPlan(spec); return { p, secs: p.sections.reduce((a, s) => a + s.bars, 0) * p.bar }; };
const long = planSec(longSpec);
t("a 54-line, 235 s song keeps every section (incl. bridge + both pre-choruses)", long.p.sections.length >= 10 && long.p.sections.some((s) => s.kind === "bridge") && long.p.sections.filter((s) => s.kind === "pre").length === 2);
t("...and fits 4:00", long.secs <= 240 && long.secs >= 215, `${long.secs.toFixed(1)} s`);
const huge = planSec({ title: "M", bpm: 68, durationSec: 240, genre: "ballad", lyrics: [{ section: "Verse 1", lines: lines(12, "a") }, { section: "Pre-Chorus", lines: lines(6, "p") }, { section: "Chorus", lines: lines(10, "c") }, { section: "Verse 2", lines: lines(12, "b") }, { section: "Bridge", lines: lines(8, "d") }, { section: "Final Chorus", lines: lines(14, "f") }, { section: "Outro", lines: lines(4, "o") }] });
t("an oversized lyric is tightened and trimmed to the 4:00 cap", huge.secs <= 240.5, `${huge.secs.toFixed(1)} s`);
const instr = planSec({ title: "I", bpm: 78, durationSec: 90, genre: "lofi", instrumental: true, lyrics: [] });
t("instrumentals plan without lyrics", instr.p.sections.length >= 4 && instr.secs > 60);
const mono = planSec({ title: "H", bpm: 100, durationSec: 200, genre: "pop", lyrics: [{ section: "Chorus", lines: ["Hold me closer tonight", "Never let the light go out"] }] });
t("a one-chorus song is extended with real sections (break, build, double chorus)", mono.p.sections.length >= 6);
const tl = long.p.sections.flatMap((s) => s.lines.map((l) => (s.startBar + l.startBar) * long.p.bar));
t("lyric timeline is strictly increasing", tl.every((v, i) => i === 0 || v > tl[i - 1]!));

/* ---------------------------------------------------------------- forge */
section("Forge v2 (3D)");
function runForge(code: string, resolution: number, refine: number): any {
  let result: any = null;
  const sb: any = { Math, Float32Array, Float64Array, Uint8Array, Uint32Array, Int32Array, Map, Date, Error, Number, String, Object, Array, console, isNaN };
  sb.self = sb; sb.postMessage = (m: any) => { if (m.type === "done" || m.type === "error") result = m; };
  vm.createContext(sb); vm.runInContext(FORGE_WORKER_SOURCE, sb);
  sb.onmessage({ data: { code, resolution, id: 1, particles: 2000, budgetMs: 120000, refine } });
  return result;
}
t("forge plan + code extraction helpers", !!extractForgeCode("hi\n```js\n" + FORGE_EXAMPLE_SWORD + "\n```") && (parseForgePlan('{"subject":"x","parts":[],}') as any)?.subject === "x");
for (const [name, code, res] of [["sword", FORGE_EXAMPLE_SWORD, 80], ["queen", FORGE_EXAMPLE_QUEEN, 80], ["fox", FORGE_EXAMPLE_FOX, 90], ["car", FORGE_EXAMPLE_CAR, 100]] as const) {
  const r = runForge(code, res, 1);
  if (!r || r.type === "error") { t(`${name}: builds`, false, r?.message); continue; }
  const s = r.stats;
  t(`${name}: one watertight, manifold, pure-quad solid`, s.watertight && s.nonManifoldEdges === 0 && s.keptComponents === 1 && s.pureQuad, `${s.vertices} verts, ${s.regularPct}% regular, genus ${s.genus}, ${s.keptComponents} piece(s)`);
  t(`${name}: refined topology is mostly regular`, s.regularPct > 85 && s.refineLevels === 1);
  let unit = true; for (let i = 0; i < r.normals.length; i += 3 * 97) { const l = Math.hypot(r.normals[i], r.normals[i + 1], r.normals[i + 2]); if (l < 0.97 || l > 1.03) { unit = false; break; } }
  t(`${name}: normals are unit length`, unit);
  const mesh = { positions: r.positions, normals: r.normals, colors: r.colors, mats: r.mats, quads: r.quads, points: r.points, pointColors: r.pointColors, material: r.material, stats: s };
  const bins = planMaterials(mesh).bins;
  t(`${name}: PBR material regions detected`, bins.length >= 2, bins.map((b) => b.name).join(", "));
  const glb = new Uint8Array(await meshToGlb(mesh, name).arrayBuffer()), dv = new DataView(glb.buffer);
  const jsonLen = dv.getUint32(12, true), gj = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  t(`${name}: GLB header, length and JSON chunk are valid`, dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(8, true) === glb.length && gj.meshes[0].primitives.length === gj.materials.length && gj.accessors[0].count === s.vertices);
  t(`${name}: OBJ and PLY export`, (await meshToObj(mesh, name).text()).startsWith("#") && (await meshToPly(mesh, name).arrayBuffer()).byteLength > s.vertices * 27);
}
const bad = runForge("function sdf(x,y,z){ return 1; }", 80, 0);
t("an empty shape gives a helpful error, not a crash", bad?.type === "error" && /empty/i.test(bad.message));
const nan = runForge("function sdf(x,y,z){ return NaN; }", 80, 0);
t("a NaN field gives a helpful error", nan?.type === "error" && /finite/i.test(nan.message));

await runVideo(t, section);
await runWeb(t, section);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
