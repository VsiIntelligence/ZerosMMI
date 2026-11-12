/**
 * Zeros Cinema Engine - foundation kit: easing curves, colour science (incl. WCAG contrast), seeded randomness and a
 * vector icon set. Pure functions, no DOM: used by the compiler, the linter, the renderer and the tests alike.
 */

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Easing                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Ease = "linear" | "in" | "out" | "inOut" | "outCubic" | "inOutCubic" | "outExpo" | "inOutExpo" | "outBack" | "outElastic" | "spring";

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a || 1)); return t * t * (3 - 2 * t); };

const C1 = 1.70158, C3 = C1 + 1;
const CURVES: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  outBack: (t) => 1 + C3 * Math.pow(t - 1, 3) + C1 * Math.pow(t - 1, 2),
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  spring: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-6.5 * t) * Math.cos(11 * t)),
};
export const EASES = Object.keys(CURVES) as Ease[];
export function ease(kind: Ease | undefined, t: number): number {
  const f = CURVES[kind ?? "outCubic"] ?? CURVES.outCubic;
  return f(clamp01(t));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Seeded randomness (deterministic: the same spec always renders the same film)                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export function rng(seed: number): () => number {
  let a = (seed | 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Stateless hash noise in 0..1 for (seed, index): lets particles be pure functions of time. */
export function hash01(seed: number, i: number): number {
  let h = Math.imul(seed ^ 0x85ebca6b, 0xc2b2ae35) ^ Math.imul(i + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Colour                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RGB = { r: number; g: number; b: number };
export type RGBA = RGB & { a: number };

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "#00000000", red: "#ef4444", green: "#22c55e", blue: "#3b82f6", yellow: "#facc15", orange: "#fb923c", purple: "#a855f7", pink: "#ec4899", cyan: "#22d3ee", gray: "#9ca3af", grey: "#9ca3af" };

export function parseColor(input: string | undefined | null): RGBA | null {
  if (!input || typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s]!;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16)) as [number, number, number, number | undefined];
      return { r, g, b, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: clamp(+m[1]!, 0, 255), g: clamp(+m[2]!, 0, 255), b: clamp(+m[3]!, 0, 255), a: clamp01(a) };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[ ,]+([\d.]+)%[ ,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const rgb = hsl2rgb(+m[1]!, clamp01(+m[2]! / 100), clamp01(+m[3]! / 100));
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { ...rgb, a: clamp01(a) };
  }
  return null;
}
export const isColor = (s: unknown): s is string => typeof s === "string" && parseColor(s) !== null;
const h2 = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
export const toHex = (c: RGB): string => `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
export const rgba = (color: string, alpha = 1): string => { const c = parseColor(color) ?? { r: 255, g: 255, b: 255, a: 1 }; return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+(clamp01(alpha) * c.a).toFixed(3)})`; };

export function hsl2rgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
export function rgb2hsl(c: RGB): { h: number; s: number; l: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
export const hueOf = (hex: string, fallback = 220): number => { const c = parseColor(hex); return c ? rgb2hsl(c).h : fallback; };

/** WCAG relative luminance 0..1. */
export function luminance(color: string): number {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const f = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
/** WCAG contrast ratio 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function mixColor(a: string, b: string, t: number): string {
  const x = parseColor(a) ?? { r: 0, g: 0, b: 0, a: 1 }, y = parseColor(b) ?? x;
  return toHex({ r: lerp(x.r, y.r, t), g: lerp(x.g, y.g, t), b: lerp(x.b, y.b, t) });
}
/** Lighten (amt>0) or darken (amt<0) in HSL space; amt in -1..1. */
export function shade(color: string, amt: number): string {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 }, h = rgb2hsl(c);
  return toHex(hsl2rgb(h.h, h.s, clamp01(h.l + amt)));
}
export function withHue(color: string, hue: number, sat?: number, light?: number): string {
  const h = rgb2hsl(parseColor(color) ?? { r: 128, g: 128, b: 128, a: 1 });
  return toHex(hsl2rgb(hue, sat ?? h.s, light ?? h.l));
}
/**
 * Returns a colour that reads on `bg` (>= `min` contrast): `preferred` untouched when it already does, otherwise the
 * preferred hue pushed lighter/darker until it passes, finally plain white/near-black.
 */
export function readableOn(bg: string, preferred: string | undefined, min = 4.5): string {
  const pref = preferred && isColor(preferred) ? preferred : undefined;
  if (pref && contrast(bg, pref) >= min) return pref;
  const dark = luminance(bg) > 0.4;
  if (pref) {
    for (let i = 1; i <= 10; i++) {
      const t = shade(pref, (dark ? -1 : 1) * i * 0.07);
      if (contrast(bg, t) >= min) return t;
    }
  }
  return dark ? "#0b0f19" : "#ffffff";
}
/** Average colour of several stops (for judging text contrast against a gradient backdrop). */
export function averageColor(colors: string[]): string {
  const cs = colors.map((c) => parseColor(c)).filter((c): c is RGBA => !!c);
  if (!cs.length) return "#000000";
  return toHex({ r: cs.reduce((s, c) => s + c.r, 0) / cs.length, g: cs.reduce((s, c) => s + c.g, 0) / cs.length, b: cs.reduce((s, c) => s + c.b, 0) / cs.length });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Icons: 24 x 24 stroke icons as SVG path data (drawn with Path2D, round caps/joins)                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

const circ = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rr = (x: number, y: number, w: number, h: number, r: number): string => `M${x + r} ${y}H${x + w - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h - r}a${r} ${r} 0 0 1 ${-r} ${r}H${x + r}a${r} ${r} 0 0 1 ${-r} ${-r}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}z`;

export const ICONS = {
  play: "M7 4L20 12L7 20Z",
  pause: "M7 4h3v16H7zM14 4h3v16h-3z",
  bolt: "M13 2L3 14H12L11 22L21 10H12Z",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0 0-7.7z",
  globe: `${circ(12, 12, 10)}M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z`,
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  rocket: `M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10zM7 14l-3 3v3l4-2M17 14l3 3v3l-4-2M10 20c0 1 1 2 2 2s2-1 2-2${circ(12, 9, 1.6)}`,
  code: "M16 18L22 12L16 6M8 6L2 12L8 18",
  music: `M9 18V5l12-2v13${circ(6, 18, 3)}${circ(18, 16, 3)}`,
  camera: `M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z${circ(12, 13, 4)}`,
  check: "M20 6L9 17L4 12",
  arrow: "M5 12h14M12 5l7 7-7 7",
  arrowUp: "M7 17L17 7M7 7h10v10",
  chart: "M12 20V10M18 20V4M6 20v-4",
  lock: `${rr(3, 11, 18, 11, 2)}M7 11V7a5 5 0 0 1 10 0v4`,
  mail: `${rr(2, 4, 20, 16, 2)}M22 6l-10 7L2 6`,
  clock: `${circ(12, 12, 10)}M12 6v6l4 2`,
  bulb: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z",
  user: `M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2${circ(12, 7, 4)}`,
  users: `M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2${circ(9, 7, 4)}M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8`,
  cart: `${circ(9, 21, 1)}${circ(20, 21, 1)}M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6`,
  gift: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z",
  leaf: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.500-4.800 10-10 10zM2 21c0-3 1.900-5.400 5.100-6 2.400-.5 4.900-2 5.900-3",
  flame: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.400-.5-2-1-3-1.100-2.100-.2-4 2-6 .5 2.500 2 4.900 4 6.500 2 1.600 3 3.500 3 5.500a7 7 0 1 1-14 0c0-1.200.4-2.300 1-3a2.500 2.500 0 0 0 2.500 2.500z",
  cloud: "M18 10h-1.300A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z",
  search: `${circ(11, 11, 8)}M21 21l-4.300-4.300`,
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  sparkle: "M12 3l1.900 5.100L19 10l-5.100 1.900L12 17l-1.900-5.100L5 10l5.100-1.900zM19 15l.9 2.100L22 18l-2.100.9L19 21l-.9-2.100L16 18l2.100-.9z",
  trophy: "M6 9H4.500a2.500 2.500 0 0 1 0-5H6M18 9h1.500a2.500 2.500 0 0 0 0-5H18M4 22h16M10 14.700V17c0 .5-.5 1-1 1.200C7.800 18.800 7 20.200 7 22M14 14.700V17c0 .5.5 1 1 1.200 1.200.6 2 2 2 3.800M18 2H6v7a6 6 0 0 0 12 0V2z",
  eye: `M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z${circ(12, 12, 3)}`,
  wifi: "M5 12.600a11 11 0 0 1 14.100 0M1.400 9a16 16 0 0 1 21.200 0M8.500 16.100a6 6 0 0 1 7 0M12 20h.010",
  cpu: `${rr(4, 4, 16, 16, 2)}${rr(9, 9, 6, 6, 1)}M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3`,
  book: "M4 19.500A2.500 2.500 0 0 1 6.500 17H20M6.500 2H20v20H6.500A2.500 2.500 0 0 1 4 19.500v-15A2.500 2.500 0 0 1 6.500 2z",
  coffee: "M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8zM6 1v3M10 1v3M14 1v3",
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10",
  plus: "M12 5v14M5 12h14",
  close: "M18 6L6 18M6 6l12 12",
  pin: `M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z${circ(12, 10, 3)}`,
  phone: "M22 16.900v3a2 2 0 0 1-2.200 2 19.800 19.800 0 0 1-8.600-3.100 19.500 19.500 0 0 1-6-6 19.800 19.800 0 0 1-3.100-8.700A2 2 0 0 1 4.100 2h3a2 2 0 0 1 2 1.700c.1 1 .4 1.900.7 2.800a2 2 0 0 1-.5 2.100L8.100 9.900a16 16 0 0 0 6 6l1.300-1.300a2 2 0 0 1 2.100-.4c.9.3 1.800.6 2.800.7a2 2 0 0 1 1.700 2z",
  trending: "M23 6l-9.500 9.500-5-5L1 18M17 6h6v6",
  layers: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  target: `${circ(12, 12, 10)}${circ(12, 12, 6)}${circ(12, 12, 2)}`,
  sun: `${circ(12, 12, 5)}M12 1v2M12 21v2M4.200 4.200l1.400 1.400M18.400 18.400l1.400 1.400M1 12h2M21 12h2M4.200 19.800l1.400-1.400M18.400 5.600l1.400-1.400`,
  moon: "M21 12.800A9 9 0 1 1 11.200 3 7 7 0 0 0 21 12.800z",
  pen: "M12 20h9M16.500 3.500a2.100 2.100 0 0 1 3 3L7 19l-4 1 1-4z",
  image: `${rr(3, 3, 18, 18, 2)}${circ(8.500, 8.500, 1.500)}M21 15l-5-5L5 21`,
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
} as const;
export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
const ICON_ALIASES: Record<string, IconName> = { lightning: "bolt", zap: "bolt", idea: "bulb", lightbulb: "bulb", rocketship: "rocket", launch: "rocket", graph: "chart", analytics: "chart", "bar-chart": "chart", growth: "trending", "trending-up": "trending", time: "clock", speed: "bolt", secure: "shield", security: "shield", privacy: "lock", team: "users", people: "users", person: "user", world: "globe", web: "globe", email: "mail", message: "chat", comment: "chat", settings: "sliders", tune: "sliders", magic: "sparkle", ai: "sparkle", award: "trophy", win: "trophy", goal: "target", focus: "target", location: "pin", map: "pin", love: "heart", like: "heart", tick: "check", done: "check", next: "arrow", right: "arrow", video: "camera", photo: "camera", film: "camera", audio: "music", sound: "music", song: "music", save: "download", x: "close" };
const ICON_LOOKUP: Record<string, IconName> = Object.fromEntries((Object.keys(ICONS) as IconName[]).map((k) => [k.toLowerCase(), k]));
export function iconName(n: unknown): IconName | null {
  if (typeof n !== "string") return null;
  const k = n.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return ICON_LOOKUP[k] ?? ICON_ALIASES[n.trim().toLowerCase()] ?? ICON_ALIASES[k] ?? null;
}
