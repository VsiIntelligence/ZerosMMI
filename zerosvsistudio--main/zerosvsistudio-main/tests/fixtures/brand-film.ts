import type { VideoSpec } from "../../src/lib/video/types";

/** A 40 second brand film: logo reveal, product devices, a graph, every new background style, a brand lockup. */
export const BRAND_SPEC: VideoSpec = {
  title: "Lumen Labs: light for every workflow", durationSec: 40, fps: 30, width: 1280, height: 720,
  script: "A brand film for Lumen Labs.", style: "premium", background: "#070a14", seed: 11,
  palette: { bg: "#070a14", surface: "#0f1530", text: "#f5f7ff", muted: "#9aa6cf", accent: "#5b8cff", accent2: "#f6a4ff" },
  fontStyle: "modern", captions: true, source: "model", warnings: [],
  brand: { name: "Lumen Labs", tagline: "Light for every workflow", mark: "orbit", monogram: "LL" },
  plan: { objective: "Make teams feel their work is lighter", keyMessage: "Lumen turns scattered work into one clear view", metaphor: "a lens that gathers scattered light into one beam", soundPlan: "warm pad, bright shimmer on the logo, impacts on the cuts" },
  research: ["Sample fixture: no public data is used."],
  audio: { mood: "cinematic", genre: "synthwave", bpm: 104, key: "A minor", voice: "female", sfx: true, voiceoverLines: [
    { startMs: 5200, text: "Work arrives from everywhere at once." },
    { startMs: 17000, text: "Lumen gathers it into one clear view." },
    { startMs: 31000, text: "See everything. Decide faster." },
  ] },
  scenes: [
    { startMs: 0, endMs: 5200, label: "Logo", layout: "logo", eyebrow: "Introducing", headline: "Lumen Labs", sub: "Light for every workflow", visual: "aurora", motion: "energetic" },
    { startMs: 5200, endMs: 9200, label: "Chaos", layout: "kinetic", words: ["INBOX", "CHAT", "TASKS", "DOCS"], motion: "explosive", visual: "burst", transition: "glitch" },
    { startMs: 9200, endMs: 15200, label: "Clarity", layout: "device", eyebrow: "One view", headline: "Every signal, *one* screen", sub: "Your team's work, gathered in a single live dashboard.", device: "laptop", visual: "flow", motion: "energetic", transition: "wipe" },
    { startMs: 15200, endMs: 20400, label: "Growth", layout: "chart", headline: "Faster reviews, *every* week", sub: "Median turnaround, illustrative", chart: { type: "bars", data: [{ label: "Jan", value: 9 }, { label: "Feb", value: 7 }, { label: "Mar", value: 5 }, { label: "Apr", value: 3 }], unit: "d" }, visual: "topo", transition: "push" },
    { startMs: 20400, endMs: 26200, label: "Phone", layout: "device", eyebrow: "Anywhere", headline: "Decide on *any* screen", sub: "The same view, wherever you are.", device: "phone", visual: "ribbons", motion: "calm", transition: "zoom" },
    { startMs: 26200, endMs: 33400, label: "Promise", layout: "statement", eyebrow: "Our promise", headline: "Clear work is *lighter* work.", visual: "lightleak", motion: "calm", transition: "dip" },
    { startMs: 33400, endMs: 40000, label: "Outro", layout: "outro", headline: "Turn the lights *on*.", sub: "lumen.example", visual: "rings", motion: "calm", transition: "flash" },
  ],
};
