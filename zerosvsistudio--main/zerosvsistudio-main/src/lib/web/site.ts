/**
 * Site assembly: turns a brief plus page bodies into the complete multi-file project (design system, pages, scripts, docs).
 */
import { BASE_JS, assemblePage, buildDesignSystem, buildReadme, notFoundMain, type Brief } from "./kit";
import { defaultPagesCss, fallbackMains } from "./content";

export type SiteParts = { mains: Record<string, string>; pagesCss?: string; extraJs?: string; notes?: string[] };

/** Extra model-written JavaScript is only kept when it parses; the baseline interactions always ship. */
export function composeJs(extra: string | undefined): { js: string; dropped: boolean } {
  const e = (extra ?? "").trim();
  if (!e) return { js: BASE_JS, dropped: false };
  try { new Function(e); } catch { return { js: BASE_JS, dropped: true }; }
  return { js: `${BASE_JS}\n/* Page extras */\n(function () {\n  "use strict";\n${e}\n})();\n`, dropped: false };
}

export function assembleSite(b: Brief, parts: SiteParts): Record<string, string> {
  const files: Record<string, string> = { ...buildDesignSystem(b) };
  const fallback = fallbackMains(b);
  for (const page of b.pages) files[page.file] = assemblePage(b, page, parts.mains[page.file]?.trim() ? parts.mains[page.file]! : fallback[page.file]!);
  files["404.html"] = assemblePage(b, { file: "404.html", title: "Page not found", nav: "", purpose: "", description: `The page you were looking for could not be found on ${b.name}.` }, notFoundMain(b), { is404: true });
  files["css/pages.css"] = parts.pagesCss?.trim() ? `${defaultPagesCss(b)}\n/* ---- page styles written for this site ---- */\n${parts.pagesCss.trim()}\n` : defaultPagesCss(b);
  const js = composeJs(parts.extraJs);
  files["js/main.js"] = js.js;
  const notes = [...(parts.notes ?? []), ...(js.dropped ? ["Extra JavaScript had a syntax error and was left out; the baseline interactions are included."] : [])];
  files["README.md"] = buildReadme(b, [...Object.keys(files), "README.md"], notes);
  return files;
}

export function buildSiteFromBrief(b: Brief): Record<string, string> { return assembleSite(b, { mains: fallbackMains(b) }); }
