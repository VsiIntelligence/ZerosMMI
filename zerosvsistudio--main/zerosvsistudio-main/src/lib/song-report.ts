import type { SongSpec, SongInfoLite } from "@/lib/song";
import { countLines } from "@/lib/parse-song-response";

export type SongCheck = { label: string; value: string; ok: boolean };
export type SongReport = { score: number; checks: SongCheck[]; headline: string };

export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const pct = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0; };

/** Objective checks on the finished master + arrangement (no ears required). */
export function songReport(spec: SongSpec, info: SongInfoLite, requestedSec = spec.durationSec): SongReport {
  const checks: SongCheck[] = [];
  const dur = info.durationSec, sung = !spec.instrumental;
  checks.push({ label: "Length", value: `${clock(dur)} (asked ${clock(requestedSec)})`, ok: dur >= requestedSec * 0.88 && dur <= 245 });
  const kinds = new Set(info.sections.map((s) => s.kind));
  checks.push({ label: "Structure", value: `${info.sections.length} sections${kinds.has("bridge") ? " incl. bridge" : ""}${kinds.has("break") ? " + instrumental" : ""}`, ok: info.sections.length >= (dur >= 150 ? 7 : 4) && kinds.has("chorus") });
  if (sung) {
    const lines = countLines(spec);
    checks.push({ label: "Lyrics", value: `${info.lyrics.length}/${lines} lines sung`, ok: info.lyrics.length >= lines * 0.9 });
    checks.push({ label: "Vocals", value: info.vocalsRendered ? `${info.voice} lead + doubles + harmonies` : "no vocal rendered", ok: info.vocalsRendered });
    /* the lyric must stand out from the band: measured in the speech band (vowels) and the consonant band (words), per 100 ms window */
    const vb = info.vocalBalance;
    if (vb && vb.windows > 0) {
      const sign = (n: number): string => (n > 0 ? "+" : "") + n;
      checks.push({
        label: "Lyric clarity",
        value: `voice ${sign(vb.speechDb)} dB over the band (consonants ${sign(vb.clarityDb)} dB), ahead of the band in ${Math.round(vb.coverage * 100)}% of the singing`,
        ok: vb.speechDb >= 6 && vb.clarityDb >= 3 && vb.coverage >= 0.9,
      });
    }
  }
  checks.push({ label: "Loudness", value: `${info.lufs} LUFS (streaming target -14)`, ok: info.lufs >= -16.5 && info.lufs <= -12 });
  checks.push({ label: "Headroom", value: `peak ${info.peakDb} dB`, ok: info.peakDb <= -0.5 });
  const dr = Math.round((pct(info.contour, 0.9) - pct(info.contour.slice(1, -2), 0.1)) * 10) / 10;
  checks.push({ label: "Dynamics", value: `${dr} dB verse-to-chorus swing`, ok: dr >= 3 });
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { score, checks, headline: `${score >= 90 ? "Studio-clean" : score >= 70 ? "Solid" : "Needs another take"} - ${checks.filter((c) => c.ok).length}/${checks.length} checks passed` };
}
