import type { Ease, IconName } from "./kit";

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Compiled elements: what the renderer draws. Coordinates are percentages of the frame (0..100); sizes are percentages */
/*  of the frame HEIGHT, so the same film renders identically at 720p, 1080p or any other resolution.                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export type AnimIn = "none" | "fade" | "rise" | "drop" | "slide-left" | "slide-right" | "scale" | "pop" | "blur" | "mask" | "chars" | "words" | "typewriter" | "wipe" | "slam";
export type AnimOut = "none" | "fade" | "rise" | "drop" | "scale" | "slide-left" | "slide-right" | "blur";
export type Loop = "none" | "float" | "pulse" | "breathe" | "spin" | "sway";

export type Anim = {
  in?: AnimIn; out?: AnimOut; loop?: Loop;
  /** ms after scene start when the entrance begins */
  delay?: number;
  /** entrance length in ms */
  dur?: number;
  /** ms after scene start when the exit begins (default: scene end - 320) */
  outAt?: number;
  /** exit length in ms (default 320) */
  outDur?: number;
  ease?: Ease;
  /** ms between characters / words / lines for staggered entrances */
  stagger?: number;
};

export type ElBase = {
  /** anchor, % of frame width / height */
  x: number; y: number;
  w?: number; h?: number;
  opacity?: number; rotate?: number; scale?: number;
  anim?: Anim;
  blend?: "lighter" | "screen" | "multiply" | "overlay";
  /** 0..1: how strongly the element reacts to the beat (scale punch, glow) */
  beat?: number;
  /** draw order inside a scene (lower first) */
  z?: number;
};

export type FontKind = "display" | "serif" | "mono" | "body";

export type TextEl = ElBase & {
  type: "text";
  /** `*accent*` marks words drawn in the accent colour */
  text: string;
  /** % of frame height */
  size: number;
  weight?: number; color: string; accent?: string;
  align?: "left" | "center" | "right";
  font?: FontKind; tracking?: number; lineHeight?: number;
  /** max line width, % of frame width */
  maxW?: number;
  italic?: boolean; upper?: boolean;
  shadow?: boolean; glow?: string; outline?: string;
  /** marker-pen highlight sweep behind the text */
  highlight?: string;
};

export type ShapeKind = "rect" | "rounded" | "circle" | "ring" | "line" | "pill" | "triangle" | "diamond" | "star" | "hex" | "blob" | "arc";
export type ShapeEl = ElBase & {
  type: "shape"; shape: ShapeKind;
  fill?: string | [string, string]; stroke?: string; strokeW?: number; radius?: number;
  glow?: string; shadow?: boolean; dash?: boolean;
  /** ring / arc / line: how much is drawn, 0..1 (animated by the entrance) */
  progress?: number;
};

export type CardEl = ElBase & { type: "card"; title?: string; body?: string; icon?: IconName; badge?: string; accent: string; fill?: string; text: string; muted: string };
export type StatEl = ElBase & { type: "stat"; value: number; prefix?: string; suffix?: string; decimals?: number; label?: string; size: number; color: string; labelColor: string; from?: number };
export type ChartEl = ElBase & { type: "chart"; chart: "bars" | "line" | "donut" | "progress"; data: { label: string; value: number }[]; colors: string[]; text: string; muted: string; unit?: string };
export type IconEl = ElBase & { type: "icon"; name: IconName; size: number; color: string; tile?: string; strokeW?: number };
export type ParticlesEl = Omit<ElBase, "x" | "y"> & { type: "particles"; kind: "dust" | "embers" | "snow" | "stars" | "rain" | "bokeh" | "confetti" | "fireflies" | "bubbles"; count: number; color: string; color2?: string; speed?: number; size?: number; x?: number; y?: number };
export type GridEl = Omit<ElBase, "x" | "y"> & { type: "grid"; kind: "lines" | "dots" | "floor"; color: string; spacing?: number; speed?: number; x?: number; y?: number };
export type BackdropEl = Omit<ElBase, "x" | "y"> & { type: "backdrop"; kind: "gradient" | "mesh" | "aurora" | "spotlight" | "rays" | "glow" | "flow" | "topo" | "ribbons" | "lightleak"; colors: string[]; angle?: number; speed?: number; x?: number; y?: number };
export type WaveEl = ElBase & { type: "wave"; style: "bars" | "line" | "circle"; color: string; color2?: string; count?: number };
export type FlashEl = Omit<ElBase, "x" | "y"> & { type: "flash"; color: string; x?: number; y?: number };
/** Orbiting dots on an ellipse: a cheap, pretty motion motif. */
export type OrbitEl = ElBase & { type: "orbit"; radius: number; count: number; color: string; color2?: string; tilt?: number; speed?: number };

export type VideoElement = TextEl | ShapeEl | CardEl | StatEl | ChartEl | IconEl | ParticlesEl | GridEl | BackdropEl | WaveEl | FlashEl | OrbitEl;

/* ------------------------------------------------------------------------------------------------------------------ */
/*  Semantic scenes: what the model writes. The compiler turns each into elements with tested layouts and choreography. */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Layout = "hero" | "statement" | "split" | "stats" | "list" | "cards" | "quote" | "chart" | "timeline" | "kinetic" | "outro" | "logo" | "device";
export type Visual = "none" | "orbit" | "grid" | "aurora" | "rings" | "burst" | "waves" | "particles" | "spotlight" | "floor" | "mesh" | "flow" | "topo" | "ribbons" | "lightleak";
export type Motion = "calm" | "energetic" | "explosive";
export type Camera = "push" | "pull" | "pan-left" | "pan-right" | "drift" | "static" | "tilt-up" | "tilt-down";
export type Transition = "cut" | "dip" | "flash" | "fade" | "wipe" | "push" | "zoom" | "glitch" | "iris";

/** The brand a film is about. Drives the logo reveal, the closing lockup and the sonic logo. */
export type BrandMark = "ring" | "square" | "hex" | "diamond" | "bolt" | "orbit" | "leaf" | "star";
export type Brand = { name: string; tagline?: string; mark: BrandMark; monogram?: string; url?: string };

export type VideoItem = { icon?: IconName; title: string; body?: string };
export type VideoStat = { value: number; prefix?: string; suffix?: string; label: string; decimals?: number };
export type VideoChart = { type: "bars" | "line" | "donut" | "progress"; data: { label: string; value: number }[]; unit?: string };

/** Legacy v2 layers, still accepted so old saved films keep rendering (converted to elements). */
export type VideoLayer = {
  type: string; [k: string]: unknown;
};

export type VideoScene = {
  startMs: number; endMs: number; label: string;
  layout: Layout;
  eyebrow?: string; headline?: string; sub?: string;
  items?: VideoItem[]; stats?: VideoStat[]; chart?: VideoChart;
  quote?: { text: string; who?: string };
  words?: string[];
  icon?: IconName; visual?: Visual; motion?: Motion;
  /** device scenes: which product frame to draw */
  device?: "laptop" | "phone";
  background?: string; accent?: string;
  camera?: Camera; transition?: Transition;
  /** optional AI image plate behind the scene */
  imagePrompt?: string; plate?: boolean;
  /** extra low-level elements, drawn above the compiled layout */
  elements?: VideoElement[];
  /** legacy */
  html?: string; layers?: VideoLayer[];
};

export type Palette = { bg: string; surface: string; text: string; muted: string; accent: string; accent2: string };
export type FontStyle = "modern" | "editorial" | "mono" | "bold";
export type VoiceLine = { startMs: number; text: string };
export type VideoAudio = {
  mood: "cinematic" | "upbeat" | "ambient" | "playful" | "tense" | "warm";
  genre: string; bpm: number; key: string; voice: "female" | "male";
  voiceoverLines: VoiceLine[];
  /** sound-design hits, whooshes and risers synchronised to the cuts (default on) */
  sfx: boolean;
  /** measured position of the first beat in the score, ms (0 when the score starts exactly on the grid) */
  beatOffsetMs?: number;
};

export type VideoSpec = {
  title: string; durationSec: number; fps: number; width: number; height: number;
  script: string; style: string; background: string; seed: number;
  palette: Palette; fontStyle: FontStyle; captions: boolean;
  scenes: VideoScene[]; audio: VideoAudio;
  /** the brand the film is about (logo reveal, lockup, sonic logo) */
  brand?: Brand;
  /** what the research found and what the plan was, kept for the report and the commentary */
  research?: string[];
  plan?: { objective: string; keyMessage: string; metaphor: string; soundPlan: string };
  /** where the film came from, for honest reporting */
  source: "model" | "fallback" | "legacy";
  warnings: string[];
};
