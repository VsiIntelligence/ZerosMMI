/**
 * A tolerant, DOM-free HTML scanner. Generated sites are linted in Node tests, on the server and in the browser, so the checks
 * cannot depend on DOMParser. It is deliberately small: tags with attributes, headings, ids, classes, links, labelled controls.
 */
export type Tag = { name: string; attrs: Record<string, string>; start: number; end: number; closing: boolean; selfClose: boolean };

const BLANK = (m: string): string => m.replace(/[^\n]/g, " ");
/** Replaces comments, <script> and <style> bodies with spaces (offsets are preserved) so their contents are never scanned as markup. */
export function maskNonMarkup(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, BLANK).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => m.replace(/>[\s\S]*<\/script/i, (inner) => ">" + BLANK(inner.slice(1, -8)) + "</script")).replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => m.replace(/>[\s\S]*<\/style/i, (inner) => ">" + BLANK(inner.slice(1, -7)) + "</style"));
}

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function tokenize(html: string): Tag[] {
  const src = maskNonMarkup(html), out: Tag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src))) {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[3] ?? ""))) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const name = m[2]!.toLowerCase();
    out.push({ name, attrs, start: m.index, end: m.index + m[0].length, closing: m[1] === "/", selfClose: m[4] === "/" || VOID.has(name) });
  }
  return out;
}

export const textOf = (html: string): string => maskNonMarkup(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();

export const opening = (tags: Tag[], name: string): Tag[] => tags.filter((t) => t.name === name && !t.closing);

/** Inner HTML of every `<name ...>...</name>` (non-nested use only: a, button, label, h1-h6, title, summary). */
export function innerOf(html: string, name: string): { tag: Tag; inner: string }[] {
  const src = maskNonMarkup(html), re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}\\s*>`, "gi"), out: { tag: Tag; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[1] ?? ""))) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    out.push({ tag: { name, attrs, start: m.index, end: m.index + m[0].length, closing: false, selfClose: false }, inner: html.slice(m.index + m[0].indexOf(">") + 1, m.index + m[0].length - `</${name}>`.length) });
  }
  return out;
}

export function classesUsed(html: string): Set<string> {
  const set = new Set<string>();
  for (const t of tokenize(html)) if (!t.closing && t.attrs["class"]) for (const c of t.attrs["class"].split(/\s+/)) if (c) set.add(c);
  return set;
}
export function idsOf(html: string): string[] { return tokenize(html).filter((t) => !t.closing && t.attrs["id"]).map((t) => t.attrs["id"]!); }
export function headings(html: string): { level: number; text: string }[] {
  const out: { level: number; text: string; at: number }[] = [];
  for (let l = 1; l <= 6; l++) for (const h of innerOf(html, `h${l}`)) out.push({ level: l, text: textOf(h.inner), at: h.tag.start });
  return out.sort((a, b) => a.at - b.at).map(({ level, text }) => ({ level, text }));
}

/** Class names defined by a stylesheet (every `.name` in a selector position). */
export function classesDefined(css: string): Set<string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'), set = new Set<string>();
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let m: RegExpExecArray | null;
  // only inside selectors (text before a `{`), not inside declaration blocks
  for (const sel of stripped.split("{").map((_, i, parts) => (i === 0 ? parts[0]! : parts[i]!.split("}").slice(-1)[0]!)).filter(Boolean)) { re.lastIndex = 0; while ((m = re.exec(sel))) set.add(m[1]!); }
  return set;
}
export function varsDefined(css: string): Set<string> { const set = new Set<string>(); for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) set.add(m[1]!); return set; }
export function varsUsed(css: string): Set<string> { const set = new Set<string>(); for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) set.add(m[1]!); return set; }
export function balanced(css: string): boolean {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let b = 0, p = 0;
  for (const c of s) { if (c === "{") b++; else if (c === "}") b--; else if (c === "(") p++; else if (c === ")") p--; if (b < 0 || p < 0) return false; }
  return b === 0 && p === 0;
}
