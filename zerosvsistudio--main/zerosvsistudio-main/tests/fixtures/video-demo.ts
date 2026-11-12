import type { VideoSpec } from "../../src/lib/video/types";

/** A hand-authored film that exercises every layout, transition, camera and motion level of the engine. */
export const DEMO_SPEC: VideoSpec = {
  title: "Zeros: from prompt to premiere", durationSec: 45, fps: 30, width: 1280, height: 720,
  script: "A launch film for Zeros.", style: "cinematic", background: "#090b1a", seed: 7,
  palette: { bg: "#090b1a", surface: "#12162e", text: "#f4f6ff", muted: "#9aa3c7", accent: "#6c8cff", accent2: "#ff7ad9" },
  fontStyle: "modern", captions: true, source: "model", warnings: [],
  audio: { mood: "cinematic", genre: "cinematic", bpm: 100, key: "A minor", voice: "female", sfx: true, voiceoverLines: [
    { startMs: 600, text: "Every great film starts as one small idea." },
    { startMs: 9000, text: "And ideas move faster than ever." },
    { startMs: 30000, text: "From the first prompt to the final frame." },
  ] },
  scenes: [
    { startMs: 0, endMs: 4200, label: "Hook", layout: "hero", eyebrow: "Introducing Zeros", headline: "Build the *future* in a single prompt", sub: "Songs, websites and films, made by one curious AI.", visual: "aurora", motion: "energetic", camera: "push" },
    { startMs: 4200, endMs: 8400, label: "Drop", layout: "kinetic", words: ["IDEAS", "BECOME", "SONGS", "SITES", "FILMS"], motion: "explosive", visual: "burst", transition: "flash" },
    { startMs: 8400, endMs: 12600, label: "Proof", layout: "stats", headline: "Numbers that *move*", stats: [{ value: 14, label: "files per website" }, { value: 98, suffix: "%", label: "checks passed" }, { value: 4.5, suffix: ":1", decimals: 1, label: "min contrast" }], visual: "grid", transition: "wipe" },
    { startMs: 12600, endMs: 16800, label: "Craft", layout: "cards", headline: "Craft you can *feel*", items: [{ icon: "music", title: "Songs", body: "Real vocals, mixed to be heard." }, { icon: "code", title: "Websites", body: "Fourteen real files, verified." }, { icon: "camera", title: "Films", body: "Motion design with sound." }], visual: "particles", transition: "push" },
    { startMs: 16800, endMs: 21000, label: "Engine", layout: "split", eyebrow: "One engine", headline: "Every medium, one *mind*", sub: "Plan, build, check, repair, deliver.", icon: "sparkle", visual: "orbit", transition: "zoom" },
    { startMs: 21000, endMs: 25200, label: "Checks", layout: "list", headline: "Verified, not *promised*", items: [{ icon: "check", title: "Links resolve", body: "Every page, every anchor" }, { icon: "eye", title: "Contrast measured", body: "WCAG ratios, not vibes" }, { icon: "shield", title: "No console errors", body: "Run in a real browser" }, { icon: "bolt", title: "Audio levelled", body: "Mastered to -14 LUFS" }], visual: "rings", transition: "glitch" },
    { startMs: 25200, endMs: 29400, label: "Growth", layout: "chart", headline: "Quality that *compounds*", sub: "Lyric clarity, before and after.", chart: { type: "bars", data: [{ label: "Pop", value: 11.8 }, { label: "Ballad", value: 10.8 }, { label: "Dance", value: 11.4 }, { label: "Rap", value: 11.2 }], unit: "dB" }, visual: "mesh", transition: "iris" },
    { startMs: 29400, endMs: 33600, label: "Pipeline", layout: "timeline", headline: "Five stages, zero guesswork", items: [{ title: "Treatment", body: "Idea to promise" }, { title: "Script", body: "Beats and copy" }, { title: "Lint", body: "Fix before render" }, { title: "Render", body: "Frames and sound" }, { title: "QA", body: "Measured report" }], visual: "spotlight", transition: "fade" },
    { startMs: 33600, endMs: 37800, label: "Quote", layout: "quote", quote: { text: "The best tools disappear and leave only the work.", who: "VsiStudio" }, visual: "aurora", transition: "dip", motion: "calm" },
    { startMs: 37800, endMs: 41400, label: "Climax", layout: "statement", eyebrow: "Your turn", headline: "Make something *unforgettable*.", visual: "floor", motion: "explosive", transition: "glitch" },
    { startMs: 41400, endMs: 45000, label: "Outro", layout: "outro", headline: "Start with a *single prompt*.", sub: "zeros.vsistudio", visual: "rings", transition: "flash", motion: "calm" },
  ],
};
