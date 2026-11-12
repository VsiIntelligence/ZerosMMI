/** Deterministic, offline album art (canvas): every title gets its own colours and shapes. */
function hash(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rngOf(seed: number): () => number { let a = seed || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const MOODS: Record<string, [number, number]> = { rock: [8, 28], metal: [0, 20], trap: [270, 300], hiphop: [38, 48], pop: [320, 190], dance: [185, 300], house: [195, 285], rnb: [285, 20], lofi: [205, 30], ballad: [215, 340], cinematic: [210, 35], synthwave: [300, 190], acoustic: [32, 95], indie: [160, 40], latin: [12, 50], afro: [30, 150], funk: [45, 300], dnb: [150, 280] };

export function makeSongCover(title: string, genre = "pop", size = 640): string {
  if (typeof document === "undefined") return "";
  const rnd = rngOf(hash(`${title}|${genre}`)), key = genre.toLowerCase().replace(/[^a-z]/g, "");
  const [h1, h2] = MOODS[key] ?? [Math.floor(rnd() * 360), Math.floor(rnd() * 360)];
  const c = document.createElement("canvas"); c.width = size; c.height = size;
  const g = c.getContext("2d");
  if (!g) return "";
  const bg = g.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, `hsl(${h1} 70% 14%)`); bg.addColorStop(1, `hsl(${h2} 75% 22%)`);
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 7; i++) {   /* soft glowing orbs */
    const x = rnd() * size, y = rnd() * size, r = size * (0.18 + rnd() * 0.38), hue = i % 2 ? h1 : h2;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `hsla(${hue + rnd() * 40 - 20} 90% 62% / ${0.35 + rnd() * 0.3})`); rg.addColorStop(1, `hsla(${hue} 90% 50% / 0)`);
    g.fillStyle = rg; g.fillRect(0, 0, size, size);
  }
  g.lineWidth = 2;
  for (let i = 0; i < 22; i++) {  /* sweeping arcs */
    g.strokeStyle = `hsla(${(i % 2 ? h1 : h2) + 30} 90% 75% / ${0.05 + rnd() * 0.12})`;
    g.beginPath(); g.arc(size * (0.2 + rnd() * 0.6), size * (0.2 + rnd() * 0.6), size * (0.1 + i * 0.035), rnd() * 6.28, rnd() * 6.28 + 2 + rnd() * 3); g.stroke();
  }
  const sun = g.createRadialGradient(size * 0.5, size * 0.42, 0, size * 0.5, size * 0.42, size * 0.3);
  sun.addColorStop(0, "hsla(0 0% 100% / 0.55)"); sun.addColorStop(0.35, `hsla(${h2} 100% 80% / 0.22)`); sun.addColorStop(1, "hsla(0 0% 100% / 0)");
  g.fillStyle = sun; g.fillRect(0, 0, size, size);
  const v = g.createLinearGradient(0, size * 0.55, 0, size); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.78)");
  g.fillStyle = v; g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size), d = img.data;  /* film grain */
  for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 14; d[i]! += n; d[i + 1]! += n; d[i + 2]! += n; }
  g.putImageData(img, 0, 0);
  g.fillStyle = "#fff"; g.textBaseline = "alphabetic";
  const words = title.toUpperCase().split(/\s+/), lines: string[] = []; let cur = "";
  g.font = `800 ${Math.round(size * 0.075)}px "Space Grotesk", system-ui, sans-serif`;
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (g.measureText(t).width > size * 0.84 && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 3), lh = size * 0.085;
  shown.forEach((ln, i) => g.fillText(ln, size * 0.08, size * 0.9 - (shown.length - 1 - i) * lh));
  g.font = `600 ${Math.round(size * 0.028)}px system-ui, sans-serif`; g.fillStyle = "rgba(255,255,255,0.7)";
  g.fillText("ZEROS · VSISTUDIO", size * 0.08, size * 0.08);
  return c.toDataURL("image/jpeg", 0.88);
}
