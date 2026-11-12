/**
 * Does "make it night" change the picture, while "draw a blue car" starts a new one? Does a request for a new 3D model leave the
 * previous model's code alone? Which earlier artifact does "the car's wheels" mean? These rules decide what gets rebuilt, so each
 * case is pinned here, including the false positives the earlier, looser rules produced.
 */
import { pickTarget, rememberedArtifacts, wantsEdit, artifactText } from "../src/lib/artifact-memory.ts";
import type { ChatAttachment } from "../src/lib/chat-attachments.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail.slice(0, 240)}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

/* ------------------------------------------------------------------ does a request change the earlier artifact? */
section("Editing an earlier artifact versus starting a new one");
const EDITS: [string, string][] = [
  ["make it night", "image"], ["change the sky to purple", "image"], ["make it darker", "image"], ["more dramatic lighting", "image"],
  ["add a rainbow", "image"], ["remove the people", "image"], ["that again but in winter", "image"], ["brighter please", "image"],
  ["make the wings bigger", "model"], ["add a tail", "model"], ["turn the head to the left", "model"], ["make the body red", "model"],
  ["make the chorus louder", "song"], ["shorter please", "song"], ["add a bridge", "song"], ["make it faster", "song"],
  ["make scene 2 darker", "video"], ["change the narration", "video"], ["the title should be bold", "video"], ["make the logo bigger", "video"],
  ["make the header blue", "web"], ["add a contact form to it", "web"], ["same site but with a dark theme", "web"], ["change the background", "web"],
];
for (const [text] of EDITS) check(`"${text}" changes the earlier artifact`, wantsEdit(text, true));
const NEW: [string, string][] = [
  ["draw a blue car", "image"], ["a sunset over mountains", "image"], ["blue car", "image"], ["make a dragon", "model"],
  ["make a red sports car", "model"], ["build a chair", "model"], ["a happy song about summer", "song"], ["make a new song about rain", "song"],
  ["create a film about the ocean", "video"], ["write a website for my bakery", "web"], ["make me a logo", "image"], ["start over with a castle", "model"],
  ["another one, a lighthouse", "image"], ["a short film about a fox", "video"],
];
for (const [text] of NEW) check(`"${text}" starts a new artifact`, !wantsEdit(text, true));
check("nothing is an edit when there is no earlier artifact", !wantsEdit("make it night", false) && !wantsEdit("change the chorus", false));
check("an empty request is never an edit", !wantsEdit("   ", true));
check("the old false positive is gone: \"draw a blue car\" after a picture is a new picture", !wantsEdit("draw a blue car", true));
check("a new 3D request does not reuse the previous model (\"make a dragon\" is new)", !wantsEdit("make a dragon", true));

/* ------------------------------------------------------------------ the earlier artifacts of a conversation */
const forge = (prompt: string, code: string): ChatAttachment => ({ kind: "forge", code, prompt });
const image = (prompt: string, src = "blob:image"): ChatAttachment => ({ kind: "image", src, prompt });
const song = (title: string, genre = "pop"): ChatAttachment => ({ kind: "song", spec: { title, bpm: 120, durationSec: 180, genre, lyrics: [] } as never });
const video = (title: string, script = ""): ChatAttachment => ({ kind: "video", spec: { title, script, brand: undefined } as never });
const site = (brief: string, title: string): ChatAttachment => ({ kind: "web", brief, project: { files: { "index.html": `<html><head><title>${title}</title></head></html>` } } });

const conversation = [
  { attachment: forge("a red dragon with gold wings", "sdf1") },
  { attachment: null },
  { attachment: image("a lighthouse in a storm", "blob:a") },
  { attachment: forge("a sports car with big wheels", "sdf2") },
  { attachment: song("Summer Nights", "pop") },
  { attachment: image("a calm harbour at dawn", "blob:b") },
  { attachment: song("Rain on the Window", "ballad") },
  { attachment: { kind: "image", src: "", prompt: "a picture that never arrived" } as ChatAttachment },
  { attachment: video("Ocean Dreams", "Waves roll in across the bay") },
  { attachment: { kind: "forge", code: "   ", prompt: "empty model" } as ChatAttachment },
  { attachment: site("a bakery website", "Sweet Bakery") },
];

section("Which earlier artifacts are remembered");
const models = rememberedArtifacts(conversation, "model");
check("3D models are remembered newest first, and an empty model is not offered for editing", models.length === 2 && models[0]!.text.includes("sports car") && models[1]!.text.includes("dragon"), JSON.stringify(models.map((m) => m.text)));
const pictures = rememberedArtifacts(conversation, "image");
check("a picture that never arrived cannot be edited, so it is not remembered", pictures.length === 2 && pictures[0]!.text.includes("harbour"), JSON.stringify(pictures.map((m) => m.text)));
const songs = rememberedArtifacts(conversation, "song");
check("songs are remembered newest first", songs[0]!.text.includes("Rain on the Window") && songs[1]!.text.includes("Summer Nights"));
check("a website's title is read from its page, so it can be found by name", artifactText(site("a bakery website", "Sweet Bakery")).includes("Sweet Bakery"));
check("the newest film is the only film remembered when there is one", rememberedArtifacts(conversation, "video").length === 1);
check("kinds never mix: a song is not offered as a 3D model", rememberedArtifacts([{ attachment: song("X") }], "model").length === 0);

section("Choosing the earlier artifact a request refers to");
check("\"the car's wheels\" finds the car, not the newer dragon", pickTarget(models, "make the car's wheels bigger")?.text.includes("sports car") === true);
check("\"the dragon's wings\" finds the dragon", pickTarget(models, "make the dragon's wings gold")?.text.includes("dragon") === true);
check("with no shared words the newest artifact is used (\"make it night\")", pickTarget(pictures, "make it night")?.text.includes("harbour") === true);
check("\"the lighthouse\" finds the older picture when it is named", pickTarget(pictures, "make the lighthouse brighter")?.text.includes("lighthouse") === true);
check("\"the rain song\" finds the rain song", pickTarget(songs, "make the rain song slower")?.text.includes("Rain") === true);
check("no artifacts means no target", pickTarget([], "make it night") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
