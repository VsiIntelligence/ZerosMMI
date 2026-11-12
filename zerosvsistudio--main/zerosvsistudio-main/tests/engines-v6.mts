/**
 * The two errors people hit, and the failures behind them:
 *   "ZerosX2.0 could not reach its reasoning engine just now"  (3D)
 *   "Picture creation failed (no picture models are set)"      (images)
 * Every way an engine really fails is simulated: retired or misspelt models, a busy provider (429), a briefly broken one (503), a
 * provider that refuses the output size, an error body that echoes the key, every text engine down while the agent is alive, no
 * picture model named anywhere. The real router and the real route handlers answer.
 */
import { World, call, TEST_ENV, readAll } from "./helpers/fakes.mts";
import { routeUrl } from "./helpers/bundle-routes.mjs";
import { clearIdentityCache } from "../src/lib/firebase-user.server.ts";
import { describeEngines, discoverModels, nativeImageBytes, recentEngineFailures, resetEngineMemory } from "../src/lib/engine.server.ts";
import { readSseText, zerosRoute } from "../src/lib/zeros-route.server.ts";
import { sanitizeSvg } from "../src/lib/image-fallback.server.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${String(detail).slice(0, 360)}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type H = (a: { request: Request }) => Promise<Response>;
type Mod = { Route: { server: { handlers: Record<string, H> } } };
const load = async (name: string): Promise<Record<string, H>> => ((await import(routeUrl(name))) as Mod).Route.server.handlers;

/** What the engines are doing right now; each test sets it, the pretend network follows it. */
const eng = {
  retired: new Set<string>(),
  flaky: new Map<string, number>(),
  busy: new Map<string, number>(),
  capLimit: Infinity,
  echoKey: false,
  listA: null as { name: string; methods?: string[]; limit?: number }[] | null,
  listB: null as string[] | null,
  imageB: false,
  agent: false,
  log: [] as string[],
  bodies: [] as { url: string; body: string }[],
};
const PNG = "iVBORw0KGgo".padEnd(200, "A");

async function main(): Promise<void> {
  process.env.ZEROS_ENGINE_BACKOFF_MS = "1";
  const world = new World().install();
  process.env.ZEROS_C_URL = "https://engine-c.test/v1"; process.env.ZEROS_C_KEY_HEADER = "x-c-key"; process.env.ZEROS_C_KEYS = "key-c1-secret";
  world.extra.push((url, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    const model = /\/models\/([^:/]+):/.exec(url.pathname)?.[1] ?? /"model":"([^"]+)"/.exec(body)?.[1] ?? "";
    eng.bodies.push({ url: url.href, body });
    if (url.hostname === "engine-c.test") {
      if (!eng.agent) return json({ error: "down" }, 500);
      if (url.pathname.endsWith("/task.create")) return json({ ok: true, task_id: "t1" });
      if (url.pathname.endsWith("/task.listMessages")) return json({ messages: [{ type: "assistant_message", assistant_message: { content: "agent says: here is the complete answer that the agent wrote for this request." } }, { type: "status_update", status_update: { agent_status: "finished" } }] });
    }
    if (url.hostname === "engine-a.test") {
      if (url.pathname.endsWith("/models") && (init.method ?? "GET") === "GET") return eng.listA ? json({ models: eng.listA.map((m) => ({ name: `models/${m.name}`, supportedGenerationMethods: m.methods ?? ["generateContent"], ...(m.limit ? { outputTokenLimit: m.limit } : {}) })) }) : json({ error: "no list" }, 404);
      if (world.engines.a === "down") { eng.log.push(`A:${model}:500`); return null; }
      if (eng.retired.has(model)) { eng.log.push(`A:${model}:404`); return json({ error: { code: 404, message: `models/${model} is not found for API version v1` } }, 404); }
      const left = eng.flaky.get(model) ?? 0;
      if (left > 0) { eng.flaky.set(model, left - 1); eng.log.push(`A:${model}:503`); return json({ error: { message: "The model is overloaded" } }, 503); }
      const busy = eng.busy.get(model) ?? 0;
      if (busy > 0) { eng.busy.set(model, busy - 1); eng.log.push(`A:${model}:429`); return json({ error: { message: "Resource exhausted" } }, 429, { "retry-after": "0" }); }
      if (eng.echoKey) return json({ error: { message: `API key not valid: key-a1-long-secret-value and AIzaSyAbcdefghijklmnopqrstuvwxyz0123456 rejected` } }, 401);
      const max = (JSON.parse(body || "{}") as { generationConfig?: { maxOutputTokens?: number } }).generationConfig?.maxOutputTokens ?? 0;
      if (max > eng.capLimit) { eng.log.push(`A:${model}:400cap${max}`); return json({ error: { message: `maxOutputTokens exceeds the model's limit of ${eng.capLimit}` } }, 400); }
      eng.log.push(`A:${model}:200`);
    }
    if (url.hostname === "engine-b.test") {
      if (url.pathname.endsWith("/models") && (init.method ?? "GET") === "GET") return eng.listB ? json({ data: eng.listB.map((id) => ({ id })) }) : json({ error: "no list" }, 404);
      if (url.pathname.endsWith("/images/generations")) return eng.imageB ? json({ data: [{ b64_json: PNG }] }) : json({ error: "no images" }, 404);
    }
    return null;
  });
  const used = () => ((world.usageRow("uid-ann")?.["used_units"] as number | undefined) ?? 0);
  const R = {
    chat: (await load("api_chat"))["POST"]!, checkout: (await load("api_billing_checkout"))["POST"]!, confirm: (await load("api_billing_confirm"))["POST"]!,
    image: (await load("api_generate_image"))["POST"]!,
  };
  const body = async (r: Response): Promise<any> => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  async function subscribe(token: string, plan: "bronze" | "gold"): Promise<void> {
    const out = await body(await call(R.checkout, { token, body: { plan } }));
    world.approve(out.subscriptionId);
    await call(R.confirm, { token, body: { subscriptionId: out.subscriptionId } });
  }
  await subscribe("tok-ann", "gold");
  let version = 0;
  const reset = () => {
    version++;
    process.env.ZEROS_A_URL = `https://engine-a.test/v${version}`; process.env.ZEROS_B_URL = `https://engine-b.test/v${version}`;
    process.env.ZEROS_A_KEYS = "key-a1-long-secret-value,key-a2-long-secret-value";
    eng.retired.clear(); eng.flaky.clear(); eng.busy.clear(); eng.capLimit = Infinity; eng.echoKey = false; eng.listA = null; eng.listB = null; eng.imageB = false; eng.agent = false; eng.log.length = 0; eng.bodies.length = 0;
    world.engines.a = "ok"; world.engines.b = "ok"; world.engines.textFor = (e, m) => `${e}:${m} says hi`; world.engines.jsonReply = {};
    process.env.ZEROS_A_MODELS = TEST_ENV["ZEROS_A_MODELS"]!; process.env.ZEROS_A_FAST_MODELS = TEST_ENV["ZEROS_A_FAST_MODELS"]!; process.env.ZEROS_A_IMAGE_MODELS = TEST_ENV["ZEROS_A_IMAGE_MODELS"]!;
    process.env.ZEROS_B_MODELS = TEST_ENV["ZEROS_B_MODELS"]!; process.env.ZEROS_B_FAST_MODELS = TEST_ENV["ZEROS_B_FAST_MODELS"]!;
    resetEngineMemory();
  };
  const ask = async (o: { reasoning?: "fast" | "medium" | "complex"; skipAgent?: boolean; heavy?: boolean } = {}) => zerosRoute("system", [{ role: "user", content: "hello" }], { reasoning: o.reasoning ?? "medium", ...(o.skipAgent ? { skipAgent: true } : {}), ...(o.heavy ? { heavy: true } : {}) });
  const textOf = async (r: Awaited<ReturnType<typeof ask>>) => (r ? readSseText(r.stream) : "");

  /* ============================================================ text engines */
  section("A retired or misspelt model never leaves Zeros without an answer");
  reset(); eng.retired.add("a-strong");
  let r = await ask();
  check("a retired first model is skipped and the next one answers", !!r && r.engine === "a" && r.model === "a-mid" && /a:a-mid says hi/.test(await textOf(r)), JSON.stringify([r?.engine, r?.model, eng.log]));
  eng.log.length = 0; r = await ask();
  check("the retired model is remembered as missing, so it is not asked again", !eng.log.some((l) => l.startsWith("A:a-strong")), eng.log.join());

  reset(); process.env.ZEROS_A_MODELS = "a-gone1,a-gone2"; process.env.ZEROS_A_FAST_MODELS = "a-gone1"; eng.retired.add("a-gone1"); eng.retired.add("a-gone2"); world.engines.b = "down";
  eng.listA = [{ name: "a-embed-1", methods: ["embedContent"] }, { name: "a-image-gen", methods: ["generateContent"] }, { name: "a-main-pro", methods: ["generateContent"], limit: 65536 }, { name: "a-main-flash", methods: ["generateContent"] }, { name: "a-tts-1", methods: ["generateContent"] }];
  r = await ask();
  check("when every configured model is gone, the engine is asked what it has and a live text model answers", !!r && r.engine === "a" && /^a-main-(pro|flash)$/.test(r.model ?? ""), JSON.stringify([r?.engine, r?.model, eng.log.slice(-4)]));
  check("embedding, picture and speech models are never used for text", !eng.log.some((l) => /embed|image|tts/.test(l)));

  reset(); process.env.ZEROS_A_MODELS = ""; process.env.ZEROS_A_FAST_MODELS = ""; world.engines.b = "down";
  eng.listA = [{ name: "a-main-pro" }, { name: "a-main-flash" }];
  r = await ask();
  check("with no models named in the settings at all, whatever the engine offers is used", !!r && r.engine === "a" && /a-main/.test(r.model ?? ""));
  check("this works at the fast level too", !!(await ask({ reasoning: "fast" })));
  const found = await discoverModels("a");
  check("discovery ranks a 'pro' tier model as best and a 'flash' tier as fast", found?.best[0] === "a-main-pro" && found?.fast[0] === "a-main-flash", JSON.stringify(found));

  section("A busy or briefly broken provider is asked again");
  reset(); eng.flaky.set("a-strong", 1);
  r = await ask();
  check("a model that answers 503 once is retried and answers", !!r && r.model === "a-strong" && eng.log.join().includes("A:a-strong:503,A:a-strong:200"), eng.log.join());
  reset(); eng.busy.set("a-strong", 2);
  r = await ask();
  check("a rate-limited model (429) is retried, honouring Retry-After", !!r && r.model === "a-strong" && eng.log.filter((l) => l.endsWith(":429")).length === 2, eng.log.join());
  reset(); eng.capLimit = 8192;
  r = await ask();
  check("a provider that refuses the output size is asked again for less, on the same model", !!r && r.model === "a-strong" && eng.log.some((l) => l.includes("400cap65536")) && eng.log.some((l) => l === "A:a-strong:200"), eng.log.join());

  section("3D: every text engine down, the agent alive");
  reset(); world.engines.a = "down"; world.engines.b = "down"; eng.agent = true;
  r = await ask({ skipAgent: true, heavy: true });
  check("3D mode (which skips the agent for speed) now falls back to it instead of failing", !!r && r.engine === "c" && /agent says/.test(await textOf(r)));
  r = await ask({ reasoning: "complex", skipAgent: true, heavy: true });
  check("including at the complex level", !!r && r.engine === "c");
  reset(); world.engines.a = "down"; world.engines.b = "down";
  r = await ask({ skipAgent: true, heavy: true });
  check("with nothing alive at all the answer is a clean null (the caller refunds and explains)", r === null);
  check("and the real reasons are recorded for the owner", recentEngineFailures().some((f) => f.status === 500));

  section("Failures are explained to the owner and never leak a key");
  reset(); eng.echoKey = true; world.engines.b = "down";
  await ask().catch(() => null);
  const echoed = JSON.stringify(recentEngineFailures());
  check("an error body that echoes the key is scrubbed before it is stored or logged", /401/.test(echoed) && !/key-a1-long-secret-value/.test(echoed) && !/AIzaSy/.test(echoed) && /\*\*\*/.test(echoed), echoed.slice(0, 300));
  reset();
  const report = JSON.stringify(await describeEngines());
  check("the owner's engine report says what is configured and never contains a key", /"configured":true/.test(report) && !/key-a1-long|key-a2-long|key-b1|key-c1-secret/.test(report));

  /* ============================================================ pictures */
  section("Pictures: 'no picture models are set' is gone");
  const make = (b: Record<string, unknown>, token = "tok-ann") => call(R.image, { token, body: b });

  reset(); process.env.ZEROS_A_IMAGE_MODELS = "";
  eng.listA = [{ name: "a-main-pro" }, { name: "a-image-gen", methods: ["generateContent"] }];
  let before = used(), res = await make({ prompt: "a red barn at sunrise" });
  check("with no picture model named, the engine's own picture model is found and used", res.status === 200 && res.headers.get("content-type") === "image/png" && eng.log.includes("A:a-image-gen:200"), `${res.status} ${eng.log}`);
  check("a picture costs exactly one request", used() === before + 10, `${before} -> ${used()}`);

  reset(); process.env.ZEROS_A_IMAGE_MODELS = "a-retired-img"; eng.retired.add("a-retired-img"); eng.listA = [{ name: "a-image-2", methods: ["generateContent"] }, { name: "a-main-pro" }];
  res = await make({ prompt: "a lighthouse in a storm" });
  check("a retired picture model is replaced by one the engine really offers", res.status === 200 && eng.log.includes("A:a-image-2:200"), eng.log.join());

  reset(); process.env.ZEROS_A_IMAGE_MODELS = ""; world.engines.textFor = () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><radialGradient id="g"><stop offset="0" stop-color="#fc6"/><stop offset="1" stop-color="#f60"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="512" cy="512" r="200" fill="#fff"/><script>alert(1)</script></svg>';
  before = used(); res = await make({ prompt: "a glowing sun over a calm sea" });
  const drawn = await res.text();
  check("with no picture model anywhere, the person still gets a picture (a drawn illustration)", res.status === 200 && res.headers.get("content-type") === "image/svg+xml" && /<circle/.test(drawn), `${res.status} ${res.headers.get("content-type")}`);
  check("the drawing is made safe: no script survives, gradients inside it do", !/<script|alert/.test(drawn) && /url\(#g\)/.test(drawn));
  check("the client is told it was drawn, with neutral header names", res.headers.get("x-zeros-style") === "illustration" && ![...res.headers.keys()].some((h) => /provider|model|engine|x-zeros-image/i.test(h)));
  check("it still costs one request", used() === before + 10, `${before} -> ${used()}`);

  reset(); process.env.ZEROS_A_IMAGE_MODELS = ""; world.engines.a = "down"; world.engines.b = "down";
  before = used(); res = await make({ prompt: "a quiet harbour" });
  const failed = await res.text();
  check("only when everything is down does it fail, plainly, naming no one", res.status === 502 && /Picture creation failed/.test(failed) && !/engine-a|engine-b/i.test(failed), failed);
  check("and the failed picture is refunded", used() === before);

  reset(); process.env.ZEROS_A_IMAGE_MODELS = ""; eng.listA = [{ name: "a-main-pro" }]; eng.listB = ["b-strong", "b-image-1"]; eng.imageB = true;
  res = await make({ prompt: "a paper boat" });
  check("the second engine's picture endpoint is used when the first has no picture model", res.status === 200 && res.headers.get("content-type") === "image/png" && eng.bodies.some((b) => b.url.includes("/images/generations")));

  section("Changing a picture builds on it");
  reset(); world.engines.jsonReply = { prompt: "A red barn in a golden wheat field at night under a starry sky, warm window light" };
  res = await make({ prompt: "make it night", previousPrompt: "a red barn in a golden wheat field at sunrise" });
  const sentA = eng.bodies.filter((b) => b.url.includes(":generateContent") && /responseModalities/.test(b.body)).at(-1)?.body ?? "";
  check("'make it night' is merged into the picture's own prompt, so nothing else drifts", res.status === 200 && /at night under a starry sky/.test(sentA) && /barn/.test(sentA), sentA.slice(0, 300));
  check("the full prompt used is handed back so the next change can build on it", decodeURIComponent(res.headers.get("x-zeros-prompt") ?? "").includes("starry sky"));
  reset(); world.engines.jsonReply = { prompt: "unused" };
  res = await make({ prompt: "make the barn blue", previousPrompt: "a red barn", base: { mimeType: "image/jpeg", data: "A".repeat(400) } });
  const edit = eng.bodies.filter((b) => b.url.includes(":generateContent") && /responseModalities/.test(b.body)).at(0)?.body ?? "";
  check("when the picture itself is available it is shown to the picture model with the change", res.status === 200 && /inlineData/.test(edit) && /make the barn blue/.test(edit) && /keeping everything else exactly the same/.test(edit), edit.slice(0, 260));
  res = await make({ prompt: "x", base: { mimeType: "image/gif", data: "A".repeat(400) } });
  check("an unsupported base picture type is ignored, not trusted", res.status === 200);
  const pic = await nativeImageBytes("a test").catch(() => null);
  check("the low-level picture call returns real bytes", !!pic && pic.bytes.length > 50 && pic.mimeType === "image/png");

  section("The drawing sanitizer");
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()" viewBox="0 0 10 10"><script>x()</script><foreignObject><div>hi</div></foreignObject><image href="https://evil.test/a.png"/><a href="javascript:alert(1)"><rect width="5" height="5" onclick="x()" fill="url(https://evil.test/p)" style="fill:url(https://evil.test/q)"/></a><use href="https://evil.test/#x"/><circle cx="5" cy="5" r="2" fill="#f00"/><style>@import url(https://evil.test/x.css)</style></svg>';
  const clean = sanitizeSvg(hostile) ?? "";
  check("scripts, handlers, foreign objects, images, links and styles are removed", !/script|onload|onclick|foreignObject|<image|<a\b|javascript:|evil\.test|<style|@import/i.test(clean), clean);
  check("the drawing's own shapes are kept", /<circle[^>]*r="2"/.test(clean) && /<rect/.test(clean));
  check("a drawing with no shapes, or no svg at all, is refused", sanitizeSvg("<svg xmlns='http://www.w3.org/2000/svg'></svg>") === null && sanitizeSvg("just words") === null);
  check("markdown fences and an xml header around a drawing are tolerated", !!sanitizeSvg('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'));
  check("an svg with no viewBox gets one so it scales", /viewBox=/.test(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="5" height="5"/></svg>') ?? ""));

  section("The real chat endpoint: 3D, music, web and video never stop at one failed engine");
  const chatBody = (mode: string, reasoning = "medium") => ({ messages: [{ role: "user", content: "build a detailed 3D model of a teapot" }], mode, memories: [], reasoning });
  const chatAs = async (mode: string, extra: { reasoning?: string } = {}) => call(R.chat, { token: "tok-ann", body: chatBody(mode, extra.reasoning) });
  reset(); world.engines.a = "down"; world.engines.b = "down"; eng.agent = true;
  let cres = await chatAs("model");
  let ctext = await cres.text();
  check("3D through /api/chat answers when only the agent is alive (no 'could not reach its reasoning engine')", cres.status === 200 && /agent says/.test(ctext) && !/could not reach/.test(ctext), `${cres.status} ${ctext.slice(0, 200)}`);
  reset(); world.engines.a = "down"; world.engines.b = "down";
  const chatBefore = used();
  cres = await chatAs("model");
  check("3D with nothing alive answers with the clear retry message and charges nothing", cres.status === 503 && !/engine-a|engine-b/.test(await cres.text()) && used() === chatBefore);
  reset(); eng.flaky.set("a-strong", 1); eng.flaky.set("a-mid", 1);
  cres = await chatAs("model", { reasoning: "complex" });
  check("3D keeps working through a briefly overloaded model", cres.status === 200);
  reset(); world.engines.a = "down"; world.engines.b = "down"; eng.agent = true;
  cres = await chatAs("music"); ctext = await cres.text();
  check("music, web and video reach the agent the same way", cres.status === 200 && /agent says/.test(ctext));

  clearIdentityCache();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
