import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
await page.goto("http://127.0.0.1:8765/index.html");
const out = await page.evaluate(async () => {
  const K = window.Kit;
  const prompt = "a bright, happy summer pop song about the beach, 30 seconds";
  const t0 = performance.now();
  const built = await K.buildSong({
    prompt, history: [{ role: "user", content: prompt }], memories: [],
    streamChat: async () => "", onStatus: () => {}, onProgress: () => {},
  });
  const renderMs = Math.round(performance.now() - t0);
  const blob = built.render.blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = new DataView(bytes.buffer);
  const fileRate = header.getUint32(24, true), fileChannels = header.getUint16(22, true), fileBits = header.getUint16(34, true);
  // decode at the file's own rate, so the browser does not resample (resampling can overshoot full scale on its own)
  const ctx = new AudioContext({ sampleRate: fileRate });
  const audio = await ctx.decodeAudioData(bytes.buffer.slice(0));
  const ch = audio.getChannelData(0);
  let sum = 0, peak = 0;
  for (let i = 0; i < ch.length; i++) { const v = ch[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / ch.length);
  // loudness per second: a real song changes over time; silence in the middle would show here
  const seconds = Math.floor(audio.duration);
  const perSecond = [];
  for (let s = 0; s < seconds; s++) { let q = 0; const from = s * audio.sampleRate, to = Math.min(ch.length, from + audio.sampleRate); for (let i = from; i < to; i++) q += ch[i] * ch[i]; perSecond.push(+Math.sqrt(q / (to - from)).toFixed(3)); }
  await ctx.close();
  const lyricLines = built.spec.lyrics.reduce((n, sec) => n + sec.lines.length, 0);
  return { fileRate, fileChannels, fileBits, renderMs, title: built.spec.title, bpm: built.spec.bpm, requestedSec: built.spec.durationSec, decodedSec: +audio.duration.toFixed(2), sampleRate: audio.sampleRate, channels: audio.numberOfChannels, rms: +rms.toFixed(4), peak: +peak.toFixed(3), quietSeconds: perSecond.filter((v) => v < 0.01).length, perSecond: perSecond.slice(0, 12), lyricLines, warnings: built.warnings.slice(0, 3), blobType: blob.type, blobBytes: blob.size, compressed: !!built.render.compressed };
});
console.log(JSON.stringify(out, null, 1));
const ok = out.decodedSec > 25 && out.decodedSec < 35 && out.rms > 0.02 && out.peak <= 1.0 && out.peak > 0.2 && out.quietSeconds <= Math.max(2, out.decodedSec * 0.1) && out.fileBits === 16;
console.log(ok ? "SONG PREVIEW: A REAL, AUDIBLE TRACK WAS RENDERED AND DECODES IN A REAL BROWSER" : "SONG CHECK FAILED");
await browser.close();
