import { createFileRoute } from "@tanstack/react-router";
import { engineJson, type ImageInput } from "@/lib/engine.server";
import { WEIGHTS } from "@/lib/billing.server";
import { charge, requireAccess } from "@/lib/access.server";

const SYSTEM = `You are ZEROS 3D QA - a senior 3D artist reviewing a procedurally generated model.
You receive STILL RENDERS of the finished mesh (front three-quarter, side, back three-quarter), the user's original REQUEST, and measured MESH STATS.
Decide, like a client would: does it look like what was asked? Judge silhouette and proportions, recognisable features, missing or malformed parts, floating or disconnected pieces, lumpy or noisy surfaces, colour choices, level of detail, and polish.
Scoring: 90+ outstanding, 80-89 good, 70-79 acceptable, below 70 needs work. "matches" is false when the subject is not recognisable or major requested parts are missing.
Be strict but fair; do not invent problems you cannot see. Every issue needs a concrete fix a programmer can apply to the signed-distance program (name the part, the direction and rough amounts, e.g. "make the ears 40% taller and move them back 0.08").
Return ONLY JSON: {"score":0-100,"matches":true|false,"summary":"one or two sentences","issues":[{"severity":"blocker|major|minor","problem":"...","fix":"..."}],"strengths":["..."]}
Maximum 6 issues.`;

type Shot = { name?: string; dataUrl?: string };

function toImage(dataUrl: string): ImageInput | null {
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[2]!.length > 700_000) return null;
  return { mimeType: m[1]!, data: m[2]! };
}

export const Route = createFileRoute("/api/verify-model")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = await requireAccess(request);
        if (!gate.ok) return gate.response;
        let body: { request?: string; stats?: Record<string, unknown>; views?: Shot[]; notes?: string[] };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: "bad json" }, { status: 400 });
        }
        const images: ImageInput[] = [];
        const labels: string[] = [];
        for (const v of (Array.isArray(body.views) ? body.views : []).slice(0, 4)) {
          const img = typeof v.dataUrl === "string" ? toImage(v.dataUrl) : null;
          if (!img) continue;
          images.push(img);
          labels.push(`Image ${images.length}: ${v.name ?? "view"}`);
        }
        if (!images.length) return Response.json({ error: "no views" }, { status: 400 });
        const prompt =
          `REQUEST:\n${String(body.request ?? "").slice(0, 800)}\n\nMESH STATS:\n${JSON.stringify(body.stats ?? {}).slice(0, 600)}\n\n` +
          `AUTOMATED NOTES:\n${(body.notes ?? []).slice(0, 8).map((n) => `- ${String(n).slice(0, 200)}`).join("\n") || "(none)"}\n\nVIEWS:\n${labels.join("\n")}`;
        const paid = await charge(gate.access, WEIGHTS.review);
        if (!paid.ok) return paid.response;
        // A busy moment must not weaken the quality check: the reviewer is asked again (after a pause) before giving up.
        const out = await (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const got = await engineJson<Record<string, unknown>>(SYSTEM, prompt, { images, maxTokens: 1800, timeoutMs: 40000, temperature: 0.2 });
            if (got && typeof got["score"] === "number") return got;
            await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
          }
          return null;
        })();
        if (!out) { await paid.refund(); return Response.json({ error: "reviewer unavailable" }, { status: 502 }); }
        return Response.json(out);
      },
    },
  },
});
