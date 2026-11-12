import { createFileRoute } from "@tanstack/react-router";
import { isVoiceKind, voicePcmBase64 } from "@/lib/engine.server";
import { WEIGHTS } from "@/lib/billing.server";
import { charge, requireAccess } from "@/lib/access.server";

/** Narration audio for the video studio. Signed in with a plan or promo only; each clip is a small charge against the allowance. */
export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = await requireAccess(request);
        if (!gate.ok) return gate.response;
        let body: { text?: string; voice?: string } = {};
        try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: "Send JSON: { text, voice? }" }, { status: 400 }); }
        const { text, voice } = body;
        if (typeof text !== "string" || !text.trim()) return Response.json({ error: "text required" }, { status: 400 });

        const paid = await charge(gate.access, WEIGHTS.voice);
        if (!paid.ok) return paid.response;

        // Never let the voice engine stall the renderer: a slow clip fails fast so the rest of the video can finish.
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000));
        const pcm = await Promise.race([voicePcmBase64(text.slice(0, 3500), isVoiceKind(voice) ? voice : "female"), timeout]).catch(() => null);
        if (!pcm) {
          await paid.refund();
          return Response.json({ error: "Vocal generation timed out or was unavailable" }, { status: 504 });
        }
        return Response.json({ pcm, sampleRate: 24000 });
      },
    },
  },
});
