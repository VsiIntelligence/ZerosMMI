/**
 * Objective vocal-audibility benchmark.
 *   npx tsx tests/tools/vocal-balance.mts [engineDir] [--quick]
 * Renders songs in several genres / voices and prints the vocal-to-backing ratio in the speech band (300 Hz - 3.4 kHz) and the
 * consonant band (1.5 - 5 kHz) during the sung passages. Higher = the lyrics are easier to hear.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
const dir = path.resolve(process.argv[2] ?? "src/lib/zeros-music");
const quick = process.argv.includes("--quick");
const { renderZerosSong } = await import(pathToFileURL(path.join(dir, "engine.ts")).href);

const L = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p} line number ${i + 1} sings softly here`);
const song = (title: string, genre: string, bpm: number, voice: string, dur: number, key = "A minor") => ({
  title, genre, bpm, voice, key, durationSec: dur, arrangement: { seed: 7 },
  lyrics: [
    { section: "Verse 1", lines: L(6, "v1") }, { section: "Pre-Chorus", lines: L(3, "pre") }, { section: "Chorus", lines: L(5, "ch") },
    { section: "Verse 2", lines: L(6, "v2") }, { section: "Chorus", lines: L(5, "ch") }, { section: "Bridge", lines: L(4, "br") }, { section: "Final Chorus", lines: L(6, "fc") },
  ],
  chords: [["Am", "F", "C", "G"]],
});
const dur = quick ? 70 : 120;
const SONGS = [
  song("Pop female", "pop", 108, "female", dur), song("Ballad male", "ballad", 70, "male", dur, "D major"),
  song("Dance female", "dance", 124, "female", dur, "F minor"), song("Hip-hop male", "hiphop", 92, "male", dur, "C minor"),
  song("Rock duet", "rock", 118, "duet", dur, "E minor"),
].slice(0, quick ? 2 : 5);
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).toLowerCase().split(",");
if (only) SONGS.splice(0, SONGS.length, ...[
  song("Pop female", "pop", 108, "female", dur), song("Ballad male", "ballad", 70, "male", dur, "D major"),
  song("Dance female", "dance", 124, "female", dur, "F minor"), song("Hip-hop male", "hiphop", 92, "male", dur, "C minor"),
  song("Rock duet", "rock", 118, "duet", dur, "E minor"),
].filter((x) => only.some((o) => x.title.toLowerCase().includes(o))));

const rows: string[] = [];
for (const spec of SONGS) {
  (globalThis as any).__balance = undefined;
  const t0 = Date.now();
  const r = await renderZerosSong(spec, { sampleRate: 32000, skipWav: true, analyze: true });
  const b = r.info?.vocalBalance ?? (globalThis as any).__balance;
  rows.push(`${spec.title.padEnd(14)} speech ${String(b?.speechDb).padStart(6)} dB | clarity ${String(b?.clarityDb).padStart(6)} dB | whole-band ${String(b?.overallDb).padStart(5)} dB | worst-10% ${String(b?.p10Db).padStart(6)} dB | vocal above band in ${Math.round((b?.coverage ?? 0) * 100)}% of windows | master ${r.info.lufs} LUFS, peak ${r.info.peakDb} dB | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(rows[rows.length - 1]);
}
