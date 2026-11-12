import { createFileRoute } from "@tanstack/react-router";
import { engineJson, type ImageInput } from "@/lib/engine.server";
import { WEIGHTS } from "@/lib/billing.server";
import { charge, requireAccess } from "@/lib/access.server";

const SYSTEM = `You are ZEROS QA - the senior art director and front-end reviewer of a premium design studio.
You receive SCREENSHOTS of a generated website (desktop and mobile), the original BRIEF, and a list of AUTOMATED FINDINGS.
Judge what a paying client would judge in five seconds, then in five minutes:
- first impression: is there a clear focal point, confident hierarchy, a distinct visual identity (not a generic template)?
- typography: pairing, scale, line length, weight contrast; spacing rhythm; alignment to a grid
- colour: palette discipline, contrast, accent usage; dark/light consistency
- polish: cards, buttons, borders, shadows, imagery/illustration quality, empty or broken areas, overlapping or cramped elements
- content: real, specific copy that matches the brief (no lorem ipsum, no placeholder names, no "coming soon" filler)
- responsiveness: does the phone screenshot stack sensibly, is text readable, are tap targets big enough?
Scoring guide: 90+ studio-grade, 80-89 strong, 70-79 acceptable, below 70 needs work. Be strict but fair - do not invent problems
you cannot see. Use the automated findings as facts; do not repeat them unless the screenshot shows extra context.
Severity: "blocker" = breaks the experience (blank/unreadable/overlapping sections, missing hero content, layout collapse);
"major" = clearly hurts quality (weak hierarchy, ugly spacing, bland/generic look, low contrast areas);
"minor" = polish. Every issue needs a concrete "fix" a developer can apply (name the selector/section and the change).
Return ONLY JSON:
{"score":0-100,"verdict":"pass"|"fix","summary":"two sentences","issues":[{"severity":"blocker|major|minor","page":"index.html","problem":"...","fix":"..."}],"strengths":["..."]}
Maximum 8 issues. verdict is "pass" only when there are no blockers and the score is at least 72.`;

type Shot = { page?: string; viewport?: string; dataUrl?: string };

function toImage(dataUrl: string): ImageInput | null {
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[2]!.length > 900_000) return null;
  return { mimeType: m[1]!, data: m[2]! };
}

export const Route = createFileRoute("/api/verify-site")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = await requireAccess(request);
        if (!gate.ok) return gate.response;
        let body: { brief?: string; files?: string[]; automated?: string[]; screenshots?: Shot[] };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: "bad json" }, { status: 400 });
        }
        const shots = (Array.isArray(body.screenshots) ? body.screenshots : []).slice(0, 4);
        const images: ImageInput[] = [];
        const labels: string[] = [];
        for (const s of shots) {
          const img = typeof s.dataUrl === "string" ? toImage(s.dataUrl) : null;
          if (!img) continue;
          images.push(img);
          labels.push(`Image ${images.length}: ${s.page ?? "page"} - ${s.viewport ?? "desktop"}`);
        }
        if (!images.length) return Response.json({ error: "no screenshots" }, { status: 400 });

        const prompt =
          `BRIEF:\n${String(body.brief ?? "").slice(0, 1500) || "(not provided)"}\n\n` +
          `FILES: ${(body.files ?? []).slice(0, 30).join(", ")}\n\n` +
          `AUTOMATED FINDINGS:\n${(body.automated ?? []).slice(0, 20).map((a) => `- ${String(a).slice(0, 220)}`).join("\n") || "(none)"}\n\n` +
          `SCREENSHOTS (in order):\n${labels.join("\n")}`;

        const paid = await charge(gate.access, WEIGHTS.review);
        if (!paid.ok) return paid.response;
        const out = await engineJson<Record<string, unknown>>(SYSTEM, prompt, {
          images,
          maxTokens: 2500,
          timeoutMs: 45000,
          temperature: 0.2,
        });
        if (!out) { await paid.refund(); return Response.json({ error: "reviewer unavailable" }, { status: 502 }); }
        return Response.json(out);
      },
    },
  },
});
