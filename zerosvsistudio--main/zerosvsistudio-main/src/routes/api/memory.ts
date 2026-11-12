import { createFileRoute } from "@tanstack/react-router";
import { engineJson } from "@/lib/engine.server";
import { WEIGHTS } from "@/lib/billing.server";
import { charge, requireAccess } from "@/lib/access.server";

/**
 * Zeros long-term memory extractor.
 * Given the latest exchange, returns durable facts to remember and stale facts to forget.
 * The client applies the result to the `memories` table under the signed-in user's own RLS.
 */
const SYSTEM = `You maintain long-term memory for Zeros, an AI assistant.
From the LATEST exchange, decide what durable facts about the USER are worth remembering for future chats.

REMEMBER only things the USER stated about themselves or asked to be remembered:
- name / what to call them, language, location (city/country level only), job/study, ongoing projects, goals
- lasting preferences (tone, formats, tools, tastes), constraints, recurring context

NEVER remember:
- passwords, API keys, card/bank/ID numbers, exact home address, phone numbers, one-time codes
- one-off task details (this specific essay, this bug), jokes, small talk, the assistant's own words
- anything you are unsure the user really said

STYLE: each fact is one short atomic sentence, third person, starting with "User" (max 18 words).
Do not repeat facts already in EXISTING. If the user changed their mind about an existing fact, put that
existing fact's exact text in "forget" and add the corrected fact. If the user asked to forget something,
put the matching existing fact(s) in "forget".
Most exchanges contain nothing to remember: return {"add":[],"forget":[]} in that case.
Return ONLY JSON: {"add": string[], "forget": string[]}`;

type Out = { add?: unknown; forget?: unknown };

const clean = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 240))
    .filter((x) => x.length >= 4)
    .slice(0, max);

export const Route = createFileRoute("/api/memory")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = await requireAccess(request);
        if (!gate.ok) return gate.response;
        let body: { user?: string; assistant?: string; existing?: string[] };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ add: [], forget: [] });
        }
        const user = String(body.user ?? "").slice(0, 2000);
        const assistant = String(body.assistant ?? "").slice(0, 1500);
        const existing = clean(body.existing, 80);
        if (user.trim().length < 6) return Response.json({ add: [], forget: [] });

        const prompt =
          `EXISTING:\n${existing.length ? existing.map((f) => `- ${f}`).join("\n") : "(none)"}\n\n` +
          `USER SAID:\n${user}\n\nASSISTANT REPLIED (context only, never a source of facts):\n${assistant}`;
        const paid = await charge(gate.access, WEIGHTS.memory);
        if (!paid.ok) return paid.response;
        const out = await engineJson<Out>(SYSTEM, prompt, { maxTokens: 700, timeoutMs: 20000, temperature: 0.1 });
        if (!out) await paid.refund();
        return Response.json({
          add: clean(out?.add, 4),
          forget: clean(out?.forget, 6),
        });
      },
    },
  },
});
