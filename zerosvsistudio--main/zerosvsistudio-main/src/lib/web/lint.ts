/**
 * Static verification for generated websites: runs in Node, on the server and in the browser (no DOM needed).
 * Mechanical problems are FIXED and reported; the rest is returned for the model to repair, then a real-browser pass follows.
 */
import { balanced, classesDefined, classesUsed, headings, idsOf, innerOf, textOf, tokenize, varsDefined, varsUsed, type Tag } from "./html-lite";
import { contrast } from "../video/kit";

export type SiteIssue = { severity: "error" | "warn" | "info"; code: string; file: string; message: string; fixed?: boolean };
export type SiteCheck = { label: string; value: string; ok: boolean };
export type SiteStats = { files: number; pages: number; css: number; js: number; docs: number; links: number; linksOk: number; anchors: number; anchorsOk: number; images: number; imagesAlt: number; fields: number; fieldsLabelled: number; classes: number; unstyled: number; tokens: number; minContrast: number; words: number; sections: number; buttons: number; forms: number };
export type SiteLint = { files: Record<string, string>; issues: SiteIssue[]; fixes: string[]; stats: SiteStats; checks: SiteCheck[]; score: number };

export const MIN_FILES = 8; // "more than 7 files"
export const REQUIRED_FILES = ["index.html", "404.html", "css/tokens.css", "css/base.css", "css/components.css", "css/pages.css", "js/main.js", "PLAN.md", "DESIGN_RULES.md", "README.md", "favicon.svg"];
const REQUIRED_TOKENS = ["--color-bg", "--color-surface", "--color-text", "--color-muted", "--color-primary", "--color-on-primary", "--color-accent", "--font-display", "--font-body", "--space-4", "--radius-md", "--shadow-md", "--text-base", "--text-3xl"];
const STATE_CLASSES = /^(js|no-js|is-[\w-]+|has-[\w-]+|reveal-delay-\d)$/;
const PLACEHOLDER = /lorem ipsum|dolor sit amet|your (text|content|title|heading|company|name) here|insert (text|content|image)|placeholder text|\bTODO\b|\bTBD\b|coming soon\.{0,3}$|click here to edit/i;

const isHtml = (f: string): boolean => /\.html?$/i.test(f);
const dirOf = (f: string): string => (f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "");
function resolvePath(from: string, href: string): string {
  const parts = (href.startsWith("/") ? href.slice(1) : dirOf(from) + href).split("/"), out: string[] = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return out.join("/");
}
function lev(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) m[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i]![j] = Math.min(m[i - 1]![j]! + 1, m[i]![j - 1]! + 1, m[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length]![b.length]!;
}
function closestPage(target: string, pages: string[]): string {
  const base = target.replace(/\.html?$/i, "").split("/").pop() ?? "";
  let best = "index.html", score = 0.55;
  for (const p of pages) { const pb = p.replace(/\.html?$/i, ""), s = 1 - lev(base, pb) / Math.max(base.length, pb.length, 1); if (s > score) { score = s; best = p; } }
  return best;
}

/** Applies tag-level edits from the end of the string so offsets stay valid. */
function editTags(html: string, tags: Tag[], fn: (t: Tag, raw: string, i: number) => string | undefined): string {
  let out = html;
  for (let i = tags.length - 1; i >= 0; i--) { const t = tags[i]!, raw = html.slice(t.start, t.end), r = fn(t, raw, i); if (r !== undefined && r !== raw) out = out.slice(0, t.start) + r + out.slice(t.end); }
  return out;
}
const addAttr = (raw: string, attr: string): string => raw.replace(/\s*\/?>$/, (end) => ` ${attr}${end.trim() === "/>" ? " />" : ">"}`);
const setAttr = (raw: string, name: string, value: string): string => (new RegExp(`\\s${name}\\s*=`, "i").test(raw) ? raw.replace(new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, "i"), `$1"${value}"`) : addAttr(raw, `${name}="${value}"`));

export function lintSite(input: Record<string, string>, opts: { autofix?: boolean } = {}): SiteLint {
  const fix = opts.autofix !== false, files: Record<string, string> = { ...input }, issues: SiteIssue[] = [], fixes: string[] = [];
  const add = (severity: SiteIssue["severity"], code: string, file: string, message: string, fixed = false): void => { issues.push({ severity, code, file, message, ...(fixed ? { fixed } : {}) }); if (fixed) fixes.push(`${file}: ${message}`); };
  const names = Object.keys(files), pages = names.filter(isHtml), cssFiles = names.filter((f) => /\.css$/i.test(f)), jsFiles = names.filter((f) => /\.js$/i.test(f));
  const st: SiteStats = { files: names.length, pages: pages.length, css: cssFiles.length, js: jsFiles.length, docs: names.filter((f) => /\.md$/i.test(f)).length, links: 0, linksOk: 0, anchors: 0, anchorsOk: 0, images: 0, imagesAlt: 0, fields: 0, fieldsLabelled: 0, classes: 0, unstyled: 0, tokens: 0, minContrast: 99, words: 0, sections: 0, buttons: 0, forms: 0 };

  /* ---- project shape ---- */
  for (const f of REQUIRED_FILES) if (!files[f]) add(f === "README.md" || f === "favicon.svg" ? "warn" : "error", "missing-file", f, `Required file ${f} is missing.`);
  if (names.length < MIN_FILES) add("error", "file-count", "project", `Only ${names.length} files; a real website ships more than 7 (pages, design system, scripts, docs).`);
  if (!pages.some((p) => /^index\.html$/i.test(p))) add("error", "no-index", "project", "There is no index.html.");

  /* ---- CSS ---- */
  const allCss = cssFiles.map((f) => files[f]!).join("\n"), defined = classesDefined(allCss), varDef = varsDefined(allCss);
  for (const f of cssFiles) {
    const css = files[f]!;
    if (!balanced(css)) add("error", "css-unbalanced", f, "Unbalanced braces or parentheses: the stylesheet is broken or cut off.");
    if (/@import\s+(url\()?["']?https?:/i.test(css)) add("warn", "css-remote-import", f, "Remote @import slows rendering and breaks offline use; use the system font stacks in the tokens.");
    if ((css.match(/!important/g) ?? []).length > 8 && f !== "css/base.css") add("warn", "css-important", f, "Many !important declarations: fix specificity instead.");
  }
  const undefinedVars = [...varsUsed(allCss)].filter((v) => !varDef.has(v) && !new RegExp(`var\\(\\s*${v}\\s*,`).test(allCss));
  for (const v of undefinedVars) add("error", "css-undefined-var", "css", `CSS uses ${v} but no stylesheet defines it.`);
  const tokens = files["css/tokens.css"] ?? "";
  st.tokens = varsDefined(tokens).size;
  const missingTokens = REQUIRED_TOKENS.filter((t) => !varsDefined(tokens).has(t));
  if (tokens && missingTokens.length) add("error", "tokens-missing", "css/tokens.css", `Design tokens missing: ${missingTokens.join(", ")}.`);
  const tv = (n: string): string => new RegExp(`${n}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(tokens)?.[1] ?? "";
  const ratios: number[] = [];
  for (const [fg, bg, min, label] of [["--color-text", "--color-bg", 7, "text on background"], ["--color-muted", "--color-bg", 4.5, "muted text on background"], ["--color-muted", "--color-surface", 4.5, "muted text on surface"], ["--color-on-primary", "--color-primary", 4.5, "button text on primary"]] as const) {
    const a = tv(fg), b = tv(bg);
    if (a && b) { const r = contrast(a, b); ratios.push(r); if (r < min) add("error", "contrast", "css/tokens.css", `${label} contrast is ${r.toFixed(1)}:1; WCAG needs ${min}:1.`); }
  }
  st.minContrast = ratios.length ? Math.round(Math.min(...ratios) * 10) / 10 : 0;

  /* ---- JavaScript ---- */
  for (const f of jsFiles) {
    const js = files[f]!;
    try { new Function(js); } catch (e) { add("error", "js-syntax", f, `JavaScript syntax error: ${(e as Error).message}.`); }
    if (/\beval\s*\(|document\.write\s*\(|new Function\s*\(/.test(js)) add("warn", "js-unsafe", f, "Uses eval / document.write / new Function.");
    if (/\balert\s*\(/.test(js)) add("warn", "js-alert", f, "alert() is a poor user experience; use an inline message.");
  }

  /* ---- pages ---- */
  const pageSet = new Set(pages), pageIds: Record<string, Set<string>> = {}, chrome: Record<string, string> = {}, titles: Record<string, string> = {}, descs: Record<string, string> = {};
  const usedClassCount: Record<string, number> = {};
  for (const f of pages) pageIds[f] = new Set(idsOf(files[f]!));
  for (const f of pages) {
    let html = files[f]!;
    const tags = tokenize(html), open = tags.filter((t) => !t.closing), lower = html.toLowerCase();
    if (!/^\s*<!doctype html/i.test(html)) add("error", "doctype", f, "Missing <!doctype html>.");
    const htmlTag = open.find((t) => t.name === "html");
    if (!htmlTag?.attrs["lang"]) add("error", "lang", f, 'The <html> element needs lang="en".');
    if (!open.some((t) => t.name === "meta" && t.attrs["name"] === "viewport")) add("error", "viewport", f, "Missing the responsive viewport meta tag.");
    const title = textOf(innerOf(html, "title")[0]?.inner ?? ""); titles[f] = title;
    if (!title) add("error", "title", f, "Missing <title>."); else if (title.length > 72) add("warn", "title-long", f, `Title is ${title.length} characters (keep it under 70).`);
    const desc = open.find((t) => t.name === "meta" && t.attrs["name"] === "description")?.attrs["content"] ?? ""; descs[f] = desc;
    if (!desc) add("error", "description", f, "Missing meta description."); else if (desc.length < 40 || desc.length > 175) add("warn", "description-length", f, `Meta description is ${desc.length} characters (aim for 50-170).`);
    const hs = headings(html), h1s = hs.filter((h) => h.level === 1);
    if (h1s.length === 0) add("error", "h1", f, "The page has no <h1>.");
    if (h1s.length > 1 && fix) {
      let seen = 0;
      html = html.replace(/<(\/?)h1\b/gi, (m, slash: string) => { if (!slash) { seen++; return seen > 1 ? "<h2" : m; } return seen > 1 ? "</h2" : m; });
      add("info", "h1", f, `Demoted ${h1s.length - 1} extra <h1> to <h2> (one h1 per page).`, true);
    } else if (h1s.length > 1) add("error", "h1", f, `${h1s.length} <h1> elements; use exactly one.`);
    for (let i = 1; i < hs.length; i++) if (hs[i]!.level - hs[i - 1]!.level > 1) { add("warn", "heading-order", f, `Heading level jumps from h${hs[i - 1]!.level} to h${hs[i]!.level} ("${hs[i]!.text.slice(0, 30)}").`); break; }
    const mainCount = open.filter((t) => t.name === "main").length;
    if (mainCount !== 1) add("error", "landmark-main", f, `Expected exactly one <main>, found ${mainCount}.`);
    for (const lm of ["header", "nav", "footer"]) if (!open.some((t) => t.name === lm)) add("warn", `landmark-${lm}`, f, `Missing a <${lm}> landmark.`);
    if (!open.some((t) => t.name === "a" && /^#main$/i.test(t.attrs["href"] ?? "") )) add("warn", "skip-link", f, "No skip link to #main.");
    for (const css of ["css/tokens.css", "css/base.css", "css/components.css", "css/pages.css"]) if (!lower.includes(css) && files[css]) add("error", "css-link", f, `The page does not link ${css}.`);
    if (!/<script[^>]+src=["'][^"']*js\/main\.js/i.test(html) && files["js/main.js"]) add("warn", "js-link", f, "The page does not load js/main.js.");

    /* id uniqueness */
    const ids = idsOf(html), dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length && fix) { const seenIds = new Set<string>(); html = editTags(html, tokenize(html), (t, raw) => { const id = t.attrs["id"]; if (t.closing || !id) return undefined; if (seenIds.has(id)) { let n = 2; while (seenIds.has(`${id}-${n}`) || ids.includes(`${id}-${n}`)) n++; seenIds.add(`${id}-${n}`); return setAttr(raw, "id", `${id}-${n}`); } seenIds.add(id); return undefined; }); add("info", "duplicate-id", f, `Renamed duplicate id(s): ${[...new Set(dup)].join(", ")}.`, true); pageIds[f] = new Set(idsOf(html)); }
    else if (dup.length) add("error", "duplicate-id", f, `Duplicate id(s): ${[...new Set(dup)].join(", ")}.`);

    /* links */
    const t2 = tokenize(html);
    html = editTags(html, t2, (t, raw) => {
      if (t.closing) return undefined;
      if (t.name === "a") {
        const href = t.attrs["href"];
        let r = raw;
        if (href === undefined) return undefined;
        if (/^(mailto:|tel:|javascript:)/i.test(href)) { if (/^javascript:/i.test(href)) add("error", "js-href", f, "javascript: links are not allowed."); return undefined; }
        if (/^https?:\/\//i.test(href)) { if (t.attrs["target"] === "_blank" && !/noopener/i.test(t.attrs["rel"] ?? "") && fix) { r = setAttr(r, "rel", "noopener noreferrer"); add("info", "noopener", f, "Added rel=\"noopener noreferrer\" to an external target=_blank link.", true); } return r === raw ? undefined : r; }
        st.links++;
        if (href === "#" || href === "") { if (fix) { add("info", "dead-link", f, 'Replaced an empty "#" link with #main.', true); st.linksOk++; return setAttr(raw, "href", "#main"); } add("error", "dead-link", f, 'Empty "#" link.'); return undefined; }
        const [pathPart, hash = ""] = href.split("#"), target = pathPart ? resolvePath(f, pathPart.split("?")[0]!) : f;
        if (pathPart && !pageSet.has(target) && !files[target]) {
          if (fix && isHtml(pathPart)) { const to = closestPage(target, pages); add("info", "broken-link", f, `Repointed broken link ${href} to ${to}.`, true); st.linksOk++; return setAttr(raw, "href", to + (hash && pageIds[to]?.has(hash) ? "#" + hash : "")); }
          add("error", "broken-link", f, `Broken internal link: ${href}.`); return undefined;
        }
        st.linksOk++;
        if (hash) { st.anchors++; const ok = (pageIds[target] ?? new Set(idsOf(files[target] ?? ""))).has(hash) || hash === "main" || hash === "top"; if (ok) st.anchorsOk++; else if (fix) { add("info", "broken-anchor", f, `Link ${href} pointed at a missing anchor; now points at the page.`, true); st.anchorsOk++; return setAttr(raw, "href", pathPart ? pathPart : "#main"); } else add("error", "broken-anchor", f, `Anchor #${hash} does not exist on ${target}.`); }
        return undefined;
      }
      return undefined;
    });

    /* images, buttons, forms */
    const t3 = tokenize(html), formRanges: [number, number][] = [];
    for (const fm of innerOf(html, "form")) formRanges.push([fm.tag.start, fm.tag.end]);
    const labelFor = new Set(tokenize(html).filter((t) => t.name === "label" && !t.closing && t.attrs["for"]).map((t) => t.attrs["for"]!)), labelRanges = innerOf(html, "label").map((l) => [l.tag.start, l.tag.end] as [number, number]);
    let imgIndex = 0;
    html = editTags(html, t3, (t, raw) => {
      if (t.closing) return undefined;
      if (t.name === "img") {
        st.images++; imgIndex++;
        let r = raw, changed = false;
        if (t.attrs["alt"] === undefined) { if (fix) { r = addAttr(r, 'alt=""'); changed = true; add("warn", "img-alt", f, "An image had no alt text; marked decorative (alt=\"\"). Describe it if it carries meaning.", true); st.imagesAlt++; } else add("error", "img-alt", f, "Image without alt text."); } else st.imagesAlt++;
        if (/^https?:\/\//i.test(t.attrs["src"] ?? "")) add("warn", "img-remote", f, `Remote image ${String(t.attrs["src"]).slice(0, 50)}: it may not load offline; prefer inline SVG.`);
        if (fix && imgIndex > 1 && !t.attrs["loading"]) { r = addAttr(r, 'loading="lazy" decoding="async"'); changed = true; }
        return changed ? r : undefined;
      }
      if (t.name === "button" && t.attrs["type"] === undefined && fix) { const inForm = formRanges.some(([a, b]) => t.start > a && t.start < b); add("info", "button-type", f, "Gave a <button> an explicit type.", true); return addAttr(raw, `type="${inForm ? "submit" : "button"}"`); }
      if (t.name === "input" || t.name === "textarea" || t.name === "select") {
        const type = (t.attrs["type"] ?? "text").toLowerCase();
        if (["hidden", "submit", "button", "reset", "image"].includes(type)) return undefined;
        st.fields++;
        const labelled = !!(t.attrs["aria-label"] || t.attrs["aria-labelledby"] || (t.attrs["id"] && labelFor.has(t.attrs["id"])) || labelRanges.some(([a, b]) => t.start > a && t.start < b));
        if (labelled) st.fieldsLabelled++; else add("error", "label", f, `A form field (${t.name}${t.attrs["name"] ? ` "${t.attrs["name"]}"` : ""}) has no label.`);
      }
      return undefined;
    });
    for (const a of innerOf(html, "a")) { const inner = a.inner; if (!textOf(inner) && !a.tag.attrs["aria-label"] && !/<img[^>]+alt=["'][^"']+["']/i.test(inner) && !/<title>/i.test(inner)) add("error", "empty-link", f, `A link to ${a.tag.attrs["href"] ?? "?"} has no accessible name.`); }
    for (const b of innerOf(html, "button")) if (!textOf(b.inner) && !b.tag.attrs["aria-label"]) add("error", "empty-button", f, "A button has no accessible name.");
    /* every button must DO something: a recognised behaviour, a submit inside a form, or a menu/theme control */
    const allIds = new Set(idsOf(html)), formSpans = innerOf(html, "form").map((x) => [x.tag.start, x.tag.end] as [number, number]);
    const BEHAVIOUR = ["data-toggle", "data-modal-open", "data-modal-close", "data-copy", "data-scroll", "data-filter", "data-billing", "data-carousel-prev", "data-carousel-next"];
    for (const t of tokenize(html)) {
      if (t.closing) continue;
      if (t.name === "button") {
        const a = t.attrs, cls = a["class"] ?? "", inForm = formSpans.some(([x, y]) => t.start > x && t.start < y), submit = (a["type"] ?? (inForm ? "submit" : "button")) === "submit" && inForm;
        const ok = submit || /\b(nav-toggle|theme-toggle)\b/.test(cls) || BEHAVIOUR.some((k) => k in a) || a["role"] === "tab" || (!!a["aria-controls"] && "aria-expanded" in a) || "onclick" in a;
        if (!ok) add("error", "dead-button", f, `A button ("${(textOf(innerOf(html, "button").find((x) => x.tag.start === t.start)?.inner ?? "") || a["aria-label"] || "?").slice(0, 24)}") does nothing: give it a data-* behaviour (data-toggle, data-modal-open, data-scroll, ...) or make it a link.`);
      }
      for (const k of ["data-toggle", "data-modal-open", "data-scroll"]) { const v = t.attrs[k]; if (v && v.startsWith("#") && !allIds.has(v.slice(1))) add("error", "behaviour-target", f, `${k}="${v}" points at an element that does not exist.`); }
      if (t.name === "a" && t.attrs["role"] === "button" && !t.attrs["href"]) add("error", "dead-button", f, "A role=button link has no href.");
    }
    st.buttons += innerOf(html, "button").length; st.forms += innerOf(html, "form").length;
    for (const fm of innerOf(html, "form")) {
      const a = fm.tag.attrs;
      if (!("data-validate" in a) && !a["action"]) add("warn", "dead-form", f, "A form has neither data-validate nor an action, so submitting it does nothing.");
      if (("data-validate" in a) && !/class=["'][^"']*\bform__status\b/.test(fm.inner)) add("error", "form-status", f, "A validated form has no .form__status element to confirm the submission.");
    }
    if ((html.match(/\sstyle\s*=/gi) ?? []).length > 6) add("warn", "inline-style", f, "Many inline styles; move them into css/pages.css using tokens.");

    /* classes */
    const used = classesUsed(html);
    for (const c of used) { usedClassCount[c] = (usedClassCount[c] ?? 0) + 1; }
    const undef = [...used].filter((c) => !defined.has(c) && !STATE_CLASSES.test(c));
    if (undef.length) add(undef.some((c) => c.startsWith("x-")) || undef.length > 3 ? "error" : "warn", "class-undefined", f, `Classes with no CSS: ${undef.slice(0, 8).join(", ")}${undef.length > 8 ? "..." : ""}.`);

    /* content */
    const text = textOf(html), words = text.split(/\s+/).filter(Boolean).length;
    st.words += words;
    const sections = (html.match(/<section\b/gi) ?? []).length; st.sections += sections;
    if (PLACEHOLDER.test(text)) add("error", "placeholder", f, "Placeholder or unfinished copy found; write real content.");
    if (f !== "404.html" && words < 140) add("warn", "thin-content", f, `Only ${words} words of content; pages should feel complete.`);
    if (f === "index.html" && sections < 4) add("warn", "thin-home", f, `The home page has ${sections} sections; a premium home page tells a fuller story (aim for 5+).`);

    /* nav consistency fingerprint */
    chrome[f] = (innerOf(html, "header")[0]?.inner ?? "").replace(/\saria-current="page"/g, "").replace(/\s+/g, " ").trim() + "||" + (innerOf(html, "footer")[0]?.inner ?? "").replace(/\s+/g, " ").trim();
    files[f] = html;
  }
  const chromes = new Set(Object.values(chrome));
  if (pages.length > 1 && chromes.size > 1) add("error", "chrome-drift", "project", `The header/footer differ between pages (${chromes.size} variants); every page must share one header and footer.`);
  const dupT = Object.entries(titles).filter(([f, t]) => t && Object.entries(titles).some(([g, u]) => g !== f && u === t));
  if (dupT.length) add("warn", "title-dup", "project", `Duplicate page titles: ${dupT.map(([f]) => f).join(", ")}.`);
  const dupD = Object.entries(descs).filter(([f, t]) => t && Object.entries(descs).some(([g, u]) => g !== f && u === t));
  if (dupD.length) add("warn", "description-dup", "project", `Duplicate meta descriptions: ${dupD.map(([f]) => f).join(", ")}.`);
  st.classes = defined.size;
  st.unstyled = Object.keys(usedClassCount).filter((c) => !defined.has(c) && !STATE_CLASSES.test(c)).length;
  if (st.minContrast === 99) st.minContrast = 0;

  /* ---- summary ---- */
  const errors = issues.filter((i) => i.severity === "error").length, warns = issues.filter((i) => i.severity === "warn").length;
  const countBy = (code: RegExp): number => issues.filter((i) => code.test(i.code) && i.severity === "error").length;
  const fileKinds = `${st.pages} pages, ${st.css} stylesheets, ${st.js} script, ${st.docs} docs${names.some((n) => /\.svg$/i.test(n)) ? ", favicon" : ""}`;
  const checks: SiteCheck[] = [
    { label: "Files", value: `${st.files} real files (${fileKinds})`, ok: st.files >= MIN_FILES && !countBy(/missing-file|file-count|no-index/) },
    { label: "Design system", value: `${st.tokens} design tokens, ${st.classes} component classes, contrast >= ${st.minContrast}:1`, ok: !countBy(/tokens-missing|contrast|css-undefined-var/) && st.tokens > 20 },
    { label: "Links", value: `${st.linksOk}/${st.links} internal links and ${st.anchorsOk}/${st.anchors} anchors resolve`, ok: st.linksOk === st.links && st.anchorsOk === st.anchors && !countBy(/broken-link|broken-anchor|dead-link/) },
    { label: "Structure", value: `one h1 per page, landmarks and skip link, header and footer identical on ${st.pages} pages`, ok: !countBy(/h1|landmark|doctype|lang|viewport|chrome-drift|duplicate-id|css-link|title|description$/) },
    { label: "Buttons", value: `${st.buttons} buttons and ${st.forms} forms, every one wired to a real behaviour`, ok: !countBy(/dead-button|dead-form|form-status|behaviour-target/) },
    { label: "Accessibility", value: `${st.imagesAlt}/${st.images} images with alt, ${st.fieldsLabelled}/${st.fields} form fields labelled, no empty links or buttons`, ok: st.imagesAlt === st.images && st.fieldsLabelled === st.fields && !countBy(/empty-link|empty-button|label$/) },
    { label: "CSS", value: `${st.css} stylesheets balanced, ${st.unstyled} unstyled classes, no undefined variables`, ok: !countBy(/css-unbalanced|css-undefined-var|class-undefined/) },
    { label: "JavaScript", value: `${st.js} script${st.js === 1 ? "" : "s"}: syntax valid, no eval or document.write`, ok: !countBy(/js-syntax|js-unsafe|js-href/) },
    { label: "Content", value: `${st.words} words across ${st.pages} pages, ${st.sections} sections, no placeholder copy`, ok: !countBy(/placeholder/) },
  ];
  return { files, issues, fixes, stats: st, checks, score: Math.max(0, Math.round(100 - errors * 9 - warns * 2)) };
}
