import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
await page.goto("http://127.0.0.1:8765/index.html");
const host = await page.evaluate(() => {
  const project = { files: {
    "index.html": '<!doctype html><html><head><meta charset="utf-8"><title>Bakery</title><link rel="stylesheet" href="style.css"></head><body><h1>Welcome</h1><p>Fresh bread daily.</p><a href="about.html">About us</a><script src="app.js"></script></body></html>',
    "about.html": '<!doctype html><html><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="style.css"></head><body><h1>About our bakery</h1><p>Family baked since 1987.</p><a href="index.html">Home</a></body></html>',
    "style.css": "body { background: #123456; color: #fff; font-family: sans-serif; padding: 32px; } h1 { color: #ffcc66; }",
    "app.js": "document.querySelector('h1').textContent = 'Welcome to Zeros Bakery';",
  } };
  return window.Kit.buildStandaloneHost(project, "index.html", "Zeros Bakery");
});
await page.setContent(host, { waitUntil: "load" });
await page.waitForTimeout(800);
const frame = page.frames().find((f) => f !== page.mainFrame()) ?? page.frames()[1];
const firstH1 = await frame.locator("h1").first().textContent({ timeout: 8000 }).catch((e) => "ERR " + e.message.slice(0, 80));
console.log("first page heading:", firstH1);
await frame.locator("a", { hasText: "About us" }).first().click({ timeout: 8000 }).catch((e) => console.log("click About failed:", e.message.slice(0, 120)));
await page.waitForTimeout(900);
const aboutH1 = await frame.locator("h1").first().textContent({ timeout: 8000 }).catch((e) => "ERR " + e.message.slice(0, 80));
console.log("after clicking About:", aboutH1);
await frame.locator("a", { hasText: "Home" }).first().click({ timeout: 8000 }).catch((e) => console.log("click Home failed:", e.message.slice(0, 120)));
await page.waitForTimeout(900);
const homeH1 = await frame.locator("h1").first().textContent({ timeout: 8000 }).catch((e) => "ERR " + e.message.slice(0, 80));
console.log("after clicking Home:", homeH1);
await page.screenshot({ path: "out/site-nav-about.png" }).catch(() => {});
console.log("page errors:", errors.length ? errors : "none");
const ok = /Welcome to Zeros Bakery/.test(firstH1) && /About our bakery/.test(aboutH1) && /Welcome to Zeros Bakery/.test(homeH1);
console.log(ok ? "SITE NAVIGATION: THE SHIPPED HOST SWITCHES PAGES AND RUNS EACH PAGE'S SCRIPT" : "SITE NAVIGATION CHECK FAILED");
await browser.close();
