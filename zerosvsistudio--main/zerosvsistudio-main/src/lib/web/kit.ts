/**
 * Zeros Web Kit. The model decides WHAT the site says; Zeros builds HOW it looks and behaves, deterministically:
 *   brief -> design tokens (contrast computed) -> base + component CSS -> shared page chrome -> plan, rules, README, 404.
 * Every page therefore shares one visual language, one header, one footer and one set of tested interactions, which removes
 * the whole class of "page 3 looks different from page 1" and "nav broken on mobile" bugs by construction.
 */
import { contrast, hueOf, isColor, mixColor, parseColor, readableOn, shade, toHex, hsl2rgb } from "../video/kit";

export type FontChoice = "sans" | "serif" | "rounded" | "mono" | "humanist";
/** Visual personality: changes shape, weight, borders, shadows and rhythm, so sites do not all look alike. */
export type Archetype = "editorial" | "tech" | "luxe" | "bold" | "soft";
export const ARCHETYPES: readonly Archetype[] = ["editorial", "tech", "luxe", "bold", "soft"];
export type PageSpec = { file: string; title: string; nav: string; purpose: string; description: string };
export type Palette = { bg: string; surface: string; text: string; muted: string; primary: string; accent: string };
export type Brief = {
  name: string; tagline: string; description: string; audience: string; tone: string; industry: string;
  palette: Palette; archetype: Archetype; fonts: { display: FontChoice; body: FontChoice }; radius: "sharp" | "soft" | "round"; density: "airy" | "balanced" | "compact";
  pages: PageSpec[]; cta: { label: string; href: string }; contact: { email: string; phone: string; address: string };
  /** section ideas per page, from the model's brief (used by PLAN.md and the page prompt) */
  sections: Record<string, string[]>;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Brief normalisation                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : d);
export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const titleCase = (s: string): string => s.replace(/(^|[\s\-/])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
/** "my bakery called Pão & Co" -> "Pão & Co": an explicit name beats any guess. */
export function explicitName(prompt: string): string {
  const m = /\b(?:called|named|titled|branded|name is|name's)\s+["\u201c\u2018']?([^"\u201d\u2019\n.,;:!?]{2,40}?)(?=["\u201d\u2019]|\s+(?:and|with|that|which|who|for|in|on|at|it|we|they|selling|offering|where)\b|[.,;:!?\n]|$)/i.exec(prompt);
  if (m) return m[1]!.trim();
  const q = /["\u201c]([^"\u201d\n]{2,40})["\u201d]/.exec(prompt);
  return q ? q[1]!.trim() : "";
}
const COPY: { match: RegExp; tagline: string; description: string; archetype: Archetype }[] = [
  { match: /bak|cafe|coffee|pastr|tea\b|brew|roast/i, tagline: "Baked fresh, made with care", description: "Honest ingredients, small batches and a warm welcome, for everyone who appreciates the difference.", archetype: "soft" },
  { match: /restaurant|chef|kitchen|pizza|bistro|catering|food|bar\b/i, tagline: "Good food, properly made", description: "Seasonal cooking, generous hospitality and a table worth coming back to.", archetype: "editorial" },
  { match: /tech|saas|software|app\b|ai\b|startup|code|dev|cloud|data|platform|cyber|digital/i, tagline: "Build faster. Ship with confidence.", description: "A sharper way to work: fast, reliable and designed to stay out of your way.", archetype: "tech" },
  { match: /fashion|luxury|jewel|perfume|boutique|couture|wedding|photograph|gallery|atelier/i, tagline: "Crafted to be remembered", description: "Considered design and unhurried craft, made for people who notice the details.", archetype: "luxe" },
  { match: /fitness|gym|sport|train|run|bike|crossfit|boxing|street|skate|music|festival/i, tagline: "Show up. Level up.", description: "High energy, honest coaching and a community that pushes you further.", archetype: "bold" },
  { match: /health|yoga|wellness|spa|clinic|dental|care|therap|nutrition|medic|mindful|meditat/i, tagline: "Care that fits your life", description: "Personal, judgement-free support and plans that work around the way you live.", archetype: "soft" },
  { match: /law|legal|finance|bank|consult|account|insurance|invest|real estate|advis/i, tagline: "Clear advice you can act on", description: "Plain-spoken expertise and careful work, from first conversation to final result.", archetype: "editorial" },
];

const PALETTES: { match: RegExp; p: Palette }[] = [
  { match: /bak|cafe|coffee|food|restaurant|chef|pastr|kitchen|pizza|tea\b/i, p: { bg: "#fffaf3", surface: "#f7ecdc", text: "#2a1a10", muted: "#6b5646", primary: "#b4531b", accent: "#e0a030" } },
  { match: /tech|saas|software|app|ai\b|startup|code|dev|cloud|data/i, p: { bg: "#0b1020", surface: "#121933", text: "#f1f4ff", muted: "#a4aed0", primary: "#6c8cff", accent: "#ff7ad9" } },
  { match: /health|yoga|wellness|spa|nature|eco|garden|organic|clinic|dental|care/i, p: { bg: "#f4fbf7", surface: "#e3f3ea", text: "#10261b", muted: "#4d6a5b", primary: "#1f8f5f", accent: "#e9a23b" } },
  { match: /law|legal|finance|bank|consult|account|insurance|invest|real estate/i, p: { bg: "#f7f8fb", surface: "#e8ecf4", text: "#0f1a2e", muted: "#516078", primary: "#1c3f94", accent: "#c8963e" } },
  { match: /fashion|luxury|jewel|studio|photo|art|gallery|design|portfolio|wedding/i, p: { bg: "#0e0c10", surface: "#19151e", text: "#f7f2fa", muted: "#b9aec6", primary: "#d9a441", accent: "#c97bd1" } },
  { match: /fitness|gym|sport|train|run|bike|outdoor|adventure|travel/i, p: { bg: "#0d1411", surface: "#16211b", text: "#f0f7f2", muted: "#9fb7a8", primary: "#8bd450", accent: "#ff7a3d" } },
];
const FALLBACK_PAL: Palette = { bg: "#fbfaf7", surface: "#f0ede6", text: "#16140f", muted: "#5d584d", primary: "#3d5afe", accent: "#ff6b3d" };

export const DARK_INK = "#0b0f19";
/** Whichever of white or near-black reads better on `bg` (the correct "text on a coloured button" choice). */
export const bestOn = (bg: string): string => (contrast(bg, "#ffffff") >= contrast(bg, DARK_INK) ? "#ffffff" : DARK_INK);
/** Nudges a brand colour (keeping its hue) until the best button text on it reaches `min` contrast. */
export function ensureOn(color: string, min = 4.5): string {
  let x = color;
  for (let i = 0; i < 16 && contrast(x, bestOn(x)) < min; i++) x = shade(x, contrast(x, "#ffffff") >= contrast(x, DARK_INK) ? -0.035 : 0.035);
  return x;
}

/** Brings any palette to values that pass WCAG: text 7:1, muted 4.5:1, primary/accent distinguishable from the background (3:1) and carrying readable button text (4.5:1). */
export function fixSitePalette(p: Palette): Palette {
  const bg = p.bg, surface = isColor(p.surface) ? p.surface : mixColor(bg, parseColor(bg) && contrast(bg, "#fff") > 4 ? "#ffffff" : "#000000", 0.06);
  return { bg, surface, text: readableOn(bg, p.text, 7), muted: readableOn(surface, readableOn(bg, p.muted, 4.5), 4.5), primary: ensureOn(readableOn(bg, p.primary, 3)), accent: ensureOn(readableOn(bg, p.accent, 3)) };
}

const DEFAULT_PAGES = (industry: string): PageSpec[] => [
  { file: "index.html", title: "Home", nav: "Home", purpose: "Win attention and explain the offer in ten seconds", description: "" },
  { file: "about.html", title: "About", nav: "About", purpose: "Tell the story and build trust", description: "" },
  { file: /saas|software|app|tech|startup/i.test(industry) ? "features.html" : "services.html", title: /saas|software|app|tech|startup/i.test(industry) ? "Features" : "Services", nav: /saas|software|app|tech|startup/i.test(industry) ? "Features" : "Services", purpose: "Show exactly what people get", description: "" },
  { file: "contact.html", title: "Contact", nav: "Contact", purpose: "Make it easy to get in touch", description: "" },
];

export function normalizeBrief(raw: unknown, prompt: string): Brief {
  const o = rec(raw), hint = `${prompt} ${str(o["industry"])} ${str(o["type"])} ${str(o["name"])}`;
  const name = str(o["name"] ?? o["siteName"] ?? o["brand"], 48) || explicitName(prompt) || titleCase(prompt.replace(/\b(make|build|create|design|a|an|the|me|my|our|website|web ?site|site|landing page|page|for|about|please|i|need|want)\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, 36)) || "Your Brand";
  const pal = rec(o["palette"]), match = PALETTES.find((x) => x.match.test(hint))?.p ?? FALLBACK_PAL;
  const pick = (k: keyof Palette, alt?: string): string => { const v = pal[k] ?? (alt ? pal[alt] : undefined); return isColor(v) ? (v as string) : match[k]; };
  const given = isColor(pal["bg"]) && (isColor(pal["primary"]) || isColor(pal["accent"]));
  const palette = fixSitePalette(given ? { bg: pick("bg"), surface: isColor(pal["surface"]) ? (pal["surface"] as string) : mixColor(pick("bg"), contrast(pick("bg"), "#fff") > 4 ? "#ffffff" : "#000000", 0.06), text: pick("text"), muted: pick("muted"), primary: pick("primary", "accent"), accent: pick("accent", "primary") } : match);
  const industry = str(o["industry"] ?? o["type"], 40) || str(prompt, 40);
  const rawPages = Array.isArray(o["pages"]) ? o["pages"] : [];
  const pages: PageSpec[] = [], seen = new Set<string>();
  for (const p of rawPages) {
    const q = typeof p === "string" ? { title: p } : rec(p);
    let file = str(q["file"] ?? q["path"] ?? q["slug"], 40).toLowerCase().replace(/^\.?\//, "");
    const title = str(q["title"] ?? q["name"] ?? q["nav"], 40) || titleCase(file.replace(/\.html?$/, "")) || "Page";
    if (!file) file = slugify(title) + ".html";
    if (!/\.html$/.test(file)) file = slugify(file.replace(/\.html?$/, "")) + ".html";
    file = file.replace(/[^a-z0-9-.]/g, "-");
    if (file === "404.html" || seen.has(file) || pages.length >= 6) continue;
    seen.add(file);
    pages.push({ file, title, nav: str(q["nav"] ?? q["label"], 18) || title.slice(0, 18), purpose: str(q["purpose"] ?? q["goal"], 160), description: str(q["description"] ?? q["metaDescription"], 170) });
  }
  if (!pages.some((p) => p.file === "index.html")) pages.unshift({ file: "index.html", title: "Home", nav: "Home", purpose: "Win attention and explain the offer in ten seconds", description: "" });
  const base = DEFAULT_PAGES(industry);
  for (const d of base) if (pages.length < 4 && !seen.has(d.file) && !pages.some((p) => p.file === d.file)) pages.push(d);
  if (!pages.some((p) => /contact/.test(p.file))) { if (pages.length >= 6) pages.pop(); pages.push(base[3]!); }
  pages.sort((a, b) => (a.file === "index.html" ? -1 : b.file === "index.html" ? 1 : /contact/.test(a.file) ? 1 : /contact/.test(b.file) ? -1 : 0));
  const copy = COPY.find((x) => x.match.test(hint));
  const tagline = str(o["tagline"] ?? o["slogan"], 90) || copy?.tagline || "Done properly, start to finish";
  const description = str(o["description"] ?? o["summary"] ?? o["pitch"], 190) || copy?.description || `${name} brings careful craft and clear communication to everything it does.`;
  for (const p of pages) if (!p.description || p.description.length < 45) p.description = (p.file === "index.html" ? description : `${p.title} at ${name}: ${p.purpose || tagline}. ${description}`).slice(0, 160);
  const cta = rec(o["cta"]);
  const contactPage = pages.find((p) => /contact/.test(p.file))?.file ?? "contact.html";
  const c = rec(o["contact"]), sections: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(rec(o["sections"]))) if (Array.isArray(v)) sections[k.endsWith(".html") ? k : k + ".html"] = v.map((x) => str(x, 90)).filter(Boolean).slice(0, 8);
  const fontOf = (v: unknown, d: FontChoice): FontChoice => oneOf(v, ["sans", "serif", "rounded", "mono", "humanist"] as const, d);
  const f = rec(o["fonts"] ?? o["typography"]);
  const archetype = oneOf(o["archetype"] ?? o["style"] ?? o["vibe"], ARCHETYPES, copy?.archetype ?? "editorial");
  return {
    name, tagline, description, archetype, audience: str(o["audience"], 140) || "people who care about quality", tone: str(o["tone"] ?? o["voice"], 80) || "warm, confident, specific", industry, palette,
    fonts: { display: fontOf(f["display"] ?? f["heading"], archetype === "luxe" || archetype === "editorial" ? "serif" : archetype === "tech" ? "sans" : archetype === "soft" ? "rounded" : "sans"), body: fontOf(f["body"], archetype === "tech" ? "sans" : "sans") },
    radius: oneOf(o["radius"], ["sharp", "soft", "round"] as const, archetype === "luxe" ? "sharp" : archetype === "bold" ? "sharp" : archetype === "soft" ? "round" : /law|finance|bank|consult/i.test(hint) ? "sharp" : "soft"), density: oneOf(o["density"], ["airy", "balanced", "compact"] as const, "balanced"),
    pages, cta: { label: str(cta["label"], 24) || (/contact/.test(contactPage) ? "Get in touch" : "Start"), href: str(cta["href"], 40) && /\.html/.test(str(cta["href"], 40)) ? str(cta["href"], 40) : contactPage },
    contact: { email: str(c["email"], 80) || "", phone: str(c["phone"], 40) || "", address: str(c["address"], 120) || "" }, sections,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Design tokens                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

const STACKS: Record<FontChoice, string> = {
  sans: `"Inter", "SF Pro Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`,
  humanist: `"Avenir Next", "Segoe UI", "Gill Sans", "Trebuchet MS", system-ui, sans-serif`,
  serif: `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif`,
  rounded: `ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif`,
  mono: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace`,
};
const RADII = { sharp: ["3px", "6px", "10px"], soft: ["6px", "12px", "20px"], round: ["10px", "20px", "32px"] } as const;
const SECTION_Y = { airy: "clamp(4.5rem, 9vw, 8.5rem)", balanced: "clamp(3.5rem, 7vw, 6rem)", compact: "clamp(2.5rem, 5vw, 4rem)" } as const;

export type TokenReport = { pairs: { label: string; fg: string; bg: string; ratio: number; min: number; ok: boolean }[]; minRatio: number };
export function tokenContrast(b: Brief): TokenReport {
  const p = b.palette, onPrimary = bestOn(p.primary), onAccent = bestOn(p.accent);
  const pairs = [
    { label: "text on background", fg: p.text, bg: p.bg, min: 7 }, { label: "text on surface", fg: p.text, bg: p.surface, min: 7 },
    { label: "muted on background", fg: p.muted, bg: p.bg, min: 4.5 }, { label: "muted on surface", fg: p.muted, bg: p.surface, min: 4.5 },
    { label: "button text on primary", fg: onPrimary, bg: p.primary, min: 4.5 }, { label: "button text on accent", fg: onAccent, bg: p.accent, min: 4.5 },
    { label: "primary on background", fg: p.primary, bg: p.bg, min: 3 }, { label: "accent on background", fg: p.accent, bg: p.bg, min: 3 },
  ].map((x) => { const ratio = Math.round(contrast(x.fg, x.bg) * 10) / 10; return { ...x, ratio, ok: ratio >= x.min }; });
  return { pairs, minRatio: Math.min(...pairs.map((x) => x.ratio)) };
}

/** The counterpart palette for the theme toggle: a dark brand gets a light twin and vice versa, same hue family, contrast re-verified. */
export function altPalette(p: Palette): Palette {
  const dark = contrast(p.bg, "#ffffff") > contrast(p.bg, "#000000"), h = hueOf(p.primary, 220), c = (hh: number, sat: number, l: number): string => toHex(hsl2rgb(hh, sat, l));
  const base: Palette = dark
    ? { bg: c(h, 0.3, 0.97), surface: c(h, 0.28, 0.92), text: c(h, 0.4, 0.09), muted: c(h, 0.18, 0.36), primary: shade(p.primary, -0.12), accent: shade(p.accent, -0.1) }
    : { bg: c(h, 0.32, 0.075), surface: c(h, 0.3, 0.115), text: c(h, 0.3, 0.96), muted: c(h, 0.2, 0.76), primary: shade(p.primary, 0.14), accent: shade(p.accent, 0.12) };
  return fixSitePalette(base);
}

const ARCH: Record<Archetype, { weight: number; tracking: string; btn: string; eyebrow: string; eyebrowTracking: string; card: string; shadow: (dark: boolean) => string }> = {
  editorial: { weight: 700, tracking: "-0.03em", btn: "6px", eyebrow: "uppercase", eyebrowTracking: "0.18em", card: "1px solid var(--color-border)", shadow: () => "none" },
  tech: { weight: 780, tracking: "-0.035em", btn: "12px", eyebrow: "uppercase", eyebrowTracking: "0.12em", card: "1px solid color-mix(in srgb, var(--color-primary) 28%, var(--color-border))", shadow: () => "0 0 48px -18px var(--glow)" },
  luxe: { weight: 500, tracking: "-0.02em", btn: "2px", eyebrow: "uppercase", eyebrowTracking: "0.34em", card: "1px solid var(--color-border)", shadow: () => "none" },
  bold: { weight: 900, tracking: "-0.04em", btn: "0px", eyebrow: "uppercase", eyebrowTracking: "0.08em", card: "2px solid var(--color-text)", shadow: () => "6px 6px 0 var(--color-text)" },
  soft: { weight: 800, tracking: "-0.025em", btn: "999px", eyebrow: "none", eyebrowTracking: "0.02em", card: "1px solid var(--color-border)", shadow: (d) => (d ? "0 18px 40px -22px rgb(0 0 0 / .6)" : "0 18px 40px -22px rgb(60 40 20 / .22)") },
};

function colorBlock(p: Palette, dark: boolean, indent: string): string {
  const onPrimary = bestOn(p.primary), onAccent = bestOn(p.accent), border = mixColor(p.bg, p.text, 0.14), surface2 = mixColor(p.bg, p.text, dark ? 0.07 : 0.035), focus = readableOn(p.bg, p.accent, 3);
  const danger = readableOn(p.bg, dark ? "#ff8a80" : "#b3261e", 4.5), success = readableOn(p.bg, dark ? "#6fe0a0" : "#176a3a", 4.5);
  const shadow = dark ? ["0 1px 2px rgb(0 0 0 / .4)", "0 8px 24px rgb(0 0 0 / .35)", "0 24px 60px rgb(0 0 0 / .45)"] : ["0 1px 2px rgb(20 20 30 / .06)", "0 8px 24px rgb(20 20 30 / .09)", "0 24px 60px rgb(20 20 30 / .14)"];
  const lines = [
    `color-scheme: ${dark ? "dark" : "light"};`, `--color-bg: ${p.bg};`, `--color-surface: ${p.surface};`, `--color-surface-2: ${surface2};`, `--color-text: ${p.text};`, `--color-muted: ${p.muted};`, `--color-border: ${border};`,
    `--color-primary: ${p.primary};`, `--color-primary-hover: ${shade(p.primary, dark ? 0.08 : -0.08)};`, `--color-on-primary: ${onPrimary};`, `--color-accent: ${p.accent};`, `--color-on-accent: ${onAccent};`, `--color-focus: ${focus};`, `--color-danger: ${danger};`, `--color-success: ${success};`,
    `--glow: color-mix(in srgb, var(--color-primary) ${dark ? 26 : 16}%, transparent);`, `--shadow-sm: ${shadow[0]};`, `--shadow-md: ${shadow[1]};`, `--shadow-lg: ${shadow[2]};`,
  ];
  return lines.map((l) => indent + l).join("\n");
}

export function buildTokens(b: Brief): string {
  const p = b.palette, dark = contrast(p.bg, "#ffffff") > contrast(p.bg, "#000000"), alt = altPalette(p), altDark = contrast(alt.bg, "#ffffff") > contrast(alt.bg, "#000000");
  const [rs, rm, rl] = RADII[b.radius], hue = Math.round(hueOf(p.primary)), A = ARCH[b.archetype];
  return `/* ${b.name} - design tokens. Generated by Zeros. Change a value here and the whole site follows (see DESIGN_RULES.md). */
:root {
  /* colour: every text pair below is verified for WCAG contrast (see DESIGN_RULES.md) */
${colorBlock(p, dark, "  ")}
  --hue: ${hue};
  --gradient-brand: linear-gradient(135deg, var(--color-primary), var(--color-accent));

  /* personality (${b.archetype}): shape, weight, borders and depth that make this site look like itself */
  --btn-radius: ${A.btn};
  --heading-weight: ${A.weight};
  --heading-tracking: ${A.tracking};
  --eyebrow-case: ${A.eyebrow};
  --eyebrow-tracking: ${A.eyebrowTracking};
  --card-border: ${A.card};
  --card-shadow: ${A.shadow(dark)};

  /* typography */
  --font-display: ${STACKS[b.fonts.display]};
  --font-body: ${STACKS[b.fonts.body]};
  --font-mono: ${STACKS.mono};
  --text-xs: clamp(0.78rem, 0.76rem + 0.1vw, 0.84rem);
  --text-sm: clamp(0.88rem, 0.86rem + 0.15vw, 0.95rem);
  --text-base: clamp(1rem, 0.97rem + 0.2vw, 1.1rem);
  --text-lg: clamp(1.15rem, 1.08rem + 0.4vw, 1.35rem);
  --text-xl: clamp(1.35rem, 1.2rem + 0.8vw, 1.8rem);
  --text-2xl: clamp(1.7rem, 1.4rem + 1.5vw, 2.5rem);
  --text-3xl: clamp(2.1rem, 1.6rem + 2.5vw, 3.4rem);
  --text-4xl: clamp(2.5rem, 1.7rem + 3.8vw, 4.4rem);
  --text-5xl: clamp(2.7rem, 1.5rem + 5.4vw, 5.6rem);
  --leading-tight: 1.06;
  --leading-snug: 1.3;
  --leading-normal: 1.65;
  --tracking-tight: -0.025em;

  /* spacing (8-point rhythm) */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: 4.5rem;
  --space-9: 7rem;

  /* shape */
  --radius-sm: ${rs};
  --radius-md: ${rm};
  --radius-lg: ${rl};
  --radius-pill: 999px;

  /* layout */
  --container: 72rem;
  --container-narrow: 46rem;
  --header-h: 4.25rem;
  --section-y: ${SECTION_Y[b.density]};

  /* motion */
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --dur-fast: 150ms;
  --dur: 300ms;
  --dur-slow: 700ms;

  /* stacking */
  --z-header: 50;
  --z-overlay: 100;
}

/* alternate theme: the colour-scheme twin of this palette, switched by the header toggle */
:root[data-theme="alt"] {
${colorBlock(alt, altDark, "  ")}
  --card-shadow: ${ARCH[b.archetype].shadow(altDark)};
}
`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Base + component CSS (static: everything themable comes from the tokens)                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export const BASE_CSS = `/* Base: reset, typography, layout primitives, accessibility. Uses tokens only. */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: calc(var(--header-h) + var(--space-4)); }
body { margin: 0; min-height: 100vh; font-feature-settings: "kern", "liga", "calt"; background: var(--color-bg); color: var(--color-text); font-family: var(--font-body); font-size: var(--text-base); line-height: var(--leading-normal); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; overflow-x: hidden; }
img, svg, video, canvas { display: block; max-width: 100%; height: auto; }
h1, h2, h3, h4 { margin: 0; font-family: var(--font-display); line-height: var(--leading-tight); letter-spacing: var(--heading-tracking); text-wrap: balance; font-optical-sizing: auto; }
h1 { font-size: var(--text-4xl); font-weight: var(--heading-weight); }
h2 { font-size: var(--text-3xl); font-weight: var(--heading-weight); }
h3 { font-size: var(--text-xl); font-weight: 700; line-height: var(--leading-snug); }
h4 { font-size: var(--text-lg); font-weight: 650; line-height: var(--leading-snug); }
p, ul, ol, dl, figure, blockquote, table { margin: 0; }
p { text-wrap: pretty; }
ul, ol { padding-left: 1.2em; }
a { color: var(--color-primary); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
a:hover { color: var(--color-primary-hover); }
::selection { background: color-mix(in srgb, var(--color-primary) 30%, transparent); }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; border-radius: var(--radius-sm); }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }
hr { border: 0; border-top: 1px solid var(--color-border); margin: 0; }

.container { width: min(100% - 2 * var(--space-5), var(--container)); margin-inline: auto; }
.container--narrow { width: min(100% - 2 * var(--space-5), var(--container-narrow)); margin-inline: auto; }
.section { padding-block: var(--section-y); position: relative; }
.section--tight { padding-block: calc(var(--section-y) * 0.55); }
.section--alt { background: var(--color-surface); }
.stack > * + * { margin-top: var(--stack, var(--space-4)); }
.stack--lg { --stack: var(--space-6); }
.cluster { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.grid { display: grid; gap: var(--space-5); }
.grid--2 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); }
.grid--3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); }
.grid--4 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); }
.split { display: grid; gap: var(--space-7); align-items: center; grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr)); }
.split--reverse > :first-child { order: 2; }
.center, .text-center { text-align: center; }
.muted { color: var(--color-muted); }
.prose > * + * { margin-top: var(--space-4); }
.prose h2, .prose h3 { margin-top: var(--space-6); }
.mt-2 { margin-top: var(--space-2); } .mt-4 { margin-top: var(--space-4); } .mt-6 { margin-top: var(--space-6); } .mt-8 { margin-top: var(--space-8); }
.mb-2 { margin-bottom: var(--space-2); } .mb-4 { margin-bottom: var(--space-4); } .mb-6 { margin-bottom: var(--space-6); } .mb-8 { margin-bottom: var(--space-8); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: var(--space-4); top: -4rem; z-index: var(--z-overlay); padding: var(--space-3) var(--space-4); background: var(--color-primary); color: var(--color-on-primary); border-radius: var(--radius-md); font-weight: 700; text-decoration: none; transition: top var(--dur-fast) var(--ease); }
.skip-link:focus { top: var(--space-3); color: var(--color-on-primary); }
@view-transition { navigation: auto; }
.text-gradient { background: var(--gradient-brand); -webkit-background-clip: text; background-clip: text; color: transparent; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;

export const COMPONENTS_CSS = `/* Components: the vocabulary every page is written in (documented in DESIGN_RULES.md). Uses tokens only. */

/* ---- header + navigation ---- */
.site-header { position: sticky; top: 0; z-index: var(--z-header); background: color-mix(in srgb, var(--color-bg) 82%, transparent); -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px); border-bottom: 1px solid transparent; transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.site-header.is-scrolled { border-bottom-color: var(--color-border); box-shadow: var(--shadow-sm); }
.site-header__bar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-5); min-height: var(--header-h); }
.brand { display: inline-flex; align-items: center; gap: var(--space-3); font-family: var(--font-display); font-weight: 800; font-size: var(--text-lg); color: var(--color-text); text-decoration: none; letter-spacing: var(--tracking-tight); }
.brand:hover { color: var(--color-text); }
.brand__mark { width: 1.9rem; height: 1.9rem; border-radius: var(--radius-sm); background: var(--gradient-brand); display: inline-block; flex: none; }
.nav-toggle { display: none; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: transparent; }
.nav-toggle__bars, .nav-toggle__bars::before, .nav-toggle__bars::after { display: block; width: 1.2rem; height: 2px; background: var(--color-text); border-radius: 2px; transition: transform var(--dur) var(--ease), opacity var(--dur-fast); content: ""; position: relative; }
.nav-toggle__bars::before { position: absolute; top: -6px; }
.nav-toggle__bars::after { position: absolute; top: 6px; }
.nav-toggle[aria-expanded="true"] .nav-toggle__bars { background: transparent; }
.nav-toggle[aria-expanded="true"] .nav-toggle__bars::before { transform: translateY(6px) rotate(45deg); }
.nav-toggle[aria-expanded="true"] .nav-toggle__bars::after { transform: translateY(-6px) rotate(-45deg); }
.site-nav { display: flex; align-items: center; gap: var(--space-5); }
.site-nav__list { display: flex; align-items: center; gap: var(--space-1); list-style: none; margin: 0; padding: 0; }
.site-nav__link { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 var(--space-3); border-radius: var(--radius-pill); color: var(--color-muted); font-weight: 600; font-size: var(--text-sm); text-decoration: none; transition: color var(--dur-fast), background var(--dur-fast); }
.site-nav__link:hover { color: var(--color-text); background: var(--color-surface-2); }
.site-nav__link[aria-current="page"] { color: var(--color-text); background: var(--color-surface-2); }
@media (max-width: 52rem) {
  .nav-toggle { display: inline-flex; }
  .site-nav { position: fixed; inset: var(--header-h) 0 auto 0; flex-direction: column; align-items: stretch; gap: var(--space-4); padding: var(--space-5); background: var(--color-bg); border-bottom: 1px solid var(--color-border); box-shadow: var(--shadow-lg); transform: translateY(-1rem); opacity: 0; visibility: hidden; transition: transform var(--dur) var(--ease), opacity var(--dur) var(--ease), visibility 0s var(--dur); }
  .site-nav.is-open { transform: none; opacity: 1; visibility: visible; transition-delay: 0s; }
  .site-nav__list { flex-direction: column; align-items: stretch; }
  .site-nav__link { font-size: var(--text-base); }
}

/* ---- buttons ---- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: 2.9rem; padding: 0 var(--space-5); border: 1px solid transparent; border-radius: var(--btn-radius); font-weight: 700; font-size: var(--text-sm); text-decoration: none; line-height: 1; transition: transform var(--dur-fast) var(--ease), box-shadow var(--dur) var(--ease), background var(--dur-fast), border-color var(--dur-fast); }
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn--primary { background: var(--color-primary); color: var(--color-on-primary); box-shadow: var(--shadow-sm); }
.btn--primary:hover { background: var(--color-primary-hover); color: var(--color-on-primary); box-shadow: var(--shadow-md); }
.btn--ghost { background: transparent; color: var(--color-text); border-color: var(--color-border); }
.btn--ghost:hover { background: var(--color-surface-2); color: var(--color-text); border-color: var(--color-muted); }
.btn--lg { min-height: 3.4rem; padding: 0 var(--space-6); font-size: var(--text-base); }
.btn--block { display: flex; width: 100%; }

/* ---- hero + headings ---- */
.hero { position: relative; overflow: hidden; padding-block: calc(var(--section-y) * 0.9); isolation: isolate; }
.hero::before { content: ""; position: absolute; inset: -20% -10% auto auto; width: min(60rem, 90vw); aspect-ratio: 1; background: radial-gradient(closest-side, var(--glow), transparent 70%); z-index: -1; pointer-events: none; }
.hero__eyebrow, .eyebrow { display: inline-block; margin-bottom: var(--space-4); font-size: var(--text-xs); font-weight: 800; letter-spacing: var(--eyebrow-tracking); text-transform: var(--eyebrow-case); color: var(--color-primary); }
.hero__title { font-size: var(--text-5xl); font-weight: var(--heading-weight); max-width: 15ch; }
.hero .split .hero__title { font-size: var(--text-4xl); }
.hero--center .hero__title { margin-inline: auto; max-width: 18ch; }
.hero__lead, .lead { font-size: var(--text-lg); color: var(--color-muted); max-width: 40rem; line-height: var(--leading-normal); }
.hero--center .hero__lead { margin-inline: auto; }
.hero__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }
.hero--center .hero__actions { justify-content: center; }
.hero__media { position: relative; }
.kicker { font-weight: 700; color: var(--color-accent); }
.section__head { max-width: 44rem; margin-bottom: var(--space-7); display: grid; gap: var(--space-3); }
.section__head.center { margin-inline: auto; }

/* ---- cards, features, stats ---- */
.card { position: relative; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-6); background: var(--color-surface-2); border: var(--card-border); box-shadow: var(--card-shadow); border-radius: var(--radius-lg); transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease), border-color var(--dur); }
.section--alt .card { background: var(--color-bg); }
.card--hover:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border)); }
.card__icon { display: inline-grid; place-items: center; width: 3rem; height: 3rem; border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-primary) 14%, transparent); color: var(--color-primary); }
.card__icon svg { width: 1.5rem; height: 1.5rem; }
.card__title { font-size: var(--text-lg); font-weight: 700; }
.card__text { color: var(--color-muted); font-size: var(--text-sm); }
.card__link { margin-top: auto; font-weight: 700; font-size: var(--text-sm); }
.features { display: grid; gap: var(--space-5); grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); }
.stats { display: grid; gap: var(--space-5); grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
.stat { padding: var(--space-5); border-left: 3px solid var(--color-primary); }
.stat__value { display: block; font-family: var(--font-display); font-size: var(--text-3xl); font-weight: 800; line-height: 1; letter-spacing: var(--tracking-tight); }
.stat__label { display: block; margin-top: var(--space-2); color: var(--color-muted); font-size: var(--text-sm); }
.badge, .pill { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); border-radius: var(--radius-pill); background: color-mix(in srgb, var(--color-primary) 14%, transparent); color: var(--color-text); font-size: var(--text-xs); font-weight: 700; border: 1px solid color-mix(in srgb, var(--color-primary) 30%, transparent); }
.media { border-radius: var(--radius-lg); overflow: hidden; background: var(--color-surface-2); border: 1px solid var(--color-border); box-shadow: var(--shadow-md); aspect-ratio: 4 / 3; display: grid; place-items: center; }
.media > svg, .media > img { width: 100%; height: 100%; object-fit: cover; }
.gallery { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); }
.logos { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: var(--space-6); color: var(--color-muted); font-weight: 800; letter-spacing: 0.04em; }
.divider { height: 1px; background: var(--color-border); margin-block: var(--space-6); }

/* ---- quotes, steps, pricing, faq, tables ---- */
.quote { display: grid; gap: var(--space-4); padding: var(--space-6); border-radius: var(--radius-lg); background: var(--color-surface-2); border: 1px solid var(--color-border); }
.quote__text { font-family: var(--font-display); font-size: var(--text-lg); line-height: var(--leading-snug); }
.quote__by { color: var(--color-muted); font-size: var(--text-sm); font-weight: 600; }
.avatar { width: 2.75rem; height: 2.75rem; border-radius: 50%; background: var(--gradient-brand); display: inline-block; }
.steps { display: grid; gap: var(--space-5); counter-reset: step; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); }
.step { position: relative; padding-top: var(--space-7); counter-increment: step; }
.step::before { content: counter(step, decimal-leading-zero); position: absolute; top: 0; left: 0; font-family: var(--font-display); font-size: var(--text-2xl); font-weight: 800; color: var(--color-primary); }
.step__num { display: none; }
.plans { display: grid; gap: var(--space-5); grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); align-items: stretch; }
.plan { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6); border-radius: var(--radius-lg); background: var(--color-surface-2); border: 1px solid var(--color-border); }
.plan--featured { border-color: var(--color-primary); box-shadow: var(--shadow-lg), 0 0 0 1px var(--color-primary); position: relative; }
.plan__name { font-weight: 800; font-size: var(--text-lg); }
.plan__price { font-family: var(--font-display); font-size: var(--text-3xl); font-weight: 800; line-height: 1; }
.plan__list { list-style: none; padding: 0; display: grid; gap: var(--space-2); color: var(--color-muted); font-size: var(--text-sm); }
.plan__list li::before { content: "\\2713"; margin-right: var(--space-2); color: var(--color-primary); font-weight: 800; }
.faq { display: grid; gap: var(--space-3); }
.faq details { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); padding: 0 var(--space-5); transition: border-color var(--dur-fast); }
.faq details[open] { border-color: color-mix(in srgb, var(--color-primary) 50%, var(--color-border)); }
.faq summary { cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-height: 3.5rem; font-weight: 700; }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after { content: "+"; font-size: 1.4em; line-height: 1; color: var(--color-primary); transition: transform var(--dur) var(--ease); }
.faq details[open] summary::after { transform: rotate(45deg); }
.faq details > :not(summary) { padding-bottom: var(--space-5); color: var(--color-muted); }
.table-wrap { overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.table th, .table td { padding: var(--space-3) var(--space-4); text-align: left; border-bottom: 1px solid var(--color-border); }
.table th { background: var(--color-surface-2); font-weight: 700; }

/* ---- call to action band ---- */
.cta-band { position: relative; overflow: hidden; padding: var(--space-8) var(--space-6); border-radius: var(--radius-lg); background: var(--gradient-brand); color: var(--color-on-primary); text-align: center; isolation: isolate; }
.cta-band__title { font-size: var(--text-3xl); color: inherit; max-width: 20ch; margin-inline: auto; }
.cta-band p { max-width: 36rem; margin: var(--space-4) auto 0; color: inherit; opacity: 0.92; }
.cta-band .btn { margin-top: var(--space-6); background: var(--color-bg); color: var(--color-text); }
.cta-band .btn:hover { background: var(--color-bg); color: var(--color-text); box-shadow: var(--shadow-lg); }

/* ---- forms ---- */
.form { display: grid; gap: var(--space-5); }
.field { display: grid; gap: var(--space-2); }
.field__label { font-weight: 700; font-size: var(--text-sm); }
.field__hint { color: var(--color-muted); font-size: var(--text-xs); }
.field__error { color: var(--color-danger); font-size: var(--text-xs); font-weight: 600; min-height: 1.1em; }
.input, .textarea, .select { width: 100%; min-height: 3rem; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-text); transition: border-color var(--dur-fast), box-shadow var(--dur-fast); }
.textarea { min-height: 8rem; resize: vertical; }
.input:hover, .textarea:hover, .select:hover { border-color: var(--color-muted); }
.input:focus-visible, .textarea:focus-visible, .select:focus-visible { border-color: var(--color-primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary) 22%, transparent); outline: none; }
.input[aria-invalid="true"], .textarea[aria-invalid="true"] { border-color: var(--color-danger); }
.checkbox { display: flex; align-items: flex-start; gap: var(--space-3); font-size: var(--text-sm); }
.checkbox input { width: 1.2rem; height: 1.2rem; margin-top: 0.15rem; accent-color: var(--color-primary); }
.form__status { padding: var(--space-4); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-text); border: 1px solid color-mix(in srgb, var(--color-success) 40%, transparent); font-weight: 600; }

/* ---- footer ---- */
.site-footer { margin-top: var(--section-y); padding-block: var(--space-8) var(--space-6); background: var(--color-surface); border-top: 1px solid var(--color-border); }
.site-footer__cols { display: grid; gap: var(--space-7); grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); }
.site-footer h2 { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.1em; color: var(--color-muted); font-weight: 800; }
.site-footer ul { list-style: none; padding: 0; margin: var(--space-3) 0 0; display: grid; gap: var(--space-2); }
.site-footer a { color: var(--color-text); text-decoration: none; }
.site-footer a:hover { color: var(--color-primary); text-decoration: underline; }
.site-footer__legal { margin-top: var(--space-7); padding-top: var(--space-5); border-top: 1px solid var(--color-border); color: var(--color-muted); font-size: var(--text-sm); display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-3); }

/* ---- scroll reveal (only hides content when JavaScript is running) ---- */
.js .reveal { opacity: 0; transform: translateY(18px); transition: opacity var(--dur-slow) var(--ease), transform var(--dur-slow) var(--ease); }
.js .reveal.is-visible { opacity: 1; transform: none; }
.js .reveal-delay-1 { transition-delay: 90ms; } .js .reveal-delay-2 { transition-delay: 180ms; } .js .reveal-delay-3 { transition-delay: 270ms; }

/* ---- premium layer: motion, depth and finish ---- */
.scroll-progress { position: fixed; inset: 0 0 auto 0; height: 3px; z-index: calc(var(--z-header) + 1); background: var(--gradient-brand); transform-origin: 0 50%; transform: scaleX(var(--p, 0)); pointer-events: none; }
.site-header__tools { display: flex; align-items: center; gap: var(--space-2); }
.theme-toggle { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 1px solid var(--color-border); border-radius: var(--btn-radius); background: transparent; color: var(--color-text); transition: background var(--dur-fast), transform var(--dur) var(--ease-spring); }
.theme-toggle:hover { background: var(--color-surface-2); transform: rotate(18deg); }
.theme-toggle svg { width: 1.2rem; height: 1.2rem; }

/* animated headlines: JS wraps words (or characters) and reveals them from behind a mask */
[data-split-ready] .word { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: 0.14em; margin-bottom: -0.14em; }
[data-split-ready] .word__inner, [data-split-ready] .char { display: inline-block; transform: translateY(112%); transition: transform 950ms var(--ease); transition-delay: calc(var(--i, 0) * 55ms); will-change: transform; }
[data-split-ready] .char { transform: translateY(70%) rotate(6deg); opacity: 0; transition: transform 800ms var(--ease-spring), opacity 500ms var(--ease); transition-delay: calc(var(--i, 0) * 28ms); }
[data-split-ready].is-in .word__inner { transform: none; }
[data-split-ready].is-in .char { transform: none; opacity: 1; }
.text-shimmer { background: linear-gradient(100deg, var(--color-text) 20%, var(--color-primary) 40%, var(--color-accent) 60%, var(--color-text) 80%); background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 6s linear infinite; }
@keyframes shimmer { to { background-position: -250% 0; } }

/* buttons: sheen sweep, sliding arrow, magnetic pull, glow */
.btn--primary { background-color: var(--color-primary); background-image: linear-gradient(135deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 90%, var(--color-accent))); position: relative; overflow: hidden; isolation: isolate; }
.btn--primary::after { content: ""; position: absolute; inset: 0; background: linear-gradient(110deg, transparent 32%, rgb(255 255 255 / 0.32) 50%, transparent 68%); transform: translateX(-130%); transition: transform 800ms var(--ease); z-index: -1; pointer-events: none; }
.btn--primary:hover::after { transform: translateX(130%); }
.btn__arrow { width: 1.1em; height: 1.1em; transition: transform var(--dur) var(--ease-spring); flex: none; }
.btn:hover .btn__arrow { transform: translateX(5px); }
.btn--glow { box-shadow: 0 10px 34px -10px var(--color-primary), var(--shadow-sm); }
.magnetic { will-change: transform; transition: transform 220ms var(--ease); }
.btn:focus-visible { outline-offset: 4px; }

/* cards: spotlight follows the pointer, tilt adds depth */
.spotlight { position: relative; overflow: hidden; }
.spotlight::before { content: ""; position: absolute; inset: 0; background: radial-gradient(420px circle at var(--mx, 50%) var(--my, 0%), color-mix(in srgb, var(--color-primary) 20%, transparent), transparent 62%); opacity: 0; transition: opacity var(--dur) var(--ease); pointer-events: none; z-index: 0; }
.spotlight:hover::before { opacity: 1; }
.spotlight > * { position: relative; z-index: 1; }
.tilt { transform: perspective(900px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)); transition: transform 260ms var(--ease); will-change: transform; }

/* bento grid: an asymmetric showcase for features */
.bento { display: grid; gap: var(--space-4); grid-template-columns: repeat(6, minmax(0, 1fr)); grid-auto-rows: minmax(10rem, auto); }
.bento__item { position: relative; overflow: hidden; grid-column: span 2; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-6); border-radius: var(--radius-lg); background: var(--color-surface-2); border: var(--card-border); box-shadow: var(--card-shadow); transition: transform var(--dur) var(--ease), border-color var(--dur); }
.bento__item:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--color-primary) 50%, var(--color-border)); }
.bento__item--wide { grid-column: span 4; }
.bento__item--tall { grid-row: span 2; }
.bento__item--feature { background: var(--color-primary); color: var(--color-on-primary); border-color: transparent; }
.bento__item--feature::before { content: ""; position: absolute; inset: -30% -20% auto auto; width: 70%; aspect-ratio: 1; background: radial-gradient(closest-side, color-mix(in srgb, var(--color-accent) 55%, transparent), transparent 70%); pointer-events: none; }
.bento__item--feature .card__text, .bento__item--feature p, .bento__item--feature .card__title { color: inherit; position: relative; }
.bento__item--feature .card__icon { background: color-mix(in srgb, var(--color-on-primary) 16%, transparent); color: inherit; }
.bento__item .card__title { font-size: var(--text-xl); }
@media (max-width: 60rem) { .bento { grid-template-columns: repeat(2, minmax(0, 1fr)); } .bento__item, .bento__item--wide { grid-column: span 2; } .bento__item--tall { grid-row: auto; } }
@media (max-width: 40rem) { .bento { grid-template-columns: minmax(0, 1fr); } .bento__item, .bento__item--wide { grid-column: auto; } }

/* marquee: an endless ticker (JS duplicates the items for a seamless loop) */
.marquee { overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); }
.marquee__track { display: flex; width: max-content; gap: var(--space-8); padding-block: var(--space-3); animation: marquee 36s linear infinite; }
.marquee:hover .marquee__track { animation-play-state: paused; }
.marquee__item { display: inline-flex; align-items: center; gap: var(--space-8); font-family: var(--font-display); font-size: var(--text-2xl); font-weight: var(--heading-weight); letter-spacing: var(--heading-tracking); white-space: nowrap; color: var(--color-muted); }
.marquee__item::after { content: ""; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--color-primary); }
@keyframes marquee { to { transform: translateX(-50%); } }

/* hero: drifting gradient mesh and a masked grid */
.hero--mesh::after { content: ""; position: absolute; inset: auto auto -30% -18%; width: min(46rem, 80vw); aspect-ratio: 1; background: radial-gradient(closest-side, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 70%); z-index: -1; animation: drift 19s ease-in-out infinite alternate; pointer-events: none; }
.hero::before { animation: drift 23s ease-in-out infinite alternate-reverse; }
.hero__grid { position: absolute; inset: 0; z-index: -1; opacity: 0.45; pointer-events: none; background-image: linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px); background-size: 4.5rem 4.5rem; -webkit-mask-image: radial-gradient(ellipse at 50% 35%, #000 0%, transparent 72%); mask-image: radial-gradient(ellipse at 50% 35%, #000 0%, transparent 72%); }
@keyframes drift { from { transform: translate3d(0, 0, 0) scale(1); } to { transform: translate3d(4%, 6%, 0) scale(1.16); } }
@keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-14px); } }

/* reveal variants */
.js .reveal--left { transform: translateX(-32px); }
.js .reveal--right { transform: translateX(32px); }
.js .reveal--scale { transform: scale(0.94); }
.js .reveal--blur { filter: blur(10px); }
.js .reveal.is-visible { filter: none; }
.section__head .eyebrow { display: inline-flex; align-items: center; gap: var(--space-3); }
.section__head .eyebrow::before { content: ""; width: 1.6rem; height: 2px; background: var(--color-primary); border-radius: 2px; }
.section__head.center .eyebrow::after { content: ""; width: 1.6rem; height: 2px; background: var(--color-primary); border-radius: 2px; }

/* personality: structural touches per archetype */
[data-style="luxe"] .btn { text-transform: uppercase; letter-spacing: 0.16em; font-size: var(--text-xs); min-height: 3.2rem; }
[data-style="luxe"] .hero__title, [data-style="luxe"] h2 { font-style: italic; }
[data-style="bold"] .btn { border: 2px solid var(--color-text); }
[data-style="bold"] .btn--primary { box-shadow: 4px 4px 0 var(--color-text); }
[data-style="bold"] .btn--primary:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--color-text); }
[data-style="bold"] .card:hover, [data-style="bold"] .bento__item:hover { transform: translate(-3px, -3px); box-shadow: 9px 9px 0 var(--color-text); }
[data-style="tech"] .eyebrow, [data-style="tech"] .stat__value { font-family: var(--font-mono); }
[data-style="soft"] .card, [data-style="soft"] .bento__item { border-radius: var(--radius-lg); }
[data-style="editorial"] .hero__title { letter-spacing: -0.04em; }
[data-style="editorial"] .lead::first-letter { font-family: var(--font-display); }

/* ---- interactive components wired by the runtime ---- */
.tabs [role="tablist"] { display: flex; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-1); border: 1px solid var(--color-border); border-radius: var(--btn-radius); width: fit-content; max-width: 100%; }
.tabs [role="tab"] { min-height: 2.75rem; padding: 0 var(--space-4); border: 0; background: transparent; border-radius: var(--btn-radius); font-weight: 700; font-size: var(--text-sm); color: var(--color-muted); transition: background var(--dur-fast), color var(--dur-fast); }
.tabs [role="tab"][aria-selected="true"] { background: var(--color-primary); color: var(--color-on-primary); }
.tabs [role="tabpanel"] { margin-top: var(--space-5); }
.chip { min-height: 2.75rem; padding: 0 var(--space-4); border: 1px solid var(--color-border); border-radius: var(--btn-radius); background: transparent; font-weight: 700; font-size: var(--text-sm); }
.chip[aria-pressed="true"] { background: var(--color-primary); color: var(--color-on-primary); border-color: transparent; }
.switch { display: inline-flex; align-items: center; gap: var(--space-3); min-height: 2.75rem; padding: 0 var(--space-4); border: 1px solid var(--color-border); border-radius: var(--btn-radius); background: transparent; font-weight: 700; font-size: var(--text-sm); }
.switch[aria-pressed="true"] { border-color: var(--color-primary); }
.carousel__track { display: flex; gap: var(--space-4); overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: var(--space-3); scrollbar-width: thin; }
.carousel__track > * { flex: 0 0 min(85%, 22rem); scroll-snap-align: start; }
.carousel__nav { display: flex; gap: var(--space-2); margin-top: var(--space-4); }
dialog.modal { width: min(92vw, 34rem); padding: var(--space-6); border: var(--card-border); border-radius: var(--radius-lg); background: var(--color-bg); color: var(--color-text); box-shadow: var(--shadow-lg); }
dialog.modal::backdrop { background: rgb(0 0 0 / 0.55); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }

@media (hover: none), (pointer: coarse) { .tilt { transform: none; } .magnetic { transform: none !important; } }
@media (prefers-reduced-motion: reduce) {
  [data-split-ready] .word__inner, [data-split-ready] .char { transform: none; opacity: 1; transition: none; }
  .marquee__track { animation: none; flex-wrap: wrap; width: auto; justify-content: center; }
  .hero::before, .hero--mesh::after, .text-shimmer, .x-art * { animation: none !important; }
  .tilt, .magnetic { transform: none !important; }
}
`;

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Baseline interactions                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export const BASE_JS = `/* Zeros site runtime: navigation, scroll progress, reveal, animated headlines, counters, marquee, pointer effects, theme, forms.
   Progressive enhancement: the site is complete without it, and any failure here switches every effect off (see the catch at the end). */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  try {
    root.classList.remove("no-js"); root.classList.add("js");
    var mq = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
    var reduce = mq("(prefers-reduced-motion: reduce)"), fine = mq("(hover: hover) and (pointer: fine)");
    var all = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };

    /* ---- mobile navigation ---- */
    var header = doc.querySelector(".site-header"), toggle = doc.querySelector(".nav-toggle"), nav = doc.getElementById("site-nav");
    function setNav(open) {
      if (!toggle || !nav) return;
      toggle.setAttribute("aria-expanded", String(open));
      var label = toggle.querySelector(".sr-only"); if (label) label.textContent = open ? "Close menu" : "Open menu";
      nav.classList.toggle("is-open", open);
    }
    if (toggle && nav) {
      toggle.addEventListener("click", function () { setNav(toggle.getAttribute("aria-expanded") !== "true"); });
      doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") { setNav(false); toggle.focus(); } });
      nav.addEventListener("click", function (e) { if (e.target && e.target.closest && e.target.closest("a")) setNav(false); });
      if (window.matchMedia) window.matchMedia("(min-width: 52.01rem)").addEventListener("change", function (m) { if (m.matches) setNav(false); });
    }

    /* ---- header shadow + scroll progress (one rAF-throttled listener) ---- */
    var bar = doc.querySelector(".scroll-progress"), ticking = false;
    function onScroll() {
      ticking = false;
      var y = window.scrollY || 0;
      if (header) header.classList.toggle("is-scrolled", y > 8);
      if (bar) { var h = doc.documentElement.scrollHeight - window.innerHeight; bar.style.setProperty("--p", h > 0 ? Math.min(1, y / h).toFixed(4) : "0"); }
    }
    window.addEventListener("scroll", function () { if (!ticking) { ticking = true; window.requestAnimationFrame(onScroll); } }, { passive: true });
    onScroll();

    /* ---- shared visibility observer ---- */
    function whenVisible(els, cb, opts) {
      if (!els.length) return;
      if (!("IntersectionObserver" in window) || reduce) { els.forEach(function (el) { cb(el, true); }); return; }
      var io = new IntersectionObserver(function (entries) { entries.forEach(function (en) { if (en.isIntersecting) { cb(en.target, false); io.unobserve(en.target); } }); }, opts || { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      els.forEach(function (el) { io.observe(el); });
    }
    whenVisible(all(".reveal"), function (el) { el.classList.add("is-visible"); });

    /* ---- animated headlines: words (or characters) rise from behind a mask ---- */
    all("[data-split]").forEach(function (el) {
      var chars = el.getAttribute("data-split") === "chars", i = 0, label = el.textContent.replace(/\\s+/g, " ").trim();
      function walk(node) {
        Array.prototype.slice.call(node.childNodes).forEach(function (n) {
          if (n.nodeType === 3) {
            var frag = doc.createDocumentFragment();
            n.textContent.split(/(\\s+)/).forEach(function (part) {
              if (!part) return;
              if (/^\\s+$/.test(part)) { frag.appendChild(doc.createTextNode(" ")); return; }
              var w = doc.createElement("span"); w.className = "word"; w.setAttribute("aria-hidden", "true");
              if (chars) { part.split("").forEach(function (ch) { var c = doc.createElement("span"); c.className = "char"; c.style.setProperty("--i", String(i++)); c.textContent = ch; w.appendChild(c); }); }
              else { var inner = doc.createElement("span"); inner.className = "word__inner"; inner.style.setProperty("--i", String(i++)); inner.textContent = part; w.appendChild(inner); }
              frag.appendChild(w);
            });
            node.replaceChild(frag, n);
          } else if (n.nodeType === 1 && !/^(script|style)$/i.test(n.nodeName)) { walk(n); }
        });
      }
      walk(el);
      el.setAttribute("aria-label", label); el.setAttribute("data-split-ready", "");
      window.requestAnimationFrame(function () { window.setTimeout(function () { whenVisible([el], function (e) { e.classList.add("is-in"); }, { threshold: 0.2 }); }, 60); });
    });

    /* ---- count-up numbers (the real value is always in the page; the animation is a flourish) ---- */
    all("[data-count]").forEach(function (el) {
      var end = parseFloat(el.getAttribute("data-count"));
      if (isNaN(end)) return;
      var dec = parseInt(el.getAttribute("data-decimals") || "0", 10), pre = el.getAttribute("data-prefix") || "", suf = el.getAttribute("data-suffix") || "";
      function fmt(v) { return pre + v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; }
      el.textContent = fmt(end);
      if (reduce) return;
      whenVisible([el], function () {
        var t0 = performance.now(), dur = 1500;
        el.textContent = fmt(0);
        (function step(t) { var p = Math.min(1, (t - t0) / dur); el.textContent = fmt(end * (1 - Math.pow(1 - p, 4))); if (p < 1) window.requestAnimationFrame(step); })(t0);
      });
    });

    /* ---- marquee: duplicate once for a seamless loop ---- */
    all(".marquee__track").forEach(function (track) {
      Array.prototype.slice.call(track.children).forEach(function (kid) { var copy = kid.cloneNode(true); copy.setAttribute("aria-hidden", "true"); track.appendChild(copy); });
    });

    /* ---- pointer effects (fine pointers only, never with reduced motion) ---- */
    if (fine && !reduce) {
      all(".spotlight").forEach(function (el) { el.addEventListener("pointermove", function (e) { var r = el.getBoundingClientRect(); el.style.setProperty("--mx", (e.clientX - r.left) + "px"); el.style.setProperty("--my", (e.clientY - r.top) + "px"); }); });
      all(".tilt").forEach(function (el) {
        el.addEventListener("pointermove", function (e) { var r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5; el.style.setProperty("--ry", (x * 7).toFixed(2) + "deg"); el.style.setProperty("--rx", (-y * 7).toFixed(2) + "deg"); });
        el.addEventListener("pointerleave", function () { el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); });
      });
      all(".magnetic").forEach(function (el) {
        el.addEventListener("pointermove", function (e) { var r = el.getBoundingClientRect(); el.style.transform = "translate(" + ((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1) + "px," + ((e.clientY - r.top - r.height / 2) * 0.25).toFixed(1) + "px)"; });
        el.addEventListener("pointerleave", function () { el.style.transform = ""; });
      });
    }

    /* ---- theme toggle (brand palette <-> its colour-scheme twin), remembered when storage is available ---- */
    var themeBtn = doc.querySelector(".theme-toggle");
    if (themeBtn) {
      var alt = root.getAttribute("data-theme") === "alt";
      themeBtn.setAttribute("aria-pressed", String(alt));
      themeBtn.addEventListener("click", function () {
        alt = !alt;
        if (alt) root.setAttribute("data-theme", "alt"); else root.removeAttribute("data-theme");
        themeBtn.setAttribute("aria-pressed", String(alt));
        try { localStorage.setItem("site-theme", alt ? "alt" : "brand"); } catch (e) { /* private mode: the choice just is not remembered */ }
      });
    }

    /* ---- declarative behaviours: every button the page writes is wired by construction ---- */
    all("[data-toggle]").forEach(function (btn) {
      var target = doc.querySelector(btn.getAttribute("data-toggle")); if (!target) return;
      btn.setAttribute("aria-expanded", String(!target.hidden));
      btn.addEventListener("click", function () { target.hidden = !target.hidden; btn.setAttribute("aria-expanded", String(!target.hidden)); });
    });
    all("[data-modal-open]").forEach(function (btn) {
      var dlg = doc.querySelector(btn.getAttribute("data-modal-open")); if (!dlg) return;
      btn.addEventListener("click", function () { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); });
    });
    all("dialog").forEach(function (dlg) {
      dlg.addEventListener("click", function (e) { if (e.target === dlg && dlg.close) dlg.close(); });
      all("[data-modal-close]", dlg).forEach(function (b) { b.addEventListener("click", function () { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }); });
    });
    all("[data-tabs]").forEach(function (box) {
      var tabs = all("[role=tab]", box), panels = all("[role=tabpanel]", box);
      function pick(t) { tabs.forEach(function (x) { var on = x === t; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; }); panels.forEach(function (p) { p.hidden = p.id !== t.getAttribute("aria-controls"); }); }
      tabs.forEach(function (t, i) {
        t.addEventListener("click", function () { pick(t); });
        t.addEventListener("keydown", function (e) { var n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1; if (n >= 0) { var nt = tabs[(n + tabs.length) % tabs.length]; nt.focus(); pick(nt); } });
      });
      if (tabs.length) pick(tabs.filter(function (t) { return t.getAttribute("aria-selected") === "true"; })[0] || tabs[0]);
    });
    all("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var text = btn.getAttribute("data-copy") || "", old = btn.textContent;
        function done() { btn.textContent = "Copied"; window.setTimeout(function () { btn.textContent = old; }, 1600); }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done); else done();
      });
    });
    all("[data-scroll]").forEach(function (btn) {
      btn.addEventListener("click", function () { var t = doc.querySelector(btn.getAttribute("data-scroll")); if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); });
    });
    all("[data-filter-group]").forEach(function (group) {
      var btns = all("[data-filter]", group), scope = doc.querySelector(group.getAttribute("data-filter-group")) || doc, items = all("[data-category]", scope);
      btns.forEach(function (b) { b.addEventListener("click", function () { var f = b.getAttribute("data-filter"); btns.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); items.forEach(function (it) { it.hidden = !(f === "all" || it.getAttribute("data-category") === f); }); }); });
    });
    all("[data-billing]").forEach(function (b) {
      b.addEventListener("click", function () { var yearly = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(yearly)); all("[data-monthly]").forEach(function (el) { el.hidden = yearly; }); all("[data-yearly]").forEach(function (el) { el.hidden = !yearly; }); });
    });
    all("[data-carousel]").forEach(function (c) {
      var track = c.querySelector("[data-carousel-track]") || c, prev = c.querySelector("[data-carousel-prev]"), next = c.querySelector("[data-carousel-next]");
      function step(d) { track.scrollBy({ left: d * track.clientWidth * 0.85, behavior: reduce ? "auto" : "smooth" }); }
      if (prev) prev.addEventListener("click", function () { step(-1); }); if (next) next.addEventListener("click", function () { step(1); });
    });

    all("[data-year]").forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

    /* ---- forms: friendly inline validation, honest demo confirmation ---- */
    all("form[data-validate]").forEach(function (form) {
      form.setAttribute("novalidate", "");
      function fieldError(el, msg) {
        var holder = el.closest(".field"), out = holder && holder.querySelector(".field__error");
        el.setAttribute("aria-invalid", msg ? "true" : "false");
        if (out) out.textContent = msg;
      }
      function check(el) {
        if (!el.name) return true;
        var v = (el.value || "").trim(), msg = "";
        if (el.required && !v) msg = "This field is required.";
        else if (el.type === "email" && v && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v)) msg = "Enter a valid email address.";
        else if (el.minLength > 0 && v && v.length < el.minLength) msg = "Please write at least " + el.minLength + " characters.";
        fieldError(el, msg);
        return !msg;
      }
      all("input, textarea, select", form).forEach(function (el) {
        el.addEventListener("blur", function () { check(el); });
        el.addEventListener("input", function () { if (el.getAttribute("aria-invalid") === "true") check(el); });
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var ok = true, first = null;
        all("input, textarea, select", form).forEach(function (el) { if (!check(el)) { ok = false; if (!first) first = el; } });
        if (!ok) { if (first) first.focus(); return; }
        var status = form.querySelector(".form__status");
        if (status) { status.hidden = false; if (status.focus) status.focus(); }
        form.reset();
      });
    });
  } catch (err) {
    /* failsafe: if any enhancement fails, show everything instead of leaving content hidden */
    root.classList.remove("js"); root.classList.add("no-js");
    if (window.console && console.warn) console.warn("[site] enhancements disabled:", err);
  }
})();
`;

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Component vocabulary (given to the model and documented in DESIGN_RULES.md)                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export const VOCAB = `LAYOUT: container, container--narrow, section, section--alt, section--tight, stack (+stack--lg), cluster, grid (+grid--2|3|4), split (+split--reverse), center, prose, muted, mt-2|4|6|8, mb-2|4|6|8
HERO: <section class="hero hero--mesh"> (+hero--center) > <div class="hero__grid" aria-hidden="true"></div> + .container > p.hero__eyebrow, h1.hero__title[data-split="words"], p.hero__lead, .hero__actions (a.btn.btn--primary.btn--lg.btn--glow.magnetic with a trailing arrow svg.btn__arrow, a.btn.btn--ghost.btn--lg); optional .hero__media with .media
ANIMATED TYPE: add data-split="words" (or "chars" for short words) to h1/h2 for a masked rise-in; wrap an accent word in <span class="text-gradient"> or <span class="text-shimmer">
SECTION HEAD: <div class="section__head"> (+center) > p.eyebrow, h2[data-split="words"], p.lead
BENTO (hero feature grid): .bento > article.bento__item (+bento__item--wide | --tall | --feature) > span.card__icon, h3.card__title, p.card__text   (use 5-6 items, mix wide/tall/feature)
CARDS: .grid.grid--3 > article.card.card--hover.spotlight.tilt.reveal > span.card__icon (inline <svg>), h3.card__title, p.card__text, a.card__link
MARQUEE: <div class="marquee" aria-label="..."><div class="marquee__track"><span class="marquee__item">Word</span>...</div></div>   (6-10 items; JS loops it)
STATS: .stats > .stat > span.stat__value[data-count="120" data-suffix="+"] , span.stat__label   (data-count animates; the real value is also the text; NEVER invent statistics)
QUOTE: figure.quote > blockquote.quote__text, figcaption.quote__by (+ .avatar)   (only with a real quote the person provided)
STEPS: ol.steps > li.step > h3, p      PRICING: .plans > .plan (+plan--featured) > .plan__name, .plan__price, ul.plan__list, a.btn
FAQ: .faq > details > summary + p      TABLE: .table-wrap > table.table      MEDIA: .media > inline <svg>      GALLERY: .gallery > .media
CTA: <div class="cta-band reveal"> > h2.cta-band__title, p, a.btn.btn--lg      BADGE: span.badge      LOGOS: .logos > span
FORM: <form class="form" data-validate novalidate> > .field > label.field__label[for], input.input|textarea.textarea|select.select (id, name, required), .field__hint, .field__error; .checkbox; button.btn.btn--primary[type=submit]; <p class="form__status" role="status" hidden tabindex="-1">Thanks...</p>
MOTION: add "reveal" (+ reveal--left|right|scale|blur, reveal-delay-1|2|3) to anything that should enter on scroll; .magnetic on primary buttons; .spotlight/.tilt on cards
INTERACTIVE (wired automatically, use these instead of writing JavaScript): <button data-toggle="#id"> shows/hides #id (aria-expanded kept in sync) | <button data-modal-open="#dlg"> opens <dialog id="dlg" class="modal"> containing <button data-modal-close> | <div class="tabs" data-tabs> with <div role="tablist"><button role="tab" id aria-controls aria-selected>...</div> and <div role="tabpanel" id> | <button data-copy="text"> | <button data-scroll="#id"> | <div data-filter-group="#grid"><button class="chip" data-filter="all|cat"> over items with data-category | <button class="switch" data-billing aria-pressed="false"> toggling [data-monthly] / [data-yearly] (hidden) | <div class="carousel" data-carousel><div class="carousel__track" data-carousel-track>...</div><div class="carousel__nav"><button data-carousel-prev>, <button data-carousel-next></div></div>
CUSTOM: anything bespoke gets a class starting with x- (for example x-menu-board) and its CSS goes in css/pages.css, using the tokens (var(--color-primary), var(--space-4), var(--radius-md)...)`;

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Page chrome                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

const ARROW = `<svg class="btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function faviconSvg(b: Brief): string {
  const letter = esc((b.name.trim()[0] ?? "Z").toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${esc(b.name)}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b.palette.primary}"/><stop offset="1" stop-color="${b.palette.accent}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="44" text-anchor="middle" font-family="system-ui, sans-serif" font-size="36" font-weight="800" fill="${bestOn(b.palette.primary)}">${letter}</text></svg>\n`;
}

export function assemblePage(b: Brief, page: PageSpec, main: string, opts: { is404?: boolean } = {}): string {
  const nav = b.pages.map((p) => `<li><a class="site-nav__link" href="${p.file}"${p.file === page.file ? ' aria-current="page"' : ""}>${esc(p.nav)}</a></li>`).join("");
  const title = page.file === "index.html" ? `${b.name}: ${b.tagline}` : `${page.title} | ${b.name}`;
  const footNav = b.pages.map((p) => `<li><a href="${p.file}">${esc(p.nav)}</a></li>`).join("");
  const contact = [b.contact.email && `<li><a href="mailto:${esc(b.contact.email)}">${esc(b.contact.email)}</a></li>`, b.contact.phone && `<li><a href="tel:${esc(b.contact.phone.replace(/[^+\d]/g, ""))}">${esc(b.contact.phone)}</a></li>`, b.contact.address && `<li>${esc(b.contact.address)}</li>`].filter(Boolean).join("");
  return `<!doctype html>
<html lang="en" class="no-js" data-style="${b.archetype}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.slice(0, 68))}</title>
<meta name="description" content="${esc(page.description.slice(0, 165))}">
<meta name="theme-color" content="${b.palette.bg}">
<meta property="og:title" content="${esc(title.slice(0, 68))}">
<meta property="og:description" content="${esc(page.description.slice(0, 165))}">
<meta property="og:type" content="website">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<script>try{if(localStorage.getItem("site-theme")==="alt")document.documentElement.setAttribute("data-theme","alt")}catch(e){}</script>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/base.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/pages.css">
</head>
<body>
<div class="scroll-progress" aria-hidden="true"></div>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="container site-header__bar">
    <a class="brand" href="index.html"><span class="brand__mark" aria-hidden="true"></span><span>${esc(b.name)}</span></a>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul class="site-nav__list">${nav}</ul>
      <a class="btn btn--primary" href="${esc(b.cta.href)}">${esc(b.cta.label)}${ARROW}</a>
    </nav>
    <div class="site-header__tools">
      <button class="theme-toggle" type="button" aria-pressed="false" aria-label="Switch colour theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg></button>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span class="sr-only">Open menu</span><span class="nav-toggle__bars" aria-hidden="true"></span></button>
    </div>
  </div>
</header>
<main id="main" tabindex="-1">
${main.trim()}
</main>
<footer class="site-footer">
  <div class="container">
    <div class="site-footer__cols">
      <div class="stack"><a class="brand" href="index.html"><span class="brand__mark" aria-hidden="true"></span><span>${esc(b.name)}</span></a><p class="muted">${esc(b.tagline)}</p></div>
      <div><h2>Explore</h2><ul>${footNav}</ul></div>
      ${contact ? `<div><h2>Contact</h2><ul>${contact}</ul></div>` : ""}
    </div>
    <div class="site-footer__legal"><span>&copy; <span data-year>${new Date().getFullYear()}</span> ${esc(b.name)}. All rights reserved.</span><span>Made with Zeros by VsiStudio</span></div>
  </div>
</footer>
<script src="js/main.js" defer></script>
</body>
</html>
`;
}

export function notFoundMain(b: Brief): string {
  return `<section class="hero hero--center">
  <div class="container">
    <p class="hero__eyebrow">Error 404</p>
    <h1 class="hero__title">This page took a wrong turn</h1>
    <p class="hero__lead">The page you are looking for has moved, been renamed, or never existed. Let's get you back to somewhere useful.</p>
    <div class="hero__actions">
      <a class="btn btn--primary btn--lg" href="index.html">Back to ${esc(b.name)}</a>
      <a class="btn btn--ghost btn--lg" href="${esc(b.pages.find((p) => /contact/.test(p.file))?.file ?? "index.html")}">Contact us</a>
    </div>
  </div>
</section>`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Documents                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export function buildPlan(b: Brief): string {
  const rows = b.pages.map((p) => `| \`${p.file}\` | ${p.title} | ${p.purpose || "-"} |`).join("\n");
  const secs = b.pages.map((p) => `### ${p.title} (\`${p.file}\`)\n${(b.sections[p.file]?.length ? b.sections[p.file]! : ["Hero with the single clearest promise", "Proof and detail", "A call to action"]).map((s) => `- ${s}`).join("\n")}`).join("\n\n");
  return `# ${b.name}: site plan

> ${b.tagline}

## 1. Brief
- **What it is:** ${b.description}
- **Audience:** ${b.audience}
- **Voice:** ${b.tone}
- **Primary action:** ${b.cta.label} (\`${b.cta.href}\`)

## 2. Site map
| File | Page | Job it does |
|---|---|---|
${rows}
| \`404.html\` | Not found | Recover lost visitors gracefully |

## 3. Page outlines
${secs}

## 4. Design direction
- **Palette:** background \`${b.palette.bg}\`, surface \`${b.palette.surface}\`, text \`${b.palette.text}\`, primary \`${b.palette.primary}\`, accent \`${b.palette.accent}\` (all contrast-checked, see DESIGN_RULES.md)
- **Type:** ${b.fonts.display} display / ${b.fonts.body} body, fluid scale
- **Shape:** ${b.radius} corners, ${b.density} spacing

## 5. Build order
1. \`css/tokens.css\`: every colour, size and shadow as a variable
2. \`css/base.css\` and \`css/components.css\`: the design system
3. Pages written in the component vocabulary, wrapped in one shared header and footer
4. \`css/pages.css\` and \`js/main.js\`: page-specific polish and interactions
5. Verification: links, anchors, headings, labels, contrast, CSS and JavaScript syntax, then a real-browser pass

## 6. Definition of done
- Every internal link and anchor resolves
- One \`h1\` per page, logical heading order, every image has alt text, every form field has a label
- Text contrast meets WCAG AA everywhere
- No horizontal scrolling from 320 px to 1440 px; works without JavaScript
- No placeholder copy
`;
}

export function buildDesignRules(b: Brief): string {
  const rep = tokenContrast(b), p = b.palette;
  return `# ${b.name}: design rules

These rules are the contract between design and code. Everything visual lives in \`css/tokens.css\`; change a token and the whole site follows. Pages are written in the component vocabulary below, so they stay consistent.

## 1. Principles
1. **One idea per section.** Each section has one heading and one job.
2. **One primary action per screen.** The \`btn--primary\` is the only loud thing in view.
3. **Hierarchy through size and weight, not decoration.** Display font for headings, body font for everything else.
4. **Space is the main design tool.** Use the spacing scale; never invent pixel values.
5. **Accessible by default.** Contrast, focus rings, labels, landmarks and reduced motion are built in, not bolted on.

## 2. Colour
| Token | Value | Use |
|---|---|---|
| \`--color-bg\` | \`${p.bg}\` | page background |
| \`--color-surface\` | \`${p.surface}\` | alternate sections |
| \`--color-text\` | \`${p.text}\` | body text and headings |
| \`--color-muted\` | \`${p.muted}\` | secondary text |
| \`--color-primary\` | \`${p.primary}\` | buttons, links, highlights |
| \`--color-accent\` | \`${p.accent}\` | gradient partner, small highlights |

### Contrast (WCAG), computed from the tokens
| Pair | Ratio | Needs | Result |
|---|---|---|---|
${rep.pairs.map((x) => `| ${x.label} | ${x.ratio}:1 | ${x.min}:1 | ${x.ok ? "pass" : "FAIL"} |`).join("\n")}

## 3. Typography
Display: ${b.fonts.display}. Body: ${b.fonts.body}. Sizes are fluid (\`clamp()\`), so type scales smoothly from 320 px to 1440 px.

| Token | Use |
|---|---|
| \`--text-5xl\` | hero title |
| \`--text-4xl\` | page title (h1) |
| \`--text-3xl\` | section title (h2) |
| \`--text-xl\` / \`--text-lg\` | card titles, lead text |
| \`--text-base\` | body |
| \`--text-sm\` / \`--text-xs\` | captions, labels |

Line length is capped near 65 characters for body text. Headings use \`text-wrap: balance\`.

## 4. Spacing, shape and depth
- Spacing: \`--space-1\` (0.25 rem) to \`--space-9\` (7 rem), an 8-point rhythm. Section padding is \`--section-y\` (${b.density}).
- Radius: \`--radius-sm\`, \`--radius-md\`, \`--radius-lg\` (${b.radius}). Buttons and chips use \`--radius-pill\`.
- Shadows: \`--shadow-sm\` for resting, \`--shadow-md\` for hover, \`--shadow-lg\` for emphasis.
- Motion: \`--dur-fast\`/\`--dur\`/\`--dur-slow\` with \`--ease\`. All motion stops under \`prefers-reduced-motion\`.

## 5. Layout
- Content width: \`.container\` (72 rem) or \`.container--narrow\` (46 rem) for reading.
- Breakpoints: the layout is fluid (CSS grid with \`auto-fit\`); the navigation collapses below 52 rem.
- Rhythm: alternate \`section\` and \`section section--alt\` to separate topics.

## 6. Component vocabulary
\`\`\`
${VOCAB}
\`\`\`

## 7. Accessibility rules
- A skip link is the first focusable element; \`<main id="main">\` is the target.
- Exactly one \`h1\` per page; headings never skip a level.
- Every image has \`alt\` (decorative images use \`alt=""\`); inline SVG icons are \`aria-hidden="true"\`.
- Every form control has a visible \`<label>\`; errors are announced next to the field.
- The current page link carries \`aria-current="page"\`; the menu button carries \`aria-expanded\`.
- Tap targets are at least 44 px; focus is always visible (3 px ring).

## 8. Extending the system
Add page-specific styling in \`css/pages.css\` using classes that start with \`x-\`, built from tokens (never raw colours). If you need a new colour, add a token to \`css/tokens.css\` first.
`;
}

export function buildReadme(b: Brief, files: string[], notes: string[] = []): string {
  const tree = [...files].sort().map((f) => `  ${f}`).join("\n");
  return `# ${b.name}

${b.description}

## Run it
Open \`index.html\` in a browser, or serve the folder:

\`\`\`bash
npx serve .
\`\`\`

## Deploy
It is plain HTML, CSS and JavaScript with no build step. Drop the folder on Netlify, Vercel, GitHub Pages or Cloudflare Pages.

## Files (${files.length})
\`\`\`
${tree}
\`\`\`

## Make it yours
- **Re-theme:** edit the variables in \`css/tokens.css\`. Colours, type scale, spacing, radius and shadows all flow from there.
- **Add a page:** copy an existing page, keep the header, footer and \`<main>\` structure, and add it to the navigation in every page.
- **Contact form:** the form validates in the browser but has no backend. Connect it to a form service (Formspree, Netlify Forms) by setting its \`action\`.
- Read \`DESIGN_RULES.md\` for the component vocabulary and \`PLAN.md\` for the site plan.
${notes.length ? `\n## Notes from the build\n${notes.map((n) => `- ${n}`).join("\n")}\n` : ""}
Made with Zeros by VsiStudio.
`;
}

/** Every static file of the design system, ready to merge into a project. */
export function buildDesignSystem(b: Brief): Record<string, string> {
  return { "css/tokens.css": buildTokens(b), "css/base.css": BASE_CSS, "css/components.css": COMPONENTS_CSS, "DESIGN_RULES.md": buildDesignRules(b), "favicon.svg": faviconSvg(b), "PLAN.md": buildPlan(b) };
}
export const _hsl = hsl2rgb; export const _toHex = toHex;
