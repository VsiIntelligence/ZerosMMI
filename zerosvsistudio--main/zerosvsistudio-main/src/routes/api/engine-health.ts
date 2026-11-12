import { createFileRoute } from "@tanstack/react-router";
import { describeEngines, nativeImageBytes } from "@/lib/engine.server";
import { generateEngineImage, imageEngineConfigured } from "@/lib/image-engine.server";
import { readSseText, zerosRoute } from "@/lib/zeros-route.server";

/** Compares two strings without stopping at the first difference. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

type Probe = { ok: boolean; ms: number; engine?: string; model?: string; sample?: string; error?: string };
async function timed(work: () => Promise<Omit<Probe, "ms" | "ok"> | null>): Promise<Probe> {
  const t0 = Date.now();
  try {
    const out = await work();
    return out ? { ok: true, ms: Date.now() - t0, ...out } : { ok: false, ms: Date.now() - t0, error: "no engine answered" };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
  }
}

/**
 * For the owner only (set ZEROS_ADMIN_TOKEN to at least 16 characters, then send it as a bearer token). It answers "why can't Zeros
 * reach its reasoning engine / make a picture?" in one call:
 *   GET /api/engine-health                 what is configured and what failed lately (never a key)
 *   GET /api/engine-health?discover=1      also asks each engine which models it really offers
 *   GET /api/engine-health?probe=1         also makes a live test call on the chat path, the 3D path and the picture path
 */
export const Route = createFileRoute("/api/engine-health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = (process.env["ZEROS_ADMIN_TOKEN"] ?? "").trim();
        const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        // Disabled (and indistinguishable from a missing page) unless the owner set a long token and it was sent.
        if (secret.length < 16 || !sameSecret(given, secret)) return new Response("Not found", { status: 404 });
        const params = new URL(request.url).searchParams;
        const report = await describeEngines({ discover: params.get("discover") === "1" });
        const picturesConfigured = { dedicated: imageEngineConfigured(), engineAModels: ((process.env["ZEROS_A_IMAGE_MODELS"] ?? "").split(",").filter((s) => s.trim()).length) };
        let probe: Record<string, Probe> | undefined;
        if (params.get("probe") === "1") {
          const say = async (o: { reasoning: "fast" | "medium"; skipAgent?: boolean; heavy?: boolean }) => timed(async () => {
            const r = await zerosRoute("Reply with the single word: pong", [{ role: "user", content: "ping" }], o);
            return r ? { engine: r.engine, ...(r.model ? { model: r.model } : {}), sample: (await readSseText(r.stream)).slice(0, 60) } : null;
          });
          probe = {
            chat: await say({ reasoning: "medium" }),
            fast: await say({ reasoning: "fast" }),
            threeD: await say({ reasoning: "medium", skipAgent: true, heavy: true }),
            picture: await timed(async () => {
              if (imageEngineConfigured()) { const out = await generateEngineImage("a small red circle on white", { budgetMs: 20_000 }); return { engine: "i", model: out.model, sample: `${out.bytes.length} bytes ${out.mimeType}` }; }
              const out = await nativeImageBytes("a small red circle on white", 20_000);
              return { engine: "a", sample: `${out.bytes.length} bytes ${out.mimeType}` };
            }),
          };
        }
        return Response.json({ checkedAt: new Date().toISOString(), ...report, pictures: picturesConfigured, ...(probe ? { probe } : {}) }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
