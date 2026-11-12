import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
await page.goto("http://127.0.0.1:8765/index.html");
const result = await page.evaluate(async () => {
  const K = window.Kit;
  const t0 = performance.now();
  const mesh = await K.forgeShape(K.FORGE_EXAMPLE_SWORD, { quality: "draft" });
  const forgeMs = Math.round(performance.now() - t0);
  const canvas = document.getElementById("stage");
  canvas.width = 448; canvas.height = 448;
  const renderer = new K.ForgeRenderer(canvas);
  renderer.setMesh(mesh);
  const url = renderer.capture(0.7, 0.25, 448);
  renderer.dispose();
  const img = new Image();
  img.src = url;
  await img.decode();
  const probe = document.createElement("canvas");
  probe.width = 448; probe.height = 448;
  const ctx = probe.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, 448, 448).data;
  let shown = 0, samples = 0; const colors = new Set();
  for (let i = 0; i < data.length; i += 4 * 3) {
    samples++;
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a > 0 && r + g + b > 60) shown++;
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  // background = the colour most often found along the picture's border; coverage = share of pixels clearly different from it
  const at = (x, y) => { const i = (y * 448 + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const border = []; for (let x = 0; x < 448; x += 8) { border.push(at(x, 0), at(x, 447)); } for (let y = 0; y < 448; y += 8) { border.push(at(0, y), at(447, y)); }
  const tally = new Map(); for (const c of border) { const k = c.map((v) => v >> 3).join(","); tally.set(k, (tally.get(k) ?? 0) + 1); }
  const bgKey = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map((v) => (+v << 3) + 4);
  let model = 0, total = 0;
  for (let y = 0; y < 448; y += 2) for (let x = 0; x < 448; x += 2) { const [r, g, b] = at(x, y); total++; if (Math.hypot(r - bgKey[0], g - bgKey[1], b - bgKey[2]) > 45) model++; }
  return { forgeMs, vertices: mesh.stats.vertices, watertight: mesh.stats.watertight, pngBytes: Math.round(url.length * 0.75), background: bgKey, modelCoverage: +(model / total).toFixed(3), distinctColors: colors.size, png: url };
});
const { png, ...facts } = result;
const fs = await import("node:fs");
fs.writeFileSync("out/sword-preview.png", Buffer.from(png.split(",")[1], "base64"));
console.log(JSON.stringify(facts));
const pass = result.modelCoverage > 0.02 && result.modelCoverage < 0.9 && result.distinctColors > 40 && result.watertight && result.vertices > 5000;
console.log(pass ? "3D PREVIEW RENDERS A REAL MODEL IN A REAL BROWSER" : "3D PREVIEW CHECK FAILED");
await browser.close();
