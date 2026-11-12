import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
await page.goto("http://127.0.0.1:8765/index.html");
const result = await page.evaluate(async () => {
  const K = window.Kit;
  const project = { files: {
    "index.html": '<!doctype html><html><head><meta charset="utf-8"><title>Bakery</title><link rel="stylesheet" href="style.css"></head><body><h1>Welcome</h1><p>Fresh bread daily.</p><a id="go" href="about.html">About us</a><script src="app.js"></script></body></html>',
    "about.html": '<!doctype html><html><head><meta charset="utf-8"><title>About</title><link rel="stylesheet" href="style.css"></head><body><h1>About our bakery</h1><p>Family baked since 1987.</p><a href="index.html">Home</a></body></html>',
    "style.css": "body { background: #123456; color: #fff; font-family: sans-serif; padding: 32px; } h1 { color: #ffcc66; }",
    "app.js": "document.querySelector('h1').textContent = 'Welcome to Zeros Bakery';",
  } };
  const html = K.assembleWebProject(project, "index.html", {});
  document.open(); document.write(html); document.close();
  await new Promise((r) => setTimeout(r, 300));
  const h1 = document.querySelector("h1")?.textContent ?? "";
  const bg = getComputedStyle(document.body).backgroundColor;
  const h1Color = getComputedStyle(document.querySelector("h1")).color;
  return { h1, bg, h1Color, htmlBytes: html.length, hasAboutLink: !!document.querySelector('a[href="about.html"]') };
});
console.log(JSON.stringify(result));
await page.screenshot({ path: "out/site-preview.png" });
// Page navigation is tested on the shipped host (run-site-nav.mjs). A bare page has no parent to handle its navigation requests.
const ok = result.h1 === "Welcome to Zeros Bakery" && result.bg === "rgb(18, 52, 86)" && result.h1Color === "rgb(255, 204, 102)";
console.log(ok ? "SITE PREVIEW: SCRIPT RAN, STYLESHEET APPLIED, LAYOUT RENDERED" : "SITE PREVIEW CHECK FAILED");
await browser.close();
