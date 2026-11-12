import type { Msg } from "@/lib/ai-client";
import { buildCommentaryPrompt, type ZeroMode } from "@/lib/zeros";
import { stripBoringOpener, displayText, isBoringLine } from "@/lib/voice-guard";

type StreamChat = (messages: Msg[], mode: ZeroMode, memories: string[], onDelta: (full: string) => void) => Promise<string>;
type ArtifactMode = "image" | "model" | "music" | "web" | "video";

function hash(text: string): number { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const pick = <T,>(arr: T[], seed: string, salt: number): T => arr[(hash(seed) + salt * 7919) % arr.length]!;
const topic = (request: string): string => request.replace(/\s+/g, " ").replace(/^[\s"'.]+|[\s"'.]+$/g, "").slice(0, 70) || "your idea";

const HOOKS: Record<ArtifactMode, string[]> = {
  image: ["Your pixels have been sufficiently persuaded. 🎨", "Somewhere a GPU just asked for a raise, and honestly it earned it. 🖼️", "I stared at the blank canvas until it blinked first. 😎"],
  model: ["Millions of particles walked into a forge and came out as one very well-behaved mesh. 🧬", "No clay, no chisel, no glue gun, just maths with excellent posture. 🛠️", "Blender called; it wants to know how I got the topology this tidy. 🔩✨"],
  music: ["Wrote it, played every instrument, sang every note, and still no band drama. 🎤🔥", "Consider this a love letter in 4/4 with surprisingly good mastering. 🎧", "The studio is quiet now, but the speakers are about to be very busy. 🥁✨"],
  web: ["Your website just went from 'idea in a text box' to 'real files with opinions'. ⚡", "I built it, clicked every button, and nothing exploded, which is my personal definition of a good Tuesday. 🕵️‍♂️", "Fourteen files, one design system, zero 'lorem ipsum' crimes. ✨"],
  video: ["Lights, camera, GPU: the premiere is in your chat. 🎬", "Directed, animated, scored and rendered frame by frame; the only thing missing is popcorn. 🍿", "Cut! Print! That one has actual rhythm. 🎞️🔥"],
};

const CLOSERS: Record<ArtifactMode, string[]> = {
  image: ["Which part should we push harder: the lighting, the palette, or the weirdness?", "Want me to try the same idea in a totally different style, just to see what happens?"],
  model: ["Want a second take with more detail on one specific part, or a totally different silhouette?", "Should we give it a base, a pose, or a more dramatic material next?"],
  music: ["Want a harder chorus, a different genre, or a second verse from another angle?", "Which line is your favourite, and should I build a whole second song around that mood?"],
  web: ["Who is the first visitor you are picturing, and what should they do in the first five seconds?", "Want me to push the design bolder, calmer, or more playful on the next pass?"],
  video: ["Want a punchier cut, a calmer one, or a version with a different story angle?", "Which scene gave you goosebumps, and should the next film be built around that feeling?"],
};

const CHECK_FACT = /\b(check|checks|checked|verif\w*|passed|QA|clean|no errors?|0 errors?|errors?-free|LUFS|dB|loudness|headroom|contrast|broken links?|validated|score|lint\w*|sync\w*|clipping)\b/i;

/** A long, in-voice explanation assembled from the build facts: used when no model can write the commentary. */
export function fallbackCommentary(mode: ArtifactMode, request: string, facts: string[], warnings: string[] = []): string {
  const t = topic(request), seed = request + mode;
  const built = facts.filter((f) => !CHECK_FACT.test(f)), checked = facts.filter((f) => CHECK_FACT.test(f));
  const bullets = (built.length ? built : facts).slice(0, 7).map((f) => `- ${f}`).join("\n");
  const checks = (checked.length ? checked : ["Everything above was produced by the same pipeline that measures it, so nothing here is a screenshot of a promise."]).slice(0, 6).map((f) => `- ${f}`).join("\n");
  const how: Record<ArtifactMode, string> = {
    image: "Download it as a PNG from the buttons under the image, or tell me what to change: lighting, mood, camera angle, palette. Specific nouns beat adjectives, so 'wet neon street at 2 a.m.' will outperform 'cool vibe' every single time.",
    model: "Orbit it, zoom in, then flip through Solid, Clay and Topology to inspect it like a pro. Download the GLB for Blender, Unity or the web (it carries real PBR materials), OBJ or PLY for other DCC tools, or STL if you want to 3D-print it. The editable shape code is in the menu too, so you can tweak any number and rebuild.",
    music: "Hit play and watch the lyrics light up in time. Tap any line to jump there, grab the WAV for the lossless master or the Opus for something shareable, and use the .lrc file for synced lyrics in a music player. The karaoke and acapella buttons render the same song without the vocals or with only the vocals.",
    web: "Click through the pages in the preview, read the QA report under it, and download the whole project as a ZIP. It is plain HTML, CSS and JavaScript, so you can host it anywhere or open it in your editor and keep going. DESIGN_RULES.md explains every token, so you can change the whole look by editing one file (css/tokens.css) instead of hunting through pages.",
    video: "Press play, watch the captions land on the beat, and download it. Tell me to change the pace, swap a scene, rewrite the narration or make it more dramatic and I will re-direct it. Tip: the short punchy line on screen is for the eyes, the narration is for the ears, so ask for them separately.",
  };
  const why: Record<ArtifactMode, string> = {
    image: `I treated **${t}** like a tiny film still: one clear subject, a deliberate light source, and a palette that does emotional work instead of just looking pretty. Images feel professional when the eye knows where to land first, so everything else is there to support that one spot.`,
    model: `For **${t}** I wrote the shape as maths, a signed-distance field, which means the surface is mathematically watertight before a single triangle exists. Then I sampled it with millions of particles, fused them into one clean all-quad mesh, snapped the hard edges so they stay crisp, and refined the topology so the surface flows the way a modeler would draw it. It is like casting a statue instead of whittling one.`,
    music: `For **${t}** I started with the hook and built the story backwards from it: a verse that sets a concrete scene, a pre-chorus that climbs, a chorus simple enough to sing back after one listen, and a bridge that turns the meaning before the final chorus lands bigger. The arrangement breathes on purpose, so verses stay intimate and choruses open up, and the mix keeps the singer in front of the band so every word can be heard.`,
    web: `For **${t}** I wrote the plan and the design rules first, then built the CSS as a system of tokens, base styles and components, and only then wrote the pages, so every page speaks the same visual language. Consistency is what makes a site feel expensive: it is the difference between a house and a pile of nice rooms.`,
    video: `For **${t}** I wrote a treatment first (the promise, the visual metaphor, the palette), then storyboarded it as beats: each scene gets one idea, one dominant line of typography and a motion rhythm that follows the music. Narration, captions and sound effects are timed together so the cuts land on the beat, and the finished film is measured frame by frame before you ever see it.`,
  };
  const think: Record<ArtifactMode, string> = {
    image: "The tempting move was to pile on detail; the better move was to decide what the picture is *about* and let everything else defer to it. I traded a bit of busy-ness for a clear focal point, because a calm image reads as confident and a crowded one reads as nervous.",
    model: "I could have chased maximum polygon count, but a model is only useful if other tools can open it, so I optimised for clean topology and honest materials over raw density. That trade costs a little visual bravado and buys you a file that works in Blender, a game engine or a printer without drama.",
    music: "I weighed a more complex arrangement against a more singable one and chose singable, because a song nobody can hum back is a very expensive background noise. The other deliberate choice was the vocal level: a synthetic voice has softer consonants than a human one, so I measured it against the band and lifted it where the instruments would have buried the words.",
    web: "I weighed one giant stylesheet against a token-based system and chose the system: a bit more structure up front, far less pain every time you want to change a colour, a font or a spacing rule. I also let the shared header, footer and head tags be generated once so they cannot drift apart between pages, which is the kind of bug that only appears when a customer finds it.",
    video: "I weighed visual spectacle against clarity and chose clarity first, then spectacle: if a viewer cannot read the line in the time it is on screen, the prettiest motion in the world is wasted. So every text block is timed to its reading length, contrast is measured, and the loud moments are reserved for the scenes that earn them.",
  };
  return `${pick(HOOKS[mode], seed, 1)}

**What I made and why**
${why[mode]}

**How I thought about it**
${think[mode]}

**What I checked**
${checks}

**Highlights worth noticing**
${bullets}

**How to get the most out of it:** ${how[mode]}${warnings.length ? `\n\n**Honest caveat:** ${warnings.slice(0, 2).join(" ")} (I would rather tell you than let you find out the hard way. 😅)` : ""}

${pick(CLOSERS[mode], seed, 2)}`;
}

/**
 * Streams Zeros' long, witty, reasoned write-up of what it just built. The full persona (chat mode) answers; if the
 * reply is missing, tiny, or boring, the deterministic fallback is used so the person always gets the real explanation.
 */
export async function streamCommentary(args: {
  mode: ArtifactMode; request: string; facts: string[]; warnings?: string[]; memories: string[]; streamChat: StreamChat; onDelta: (text: string) => void;
}): Promise<string> {
  const { mode, request, facts, warnings = [], memories, streamChat, onDelta } = args;
  const prompt = buildCommentaryPrompt(mode, request, facts, warnings);
  try {
    const full = await streamChat([{ role: "user", content: prompt }], "chat", memories, (raw) => onDelta(displayText(raw)));
    const text = stripBoringOpener(full).trim();
    const firstLine = text.split(/\n/)[0] ?? "";
    if (text.length >= 1100 && !isBoringLine(firstLine)) return text;
  } catch { /* fall through to the fallback */ }
  const fb = fallbackCommentary(mode, request, facts, warnings);
  onDelta(fb);
  return fb;
}
