/**
 * ZerosX2.0 v5 tests: monthly subscriptions, promo access, "no plan = no access" on every route, daily allowances,
 * reasoning routing, the identity filter and what the responses reveal. Everything runs against the pretend backend
 * in tests/helpers/fakes.mts (no network, no keys). Routes run from real bundles (tests/helpers/bundle-routes.mjs).
 *
 *   npx tsx tests/zeros-v5.mts
 */
import { routeUrl } from "./helpers/bundle-routes.mjs";
import { World, call, json, sseText, TEST_ENV } from "./helpers/fakes.mts";
import { buildSystemPrompt, REASONING_NOTE, ZEROS_ALWAYS } from "../src/lib/zeros.ts";
import { raceFirst, readSseText, zerosRoute, parseReasoning } from "../src/lib/zeros-route.server.ts";
import { engineCatalog, listOf } from "../src/lib/zeros-models.server.ts";
import { toChatSse } from "../src/lib/engine.server.ts";
import { PLANS, WINDOW_MS, WEIGHTS, GRACE_MS, applyUsage, canUseComplex, entitlementOf, needsRefresh, unitsFor, usageState, type BillingRow } from "../src/lib/billing.server.ts";
import { PRICE_USD, addMonths, interpretSubscription, planTermsProblem, verifyNewSubscription } from "../src/lib/paypal.server.ts";
import { cleanCodeInput, codesMatch, promoTag } from "../src/lib/promo-core.server.ts";
import { lockSeconds } from "../src/lib/promo.server.ts";
import { shouldAdopt } from "../src/lib/subscriptions.server.ts";
import { Redactor, buildPatterns, hideTerms, redactSse, redactText } from "../src/lib/redact.server.ts";
import { verifyFirebaseToken, clearIdentityCache } from "../src/lib/firebase-user.server.ts";
import { buildHistoryWindow } from "../src/lib/chat-window.ts";
import { formatChatError } from "../src/lib/chat-errors.ts";

let pass = 0, fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail}]` : ""}`);
};
const section = (s: string) => console.log(`\n== ${s}`);

type H = (a: { request: Request }) => Promise<Response>;
type Mod = { Route: { server: { handlers: Record<string, H> } } };
const load = async (name: string): Promise<Record<string, H>> => ((await import(routeUrl(name))) as Mod).Route.server.handlers;

const DAY = 86_400_000;
const body = async (r: Response): Promise<any> => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function main(): Promise<void> {
  const world = new World().install();
  const R = {
    chat: (await load("api_chat"))["POST"]!,
    status: (await load("api_billing_status"))["GET"]!,
    checkout: (await load("api_billing_checkout"))["POST"]!,
    confirm: (await load("api_billing_confirm"))["POST"]!,
    cancel: (await load("api_billing_cancel"))["POST"]!,
    promo: (await load("api_billing_promo"))["POST"]!,
    webhook: (await load("api_billing_webhook"))["POST"]!,
    image: await load("api_generate_image"),
    tts: (await load("api_tts"))["POST"]!,
    memory: (await load("api_memory"))["POST"]!,
    verifyModel: (await load("api_verify_model"))["POST"]!,
    verifySite: (await load("api_verify_site"))["POST"]!,
    connectorsCall: (await load("api_connectors_call"))["POST"]!,
    appsIndex: (await load("api_apps_index"))["GET"]!,
  };

  const ask = (token: string | undefined, text = "hello there", extra: Record<string, unknown> = {}) =>
    call(R.chat, { ...(token ? { token } : {}), body: { messages: [{ role: "user", content: text }], mode: "chat", reasoning: "medium", ...extra } });
  const status = async (token: string) => body(await call(R.status, { token, method: "GET" }));

  /** Subscribes `token` to `plan` the way a person does, and returns the PayPal subscription id. */
  async function subscribe(token: string, plan: "bronze" | "gold"): Promise<string> {
    const res = await call(R.checkout, { token, body: { plan } });
    const out = await body(res);
    if (res.status !== 200) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(out)}`);
    world.approve(out.subscriptionId);
    const done = await call(R.confirm, { token, body: { subscriptionId: out.subscriptionId } });
    if (done.status !== 200) throw new Error(`confirm failed: ${done.status} ${await done.text()}`);
    return out.subscriptionId as string;
  }

  /* ================================================================ money rules */
  section("Prices, plans and monthly math");
  check("Bronze is $25 and Gold is $50", PRICE_USD.bronze === 25 && PRICE_USD.gold === 50 && PLANS.bronze.priceUsd === 25 && PLANS.gold.priceUsd === 50);
  check("Bronze allows 100 requests and Gold 500 every 24 hours", PLANS.bronze.dailyRequests === 100 && PLANS.gold.dailyRequests === 500 && WINDOW_MS === 24 * 3600 * 1000);
  check("the plan cards promise the allowances", PLANS.bronze.features[0]!.startsWith("100 requests every 24 hours") && PLANS.gold.features[0]!.startsWith("500 requests every 24 hours"));
  check("a month later keeps the day and clamps short months", addMonths("2026-01-31T10:00:00.000Z") === "2026-02-28T10:00:00.000Z" && addMonths("2028-01-31T10:00:00.000Z") === "2028-02-29T10:00:00.000Z" && addMonths("2026-12-15T08:30:00.000Z") === "2027-01-15T08:30:00.000Z");

  const planOk = world.planBody(25);
  check("a plan that is monthly, USD, open-ended, no trial and $25 can sell Bronze", planTermsProblem(planOk, "bronze") === null);
  check("the $50 plan cannot sell Bronze (and the $25 plan cannot sell Gold)", planTermsProblem(world.planBody(50), "bronze") !== null && planTermsProblem(planOk, "gold") !== null);
  check("a plan with a free trial is refused", planTermsProblem({ ...planOk, billing_cycles: [{ tenure_type: "TRIAL", frequency: { interval_unit: "MONTH", interval_count: 1 }, total_cycles: 1, pricing_scheme: { fixed_price: { value: "0", currency_code: "USD" } } }, ...planOk.billing_cycles] }, "bronze") !== null);
  check("a yearly plan is refused", planTermsProblem({ ...planOk, billing_cycles: [{ ...planOk.billing_cycles[0], frequency: { interval_unit: "YEAR", interval_count: 1 } }] }, "bronze") !== null);
  check("a plan that stops after 12 payments is refused", planTermsProblem({ ...planOk, billing_cycles: [{ ...planOk.billing_cycles[0], total_cycles: 12 }] }, "bronze") !== null);
  check("a plan in another currency is refused", planTermsProblem({ ...planOk, billing_cycles: [{ ...planOk.billing_cycles[0], pricing_scheme: { fixed_price: { value: "25.00", currency_code: "EUR" } } }] }, "bronze") !== null);
  check("a plan that is not ACTIVE is refused", planTermsProblem({ ...planOk, status: "INACTIVE" }, "bronze") !== null);

  const sub = (o: Record<string, any> = {}) => ({ id: "I-1", status: "ACTIVE", plan_id: "P-BRONZE", custom_id: "uid-ann", billing_info: { last_payment: { amount: { value: "25.00", currency_code: "USD" }, time: "2026-10-19T12:00:00Z" } }, ...o });
  const good = verifyNewSubscription(sub(), "uid-ann");
  check("a paid, active subscription of this account unlocks its plan for one month", good.ok && good.facts.plan === "bronze" && good.facts.paidThrough === "2026-11-19T12:00:00.000Z");
  check("someone else's subscription is refused", !verifyNewSubscription(sub(), "uid-bob").ok && (verifyNewSubscription(sub(), "uid-bob") as any).code === "WRONG_ACCOUNT");
  check("a subscription of an unknown PayPal plan is refused", !interpretSubscription(sub({ plan_id: "P-OTHER" })).ok);
  check("a payment of the wrong amount is refused", (interpretSubscription(sub({ billing_info: { last_payment: { amount: { value: "1.00", currency_code: "USD" }, time: "2026-10-19T12:00:00Z" } } })) as any).code === "WRONG_AMOUNT");
  check("a payment in the wrong currency is refused", (interpretSubscription(sub({ billing_info: { last_payment: { amount: { value: "25.00", currency_code: "EUR" }, time: "2026-10-19T12:00:00Z" } } })) as any).code === "WRONG_AMOUNT");
  check("an approved-but-unpaid subscription waits instead of unlocking", (verifyNewSubscription(sub({ billing_info: {} }), "uid-ann") as any).code === "PENDING");
  check("a subscription that was never approved unlocks nothing", (verifyNewSubscription(sub({ status: "APPROVAL_PENDING", billing_info: {} }), "uid-ann") as any).code === "NOT_APPROVED");
  check("a cancelled or suspended subscription cannot start a plan", (verifyNewSubscription(sub({ status: "CANCELLED" }), "uid-ann") as any).code === "NOT_ACTIVE" && (verifyNewSubscription(sub({ status: "SUSPENDED" }), "uid-ann") as any).code === "NOT_ACTIVE");

  const row = (o: Partial<BillingRow> = {}): BillingRow => ({ plan: "bronze", subscription_id: "I-1", status: "ACTIVE", paid_through: "2026-11-19T12:00:00.000Z", cancel_requested: false, checked_at: null, ...o });
  const t0 = Date.parse("2026-10-19T12:00:00Z"), end = Date.parse("2026-11-19T12:00:00Z");
  check("access lasts the month that was paid for", entitlementOf(row(), t0)?.plan === "bronze" && entitlementOf(row(), end - 1000)?.plan === "bronze");
  check("a renewing subscription gets a short grace while the payment lands", entitlementOf(row(), end + GRACE_MS - 1000)?.plan === "bronze" && entitlementOf(row(), end + GRACE_MS + 1000) === null);
  check("a cancelled subscription ends exactly when the paid month ends", entitlementOf(row({ status: "CANCELLED", cancel_requested: true }), end - 1000)?.cancelling === true && entitlementOf(row({ status: "CANCELLED", cancel_requested: true }), end + 1000) === null);
  check("a suspended or expired subscription has no grace", entitlementOf(row({ status: "SUSPENDED" }), end + 1000) === null && entitlementOf(row({ status: "EXPIRED" }), end + 1000) === null);
  check("a row with no payment unlocks nothing", entitlementOf(row({ paid_through: null }), t0) === null && entitlementOf(null, t0) === null);
  check("PayPal is asked again only near the end of the month, and not every request", !needsRefresh(row({ checked_at: null }), t0) && needsRefresh(row({ checked_at: null }), end - 3600_000) && !needsRefresh(row({ checked_at: new Date(end).toISOString() }), end + 60_000) && needsRefresh(row({ checked_at: new Date(end - 3600_000).toISOString() }), end + 6 * 60_000));
  check("a cancelled subscription is never re-read (it cannot renew)", !needsRefresh(row({ status: "CANCELLED" }), end + DAY));
  check("an older subscription never replaces a newer one, and an unpaid new one never replaces a paid one", !shouldAdopt(row({ subscription_id: "I-NEW" }), { subscriptionId: "I-OLD", plan: "bronze", status: "CANCELLED", owner: "u", email: null, lastPaymentAt: null, paidThrough: "2026-10-01T00:00:00.000Z" }, t0) && !shouldAdopt(row(), { subscriptionId: "I-NEW", plan: "gold", status: "ACTIVE", owner: "u", email: null, lastPaymentAt: null, paidThrough: null }, t0) && shouldAdopt(row(), { subscriptionId: "I-NEW", plan: "gold", status: "ACTIVE", owner: "u", email: null, lastPaymentAt: "x", paidThrough: "2026-11-19T12:00:00.000Z" }, t0));

  section("Allowances: 100 and 500 per 24 hours");
  check("100 requests fit on Bronze and the 101st does not", (() => { let r = null as ReturnType<typeof applyUsage> | null; let row0 = null as any; for (let i = 0; i < 100; i++) { r = applyUsage(row0, unitsFor(1), 100, t0); if (!r.allowed) return false; row0 = r.next; } return !applyUsage(row0, unitsFor(1), 100, t0).allowed; })());
  check("500 requests fit on Gold and the 501st does not", (() => { let row0 = null as any; for (let i = 0; i < 500; i++) { const r = applyUsage(row0, unitsFor(1), 500, t0); if (!r.allowed) return false; row0 = r.next; } return !applyUsage(row0, unitsFor(1), 500, t0).allowed; })());
  check("the count starts again 24 hours after the first request in the window", usageState({ window_start: new Date(t0).toISOString(), used_units: 1000 }, 100, t0 + WINDOW_MS - 1).remainingRequests === 0 && usageState({ window_start: new Date(t0).toISOString(), used_units: 1000 }, 100, t0 + WINDOW_MS).remainingRequests === 100);
  check("every kind of call has a price, and apps cost 1.2", WEIGHTS.chat === 1 && WEIGHTS.connector === 1.2 && WEIGHTS.image === 1 && unitsFor(WEIGHTS.connector) === 12 && unitsFor(WEIGHTS.memory) === 1);
  check("Complex reasoning is Gold or promo only", canUseComplex("gold") && !canUseComplex("bronze") && !canUseComplex(null) && canUseComplex(null, true));

  /* ================================================================ promo core */
  section("Promo code: matching, fingerprints and lock-outs");
  check("typed codes are tidied: spaces, zero-width characters, length", cleanCodeInput("  abc \u200B") === "abc" && cleanCodeInput(42) === "" && cleanCodeInput("x".repeat(500)).length === 200);
  check("codes compare exactly (case matters) in constant time", (await codesMatch("Open-Sesame-4821", "Open-Sesame-4821")) && !(await codesMatch("open-sesame-4821", "Open-Sesame-4821")) && !(await codesMatch("", "x")));
  const tag = await promoTag("Open-Sesame-4821");
  check("the stored fingerprint is stable, differs per code and never contains the code", tag === (await promoTag("Open-Sesame-4821")) && tag !== (await promoTag("Open-Sesame-4822")) && !tag.includes("Sesame") && tag.length === 32);
  check("lock-outs start after the limit and grow, up to a day", lockSeconds(4, 5) === 0 && lockSeconds(5, 5) === 900 && lockSeconds(6, 5) === 1800 && lockSeconds(40, 5) === 86400);

  /* ================================================================ identity filter */
  section("Identity filter: the assistant never says what runs it");
  const pats = buildPatterns(hideTerms({ ZEROS_HIDE_TERMS: "Alphacorp, Betaworks AI, Orchard" }));
  const rx = (s: string) => redactText(s, pats);
  check("'I'm <name>' becomes Zeros", rx("Hi! I'm Alphacorp, a large language model.") === "Hi! I'm Zeros, a large language model.");
  check("'I am a large language model called <name>' becomes Zeros", rx("I am a large language model called Alphacorp") === "I am a large language model called Zeros");
  check("'trained by', 'powered by' and 'built on' lose the name", rx("I was trained by Betaworks AI.") === "I was trained by Zeros." && rx("This app is powered by Alphacorp tech") === "This app is powered by Zeros tech" && rx("It is built on Alphacorp.") === "It is built on Zeros.");
  check("'my model is <name>' becomes Zeros", rx("My underlying model is Alphacorp.") === "My underlying model is Zeros.");
  check("a denial is left alone (no 'I'm not Zeros')", rx("I'm not Alphacorp, I'm Zeros.") === "I'm not Alphacorp, I'm Zeros.");
  check("ordinary words and other uses are never mangled", rx("What a lovely orchard! Alphacorp released a new phone. I'm in the Orchard district.") === "What a lovely orchard! Alphacorp released a new phone. I'm in the Orchard district." && rx("My name is Sam and I'm happy.") === "My name is Sam and I'm happy.");
  check("it needs real names: no terms means no change", redactText("I'm Alphacorp", buildPatterns([])) === "I'm Alphacorp");
  const streamed = (() => { const r = new Redactor(pats); let out = ""; for (const piece of ["Hello! I", "'m Alp", "hacorp, built", " on Beta", "works AI. ", "Fine ", "day ".repeat(60)]) out += r.push(piece); return out + r.flush(); })();
  check("a name split across stream chunks is still caught", streamed.startsWith("Hello! I'm Zeros, built on Zeros. Fine day") && !/Alphacorp|Betaworks/.test(streamed), streamed.slice(0, 80));
  const sseIn = new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); for (const p of ["Yo, I'm Alpha", "corp and I run on Betaworks AI. ", "All good."]) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)); c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } });
  const sseOut = await new Response(redactSse(sseIn, pats)).text();
  check("a whole reply stream is filtered, complete, ordered and ends with [DONE]", sseText(sseOut) === "Yo, I'm Zeros and I run on Zeros. All good." && sseOut.trim().endsWith("data: [DONE]") && sseOut.includes('"finish_reason":"stop"'), sseText(sseOut));

  /* ================================================================ personality (prompts must not name vendors either) */
  section("Persona");
  const modes = ["chat", "search", "image", "model", "music", "web", "video"] as const, levels = ["fast", "medium", "complex"] as const;
  check("every mode and level carries the ZerosX2.0 identity and VsiStudio as creator", modes.every((m) => levels.every((l) => { const p = buildSystemPrompt(m, [], l); return p.includes("ZerosX2.0") && p.includes("created by VsiStudio"); })));
  check("the persona forbids revealing what runs underneath", /never (reveal|discuss|confirm)/i.test(buildSystemPrompt("chat")) && /trade secret|VsiStudio/i.test(buildSystemPrompt("chat")));
  check("every mode asks for wit, length and emojis; levels change the instructions", modes.every((m) => /wittiest|LONG|emojis/i.test(buildSystemPrompt(m)) && ZEROS_ALWAYS.includes("Emojis")) && levels.every((l) => buildSystemPrompt("chat", [], l).includes(REASONING_NOTE[l])));
  check("reasoning values from the browser are validated", parseReasoning("fast") === "fast" && parseReasoning("complex") === "complex" && parseReasoning("x") === "medium" && parseReasoning(undefined) === "medium");

  /* ================================================================ engines and router */
  section("Engines: configured from the environment, routed by reasoning level");
  const cat = engineCatalog();
  check("models come from the environment: strongest first, quickest first", cat.a.best[0] === "a-strong" && cat.a.fast[0] === "a-fast" && cat.b.best[0] === "b-strong" && cat.b.fast[0] === "b-fast");
  check("a list is cleaned and de-duplicated; one list can stand in for the other", listOf(" a, b ,a,,") .join() === "a,b" && engineCatalog({ ZEROS_A_MODELS: "x,y" }).a.fast.join() === "x,y");
  check("raceFirst: the first answer wins and losers are cancelled", await (async () => { const cancelled: string[] = []; const r = await raceFirst<string>([() => new Promise((res) => setTimeout(() => res("slow"), 40)), () => Promise.resolve("quick")], (v) => cancelled.push(v)); await new Promise((res) => setTimeout(res, 70)); return r === "quick" && cancelled.join() === "slow"; })());
  const chunked = new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); const ev = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "whole sentence" }] } }] })}\n\n`; c.enqueue(enc.encode(ev.slice(0, 20))); c.enqueue(enc.encode(ev.slice(20))); c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] })}\n\n`)); c.close(); } });
  check("an event split across network chunks is reassembled, not lost", (await readSseText(toChatSse(chunked))) === "whole sentence");

  const ask1 = (reasoning: "fast" | "medium" | "complex") => zerosRoute("sys", [{ role: "user", content: "hi" }], { reasoning });
  let r = await ask1("fast");
  check("Fast answers from the first engine to reply", !!r && /says hi/.test(await readSseText(r.stream)));
  world.log.length = 0;
  r = await ask1("medium");
  check("Medium tries the strongest engine-A model first", !!r && r.engine === "a" && r.model === "a-strong" && /a:a-strong/.test(await readSseText(r.stream)));
  world.engines.a = "down";
  r = await ask1("medium");
  check("Medium falls back to engine B when A is down", !!r && r.engine === "b" && r.model === "b-strong");
  r = await ask1("fast");
  check("Fast falls back too", !!r && r.engine === "b");
  world.engines.b = "down";
  check("with every engine down the router answers null (the route then refunds)", (await ask1("medium")) === null && (await ask1("fast")) === null && (await ask1("complex")) === null);
  world.engines.a = "ok"; world.engines.b = "ok";
  r = await ask1("complex");
  check("Complex plans, answers and reviews", !!r && r.planned === true && r.verified === true);
  world.engines.textFor = (engine, model) => (model === "a-fast" ? "plan text" : `${engine}:${model} says hi`);

  /* ================================================================ anyone without a plan gets nothing */
  section("No plan, no access: every route that costs money");
  world.log.length = 0;
  const engineCalls = () => world.calls("engine-a.test") + world.calls("engine-b.test");
  const guarded: [string, () => Promise<Response>][] = [
    ["chat", () => ask(undefined)],
    ["image", () => call(R.image["POST"]!, { body: { prompt: "a cat" } })],
    ["voice", () => call(R.tts, { body: { text: "hello there" } })],
    ["memory", () => call(R.memory, { body: { user: "My name is Ann and I like tea", assistant: "ok" } })],
    ["3D review", () => call(R.verifyModel, { body: { views: [{ dataUrl: "data:image/png;base64,AAAA" }] } })],
    ["site review", () => call(R.verifySite, { body: { screenshots: [{ dataUrl: "data:image/png;base64,AAAA" }] } })],
    ["app action", () => call(R.connectorsCall, { body: { toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" } })],
    ["app list", () => call(R.appsIndex, { method: "GET" })],
  ];
  for (const [name, run] of guarded) check(`${name}: signed-out is refused (401)`, (await run()).status === 401);
  const signedInNoPlan: [string, () => Promise<Response>][] = [
    ["chat", () => ask("tok-ann")],
    ["image", () => call(R.image["POST"]!, { token: "tok-ann", body: { prompt: "a cat" } })],
    ["voice", () => call(R.tts, { token: "tok-ann", body: { text: "hello there" } })],
    ["memory", () => call(R.memory, { token: "tok-ann", body: { user: "My name is Ann and I like tea", assistant: "ok" } })],
    ["3D review", () => call(R.verifyModel, { token: "tok-ann", body: { views: [{ dataUrl: "data:image/png;base64,AAAA" }] } })],
    ["site review", () => call(R.verifySite, { token: "tok-ann", body: { screenshots: [{ dataUrl: "data:image/png;base64,AAAA" }] } })],
    ["app action", () => call(R.connectorsCall, { token: "tok-ann", body: { toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" } })],
    ["app list", () => call(R.appsIndex, { token: "tok-ann", method: "GET" })],
  ];
  for (const [name, run] of signedInNoPlan) { const res = await run(); const b = await body(res); check(`${name}: signed in without a plan is refused (402) and says to choose a plan`, res.status === 402 && /plan/i.test(JSON.stringify(b))); }
  check("not a single engine call was made for anyone without a plan", engineCalls() === 0, `${engineCalls()} calls`);
  check("the image route has no GET form (an <img> tag cannot log in)", R.image["GET"] === undefined);
  check("a person without a plan has no usage recorded and no row in the plan table", !world.usageRow("uid-ann") && !world.billingRow("uid-ann"));
  const st0 = await status("tok-ann");
  check("status for a person with nothing: no plan, not unlimited, two monthly offers", st0.plan === null && st0.unlimited === false && st0.plans.length === 2 && st0.plans.every((p: any) => p.interval === "month") && st0.plans[0].priceUsd === 25 && st0.plans[1].priceUsd === 50 && st0.subscription === null);
  check("status needs a login", (await call(R.status, { method: "GET" })).status === 401);

  /* ================================================================ subscribing */
  section("Monthly subscription: checkout, PayPal, confirmation");
  let res = await call(R.checkout, { token: "tok-ann", body: { plan: "platinum" } });
  check("an unknown plan is refused", res.status === 400);
  check("checkout needs a login", (await call(R.checkout, { body: { plan: "bronze" } })).status === 401);
  res = await call(R.checkout, { token: "tok-ann", body: { plan: "bronze" } });
  const co = await body(res);
  const ppSub = world.paypal.subs.get(co.subscriptionId)!;
  check("checkout returns PayPal's own approval page", res.status === 200 && /^https:\/\/www\.paypal\.com\//.test(co.approveUrl) && /^I-/.test(co.subscriptionId));
  check("the subscription is the monthly Bronze plan, owned by this account, returning to the chat", ppSub.plan_id === "P-BRONZE" && ppSub.custom_id === "uid-ann" && ppSub.ctx.return_url === "https://zeros.test/chat?checkout=return" && ppSub.ctx.cancel_url === "https://zeros.test/chat?checkout=cancel");
  check("nothing unlocks from starting a checkout", (await status("tok-ann")).plan === null && (await ask("tok-ann")).status === 402);

  res = await call(R.confirm, { token: "tok-ann", body: { subscriptionId: co.subscriptionId } });
  check("coming back without approving unlocks nothing (409)", res.status === 409 && (await status("tok-ann")).plan === null && !world.billingRow("uid-ann")?.["paid_through"]);
  check("a malformed subscription id is refused (400)", (await call(R.confirm, { token: "tok-ann", body: { subscriptionId: "../etc" } })).status === 400);
  check("confirm needs a login", (await call(R.confirm, { body: { subscriptionId: co.subscriptionId } })).status === 401);

  world.approve(co.subscriptionId, { paid: false });
  res = await call(R.confirm, { token: "tok-ann", body: { subscriptionId: co.subscriptionId } });
  check("approved but the first payment has not cleared: waits (409 PENDING), nothing unlocked", res.status === 409 && (await body(res)).code === "PENDING" && (await status("tok-ann")).plan === null);

  res = await call(R.confirm, { token: "tok-bob", body: { subscriptionId: co.subscriptionId } });
  world.approve(co.subscriptionId);
  const stolen = await call(R.confirm, { token: "tok-bob", body: { subscriptionId: co.subscriptionId } });
  check("another account cannot claim someone else's payment (403)", stolen.status === 403 && (await status("tok-bob")).plan === null && !world.billingRow("uid-bob"));

  world.approve(co.subscriptionId, { amount: "24.00" });
  res = await call(R.confirm, { token: "tok-ann", body: { subscriptionId: co.subscriptionId } });
  check("a payment of the wrong amount unlocks nothing (402)", res.status === 402 && (await status("tok-ann")).plan === null);

  world.approve(co.subscriptionId);
  res = await call(R.confirm, { token: "tok-ann", body: { subscriptionId: co.subscriptionId } });
  const confirmed = await body(res);
  check("a paid subscription unlocks Bronze until the end of the paid month", res.status === 200 && confirmed.plan === "bronze" && confirmed.renewsAt === "2026-11-19T12:00:00.000Z");
  const st1 = await status("tok-ann");
  check("status shows the plan, 100 requests, the renewal date and no Complex", st1.plan === "bronze" && st1.dailyRequests === 100 && st1.complexAllowed === false && st1.subscription?.renewsAt === "2026-11-19T12:00:00.000Z" && st1.subscription?.cancelling === false);
  res = await call(R.confirm, { token: "tok-ann", body: { subscriptionId: co.subscriptionId } });
  check("confirming twice is harmless", res.status === 200 && (await body(res)).alreadyActive === true && world.tables["zeros_billing"]!.size === 1);

  res = await call(R.checkout, { token: "tok-ann", body: { plan: "bronze" } });
  check("a second Bronze while one is running is refused (no double charge)", res.status === 409 && world.paypal.counter === 1);

  /* ================================================================ the month, the renewal, the lapse */
  section("Every month: access follows the payment");
  world.advanceDays(20);
  check("twenty days in, the plan still works", (await ask("tok-ann")).status === 200);
  world.advanceDays(11);                       /* day 31: the next payment is due, PayPal has not taken it yet */
  check("when the month ends the plan keeps working through the short grace", (await ask("tok-ann")).status === 200);
  world.advanceDays(3);                        /* day 34: grace is over and nothing was paid */
  res = await ask("tok-ann");
  check("no payment after the grace: access ends (402)", res.status === 402 && (await status("tok-ann")).plan === null);
  check("PayPal was asked about it instead of trusting the stored dates", world.calls(/\/v1\/billing\/subscriptions\/I-TEST000001$/) >= 2);
  world.renew(co.subscriptionId);              /* the payment finally lands */
  world.advanceMinutes(10);
  res = await ask("tok-ann");
  check("when the monthly payment lands, access returns by itself", res.status === 200 && (await status("tok-ann")).plan === "bronze");
  check("and runs another month from that payment", (await status("tok-ann")).subscription?.renewsAt === new Date(Date.parse(addMonths(new Date(world.now - 10 * 60_000).toISOString(), 1))).toISOString() || (await status("tok-ann")).subscription?.renewsAt?.startsWith("2026-1"));

  /* ================================================================ cancel */
  section("Cancelling");
  check("cancel needs a login", (await call(R.cancel, {})).status === 401);
  check("cancelling with no subscription says so (404)", (await call(R.cancel, { token: "tok-cy" })).status === 404);
  res = await call(R.cancel, { token: "tok-ann" });
  const cancelled = await body(res);
  check("cancel stops the monthly payments at PayPal", res.status === 200 && cancelled.cancelled === true && world.paypal.cancelled.includes(co.subscriptionId));
  const st2 = await status("tok-ann");
  check("the paid month stays usable and the status says when it ends", st2.plan === "bronze" && st2.subscription?.cancelling === true && !!st2.subscription?.endsAt && st2.subscription?.renewsAt === null);
  check("the plan still works until then", (await ask("tok-ann")).status === 200);
  world.advanceDays(33);
  check("and then it ends, with no renewal", (await ask("tok-ann")).status === 402);
  res = await call(R.cancel, { token: "tok-ann" });
  check("cancelling twice is harmless", res.status === 200);
  res = await call(R.checkout, { token: "tok-ann", body: { plan: "bronze" } });
  check("a lapsed person can subscribe again", res.status === 200);
  const again = await body(res);
  world.approve(again.subscriptionId);
  check("and the new subscription takes over", (await call(R.confirm, { token: "tok-ann", body: { subscriptionId: again.subscriptionId } })).status === 200 && (await status("tok-ann")).plan === "bronze" && world.billingRow("uid-ann")?.["subscription_id"] === again.subscriptionId);

  /* ================================================================ upgrade */
  section("Upgrading Bronze to Gold");
  res = await call(R.checkout, { token: "tok-ann", body: { plan: "gold" } });
  const up = await body(res);
  check("Bronze holders can start Gold", res.status === 200 && world.paypal.subs.get(up.subscriptionId)!.plan_id === "P-GOLD");
  world.approve(up.subscriptionId);
  world.paypal.cancelled.length = 0;
  res = await call(R.confirm, { token: "tok-ann", body: { subscriptionId: up.subscriptionId } });
  check("Gold unlocks, and the old Bronze subscription is cancelled so nothing is charged twice", res.status === 200 && (await status("tok-ann")).plan === "gold" && world.paypal.cancelled.includes(again.subscriptionId));
  check("Gold has 500 requests and Complex reasoning", (await status("tok-ann")).dailyRequests === 500 && (await status("tok-ann")).complexAllowed === true);
  res = await call(R.checkout, { token: "tok-ann", body: { plan: "bronze" } });
  check("Gold holders cannot buy Bronze on top (409, with the way to switch)", res.status === 409 && /cancel Gold/i.test((await body(res)).error));
  res = await call(R.checkout, { token: "tok-ann", body: { plan: "gold" } });
  check("nor a second Gold", res.status === 409);

  /* ================================================================ PayPal plan misconfigured */
  section("A wrongly created PayPal plan can never sell a plan for the wrong money");
  world.advanceMinutes(15);                   /* the plan check is cached for ten minutes */
  world.paypal.plans.set("P-BRONZE", world.planBody(10));
  const before = world.paypal.counter;
  res = await call(R.checkout, { token: "tok-cy", body: { plan: "bronze" } });
  const bad = await res.text();
  check("a $10 plan in the Bronze slot refuses to start (503) and creates no subscription", res.status === 503 && world.paypal.counter === before);
  check("the person sees a plain message, not the configuration problem", /temporarily unavailable/i.test(bad) && !/P-BRONZE|expected 25|plan/i.test(bad.replace(/temporarily unavailable.*/i, "")), bad);
  world.paypal.plans.set("P-BRONZE", world.planBody(25, { billing_cycles: [{ tenure_type: "TRIAL", frequency: { interval_unit: "MONTH", interval_count: 1 }, total_cycles: 1, pricing_scheme: { fixed_price: { value: "0.00", currency_code: "USD" } } }, ...world.planBody(25).billing_cycles] }));
  world.advanceMinutes(15);
  check("a plan with a free trial refuses to start too", (await call(R.checkout, { token: "tok-cy", body: { plan: "bronze" } })).status === 503);
  world.paypal.plans.set("P-BRONZE", world.planBody(25));
  world.advanceMinutes(15);
  process.env.PAYPAL_PLAN_ID_GOLD = "";
  check("with a plan id missing, payments are unavailable (503) rather than half-working", (await call(R.checkout, { token: "tok-cy", body: { plan: "bronze" } })).status === 503);
  process.env.PAYPAL_PLAN_ID_GOLD = TEST_ENV["PAYPAL_PLAN_ID_GOLD"]!;
  world.paypal.down = true;
  check("when PayPal is down checkout says so (not a crash)", [502, 503].includes((await call(R.checkout, { token: "tok-cy", body: { plan: "bronze" } })).status));
  world.paypal.down = false;

  /* ================================================================ webhooks */
  section("PayPal webhooks");
  const hook = (event: unknown, headers: Record<string, string> = { "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "t1", "paypal-transmission-time": "now", "paypal-auth-algo": "SHA256withRSA" }) => call(R.webhook, { headers, body: event });
  world.paypal.webhookValid = false;
  check("a webhook PayPal does not vouch for is rejected (400)", (await hook({ event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: up.subscriptionId } })).status === 400);
  world.paypal.webhookValid = true;
  check("a webhook without PayPal's signature headers is rejected", (await hook({ event_type: "x" }, {})).status === 400);
  process.env.PAYPAL_WEBHOOK_ID = "";
  check("with no PAYPAL_WEBHOOK_ID nothing is trusted", (await hook({ event_type: "x", resource: {} })).status === 400);
  process.env.PAYPAL_WEBHOOK_ID = TEST_ENV["PAYPAL_WEBHOOK_ID"]!;
  check("an event of no interest is acknowledged", (await hook({ event_type: "CUSTOMER.SOMETHING", resource: {} })).status === 200);

  /* a person pays, then closes the tab before returning: the webhook alone activates the plan */
  const cyCo = await body(await call(R.checkout, { token: "tok-cy", body: { plan: "bronze" } }));
  check("before PayPal reports a payment, a webhook unlocks nothing", (await hook({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: cyCo.subscriptionId } })).status === 200 && (await status("tok-cy")).plan === null);
  world.approve(cyCo.subscriptionId);
  res = await hook({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: cyCo.subscriptionId } });
  check("once PayPal reports the payment, the webhook activates the plan by itself", res.status === 200 && (await status("tok-cy")).plan === "bronze");
  world.advanceDays(29); world.renew(cyCo.subscriptionId);
  await hook({ event_type: "PAYMENT.SALE.COMPLETED", resource: { billing_agreement_id: cyCo.subscriptionId } });
  check("a renewal webhook extends access", (await status("tok-cy")).subscription?.renewsAt === addMonths(new Date(world.now).toISOString(), 1));
  await hook({ event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: up.subscriptionId } });
  check("a late message about a replaced subscription cannot take Gold away", (await status("tok-ann")).plan === "gold");

  world.paypal.sales.set("SALE-1", { id: "SALE-1", billing_agreement_id: cyCo.subscriptionId, state: "refunded" });
  res = await hook({ event_type: "PAYMENT.SALE.REFUNDED", resource: { sale_id: "SALE-1", id: "REF-1" } });
  check("a full refund ends access at once and stops the subscription", res.status === 200 && (await status("tok-cy")).plan === null && (await ask("tok-cy")).status === 402 && world.paypal.cancelled.includes(cyCo.subscriptionId));
  world.paypal.sales.set("SALE-2", { id: "SALE-2", billing_agreement_id: up.subscriptionId, state: "partially_refunded" });
  await hook({ event_type: "PAYMENT.SALE.REFUNDED", resource: { sale_id: "SALE-2", id: "REF-2" } });
  check("a partial refund does not take the plan away", (await status("tok-ann")).plan === "gold");

  /* ================================================================ allowances through the routes */
  section("Allowances through the real routes");
  const ann = "uid-ann";
  world.tables["zeros_usage"]!.delete(ann);
  world.advanceDays(0);
  res = await ask("tok-ann", "hello", { reasoning: "complex" });
  check("Gold can use Complex reasoning", res.status === 200);
  await res.text();
  const bobCo = await body(await call(R.checkout, { token: "tok-bob", body: { plan: "bronze" } }));
  world.approve(bobCo.subscriptionId);
  await call(R.confirm, { token: "tok-bob", body: { subscriptionId: bobCo.subscriptionId } });
  res = await ask("tok-bob", "hello", { reasoning: "complex" });
  check("Bronze cannot use Complex reasoning (403) and is not charged for trying", res.status === 403 && !world.usageRow("uid-bob"));

  let ok = 0, last: Response | null = null;
  for (let i = 0; i < 100; i++) { last = await ask("tok-bob", `message ${i}`); if (last.status === 200) { ok++; await last.text(); } else break; }
  check("Bronze gets exactly 100 requests in 24 hours", ok === 100 && world.usageRow("uid-bob")?.["used_units"] === 1000, `${ok} ok`);
  res = await ask("tok-bob", "one more");
  const limited = await body(res);
  check("the 101st is refused (429) with the reset time", res.status === 429 && /100 requests every 24 hours on the Bronze plan/.test(limited.error) && !!limited.resetsAt);
  check("images, voice, reviews and memory are refused too once the allowance is gone", (await call(R.image["POST"]!, { token: "tok-bob", body: { prompt: "cat" } })).status === 429 && (await call(R.tts, { token: "tok-bob", body: { text: "hello" } })).status === 429);
  world.advanceMinutes(24 * 60 - 1);
  check("still refused a minute before the window ends", (await ask("tok-bob")).status === 429);
  world.advanceMinutes(2);
  res = await ask("tok-bob");
  check("24 hours after the first request the allowance is back", res.status === 200);
  await res.text();

  world.tables["zeros_usage"]!.set(ann, { user_id: ann, window_start: new Date(world.now).toISOString(), used_units: 4990 });
  res = await ask("tok-ann"); await res.text();
  const r501 = await ask("tok-ann");
  check("Gold gets exactly 500 requests: the 500th passes and the 501st is refused", res.status === 200 && r501.status === 429 && /500 requests every 24 hours on the Gold plan/.test((await body(r501)).error));

  /* refunds */
  world.tables["zeros_usage"]!.delete("uid-bob");
  world.engines.a = "down"; world.engines.b = "down";
  res = await ask("tok-bob");
  check("when no engine can answer the person is not charged", res.status === 503 && (world.usageRow("uid-bob")?.["used_units"] ?? 0) === 0);
  const sorry = await res.text();
  check("and the apology names no one", !/alphacorp|betaworks|engine-a|engine-b/i.test(sorry) && /not charged/.test(sorry), sorry);
  world.engines.a = "ok"; world.engines.b = "ok";

  /* what each kind of call costs */
  world.tables["zeros_usage"]!.delete("uid-bob");
  const used = () => (world.usageRow("uid-bob")?.["used_units"] ?? 0) as number;
  res = await call(R.image["POST"]!, { token: "tok-bob", body: { prompt: "a fox in a hat" } });
  const png = new Uint8Array(await res.arrayBuffer());
  check("a picture comes back as image bytes, costs 1 request, and shows no maker", res.status === 200 && res.headers.get("content-type") === "image/png" && png.length > 50 && used() === 10 && ![...res.headers.keys()].some((h) => /provider|model|engine|x-zeros-image/i.test(h)));
  res = await call(R.tts, { token: "tok-bob", body: { text: "Welcome to the show", voice: "male" } });
  const voiced = await body(res);
  const voiceCall = world.log.filter((l) => l.body.includes("responseModalities") && l.body.includes('"AUDIO"')).pop();
  check("a voice clip costs 0.3, sounds like the male voice from the settings, and returns audio", res.status === 200 && !!voiced.pcm && used() === 13 && !!voiceCall && voiceCall.body.includes("voice-m"));
  await (await call(R.tts, { token: "tok-bob", body: { text: "Welcome", voice: "bogus" } })).text();
  check("an unknown voice falls back to the default (female) voice", world.log.filter((l) => l.body.includes('"AUDIO"')).pop()!.body.includes("voice-f"));
  world.engines.jsonReply = { add: ["User likes tea"], forget: [] };
  res = await call(R.memory, { token: "tok-bob", body: { user: "My name is Ann and I like tea", assistant: "Nice" } });
  const mem = await body(res);
  check("a memory check costs 0.1 and returns what to remember", res.status === 200 && mem.add?.[0] === "User likes tea" && used() === 13 + 3 + 1, `${used()}`);
  world.engines.jsonReply = { score: 91, matches: true, summary: "great", issues: [], strengths: [] };
  const shot = { dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  const before2 = used();
  res = await call(R.verifyModel, { token: "tok-bob", body: { request: "a fox", views: [shot] } });
  check("a 3D review costs 0.5 and returns the verdict", res.status === 200 && (await body(res)).score === 91 && used() === before2 + 5);
  res = await call(R.verifySite, { token: "tok-bob", body: { brief: "a site", screenshots: [shot] } });
  check("a site review costs 0.5", res.status === 200 && used() === before2 + 10);
  const before3 = used();
  world.engines.a = "down"; world.engines.b = "down";
  res = await call(R.verifySite, { token: "tok-bob", body: { brief: "a site", screenshots: [shot] } });
  check("a review that could not run is refunded", res.status === 502 && used() === before3);
  res = await call(R.image["POST"]!, { token: "tok-bob", body: { prompt: "a fox" } });
  const imgFail = await res.text();
  check("a picture that could not be made is refunded and the message names no one", res.status === 502 && used() === before3 && /Picture creation failed/.test(imgFail) && !/engine-a|engine-b|alphacorp|betaworks/i.test(imgFail), imgFail);
  world.engines.a = "ok"; world.engines.b = "ok";

  /* ================================================================ promo through the routes */
  section("Promo code: free and unlimited, and nothing else is");
  const promo = (token: string | undefined, code: unknown, ip = "203.0.113.7") => call(R.promo, { ...(token ? { token } : {}), headers: { "cf-connecting-ip": ip }, body: { code } });
  check("redeeming needs a login", (await promo(undefined, "Open-Sesame-4821")).status === 401);
  res = await promo("tok-cy", "");
  check("an empty code is refused without counting as a guess", res.status === 400 && !world.tables["zeros_promo_attempts"]!.size);
  res = await promo("tok-cy", "open-sesame-4821");
  check("a wrong code (even just the wrong case) is refused with a plain message", res.status === 400 && (await body(res)).error === "That code isn't valid." && (await status("tok-cy")).unlimited === false);
  check("a wrong code unlocks nothing anywhere", (await ask("tok-cy")).status === 402);
  for (let i = 0; i < 3; i++) await promo("tok-cy", `guess-${i}`);       /* 4 misses so far */
  res = await promo("tok-cy", "guess-4");                                  /* the 5th */
  check("the 5th miss is still answered normally", res.status === 400);
  res = await promo("tok-cy", "Open-Sesame-4821");
  const locked = await res.text();
  check("after five misses the account is locked out (429, Retry-After), even for the right code", res.status === 429 && Number(res.headers.get("retry-after")) >= 890 && !locked.includes("Open-Sesame"), `${res.status}`);
  world.advanceMinutes(16);
  res = await promo("tok-cy", " Open-Sesame-4821 ");
  check("after the lock-out passes, the right code works (spaces around it are fine)", res.status === 200 && (await body(res)).unlimited === true);
  const stp = await status("tok-cy");
  check("the account is now Unlimited: no plan needed, Complex allowed", stp.unlimited === true && stp.planLabel === "Unlimited" && stp.complexAllowed === true && stp.plan === null && stp.subscription === null);
  check("only a fingerprint of the code is stored, never the code", JSON.stringify([...world.tables["zeros_promo"]!.values()]).includes(await promoTag("Open-Sesame-4821")) && !JSON.stringify([...world.tables["zeros_promo"]!.values()]).includes("Sesame"));

  const rpcBefore = world.calls("rpc/zeros_consume_usage");
  let allOk = true;
  for (let i = 0; i < 160; i++) { const x = await ask("tok-cy", `unlimited ${i}`, i % 3 === 0 ? { reasoning: "complex" } : {}); if (x.status !== 200) { allOk = false; break; } await x.text(); }
  check("160 requests in a row all pass (far beyond Bronze's 100 and Gold's 500 per day is unlimited), including Complex", allOk);
  check("promo requests are never counted or charged", world.calls("rpc/zeros_consume_usage") === rpcBefore && !world.usageRow("uid-cy"));
  check("images, voice, reviews and memory are unlimited for promo accounts too", (await call(R.image["POST"]!, { token: "tok-cy", body: { prompt: "cat" } })).status === 200 && (await call(R.tts, { token: "tok-cy", body: { text: "hello" } })).status === 200 && world.calls("rpc/zeros_consume_usage") === rpcBefore);
  res = await call(R.checkout, { token: "tok-cy", body: { plan: "gold" } });
  check("a promo account has nothing to buy (409)", res.status === 409);

  /* The code is a secret: no response or header ever contains it. */
  const everything = world.log.map((l) => l.body).join(" ");
  check("the code is never sent anywhere except to the comparison", !world.log.some((l) => !l.url.includes("/api/") && l.body.includes("Open-Sesame-4821")) && !/Open-Sesame/.test(JSON.stringify(stp)));

  /* rotating the code revokes everyone who redeemed the old one */
  process.env.PROMO_CODE = "Fresh-Code-9917";
  check("changing PROMO_CODE ends access for those who used the old code", (await ask("tok-cy")).status === 402 && (await status("tok-cy")).unlimited === false);
  check("the old code no longer works for anyone", (await promo("tok-bob", "Open-Sesame-4821", "198.51.100.5")).status === 400);
  res = await promo("tok-bob", "Fresh-Code-9917", "198.51.100.5");
  check("the new code works", res.status === 200 && (await status("tok-bob")).unlimited === true);
  check("a promo account that also has a plan is simply unlimited", (await status("tok-bob")).plan === null && (await status("tok-bob")).unlimited === true);
  process.env.PROMO_CODE = "";
  check("with PROMO_CODE removed, no promo access exists at all: an unlimited account falls back to what it paid for", (await status("tok-bob")).unlimited === false && (await status("tok-bob")).plan === "bronze" && (await ask("tok-cy")).status === 402 && (await promo("tok-ann", "", "198.51.100.9")).status === 400 && (await promo("tok-ann", "anything", "198.51.100.9")).status === 400);
  process.env.PROMO_CODE = TEST_ENV["PROMO_CODE"]!;
  check("an empty typed code can never match an empty PROMO_CODE", await (async () => { process.env.PROMO_CODE = ""; const out = (await promo("tok-ann", "   ", "198.51.100.10")).status; process.env.PROMO_CODE = TEST_ENV["PROMO_CODE"]!; return out === 400; })());

  /* guessing from many accounts at one address is slowed too */
  world.tables["zeros_promo_attempts"]!.clear();
  let lastStatus = 0;
  for (let i = 0; i < 24; i++) { lastStatus = (await promo(i % 2 ? "tok-ann" : "tok-bob", `x${i}`, "192.0.2.77")).status; }
  check("many wrong guesses from one address end in a lock-out for that address", lastStatus === 429);
  check("that address cannot even try the right code now", (await promo("tok-ann", "Open-Sesame-4821", "192.0.2.77")).status === 429);
  check("while a different account on a different address is unaffected", (await promo("tok-cy", "Open-Sesame-4821", "192.0.2.78")).status === 200);

  /* ================================================================ responses reveal nothing */
  section("Responses reveal nothing about what runs Zeros");
  world.tables["zeros_usage"]!.clear();
  res = await ask("tok-cy");
  const headerNames = [...res.headers.keys()].join(",");
  check("chat headers carry no provider or model", !/provider|model|engine/i.test(headerNames) && res.headers.get("x-zeros-reasoning") === "medium", headerNames);
  const text = sseText(await res.text());
  check("the reply text arrives", text.length > 0);
  world.engines.textFor = (engine, model) => (engine === "a" ? "Hello! I'm Alphacorp, built on Betaworks AI." : "ok");
  res = await ask("tok-cy");
  check("if the model describes itself by its maker's name, the name is replaced before it reaches anyone", sseText(await res.text()) === "Hello! I'm Zeros, built on Zeros.");
  world.engines.textFor = (engine, model) => `${engine}:${model} says hi`;
  world.brokenTables.add("zeros_billing");
  res = await ask("tok-ann");
  const brokenBody = await res.text();
  check("a database failure fails closed (502/503) with a generic message that exposes no setting names", [502, 503].includes(res.status) && !/SUPABASE|service|key|rest\/v1|zeros_billing/i.test(brokenBody) && /temporarily unavailable/i.test(brokenBody), brokenBody);
  world.brokenTables.clear();
  const allSeen = JSON.stringify(world.log.map((l) => ({ url: l.url, headers: l.headers }))).length;
  check("engine keys are only ever sent to their own engine", world.log.filter((l) => l.headers["x-test-key"]).every((l) => l.url.startsWith("https://engine-a.test/")) && world.log.filter((l) => /^Bearer key-b/.test(l.headers["authorization"] ?? "")).every((l) => l.url.startsWith("https://engine-b.test/")) && allSeen > 0);

  /* ================================================================ sign-in */
  section("Sign-in: tokens verified by the identity service");
  clearIdentityCache();
  const who = await verifyFirebaseToken("tok-ann");
  check("a valid token gives the account id", who?.uid === "uid-ann" && who.email === "ann@example.com");
  check("a forged token is refused", (await verifyFirebaseToken("forged")) === null);

  /* ================================================================ history and errors */
  section("Chat window and error wording");
  const longChat = Array.from({ length: 60 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `message ${i} ${"x".repeat(900)}` }));
  const win = buildHistoryWindow(longChat);
  check("a long chat is sent as a bounded window", win.reduce((a, m) => a + m.content.length, 0) < 25000 && win[0]!.content.startsWith("Earlier in this chat") && win[win.length - 1]!.content.startsWith("message 59"));
  check("network failures read as a connection problem; server messages pass through", /could not be reached/.test(formatChatError(new TypeError("Failed to fetch"))) && formatChatError(new Error("Daily limit reached: 100 requests")) === "Daily limit reached: 100 requests");

  world.uninstall();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
