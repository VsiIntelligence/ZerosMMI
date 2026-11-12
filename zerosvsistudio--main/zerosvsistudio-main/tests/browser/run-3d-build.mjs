import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
await page.goto("http://127.0.0.1:8765/index.html");
const out = await page.evaluate(async () => {
  const K = window.Kit;
  const run = async (label, previousCode) => {
    const calls = [];
    const statuses = [];
    const streamChat = async (messages, mode, memories, onDelta) => {
      const text = String(messages[messages.length - 1].content);
      calls.push({ planned: text.startsWith("[[PLAN]]"), repair: text.includes("[[REPAIR]]") });
      return "A sword, forged in code.\n```js\n" + K.FORGE_EXAMPLE_SWORD + "\n```";
    };
    const t0 = performance.now();
    const built = await K.buildModel({ prompt: label, previousCode, memories: [], streamChat, onStatus: (s) => statuses.push(s) });
    return {
      label, ms: Math.round(performance.now() - t0), planCalls: calls.filter((c) => c.planned).length, codeCalls: calls.filter((c) => !c.planned && !c.repair).length,
      quality: built.quality, watertight: built.stats.watertight, vertices: built.stats.vertices, components: built.stats.keptComponents,
      features: built.features, facts: built.facts.length, warnings: built.warnings.slice(0, 3),
    };
  };
  const fresh = await run("a hero sword", null);
  const edit = await run("make the blade longer", K.FORGE_EXAMPLE_SWORD);
  return { fresh, edit };
});
console.log(JSON.stringify(out, null, 1));
const ok = out.fresh.planCalls === 1 && out.edit.planCalls === 0 && out.fresh.watertight && out.fresh.components === 1 && out.fresh.vertices > 5000;
console.log(ok ? "3D BUILD: NEW MODELS GET A PLAN, EDITS SKIP IT, OUTPUT IS A SOLID MESH" : "3D BUILD CHECK FAILED");
await browser.close();
