/**
 * Runs code from a chat reply in a sandbox that cannot reach the person's account, the network or the page around it.
 *
 * JavaScript runs in its own Web Worker: no page, no document, no storage, and network calls are refused. A run that goes past its
 * time limit is stopped, so a loop that never ends cannot freeze Zeros. HTML is shown in a sandboxed frame whose content security
 * policy allows no network.
 */

export type RunnableLanguage = "javascript" | "html";

/** Which reply code blocks can be run or previewed. Anything else is shown as plain code. */
export function runnableLanguage(language: string): RunnableLanguage | null {
  const name = language.trim().toLowerCase();
  if (name === "js" || name === "javascript" || name === "mjs") return "javascript";
  if (name === "html" || name === "htm") return "html";
  return null;
}

export type RunLog = { level: "log" | "info" | "warn" | "error" | "debug"; text: string };
export type RunOutcome = { logs: RunLog[]; errors: string[]; timedOut: boolean; ms: number };

const MAX_LOGS = 300;
const MAX_TEXT = 4000;
const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** The worker's own code. It refuses network access and reports output back to Zeros. */
export const SANDBOX_WORKER_SOURCE = `
"use strict";
const refused = () => { throw new Error("Network access is turned off in Zeros' code runner."); };
self.fetch = refused;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;
self.importScripts = refused;
const show = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; } catch (e) { return String(value); }
};
const post = (type, data) => self.postMessage({ source: "zeros-run", type: type, data: data });
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => post("log", { level: level, text: args.map(show).join(" ") });
}
self.addEventListener("error", (event) => { event.preventDefault(); post("error", { text: String(event.message || (event.error && event.error.message) || "error") }); });
self.addEventListener("unhandledrejection", (event) => { event.preventDefault(); post("error", { text: show(event.reason) }); });
self.onmessage = (event) => {
  try { (0, eval)(event.data.code); } catch (error) { post("error", { text: show(error) }); }
  post("done", {});
};
`;

/** Runs JavaScript and reports what it printed. Resolves when it finishes, fails or runs past `timeoutMs`. */
export function runJavascript(code: string, opts: { timeoutMs?: number } = {}): Promise<RunOutcome> {
  const limit = Math.min(Math.max(opts.timeoutMs ?? 5000, 200), 30000);
  const started = performance.now();
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([SANDBOX_WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url);
    const logs: RunLog[] = [], errors: string[] = [];
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve({ logs, errors, timedOut, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish(true), limit);
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { source?: string; type?: string; data?: { level?: RunLog["level"]; text?: unknown } } | null;
      if (!message || message.source !== "zeros-run") return;
      if (message.type === "log" && logs.length < MAX_LOGS) logs.push({ level: message.data?.level ?? "log", text: clip(String(message.data?.text ?? "")) });
      if (message.type === "error" && errors.length < 20) errors.push(clip(String(message.data?.text ?? "error")));
      if (message.type === "done") finish(false);
    };
    worker.onerror = (event: ErrorEvent) => {
      errors.push(clip(event.message || "The code could not start."));
      finish(false);
    };
    worker.postMessage({ code });
  });
}

const HTML_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/** The HTML to show in a preview frame, with a policy that allows no network. */
export function htmlDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (whole) => `${whole}${policy}`);
  return `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${html}</body></html>`;
}

/** The language and code of a markdown code block, read from the parsed reply (the `pre` element and its `code` child). */
export function codeFromPre(node: unknown): { language: string; code: string } | null {
  const pre = node as { children?: { tagName?: string; properties?: { className?: unknown }; children?: { value?: string }[] }[] } | undefined;
  const first = pre?.children?.[0];
  if (!first || first.tagName !== "code") return null;
  const classes = Array.isArray(first.properties?.className) ? (first.properties?.className as unknown[]).map(String) : [];
  const language = (classes.find((name) => name.startsWith("language-")) ?? "").slice("language-".length);
  const code = (first.children ?? []).map((child) => child.value ?? "").join("").replace(/\n$/, "");
  return { language, code };
}
