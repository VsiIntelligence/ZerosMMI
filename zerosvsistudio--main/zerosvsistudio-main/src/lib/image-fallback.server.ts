/**
 * What happens when no picture model can be reached: a person still gets a picture. A text engine draws a vector illustration, the
 * server checks it hard (a drawing is code, so scripts, event handlers and anything that loads from the internet are removed), and it
 * is handed back like any other image. Also: turning "the same, but at night" into a complete picture request.
 */
import { engineJson, engineText } from "./engine.server";

/** The only things a drawing may contain. Everything else is dropped. */
const ALLOWED_TAGS = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "fecomposite", "feflood", "femerge", "femergenode", "fedropshadow", "feturbulence", "fedisplacementmap", "fecomponenttransfer", "fefunca", "fefuncr", "fefuncg", "fefuncb", "femorphology", "use", "symbol", "title", "desc"]);

/** Strips everything dangerous from an SVG drawing; returns null when nothing safe is left. */
export function sanitizeSvg(raw: string): string | null {
  const match = /<svg[\s\S]*<\/svg>/i.exec(raw.replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!doctype[\s\S]*?>/gi, ""));
  if (!match) return null;
  let svg = match[0];
  if (svg.length > 400_000) return null;
  svg = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  // drop whole elements that can run code or load things, with their contents
  svg = svg.replace(/<(script|foreignobject|iframe|object|embed|audio|video|link|style|animate|animatetransform|animatemotion|set|image|canvas|meta|base)\b[\s\S]*?(?:<\/\1\s*>|\/>)/gi, "");
  svg = svg.replace(/<(script|foreignobject|iframe|object|embed|audio|video|link|style|animate|animatetransform|animatemotion|set|image|canvas|meta|base)\b[^>]*>/gi, "");
  // keep only known tags
  svg = svg.replace(/<\/?([a-zA-Z][\w:-]*)([^>]*)>/g, (whole, tag: string, rest: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (whole.startsWith("</")) return `</${tag}>`;
    const selfClosing = /\/\s*$/.test(rest);
    const attributes: string[] = [];
    for (const m of rest.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = m[1]!, value = m[3] ?? m[4] ?? "";
      const k = key.toLowerCase();
      if (k.startsWith("on")) continue;
      if ((k === "href" || k === "xlink:href") && !/^#[\w-]+$/.test(value.trim())) continue;
      if (/javascript:|data:text|vbscript:|expression\s*\(|@import|behavior\s*:|<|>/i.test(value)) continue;
      // paint servers, clips and filters may only point at things inside the drawing
      const refs = [...value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)];
      if (refs.some((m) => !(m[2] ?? "").trim().startsWith("#"))) continue;
      attributes.push(`${key}="${value.replace(/"/g, "&quot;")}"`);
    }
    if (name === "svg" && !attributes.some((a) => /^xmlns=/i.test(a))) attributes.unshift('xmlns="http://www.w3.org/2000/svg"');
    return `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}${selfClosing ? "/" : ""}>`;
  });
  if (!/<svg[^>]*\sviewBox=/i.test(svg)) svg = svg.replace(/<svg\b/i, '<svg viewBox="0 0 1024 1024"');
  return /<(path|rect|circle|ellipse|polygon|polyline|line|text)\b/i.test(svg) ? svg : null;
}

const ILLUSTRATOR_SYSTEM = `You are a master vector illustrator. Draw ONE finished, beautiful illustration as a single SVG document.
Rules:
- Output ONLY the SVG, starting with <svg and ending with </svg>. No markdown fences, no explanations.
- viewBox="0 0 1024 1024" (or the aspect ratio requested), xmlns="http://www.w3.org/2000/svg".
- Compose like an artist: one clear focal point, foreground / midground / background layers, a believable light source, a considered colour palette (3-5 harmonious hues plus accents).
- Use <defs> with linearGradient/radialGradient for depth and lighting, soft shadows with feGaussianBlur, rim light and highlights, subtle texture with feTurbulence where it helps. Rich detail: dozens of well-placed shapes, not a few blobs.
- Draw every subject the person named, recognisably. Do not add text, logos or watermarks unless the person asked for specific text.
- Use only: svg, g, defs, path, rect, circle, ellipse, line, polyline, polygon, text, linearGradient, radialGradient, stop, clipPath, mask, pattern, filter and fe* primitives, use, symbol. No scripts, no images, no external references, no event handlers, no CSS imports.
- Keep it under 30 000 characters.`;

/** A full illustration for the request, or null when no text engine answers. */
export async function illustrate(prompt: string, size: { width?: number | undefined; height?: number | undefined } = {}, previous?: { svg?: string }): Promise<string | null> {
  const w = Math.max(256, Math.min(2048, Math.round(size.width ?? 1024))), h = Math.max(256, Math.min(2048, Math.round(size.height ?? 1024)));
  const ask = `Illustration to draw: ${prompt}\nCanvas: ${w}x${h} (viewBox="0 0 ${w} ${h}").${previous?.svg ? `\n\nThis is the current drawing; change it as asked and keep everything else the same:\n${previous.svg.slice(0, 18_000)}` : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await engineText(ILLUSTRATOR_SYSTEM, ask, { timeoutMs: 60_000, maxTokens: 16_000 }).catch(() => null);
    const clean = text ? sanitizeSvg(text.replace(/^```(?:svg|xml)?\s*/i, "").replace(/```\s*$/i, "")) : null;
    if (clean) return clean;
  }
  return null;
}

const MERGE_SYSTEM = `You maintain the text prompt of a picture. You get the CURRENT prompt and a CHANGE the person asked for. Write ONE complete new prompt (max 90 words) that keeps every detail of the current picture that the change does not touch (subject, setting, style, colours, composition, lighting) and applies the change exactly.
If the change is a brand-new picture idea unrelated to the current one, just polish the change. Never add text, logos or watermarks unless asked. Return ONLY JSON: {"prompt":"..."}`;

/** "Make it night" + the picture's old prompt -> a complete prompt for the changed picture. */
export async function mergePrompt(previous: string, change: string): Promise<string> {
  const out = await engineJson<{ prompt?: string }>(MERGE_SYSTEM, `CURRENT PROMPT:\n${previous.slice(0, 900)}\n\nCHANGE:\n${change.slice(0, 600)}`, { maxTokens: 300, timeoutMs: 8000, temperature: 0.4 }).catch(() => null);
  const merged = out?.prompt?.trim();
  return merged && merged.length > 12 ? merged.slice(0, 900) : `${previous.slice(0, 700)}. Change: ${change.slice(0, 400)}`;
}
