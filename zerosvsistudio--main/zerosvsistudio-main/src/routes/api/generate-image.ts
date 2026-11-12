import { createFileRoute } from "@tanstack/react-router";
import { generateEngineImage, imageEngineConfigured } from "@/lib/image-engine.server";
import { engineBImageBytes, engineJson, nativeImageBytes, type ImageInput } from "@/lib/engine.server";
import { illustrate, mergePrompt } from "@/lib/image-fallback.server";
import { appOrigin } from "@/lib/app-origin.server";
import { WEIGHTS } from "@/lib/billing.server";
import { charge, requireAccess } from "@/lib/access.server";

const ENHANCE_SYSTEM = `You are a world-class prompt engineer for text-to-image models.
Rewrite the user's idea as ONE vivid image prompt (max 90 words): subject, setting, composition and camera (lens, angle), lighting, colour palette, mood, medium or style, and quality cues.
Keep the user's intent and every named subject, piece of text or style they asked for EXACTLY. Never add text, logos or watermarks unless asked. If the idea is already rich, only polish it.
Return ONLY JSON: {"prompt":"..."}`;

async function enhancePrompt(prompt: string): Promise<string> {
  if (prompt.length > 420) return prompt;
  try {
    const out = await engineJson<{ prompt?: string }>(ENHANCE_SYSTEM, prompt, { maxTokens: 320, timeoutMs: 5000, temperature: 0.7 });
    const better = out?.prompt?.trim();
    return better && better.length > 12 ? better.slice(0, 900) : prompt;
  } catch {
    return prompt;
  }
}

/** The app's own address as a host name: the picture service accepts requests that name it. */
function referrerOf(request: Request): string {
  try { return new URL(appOrigin(request)).hostname; } catch { return ""; }
}

/** The value, or null when `ms` passes first. */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

export type MadeImage = { bytes: Uint8Array; mimeType: string; /** How it was made: a picture model, or drawn by Zeros as an illustration. */ drawn: boolean; prompt: string };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Makes a picture, never giving up while any way of making one is left:
 *  1. when changing an existing picture: the text service's picture models, shown the picture itself;
 *  2. the first picture service, when it is set up;
 *  3. the text service's picture models (named in the settings, or whatever it offers);
 *  4. the second text service's picture endpoint;
 *  5. a drawn illustration, so a person gets a picture even when no picture model can be reached.
 * Every failure is kept short for the log; what the person sees never names a service.
 */
async function makeImage(
  prompt: string,
  size: { width?: number | undefined; height?: number | undefined } | undefined,
  referrer: string,
  edit: { base?: ImageInput | undefined; previousPrompt?: string | undefined } = {},
): Promise<MadeImage> {
  const problems: string[] = [];
  // "the same, but at night": the change is merged into the picture's own prompt so nothing else about it drifts.
  const merged = edit.previousPrompt ? ((await within(mergePrompt(edit.previousPrompt, prompt), 9000)) ?? `${edit.previousPrompt.slice(0, 700)}. Change: ${prompt.slice(0, 400)}`) : prompt;
  const enhanced = edit.previousPrompt ? merged : ((await within(enhancePrompt(merged), 4000)) ?? merged);

  if (edit.base) {
    try {
      const out = await nativeImageBytes(`Change this picture as follows, keeping everything else exactly the same: ${prompt}`, 40_000, edit.base);
      return { ...out, drawn: false, prompt: enhanced };
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "failed");
    }
  }
  if (imageEngineConfigured()) {
    try {
      const result = await generateEngineImage(enhanced, { ...size, referrer, budgetMs: 25_000 });
      return { bytes: result.bytes, mimeType: result.mimeType, drawn: false, prompt: enhanced };
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "failed");
    }
  }
  try {
    return { ...(await nativeImageBytes(enhanced, 30_000)), drawn: false, prompt: enhanced };
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "failed");
  }
  const second = await engineBImageBytes(enhanced, size ?? {}, 30_000).catch(() => null);
  if (second) return { ...second, drawn: false, prompt: enhanced };

  const drawing = await illustrate(enhanced, size ?? {}).catch(() => null);
  if (drawing) {
    console.warn("[Zeros] No picture model could be reached, so the picture was drawn as an illustration. Problems:", problems.join(" | "));
    return { bytes: encode(drawing), mimeType: "image/svg+xml", drawn: true, prompt: enhanced };
  }
  console.error("[Zeros] Picture creation failed:", problems.join(" | "));
  throw new Error("Picture creation failed (" + ([...new Set(problems)].slice(0, 2).join(", ") || "no picture service is set up") + "). Please try again in a moment.");
}

/**
 * Makes one picture. Signed in with a plan or promo only, and each picture counts as one request against the 24-hour allowance.
 * (There is deliberately no GET form: an <img> tag cannot carry a login, so a URL anyone could open would be free images for everyone.)
 */
export const Route = createFileRoute("/api/generate-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = await requireAccess(request);
        if (!gate.ok) return gate.response;
        let body: { prompt?: string; width?: number; height?: number; previousPrompt?: string; base?: { mimeType?: string; data?: string } } = {};
        try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: "Send JSON: { prompt }" }, { status: 400 }); }
        const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1500) : "";
        if (!prompt) return Response.json({ error: "Prompt required" }, { status: 400 });

        // A picture to change travels as base64 (a few megabytes at most) together with what it was made from.
        const base = body.base && typeof body.base.data === "string" && body.base.data.length > 100 && body.base.data.length < 4_500_000 && /^image\/(?:png|jpeg|webp)$/.test(body.base.mimeType ?? "") && /^[A-Za-z0-9+/=\s]+$/.test(body.base.data)
          ? { mimeType: body.base.mimeType!, data: body.base.data.replace(/\s+/g, "") }
          : undefined;
        const previousPrompt = typeof body.previousPrompt === "string" && body.previousPrompt.trim() ? body.previousPrompt.trim().slice(0, 900) : undefined;

        const paid = await charge(gate.access, WEIGHTS.image);
        if (!paid.ok) return paid.response;
        try {
          const made = await makeImage(prompt, { width: body.width, height: body.height }, referrerOf(request), { base, previousPrompt });
          return new Response(made.bytes as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": made.mimeType,
              "Cache-Control": "no-store",
              // what this picture was made from (so "change it" can build on it) and whether it was drawn; neither names a service
              "X-Zeros-Prompt": encodeURIComponent(made.prompt.slice(0, 800)),
              ...(made.drawn ? { "X-Zeros-Style": "illustration" } : {}),
            },
          });
        } catch (error) {
          await paid.refund();
          return Response.json({ error: error instanceof Error ? error.message : "Picture creation failed. Please try again." }, { status: 502 });
        }
      },
    },
  },
});
