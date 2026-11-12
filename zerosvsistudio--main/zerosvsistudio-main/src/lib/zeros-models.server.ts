/**
 * ZerosX2.0's model catalogue. Which models answer, and in which order, is decided by server-side settings, never by code:
 *
 *   ZEROS_A_MODELS / ZEROS_A_FAST_MODELS   engine A (text, vision, images, voice)
 *   ZEROS_B_MODELS / ZEROS_B_FAST_MODELS   engine B (text)
 *
 * `*_MODELS` lists the strongest first; `*_FAST_MODELS` lists the quickest first (it defaults to the other list). Each is tried in
 * turn until one answers, so a retired or busy model is simply skipped.
 */
type Env = Record<string, string | undefined>;

export type EngineModels = { best: string[]; fast: string[] };
export type Catalog = { a: EngineModels; b: EngineModels };

const defaultEnv = (): Env => (typeof process !== "undefined" && process.env ? (process.env as Env) : {});

/** A comma-separated setting as a clean, de-duplicated list. */
export function listOf(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

function models(best: string | undefined, fast: string | undefined): EngineModels {
  const b = listOf(best);
  const f = listOf(fast);
  return { best: b.length ? b : f, fast: f.length ? f : b };
}

/** The configured models for both text engines. Read on every call, so a changed setting applies at once. */
export function engineCatalog(e: Env = defaultEnv()): Catalog {
  return {
    a: models(e["ZEROS_A_MODELS"], e["ZEROS_A_FAST_MODELS"]),
    b: models(e["ZEROS_B_MODELS"], e["ZEROS_B_FAST_MODELS"]),
  };
}
