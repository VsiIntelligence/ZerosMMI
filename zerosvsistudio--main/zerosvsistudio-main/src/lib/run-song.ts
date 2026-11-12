import type { Msg } from "@/lib/ai-client";
import type { ZeroMode } from "@/lib/zeros";
import { countLines, lyricBudget, lyricIssues, parseSong, requestedSongSeconds, secondsPerLine, shapeSongForRequest, type LyricIssue } from "@/lib/parse-song-response";
import { liteInfo, renderSongDetailed, type SongInfoLite, type SongRender, type SongSpec } from "@/lib/song";
import { clock, songReport, type SongReport } from "@/lib/song-report";

type StreamChat = (messages: Msg[], mode: ZeroMode, memories: string[], onDelta: (full: string) => void) => Promise<string>;

export type SongBuild = {
  spec: SongSpec;
  witty: string;
  render: SongRender;
  lite: SongInfoLite;
  report: SongReport;
  /** the model's reply was unusable and a prompt-based fallback lyric was used */
  usedFallback: boolean;
  /** an automatic rewrite pass added missing sections / lines */
  expanded: boolean;
  warnings: string[];
  facts: string[];
};

const major = (issues: LyricIssue[]): LyricIssue[] => issues.filter((i) => i.severity === "major");

/**
 * The lyric decides the length: enough lines for the target tempo -> a longer song, up to 4:00. A length the person asked for wins:
 * the song takes that length and its lyric is shortened to fit.
 */
function fitDuration(spec: SongSpec, asked?: number): SongSpec {
  if (asked !== undefined) return shapeSongForRequest(spec, asked);
  if (spec.instrumental) return spec;
  const natural = 14 + countLines(spec) * secondsPerLine(spec.bpm);
  const durationSec = Math.min(240, Math.max(spec.durationSec, Math.round(natural)));
  return durationSec === spec.durationSec ? spec : { ...spec, durationSec };
}

export async function buildSong(args: {
  prompt: string;
  history: Msg[];
  memories: string[];
  streamChat: StreamChat;
  onStatus: (s: string) => void;
  onProgress: (fraction: number, label: string) => void;
  /** The song this one changes (its complete spec), so "make the chorus bigger" revises that song instead of writing a new one. */
  previous?: SongSpec | null;
}): Promise<SongBuild> {
  const { prompt, memories, streamChat, onStatus, onProgress, previous } = args;
  const warnings: string[] = [];
  // Editing keeps every part of the previous song that the request does not touch: the key, tempo, voice, title and lyric.
  const history: Msg[] = previous
    ? [...args.history.slice(0, -1), { role: "user", content: `${args.prompt}\n\nThis is an EDIT of the song below. Return the COMPLETE song object again with only the requested change made. Keep the title, key, tempo, voice, structure and every lyric line that the request does not touch.\nPREVIOUS SONG (JSON):\n${JSON.stringify(previous).slice(0, 14000)}` }]
    : args.history;

  /* 1. write the song ------------------------------------------------------------------------------------------ */
  onStatus(previous ? "Revising the song as you asked…" : "Writing the lyrics and the chord map…");
  let text = await streamChat(history, "music", memories, () => {});
  let parsed = parseSong(text, prompt);
  if (parsed.fromFallback) {
    onStatus("The first draft came back garbled - asking for a clean take…");
    text = await streamChat([...history, { role: "user", content: `${prompt}\n\nReply with ONE witty line and then exactly one \`\`\`json block containing the complete song object (title, bpm, genre, key, voice, durationSec, lyrics with sections and lines, chords). No text after the block.` }], "music", memories, () => {});
    const retry = parseSong(text, prompt);
    if (!retry.fromFallback) parsed = retry;
  }
  // A length the person asked for is honoured (the song is shortened to fit); otherwise the lyric decides the length.
  const asked = requestedSongSeconds(prompt);
  let spec = fitDuration(parsed.spec, asked), witty = parsed.witty, expanded = false;

  /* 2. songwriting check -> one rewrite pass when the lyric is too thin for a full song ------------------------- */
  let issues = lyricIssues(spec);
  if (!parsed.fromFallback && major(issues).length && asked === undefined) {
    onStatus("Checking line budget, hook and structure - expanding the lyrics…");
    const budget = lyricBudget(spec.bpm, Math.max(spec.durationSec, 210));
    const msg = `[[EXPAND]] The user asked: "${prompt.slice(0, 600)}"\n\nYour previous song (JSON) is below. Problems found:\n${issues.map((i) => `- [${i.severity}] ${i.problem}`).join("\n")}\n\nReturn the COMPLETE improved JSON again (every section, never a diff). Keep the title, the hook and the best lines. Target about ${budget} sung lines for a ${Math.max(spec.durationSec, 210)} s song at ${spec.bpm} bpm, with a real second verse, a bridge that turns the story and a Final Chorus that grows.\n\nPREVIOUS JSON:\n${JSON.stringify({ title: spec.title, style: spec.style, genre: spec.genre, bpm: spec.bpm, key: spec.key, voice: spec.voice, vocalStyle: spec.vocalStyle, durationSec: spec.durationSec, lyrics: spec.lyrics.map((s) => ({ section: s.section, lines: s.lines })), ...(spec.chords ? { chords: spec.chords } : {}) })}`;
    try {
      const again = parseSong(await streamChat([{ role: "user", content: msg }], "music", memories, () => {}), prompt);
      if (!again.fromFallback) {
        const next = fitDuration(again.spec, asked), nextIssues = lyricIssues(next);
        if (countLines(next) >= countLines(spec) && major(nextIssues).length <= major(issues).length) { spec = next; issues = nextIssues; expanded = true; witty = witty || again.witty; }
        else warnings.push("The rewrite was not better than the first draft, so the first draft was kept.");
      }
    } catch { warnings.push("The lyric-expansion pass was skipped."); }
  }
  if (parsed.fromFallback) warnings.push("The lyric model did not return usable JSON, so Zeros wrote a first draft from your own words - ask again for a fully custom lyric.");

  /* 3. play it: compose, arrange, sing, mix, master ------------------------------------------------------------- */
  onStatus("Recording the track…");
  const progress = (f: number, label: string) => { onProgress(f, label); onStatus(`${label}… ${Math.round(f * 100)}%`); };
  let render: SongRender;
  try {
    render = await renderSongDetailed(spec, progress);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`The first render failed (${msg.slice(0, 80)}); retried in memory-saver mode.`);
    onStatus("Retrying in memory-saver mode…");
    render = await renderSongDetailed(spec, progress, { sampleRate: 32000, compress: false });
  }
  const lite = liteInfo(render.info);
  const report = songReport(spec, lite, spec.durationSec);
  const lines = countLines(spec);
  const facts = [
    `"${spec.title}" - ${render.info.genre}, ${render.info.bpm} bpm, ${render.info.key}, ${clock(render.info.durationSec)}${spec.instrumental ? ", instrumental" : `, ${render.info.voice} lead vocal`}`,
    `${render.info.sections.length} sections (${render.info.sections.map((s) => s.name).join(" > ")})`,
    ...(spec.instrumental ? [] : [`${lines} written lyric lines${expanded ? " (expanded by an automatic songwriting rewrite pass)" : ""}, ${render.info.lyrics.length} placed on the timeline for synced karaoke`]),
    `Mastered to ${render.info.lufs} LUFS with ${render.info.peakDb} dB peak; verse-to-chorus loudness swing makes the choruses open up`,
    `Quality report: ${report.headline}`,
    `Style brief: ${spec.style ?? ""}`,
    `Hook / first lines of the chorus: ${(spec.lyrics.find((s) => /chorus|hook/i.test(s.section))?.lines ?? []).slice(0, 2).join(" / ")}`,
    ...(render.compressed ? [`Exports: lossless WAV (${(render.blob.size / 1e6).toFixed(0)} MB), Opus (${(render.compressed.size / 1e6).toFixed(1)} MB), synced .lrc and a lyric sheet`] : ["Exports: lossless WAV, synced .lrc and a lyric sheet"]),
  ];
  return { spec, witty, render, lite, report, usedFallback: parsed.fromFallback, expanded, warnings, facts };
}
