/**
 * Lengths the person asks for are honoured: a song takes the length it was asked for (its lyric shortened to fit, ending on the
 * hook), and a film built from the studio template says so when its length differs. Also checks the parser that reads the request.
 */
import { requestedSongSeconds, shapeSongForRequest, lyricBudget, countLines, promptSpec } from "../src/lib/parse-song-response.ts";
import { fallbackVideoSpec } from "../src/lib/video-spec.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail.slice(0, 240)}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

section("Reading the requested length");
check('"a 30 second song" asks for 30 seconds', requestedSongSeconds("a happy song about summer, 30 seconds") === 30);
check('"one minute" asks for 60 seconds', requestedSongSeconds("a short jingle, one minute") === 60);
check('"2 minute" asks for 120 seconds', requestedSongSeconds("a ballad, 2 minute") === 120);
check('"a 3-minute song" asks for 180 seconds', requestedSongSeconds("a 3-minute song about rain") === 180);
check("a request with no length asks for nothing", requestedSongSeconds("a song about rain") === undefined);
check("lengths are kept within the song limits (5 s becomes 15 s, 900 s becomes 240 s)", requestedSongSeconds("a 5 second song") === 15 && requestedSongSeconds("a 900 second song") === 240);

section("Shaping a song to the requested length");
const long = promptSpec("a happy song about summer");
const shaped = shapeSongForRequest(long, 30);
const lines = shaped.lyrics.reduce((n, sec) => n + sec.lines.length, 0);
check("a 180-second song asked to be 30 seconds becomes 30 seconds", shaped.durationSec === 30, String(shaped.durationSec));
check("its lyric fits the lines a 30-second song can sing", lines <= lyricBudget(shaped.bpm, 30) && lines > 0, `${lines} lines, budget ${lyricBudget(shaped.bpm, 30)}`);
check("the short song keeps a verse excerpt and ends on its hook", shaped.lyrics[0]!.section.toLowerCase().includes("verse") && /chorus/i.test(shaped.lyrics[shaped.lyrics.length - 1]!.section));
check("the original song is not changed", countLines(long) > lines);
check("a song already the right length is only relabelled", shapeSongForRequest({ ...long, lyrics: long.lyrics.slice(0, 1) }, 240).lyrics.length === 1);
check("no request leaves the song untouched", shapeSongForRequest(long, undefined) === long);
const inst = shapeSongForRequest({ ...long, instrumental: true }, 45);
check("an instrumental takes the new length and keeps no lyric to trim", inst.durationSec === 45 && inst.lyrics.length === long.lyrics.length);
const withChords = shapeSongForRequest({ ...long, chords: long.lyrics.map((_, i) => [`C${i}`]) }, 30);
check("chord progressions stay aligned with their sections", (withChords.chords?.length ?? 0) === withChords.lyrics.length && withChords.lyrics.every((sec, i) => withChords.chords![i]!.length >= 1));

section("A film from the studio template says when its length differs");
const fb30 = fallbackVideoSpec("Make a 30 second video about a Lisbon coffee roaster");
check("the template keeps its readable 45-second layout", fb30.durationSec === 45 && fb30.scenes.length === 7);
check("the film says the requested length was not used", fb30.warnings.some((w) => /30-second length you asked for was not used/.test(w)), JSON.stringify(fb30.warnings));
check("the AI-director warning still comes first", fb30.warnings[0]!.includes("Lisbon"));
const fb45 = fallbackVideoSpec("a film about the ocean");
check("no note when no length was asked for", fb45.warnings.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
