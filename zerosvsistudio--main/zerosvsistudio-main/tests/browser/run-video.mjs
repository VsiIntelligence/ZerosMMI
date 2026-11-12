import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
await page.goto("http://127.0.0.1:8765/index.html");
const out = await page.evaluate(async () => {
  const K = window.Kit;
  const prompt = "a 10 second film about the ocean at dawn, calm and cinematic";
  const t0 = performance.now();
  const build = await K.buildVideo({ prompt, history: [{ role: "user", content: prompt }], memories: [], streamChat: async () => "", onStatus: () => {} });
  const planMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const result = await K.renderVideoWithMeta(build.spec, () => {}, () => {}, { quality: "standard" });
  const renderMs = Math.round(performance.now() - t1);
  const blob = result.blob;
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true; video.preload = "auto"; video.src = url;
  document.body.appendChild(video);
  const meta = await new Promise((resolve) => { video.onloadedmetadata = () => resolve({ ok: true }); video.onerror = () => resolve({ ok: false, code: video.error && video.error.code }); setTimeout(() => resolve({ ok: false, code: "timeout" }), 20000); });
  // seek to the middle and make sure a frame actually decodes (black or empty output would still have metadata)
  let midFrame = null;
  if (meta.ok) {
    try { video.currentTime = Math.min(3, (video.duration || 3) / 2); await new Promise((r) => { video.onseeked = r; setTimeout(r, 4000); }); } catch {}
    const c = document.createElement("canvas"); c.width = 160; c.height = 90;
    const cx = c.getContext("2d"); cx.drawImage(video, 0, 0, 160, 90);
    const px = cx.getImageData(0, 0, 160, 90).data; let lit = 0, n = 0; const colors = new Set();
    for (let i = 0; i < px.length; i += 16) { n++; if (px[i] + px[i + 1] + px[i + 2] > 45) lit++; colors.add(((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4)); }
    midFrame = { litShare: +(lit / n).toFixed(3), distinctColors: colors.size };
  }
  return { planMs, renderMs, title: build.spec.title, requestedSec: build.spec.durationSec, fps: build.spec.fps, size: [build.spec.width, build.spec.height], scenes: build.spec.scenes.length, blobType: blob.type, blobBytes: blob.size, playable: meta, videoDuration: video.duration, videoSize: [video.videoWidth, video.videoHeight], midFrame, captions: !!result.vtt, source: build.spec.source, warnings: (build.warnings || []).slice(0, 3) };
});
console.log(JSON.stringify(out, null, 1));
const ok = out.playable.ok && out.blobBytes > 20000 && out.videoSize[0] > 0 && out.midFrame && out.midFrame.distinctColors > 8;
console.log(ok ? "VIDEO PREVIEW: A PLAYABLE FILM WITH VISIBLE FRAMES WAS RENDERED IN A REAL BROWSER" : "VIDEO CHECK FAILED");
await browser.close();
