/**
 * Zeros' short witty lines for modes whose result bubble is written by the app (not by the model).
 * Deterministic per prompt, so the same request always gets the same quip and no two modes sound alike.
 */
type Mode = "image" | "model" | "music" | "video" | "web";

const BANK: Record<Mode, string[]> = {
  image: [
    "Fresh off the pixel press: **{p}** — I only argued with the lighting twice. 🎨",
    "**{p}**, rendered. Somewhere a graphics card is asking for a raise. 🖼️✨",
    "One **{p}**, served at the perfect temperature of 'wait, that's actually gorgeous'. 🔥",
    "You asked for **{p}**. I asked the universe nicely. Here's what we got. 🌌",
    "Plot twist: **{p}** came out better than my self-confidence. 😎",
  ],
  model: [
    "**{p}** is out of the forge — millions of tiny particles fused into one clean mesh, zero glue guns. 🧬✨",
    "Particles reported for duty, merged into **{p}**, and refused to talk about the paperwork. 🫧🔩",
    "Sculpted **{p}** from a cloud of pure intention. Spin it, zoom in, judge it lovingly. 🌀",
    "**{p}**: particles in, watertight mesh out. Blender wishes it were this punctual. 🛠️",
  ],
  music: [
    "**{p}** is mixed, mastered and mildly emotional. Headphones recommended. 🎧🔥",
    "Wrote it, played every instrument, and sang all of it myself. No band drama, 100% vibes. 🎤✨",
    "Your track **{p}** just walked out of the studio looking unreasonably cool. 🎶😎",
    "I composed, arranged, and mixed this one personally — consider it a love letter in 4/4. 🥁💛",
  ],
  video: [
    "**{p}** is in the can — scored, voiced and rendered frame by frame. Popcorn optional. 🍿🎬",
    "Lights, camera, GPU. Your film **{p}** is ready for its premiere. ✨🎞️",
    "Cut! Print! **{p}** came out cinematic enough to need a red carpet. 🎥🔥",
    "Directed, animated, scored. The only thing I didn't do is make the popcorn. 🍿😄",
  ],
  web: [
    "Site shipped: designed, built, clicked through, and screenshot-checked before you even asked. ⚡",
    "Your website is live in preview — I poked every button so you don't have to. 🕵️‍♂️✨",
  ],
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function quip(mode: Mode, prompt: string): string {
  const bank = BANK[mode];
  const p = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || "your idea";
  return (bank[hash(prompt) % bank.length] ?? bank[0] ?? "").replace("{p}", p);
}
