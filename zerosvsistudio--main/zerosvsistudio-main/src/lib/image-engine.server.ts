/**
 * The first picture service. Pictures are rendered on the server and handed to the browser as image bytes, so the browser never
 * talks to the service and never sees its address. Settings (server secrets):
 *   ZEROS_I_KEY      the key (required)
 *   ZEROS_I_URL      the base address (required)
 *   ZEROS_I_MODELS   comma-separated model names, best first (required)
 *   ZEROS_I_QUERY    optional extra query string added to every request
 * Requests carry the same parameters the working version used: no logo, safe mode, and this app's address as the referrer.
 */
import { listOf } from "./zeros-models.server";

type Env = Record<string, string | undefined>;
export type ImageOptions = {
  width?: number | undefined;
  height?: number | undefined;
  /** This app's host name, sent so the service accepts the request. */
  referrer?: string | undefined;
  /** The most time this service may use in total. */
  budgetMs?: number | undefined;
};
export type ImageEngineResult = { bytes: Uint8Array; mimeType: string; model: string; modelsTried: number };

const PER_REQUEST_MS = 15_000;
const DEFAULT_BUDGET_MS = 25_000;

const env = (): Env => (typeof process !== "undefined" && process.env ? (process.env as Env) : {});
const setting = (name: string): string => (env()[name] ?? "").trim();

type Config = { url: string; key: string; models: string[]; query: string };

function config(): Config | null {
  const url = setting("ZEROS_I_URL").replace(/\/+$/, ""), key = setting("ZEROS_I_KEY"), models = listOf(setting("ZEROS_I_MODELS") || setting("ZEROS_I_MODEL"));
  return url && key && models.length ? { url, key, models, query: setting("ZEROS_I_QUERY").replace(/^[?&]+/, "") } : null;
}

/** True when the first picture service is fully set up; otherwise the text service's image models answer. */
export function imageEngineConfigured(): boolean {
  return config() !== null;
}

/** A failure whose message is short and safe to show: a status code or what went wrong. Never the service's name. */
class PictureFailure extends Error {}

function requestUrl(c: Config, prompt: string, model: string, width: number, height: number, referrer: string): string {
  const query = new URLSearchParams({ model, width: String(width), height: String(height), nologo: "true", safe: "true" });
  if (referrer) query.set("referrer", referrer);
  return `${c.url}/image/${encodeURIComponent(prompt)}?${query.toString()}${c.query ? `&${c.query}` : ""}`;
}

async function fetchImage(c: Config, url: string, timeoutMs: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Authorization: "Bearer " + c.key }, signal: controller.signal });
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    if (!response.ok) throw new PictureFailure("HTTP " + response.status);
    if (!mimeType.startsWith("image/")) throw new PictureFailure("no picture in the reply (HTTP " + response.status + ")");
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mimeType };
  } catch (error) {
    if (error instanceof PictureFailure) throw error;
    throw new PictureFailure(controller.signal.aborted ? "timed out" : "could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders one picture, trying each configured model in order until the time budget runs out. When every attempt fails, the error
 * says why in plain terms (status codes, timeouts); the model names go to the server log only.
 */
export async function generateEngineImage(prompt: string, options: ImageOptions = {}): Promise<ImageEngineResult> {
  const c = config();
  if (!c) throw new PictureFailure("not set up");
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const width = Math.min(1536, Math.max(512, Math.round(options.width ?? 1024)));
  const height = Math.min(1536, Math.max(512, Math.round(options.height ?? 1024)));
  const problems: string[] = [];
  let tried = 0;
  for (const model of c.models) {
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    tried += 1;
    try {
      const result = await fetchImage(c, requestUrl(c, prompt, model, width, height, options.referrer ?? ""), Math.min(PER_REQUEST_MS, remaining));
      return { bytes: result.bytes, mimeType: result.mimeType, model, modelsTried: tried };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "failed";
      console.warn(`[Zeros] picture model ${model}: ${reason}`);
      problems.push(reason);
    }
  }
  throw new PictureFailure([...new Set(problems)].slice(0, 3).join(", ") || "no picture models are set");
}
