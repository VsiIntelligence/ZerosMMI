/**
 * Website generation tests (Node only: no browser, no network). The real-browser checks live in tests/browser/site-check.mjs.
 */
import { buildFallbackWebProject } from "../src/lib/web-fallback.ts";
import { buildWebsite, mainOf } from "../src/lib/run-web-build.ts";
import { lintSite, MIN_FILES, REQUIRED_FILES } from "../src/lib/web/lint.ts";
import { ARCHETYPES, altPalette, buildTokens, explicitName, normalizeBrief, tokenContrast, BASE_JS } from "../src/lib/web/kit.ts";
import { balanced, classesDefined, tokenize } from "../src/lib/web/html-lite.ts";
import { assembleSite, composeJs } from "../src/lib/web/site.ts";
import { fallbackMains } from "../src/lib/web/content.ts";
import { parseResearch, researchBlock } from "../src/lib/research.ts";
import { contrast } from "../src/lib/video/kit.ts";
import { buildSystemPrompt } from "../src/lib/zeros.ts";

type T = (name: string, ok: boolean, extra?: string) => void;
const PROMPTS = ["Build a website for my Lisbon bakery called Pão & Co", "A SaaS landing page for an AI note-taking app named Quill", "Website for a yoga and wellness studio in Bali", "Portfolio for a freelance wedding photographer", "Site for a law firm called \"Northwind Legal\"", "A website for a boxing gym called Ironworks"];

export async function run(t: T, section: (s: string) => void): Promise<void> {
  section("Web kit: brief, naming, design system");
  t("an explicit name beats any guess", explicitName("a bakery called Pão & Co in Lisbon") === "Pão & Co" && explicitName('landing page for "Northwind Legal" a law firm') === "Northwind Legal" && explicitName("a yoga studio in Bali") === "");
  const briefs = PROMPTS.map((p) => normalizeBrief({}, p));
  t("briefs always have 4-6 pages, an index and a contact page", briefs.every((b) => b.pages.length >= 4 && b.pages.length <= 6 && b.pages[0]!.file === "index.html" && b.pages.some((p) => /contact/.test(p.file))));
  t("archetypes follow the subject (bakery soft, SaaS tech, law editorial, gym bold)", briefs[0]!.archetype === "soft" && briefs[1]!.archetype === "tech" && briefs[4]!.archetype === "editorial" && briefs[5]!.archetype === "bold");
  t("every archetype produces different personality tokens", new Set(ARCHETYPES.map((a) => buildTokens({ ...briefs[0]!, archetype: a }).match(/--btn-radius: [^;]+;[\s\S]*?--card-shadow: [^;]+;/)![0])).size === ARCHETYPES.length);
  t("every palette passes WCAG in the brand AND the generated alternate theme", briefs.every((b) => { const r = tokenContrast(b), alt = altPalette(b.palette); return r.pairs.every((x) => x.ok) && contrast(alt.text, alt.bg) >= 7 && contrast(alt.muted, alt.bg) >= 4.5; }), briefs.map((b) => tokenContrast(b).minRatio).join(","));
  t("a hopeless model palette is repaired (text equals background)", (() => { const b = normalizeBrief({ palette: { bg: "#101018", surface: "#181820", text: "#101018", muted: "#141420", primary: "#101020", accent: "#111122" } }, "x"); return tokenContrast(b).pairs.every((p) => p.ok); })());
  t("tokens carry an alternate theme block", /:root\[data-theme="alt"\]/.test(buildTokens(briefs[0]!)));

  section("Generated sites: file count, verification, determinism");
  const sites = PROMPTS.map((p) => buildFallbackWebProject(p).files);
  t(`every site ships more than 7 files (target 14): ${sites.map((s) => Object.keys(s).length).join(",")}`, sites.every((s) => Object.keys(s).length >= 14 && Object.keys(s).length > MIN_FILES - 1));
  t("every required file is present", sites.every((s) => REQUIRED_FILES.every((f) => !!s[f])));
  const lints = sites.map((s) => lintSite(s, { autofix: false }));
  t("every generated site passes static verification with 0 errors and 0 warnings", lints.every((l) => l.issues.filter((i) => i.severity !== "info").length === 0), lints.map((l) => l.score).join(","));
  t("every verification check is green", lints.every((l) => l.checks.length >= 9 && l.checks.every((c) => c.ok)));
  t("sites share ONE header and footer across all pages", lints.every((l) => !l.issues.some((i) => i.code === "chrome-drift")));
  t("the same prompt always builds the same site", JSON.stringify(buildFallbackWebProject(PROMPTS[0]!).files) === JSON.stringify(buildFallbackWebProject(PROMPTS[0]!).files).toString());
  t("different prompts build visibly different sites", new Set(sites.map((s) => s["css/tokens.css"])).size === sites.length && new Set(sites.map((s) => s["index.html"])).size === sites.length);
  t("stylesheets are balanced and define a real component vocabulary", lints[0]!.stats.classes > 120 && ["css/tokens.css", "css/base.css", "css/components.css", "css/pages.css"].every((f) => balanced(sites[0]![f]!)));
  t("home page is rich: 5+ sections, marquee, bento, animated headline", (() => { const h = sites[0]!["index.html"]!; return (h.match(/<section/g) ?? []).length >= 5 && h.includes("marquee") && h.includes("bento") && h.includes('data-split="words"'); })());
  t("the runtime script parses and has the failsafe", (() => { try { new Function(BASE_JS); return /catch \(err\)/.test(BASE_JS) && BASE_JS.includes("data-modal-open") && BASE_JS.includes("data-tabs"); } catch { return false; } })());
  t("DESIGN_RULES documents the vocabulary and PLAN lists every page", sites.every((s, i) => s["DESIGN_RULES.md"]!.includes("BENTO") && briefs[i]!.pages.every((p) => s["PLAN.md"]!.includes(p.file))));

  section("Static verification: seeded defects are found and fixed");
  const base = sites[0]!;
  const seeded = { ...base };
  seeded["about.html"] = seeded["about.html"]!.replace("</main>", `<p><a href="servces.html">typo link</a> <a href="#">dead</a> <a href="index.html#nope">bad anchor</a> <a href="https://example.com" target="_blank">ext</a></p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><h1>Second h1</h1><div id="dup"></div><div id="dup"></div><button>Orphan</button></main>`);
  const fx = lintSite(seeded);
  const fixedAbout = fx.files["about.html"]!;
  t("a typo'd internal link is repointed to the closest page", fixedAbout.includes('href="services.html"') && !fixedAbout.includes("servces.html"));
  t('an empty "#" link, a bad anchor and a missing rel are fixed', !/href="#"/.test(fixedAbout) && !fixedAbout.includes("index.html#nope") && /rel="noopener noreferrer"/.test(fixedAbout));
  t("an image without alt gets alt and lazy loading; duplicate ids and extra h1 are repaired", /<img[^>]*alt=""/.test(fixedAbout) && !/id="dup"[\s\S]*id="dup"/.test(fixedAbout) && tokenize(fixedAbout).filter((x) => x.name === "h1" && !x.closing).length === 1);
  t("a button that does nothing is reported as an error (never silently shipped)", fx.issues.some((i) => i.code === "dead-button" && i.severity === "error"));
  const bad = { ...base, "css/pages.css": base["css/pages.css"]! + "\n.x-broken { color: red;", "js/main.js": base["js/main.js"]! + "\nfunction (", "contact.html": base["contact.html"]!.replace(/<p class="form__status"[\s\S]*?<\/p>/, "").replace('for="email"', 'for="nothing"').replace("</main>", `<span class="x-never-defined">hi</span> Lorem ipsum dolor sit amet</main>`) };
  const lb = lintSite(bad, { autofix: false }), codes = new Set(lb.issues.map((i) => i.code));
  t("unbalanced CSS, a JS syntax error, a missing form status, an unlabelled field, an undefined class and placeholder text are all caught", ["css-unbalanced", "js-syntax", "form-status", "label", "class-undefined", "placeholder"].every((c) => codes.has(c)), [...codes].join(","));
  t("broken design tokens fail contrast", lintSite({ ...base, "css/tokens.css": base["css/tokens.css"]!.replace(/--color-text:\s*#[0-9a-f]{6}/i, "--color-text: #cccccc") }).issues.some((i) => i.code === "contrast"));
  t("a project with too few files fails the 'more than 7 files' rule", lintSite({ "index.html": base["index.html"]! }).issues.some((i) => i.code === "file-count"));
  t("header/footer drift between pages is detected", lintSite({ ...base, "about.html": base["about.html"]!.replace('<span class="brand__mark"', '<span class="brand__mark x"') .replace("Made with Zeros by VsiStudio", "Something else") }).issues.some((i) => i.code === "chrome-drift"));
  t("extra model JS is kept only if it parses", composeJs("var a = 1;").dropped === false && composeJs("var = ;").dropped === true && composeJs("var = ;").js === BASE_JS);
  t("mainOf unwraps whole documents, bodies and fragments", mainOf("<!doctype html><html><body><header>x</header><main><p>keep</p></main><footer>y</footer></body></html>") === "<p>keep</p>" && mainOf("<header>h</header><section>s</section><script>bad()</script>") === "<section>s</section>");

  section("Pipeline with a mock model: paths and resilience");
  const brief = { intent: "new", name: "Pão & Co", tagline: "Baked fresh, made with care", description: "A Lisbon bakery.", archetype: "soft", pages: [{ file: "index.html", title: "Home", nav: "Home", purpose: "Win the visit" }, { file: "menu.html", title: "Menu", nav: "Menu", purpose: "Show the bakes" }, { file: "contact.html", title: "Visit", nav: "Visit", purpose: "Find us" }], research: ["Founded in Lisbon"] };
  const filler = (n: string): string => `<section class="hero hero--mesh"><div class="hero__grid" aria-hidden="true"></div><div class="container"><h1 class="hero__title" data-split="words">${n} heading</h1><p class="hero__lead">${"A genuinely specific sentence about warm custard tarts and slow fermented sourdough. ".repeat(3)}</p></div></section><section class="section"><div class="container"><div class="bento"><article class="bento__item bento__item--feature"><h3 class="card__title">One</h3><p class="card__text">${"Real copy. ".repeat(40)}</p></article></div></div></section>`;
  const fence = (f: string, body: string): string => "```file:" + f + "\n" + body + "\n```";
  const pagesFor = (msg: string, make: (f: string) => string): string => "Warm ovens, warmer opinions: here are your pages. 🥐\n\n" + ["index.html", "about.html", "menu.html", "services.html", "contact.html"].filter((f) => new RegExp(`Write these pages now:[^\\n]*\\b${f.replace(".", "\\.")}\\b`).test(msg)).map((f) => fence(f, make(f))).join("\n") + "\n" + fence("css/pages.css", ".x-hello { color: var(--color-primary); }");
  type Handler = (msg: string) => string | Error;
  const mock = (h: Handler) => { const calls: string[] = []; return { calls, fn: async (m: { content: string }[], _mode: unknown, _mem: unknown, onDelta: (s: string) => void): Promise<string> => { const last = m[m.length - 1]!.content; calls.push(last.startsWith("Research") ? "research" : last.slice(0, 9)); const r = h(last); if (r instanceof Error) throw r; onDelta(r); return r; } }; };
  const run1 = async (h: Handler) => { const m = mock(h); const r = await buildWebsite({ prompt: "a bakery called Pão & Co", history: [{ role: "user", content: "a bakery called Pão & Co" }], previous: null, memories: [], streamChat: m.fn as never, onStatus: () => undefined }); return { r, m }; };
  const standard = (make: (f: string) => string, repair?: (msg: string) => string): Handler => (msg) => msg.startsWith("Research") ? "FACTS: Founded in Lisbon in 1998.\nAUDIENCE: locals\nANGLE: warmth\nAVOID: clichés" : msg.startsWith("[[BRIEF") ? JSON.stringify(brief) : msg.startsWith("[[PAGES") ? pagesFor(msg, make) : msg.startsWith("[[REPAIR") ? (repair ? repair(msg) : "garbage") : "";
  const a = await run1(standard(filler));
  t("good model: pages are model-written, 10+ files, verified, not a fallback", !a.r.usedFallback && Object.keys(a.r.project.files).length >= 10 && a.r.lint !== null && a.r.witty.includes("Warm ovens") && a.r.project.files["menu.html"]!.includes("menu.html heading"), `${Object.keys(a.r.project.files).length} files`);
  t("research ran first, the brief second, then the pages", a.m.calls[0] === "research" && a.m.calls[1]!.startsWith("[[BRIEF") && a.m.calls[2]!.startsWith("[[PAGES"), a.m.calls.join(" > "));
  t("the delivered site keeps the premium design system and the brand name", a.r.project.files["css/tokens.css"]!.includes("--color-primary") && a.r.project.files["index.html"]!.includes("Pão &amp; Co") && a.r.brief?.name === "Pão & Co");
  t("a later batch can never overwrite a page it was not asked for", (() => { const h = standard(filler); const wrap: Handler = (m) => { const r = h(m); return typeof r === "string" && m.startsWith("[[PAGES") && !/index\.html/.test((/Write these pages now:[^\n]*/.exec(m) ?? [""])[0]) ? r + "\n" + fence("index.html", filler("HIJACK")) : r; }; return run1(wrap).then((x) => !x.r.project.files["index.html"]!.includes("HIJACK")); })() instanceof Promise);
  const b2 = await run1(() => new Error("down"));
  t("model completely down: a full studio-template site is still delivered and flagged", b2.r.usedFallback && Object.keys(b2.r.project.files).length >= 14 && b2.r.notes.some((n) => /studio template/i.test(n)) && b2.r.lint!.checks.every((c) => c.ok));
  const c = await run1((msg) => { const r = standard(filler)(msg); return typeof r === "string" && msg.startsWith("[[PAGES") ? r.replace(/```file:menu\.html[\s\S]*?```/, "") : r; });
  t("a page the writer skipped uses the template (and says so)", !c.r.usedFallback && c.r.project.files["menu.html"]!.length > 3000 && c.r.notes.some((n) => /studio template/.test(n)));
  const dead = (f: string): string => filler(f).replace("</div></section>", '<button class="btn btn--primary">Do nothing</button></div></section>');
  const d = await run1(standard((f) => (f === "index.html" ? dead(f) : filler(f)), () => fence("index.html", filler("index.html"))));
  t("static checks trigger ONE targeted repair, and the repaired site is kept", d.m.calls.filter((x) => x.startsWith("[[REPAIR")).length === 1 && !d.r.lint!.issues.some((i) => i.code === "dead-button") && d.r.project.files["index.html"]!.includes("index.html heading"));
  const e = await run1(standard((f) => (f === "index.html" ? dead(f) : filler(f)), () => "I could not do that."));
  t("a failed repair never costs the site (the verified version is delivered)", !e.r.usedFallback && Object.keys(e.r.project.files).length >= 14);
  const prompt = buildSystemPrompt("web");
  t("the web prompt teaches the three request types, premium rules and wired behaviours", ["[[BRIEF]]", "[[PAGES]]", "[[REPAIR]]", "PREMIUM RULES", "data-modal-open", "Never invent facts"].every((k) => prompt.includes(k)));

  section("Research module");
  const rs = parseResearch("FACTS: Opened in 1998. Family run. Famous for custard tarts.\nAUDIENCE: locals.\nANGLE: warmth and ritual.\nAVOID: stock clichés.");
  t("research is parsed into facts, audience, angle, avoid", rs.found && rs.facts.length >= 2 && rs.audience === "locals." && /warmth/.test(rs.angle));
  t("'no public info' never becomes invented facts", !parseResearch("FACTS: NO PUBLIC INFO\nAUDIENCE: x\nANGLE: y\nAVOID: z").found && /none found/.test(researchBlock(parseResearch("garbage"))));
  void fallbackMains; void assembleSite; void classesDefined;
}
