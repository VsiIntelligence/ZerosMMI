import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
await page.goto("http://127.0.0.1:8765/index.html");
const r = await page.evaluate(async () => {
  const K = window.Kit;
  const hello = await K.runJavascript("console.log('hi', 1 + 1, { a: 1 }); console.warn('careful');");
  const boom = await K.runJavascript("throw new Error('boom here')");
  const forever = await K.runJavascript("while (true) {}", { timeoutMs: 1200 });
  const responsive = await new Promise((resolve) => { const t0 = performance.now(); setTimeout(() => resolve(Math.round(performance.now() - t0)), 0); });
  const net = await K.runJavascript("fetch('https://example.com/x').then(() => console.log('reached')).catch((e) => console.error(e.message));", { timeoutMs: 3000 });
  const dom = await K.runJavascript("console.log(typeof document, typeof window, typeof localStorage)");
  const sum = await K.runJavascript("let s = 0; for (let i = 1; i <= 100; i++) s += i; console.log('sum', s)");
  return { hello, boom, forever, responsive, net, dom, sum };
});
const checks = [
  ["output is captured with its level", r.hello.logs.some((l) => l.level === "log" && l.text === 'hi 2 {"a":1}') && r.hello.logs.some((l) => l.level === "warn" && l.text === "careful")],
  ["an uncaught error is reported, not swallowed", r.boom.errors.some((e) => e.includes("boom here")) && !r.boom.timedOut],
  ["a loop that never ends is stopped at its limit", r.forever.timedOut === true && r.forever.ms >= 1100 && r.forever.ms < 4000],
  ["the page stays responsive after a runaway loop", r.responsive < 250],
  ["network access is refused, with a plain reason", r.net.errors.some((e) => /Network access is turned off/.test(e)) && !r.net.logs.some((l) => l.text === "reached")],
  ["the code cannot reach the page (no document, window or storage)", r.dom.logs.some((l) => l.text === "undefined undefined undefined")],
  ["ordinary code computes correctly", r.sum.logs.some((l) => l.text === "sum 5050")],
];
for (const [name, ok] of checks) console.log(ok ? "PASS" : "FAIL", name);
console.log("details:", JSON.stringify({ forever: r.forever.ms, responsive: r.responsive, net: r.net.errors[0]?.slice(0, 80) }));
console.log("page errors:", errors.length ? errors : "none");
console.log(checks.every(([, ok]) => ok) && !errors.length ? "CODE RUNNER: SANDBOXED, TIME-LIMITED AND CORRECT IN A REAL BROWSER" : "CODE RUNNER CHECK FAILED");
await browser.close();
