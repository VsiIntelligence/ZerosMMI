/**
 * The studio template: a complete multi-file website built deterministically from the person's own words with the Zeros Web Kit
 * (design tokens, base + component CSS, shared header/footer, five pages, 404, scripts, plan, design rules, README, favicon).
 * Used when the model cannot be reached, and verified by exactly the same checks as a model-written site.
 */
import { normalizeBrief } from "./web/kit";
import { buildSiteFromBrief } from "./web/site";

export function buildFallbackWebProject(prompt: string): { files: Record<string, string> } {
  const brief = normalizeBrief({}, (prompt || "Studio Site").replace(/[<>]/g, "").trim() || "Studio Site");
  return { files: buildSiteFromBrief(brief) };
}
