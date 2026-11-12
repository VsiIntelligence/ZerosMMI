/**
 * The director. Turns a request into a film script the Cinema Engine can always render:
 *   research (verified facts) -> treatment + semantic scenes -> parse (one stricter retry) -> pre-flight lint -> targeted repair -> honest fallback.
 * Dependency-injected (streamChat, measure) so every path is testable without a network.
 */
import type { Msg } from "@/lib/ai-client";
import type { ZeroMode } from "@/lib/zeros";
import { isBoringLine, stripBoringOpener } from "@/lib/voice-guard";
import { lintVideoSpec, type LintResult } from "@/lib/video-lint";
import { MAX_FILM_SEC, MIN_FILM_SEC, fallbackVideoSpec, requestedSeconds, tryParseVideoSpec, type VideoSpec } from "@/lib/video-spec";
import { researchBlock, researchTopic, type Research } from "@/lib/research";
import type { Measure } from "@/lib/video/layouts";

type StreamChat = (messages: Msg[], mode: ZeroMode, memories: string[], onDelta: (full: string) => void) => Promise<string>;

export type VideoBuild = {
  spec: VideoSpec; lint: LintResult;
  /** the director's own funny opening line (empty if it was missing or boring) */
  witty: string;
  usedFallback: boolean; repaired: boolean; attempts: number;
  warnings: string[]; facts: string[];
  research: Research;
};

/** Issues the model is better placed to fix than the engine (copy and structure, not geometry). */
const REPAIRABLE = new Set(["reading-time", "small-text", "hook", "headline", "caption-zone", "scene-count", "variety", "out-of-frame", "text-overlap", "outro", "duration"]);

/** The opening line is whatever precedes the JSON, if it is not itself boring. */
export function openingLine(reply: string): string {
  const head = reply.slice(0, Math.max(0, reply.indexOf("{"))).replace(/```(?:json)?/gi, "").trim();
  if (!head) return "";
  const first = stripBoringOpener(head).split(/\n/)[0]?.trim() ?? "";
  return first && first.length <= 220 && !isBoringLine(first) ? first : "";
}

export const repairPrompt = (lint: LintResult, spec: VideoSpec): string => {
  const issues = lint.issues.filter((i) => i.severity !== "info" && !i.fixed && (i.severity === "error" || REPAIRABLE.has(i.code))).slice(0, 8).map((i) => `- ${i.message}`).join("\n");
  return `The pre-flight check on your script found problems:\n${issues}\n\nFix them: shorten crowded copy, keep headlines under 8 words, keep scene timing contiguous, keep the film between 20 and 45 seconds, and vary layouts and transitions. Keep every idea, the palette, the brand, the audio block and the narration intent. Reply with ONLY the corrected JSON object (no opening line, no code fences, no commentary).\n\nYour current script:\n${JSON.stringify({ title: spec.title, durationSec: spec.durationSec, style: spec.style, brand: spec.brand, palette: spec.palette, fontStyle: spec.fontStyle, audio: spec.audio, scenes: spec.scenes })}`;
};

/** Adds the research notes and the target length to the person's latest message (never mutates the history). */
export function withBrief(history: Msg[], brief: string): Msg[] {
  if (!brief || !history.length) return history;
  const last = history[history.length - 1]!;
  if (last.role !== "user") return [...history, { role: "user", content: brief }];
  return [...history.slice(0, -1), { ...last, content: `${last.content}\n\n${brief}` }];
}

export async function buildVideo(args: {
  prompt: string; history: Msg[]; memories: string[]; streamChat: StreamChat;
  onStatus: (s: string) => void; measure?: Measure;
  /** The film this one changes (its complete script), so "make scene 2 darker" revises that film instead of writing a new one. */
  previous?: VideoSpec | null;
}): Promise<VideoBuild> {
  const { prompt, memories, streamChat, onStatus, previous } = args;
  const history: Msg[] = previous
    ? [...args.history.slice(0, -1), { role: "user", content: `${args.prompt}\n\nThis is an EDIT of the film below. Return the COMPLETE script again with only the requested change made. Keep the title, palette, fonts, scenes, timing and narration that the request does not touch.\nPREVIOUS SCRIPT (JSON):\n${JSON.stringify(previous).slice(0, 14000)}` }]
    : args.history;
  const lintOpts = args.measure ? { measure: args.measure } : {};
  const warnings: string[] = [];
  let attempts = 1, repaired = false, usedFallback = false, witty = "";

  /* 0 - research first: verified facts from a time-boxed search (never blocks, never invents) */
  onStatus("Researching the subject…");
  const research = await researchTopic({ kind: "video", request: prompt, streamChat, memories });
  const target = requestedSeconds(prompt);
  const brief = [
    research.found || research.angle || research.audience ? researchBlock(research) : "",
    `TARGET LENGTH: ${target ? `about ${Math.round(Math.min(MAX_FILM_SEC, Math.max(MIN_FILM_SEC, target)))} seconds` : "your choice, usually about 30 seconds"} (films run ${MIN_FILM_SEC}-${MAX_FILM_SEC} seconds).`,
  ].filter(Boolean).join("\n\n");
  const directed = withBrief(history, brief);
  // (an edit keeps the previous film's research, so the revised film stays grounded in the same facts)

  /* 1 - treatment (the plan) + semantic scenes */
  onStatus("Planning the treatment and storyboard…");
  let raw = "";
  try { raw = await streamChat(directed, "video", memories, (full) => onStatus(`Directing… ${(full.match(/"layout"/g) ?? []).length} scenes drafted`)); } catch (e) { warnings.push(`The director hit an error (${e instanceof Error ? e.message : "unknown"}).`); }
  witty = openingLine(raw);
  let spec = raw ? tryParseVideoSpec(raw, prompt) : null;

  /* 2 - one stricter retry when the reply was not usable JSON */
  if (!spec) {
    attempts++;
    onStatus("The first draft was not valid JSON; re-directing…");
    try {
      raw = await streamChat([...directed, { role: "assistant", content: raw.slice(0, 600) || "(no reply)" }, { role: "user", content: "That was not a valid script. Reply with ONLY the JSON object described in your instructions: no code fences, no prose before or after it, every string closed, at least 6 scenes." }], "video", memories, (full) => onStatus(`Directing… ${(full.match(/"layout"/g) ?? []).length} scenes drafted`));
      spec = tryParseVideoSpec(raw, prompt);
    } catch { /* fall through to the studio template */ }
  }
  if (!spec) {
    usedFallback = true;
    spec = fallbackVideoSpec(prompt);
    warnings.push(...spec.warnings);
  }

  /* 3 - pre-flight */
  onStatus("Pre-flight checks…");
  let lint = lintVideoSpec(spec, lintOpts);

  /* 4 - targeted repair, kept only if it genuinely improves the script */
  const actionable = lint.issues.filter((i) => !i.fixed && (i.severity === "error" || (i.severity === "warn" && REPAIRABLE.has(i.code))));
  if (!usedFallback && (actionable.some((i) => i.severity === "error") || actionable.length >= 3)) {
    attempts++;
    onStatus("Polishing the script…");
    try {
      const fixed = await streamChat([...directed, { role: "assistant", content: JSON.stringify({ title: spec.title, scenes: spec.scenes.length }) }, { role: "user", content: repairPrompt(lint, spec) }], "video", memories, () => undefined);
      const candidate = tryParseVideoSpec(fixed, prompt);
      if (candidate) {
        const l2 = lintVideoSpec(candidate, lintOpts);
        if (l2.score > lint.score) { spec = candidate; lint = l2; repaired = true; }
      }
    } catch { /* a failed polish never costs the film: keep the original */ }
  }
  for (const i of lint.issues) if (!i.fixed && i.severity === "error") warnings.push(i.message);
  if (lint.score < 70 && !usedFallback) warnings.push("The pre-flight score is modest; the film will render, but ask for a tighter script if it feels crowded.");

  /* 5 - the film carries its research and plan, so the report and the commentary can cite them */
  const finalSpec: VideoSpec = { ...lint.spec, ...(research.found ? { research: research.facts } : {}) };
  const layouts = [...new Set(finalSpec.scenes.map((s) => s.layout))];
  const facts = [
    `Film: "${finalSpec.title}", ${finalSpec.durationSec}s, ${finalSpec.scenes.length} scenes (${layouts.join(", ")})`,
    finalSpec.plan?.keyMessage ? `Treatment: ${finalSpec.plan.keyMessage}${finalSpec.plan.metaphor ? ` (metaphor: ${finalSpec.plan.metaphor})` : ""}` : "",
    research.found ? `Research: ${research.facts.slice(0, 3).join("; ")}` : "Research: no public information found, so the film is built from the request alone",
    `Palette: ${finalSpec.palette.bg} background with ${finalSpec.palette.accent} / ${finalSpec.palette.accent2} accents, ${finalSpec.fontStyle} type`,
    finalSpec.brand ? `Brand: ${finalSpec.brand.name} (${finalSpec.brand.mark} mark)` : "",
    `Score: ${finalSpec.audio.genre}, ${finalSpec.audio.bpm} BPM, ${finalSpec.audio.key}; ${finalSpec.audio.voiceoverLines.length} narration lines`,
    `Pre-flight check: ${lint.score}/100 with ${lint.fixes.length} automatic fixes${repaired ? " plus a script repair pass" : ""}`,
    ...finalSpec.scenes.slice(0, 4).map((s) => `Scene "${s.label}": ${s.layout}${s.headline ? ` - "${s.headline.replace(/\*/g, "")}"` : ""}`),
  ].filter(Boolean);
  return { spec: finalSpec, lint, witty, usedFallback, repaired, attempts, warnings, facts, research };
}
