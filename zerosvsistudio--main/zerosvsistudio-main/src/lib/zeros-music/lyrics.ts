import type { Syllable } from "./vocal";
import { EXTRA_DICT } from "./lyrics-dict";
import { PHONEMES } from "./vocal";

/** ARPAbet tokens in, syllables out. The LLM supplies phonemes; a rule-based guesser covers anything it skips. */

const VOWELS = new Set(["IY", "IH", "EH", "AE", "AA", "AO", "UH", "UW", "AH", "AX", "ER", "AY", "EY", "OW", "AW", "OY"]);
const FUNCTION_WORDS = new Set(["the", "a", "an", "to", "of", "and", "in", "on", "at", "for", "my", "your", "i", "me", "you", "it", "is", "be", "we", "he", "she", "but", "so", "or", "as", "by", "our", "no", "oh", "do", "if", "up", "can", "was", "are", "with", "that", "this", "all", "just"]);

const ALIAS: Record<string, string> = { AH0: "AX", ER0: "ER", AXR: "ER", UX: "UW", IX: "IH", EL: "L", EM: "M", EN: "N", DX: "D", Q: "T", NX: "NG", HV: "HH", WH: "W", ZH: "ZH" };

export type ParsedPh = { p: string; stress: number };

export function parseArpabet(text: string): ParsedPh[][] {
  const words: ParsedPh[][] = [];
  let cur: ParsedPh[] = [];
  for (const raw of text.replace(/[\/\[\]{}()]/g, " ").split(/\s+/)) {
    if (!raw) continue;
    if (raw === "|" || raw === "||" || raw === "-") { if (cur.length) words.push(cur); cur = []; continue; }
    const m = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/^([A-Z]+)([012])?$/);
    if (!m) continue;
    let sym = m[1]!;
    const st = m[2] === undefined ? -1 : Number(m[2]);
    if (m[2] !== undefined && ALIAS[sym + m[2]]) sym = ALIAS[sym + m[2]]!;
    else if (ALIAS[sym]) sym = ALIAS[sym]!;
    if (sym === "AH" && st === 0) sym = "AX";
    if (!PHONEMES[sym]) continue;
    cur.push({ p: sym, stress: st });
  }
  if (cur.length) words.push(cur);
  return words;
}

const ONSET2 = new Set(["PL", "BL", "KL", "GL", "FL", "SL", "PR", "BR", "TR", "DR", "KR", "GR", "FR", "THR", "SHR", "TW", "KW", "GW", "SW", "SP", "ST", "SK", "SM", "SN", "SF", "HY", "THW"]);
const ONSET3 = new Set(["SPL", "SPR", "STR", "SKR", "SKW", "SKL"]);

export function syllabify(word: ParsedPh[], contentWord = true): Syllable[] {
  const vi = word.map((x, i) => (VOWELS.has(x.p) ? i : -1)).filter((i) => i >= 0);
  if (!vi.length) return word.length ? [{ onset: [], nucleus: "AX", coda: word.map((w) => w.p), stress: 0 }] : [];
  const sylls: Syllable[] = vi.map((i) => ({ onset: [], nucleus: word[i]!.p, coda: [], stress: word[i]!.stress < 0 ? (contentWord ? 1 : 0) : word[i]!.stress }));
  sylls[0]!.onset = word.slice(0, vi[0]).map((x) => x.p);
  sylls[sylls.length - 1]!.coda = word.slice(vi[vi.length - 1]! + 1).map((x) => x.p);
  for (let k = 0; k < vi.length - 1; k++) {
    const cluster = word.slice(vi[k]! + 1, vi[k + 1]).map((x) => x.p);
    let split = 0; // number of consonants that stay in the coda
    if (cluster.length === 1) split = 0;
    else if (cluster.length === 2) split = ONSET2.has(cluster.join("")) ? 0 : 1;
    else if (cluster.length >= 3) {
      const last3 = cluster.slice(-3).join(""), last2 = cluster.slice(-2).join("");
      split = ONSET3.has(last3) ? cluster.length - 3 : ONSET2.has(last2) ? cluster.length - 2 : cluster.length - 1;
    }
    sylls[k]!.coda = cluster.slice(0, split);
    sylls[k + 1]!.onset = cluster.slice(split);
  }
  // single-syllable unstressed function words keep stress 0; multi-syllable words: reduce secondary vowels
  if (sylls.length > 1 && !word.some((x) => x.stress === 1)) sylls[0]!.stress = 1;
  return sylls;
}

/* ------------------------------------------------------------ fallback LTS */
const BASE_DICT: Record<string, string> = {
  the: "DH AX", a: "AX", an: "AE N", to: "T UW", of: "AH V", and: "AE N D", you: "Y UW", your: "Y AO R", i: "AY", me: "M IY", my: "M AY", we: "W IY", be: "B IY", is: "IH Z", it: "IH T",
  love: "L AH V", heart: "HH AA R T", night: "N AY T", light: "L AY T", fire: "F AY ER", eyes: "AY Z", time: "T AY M", life: "L AY F", world: "W ER L D", dream: "D R IY M", dreams: "D R IY M Z",
  tonight: "T AX N AY T", forever: "F ER EH V ER", never: "N EH V ER", always: "AO L W EY Z", feel: "F IY L", feeling: "F IY L IH NG", know: "N OW", go: "G OW", oh: "OW", no: "N OW", so: "S OW",
  one: "W AH N", two: "T UW", for: "F AO R", are: "AA R", was: "W AH Z", were: "W ER", have: "HH AE V", has: "HH AE Z", with: "W IH TH", what: "W AH T", when: "W EH N", where: "W EH R", who: "HH UW",
  why: "W AY", how: "HH AW", there: "DH EH R", their: "DH EH R", they: "DH EY", this: "DH IH S", that: "DH AE T", then: "DH EH N", them: "DH EH M", come: "K AH M", some: "S AH M", from: "F R AH M",
  said: "S EH D", says: "S EH Z", done: "D AH N", gone: "G AO N", does: "D AH Z", people: "P IY P AH L", through: "TH R UW", though: "DH OW", thought: "TH AO T", would: "W UH D", could: "K UH D", should: "SH UH D",
  baby: "B EY B IY", yeah: "Y EH", hey: "HH EY", ooh: "UW", ah: "AA", la: "L AA", na: "N AA", mmm: "M", wanna: "W AA N AX", gonna: "G AO N AX", gotta: "G AA T AX", cause: "K AH Z",
  every: "EH V R IY", beautiful: "B Y UW T AX F AH L", river: "R IH V ER", over: "OW V ER", under: "AH N D ER", into: "IH N T UW", city: "S IH T IY", away: "AX W EY", again: "AX G EH N", ever: "EH V ER",
  tell: "T EH L", all: "AO L", old: "OW L D", cold: "K OW L D", gold: "G OW L D", hold: "HH OW L D", young: "Y AH NG", wild: "W AY L D", free: "F R IY", alive: "AX L AY V", rise: "R AY Z", fall: "F AO L",
  fly: "F L AY", sky: "S K AY", high: "HH AY", die: "D AY", cry: "K R AY", try: "T R AY", stay: "S T EY", say: "S EY", way: "W EY", day: "D EY", play: "P L EY", pray: "P R EY", away2: "AX W EY",
  home: "HH OW M", alone: "AX L OW N", together: "T AX G EH DH ER", sun: "S AH N", moon: "M UW N", star: "S T AA R", stars: "S T AA R Z", rain: "R EY N", sea: "S IY", ocean: "OW SH AX N", soul: "S OW L", pain: "P EY N",
  dance: "D AE N S", sing: "S IH NG", song: "S AO NG", music: "M Y UW Z IH K", voice: "V OY S", hand: "HH AE N D", hands: "HH AE N D Z", face: "F EY S", name: "N EY M", mind: "M AY N D", dark: "D AA R K", bright: "B R AY T",
  dil: "D IH L", pyaar: "P Y AA R", tum: "T UH M", mera: "M EY R AA", tera: "T EY R AA", hai: "HH EH", ho: "HH OW", nahi: "N AX HH IY", kya: "K Y AA", yaar: "Y AA R", zindagi: "Z IH N D AX G IY", ishq: "IH SH K",
};

const DICT: Record<string, string> = { ...BASE_DICT, ...EXTRA_DICT };

const isV = (c: string): boolean => "aeiouy".includes(c);

export function guessPhonemes(rawWord: string): ParsedPh[] {
  const w = rawWord.toLowerCase().replace(/[^a-z']/g, "").replace(/'/g, "");
  if (!w) return [];
  const known = DICT[w];
  if (known) return parseArpabet(known)[0] ?? [];
  const out: string[] = [];
  const n = w.length;
  const at = (i: number): string => w[i] ?? "";
  const magicE = (i: number): boolean => at(i + 1) !== "" && !isV(at(i + 1)) && at(i + 2) === "e" && (i + 3 === n || at(i + 3) === "s" && i + 4 === n || at(i + 3) === "d" && i + 4 === n);
  for (let i = 0; i < n; i++) {
    const c = at(i), c2 = c + at(i + 1), c3 = c2 + at(i + 2);
    const prevV = i > 0 && isV(at(i - 1)), nextV = isV(at(i + 1));
    if (c === at(i - 1) && !isV(c) && c !== "s" || (c2 === "ck" && out.push("K"))) { if (c2 === "ck") i++; continue; }
    if (c3 === "igh") { out.push("AY"); i += 2; continue; }
    if (c3 === "tch") { out.push("CH"); i += 2; continue; }
    if (c3 === "dge") { out.push("JH"); i += 2; continue; }
    if (c2 === "th") { out.push("TH"); i++; continue; }
    if (c2 === "sh") { out.push("SH"); i++; continue; }
    if (c2 === "ch") { out.push("CH"); i++; continue; }
    if (c2 === "ph") { out.push("F"); i++; continue; }
    if (c2 === "wh") { out.push("W"); i++; continue; }
    if (c2 === "ng") { out.push("NG"); i++; continue; }
    if (c2 === "gh") { i++; continue; }
    if (c2 === "qu") { out.push("K", "W"); i++; continue; }
    if (c2 === "kn" && i === 0) { out.push("N"); i++; continue; }
    if (c2 === "wr" && i === 0) { out.push("R"); i++; continue; }
    if (c2 === "ee" || c2 === "ea") { out.push("IY"); i++; continue; }
    if (c2 === "oo") { out.push("UW"); i++; continue; }
    if (c2 === "ou") { out.push(i + 2 < n && at(i + 2) === "r" ? "AO" : "AW"); i++; continue; }
    if (c2 === "ow") { out.push(i + 2 === n || !isV(at(i + 2)) ? "OW" : "AW"); i++; continue; }
    if (c2 === "oa" || c2 === "oe") { out.push("OW"); i++; continue; }
    if (c2 === "ai" || c2 === "ay" || c2 === "ei" || c2 === "ey") { out.push("EY"); i++; continue; }
    if (c2 === "ie") { out.push(i + 2 === n ? "AY" : "IY"); i++; continue; }
    if (c2 === "oy" || c2 === "oi") { out.push("OY"); i++; continue; }
    if (c2 === "au" || c2 === "aw") { out.push("AO"); i++; continue; }
    if (c2 === "ar") { out.push("AA", "R"); i++; continue; }
    if (c2 === "or") { out.push("AO", "R"); i++; continue; }
    if (c2 === "er" || c2 === "ir" || c2 === "ur") { out.push("ER"); i++; continue; }
    if (c === "a") { out.push(magicE(i) ? "EY" : i === n - 1 ? "AX" : "AE"); continue; }
    if (c === "e") { if (i === n - 1 && n > 2 && !isV(at(i - 1))) continue; if (i === n - 2 && at(i + 1) === "s" && n > 3) continue; if (i === n - 2 && at(i + 1) === "d" && n > 3 && !"td".includes(at(i - 1))) continue; out.push(i === n - 1 ? "IY" : "EH"); continue; }
    if (c === "i") { out.push(magicE(i) ? "AY" : "IH"); continue; }
    if (c === "o") { out.push(magicE(i) ? "OW" : i === n - 1 ? "OW" : "AA"); continue; }
    if (c === "u") { out.push(magicE(i) ? "UW" : "AH"); continue; }
    if (c === "y") { if (i === 0) out.push("Y"); else out.push(i === n - 1 ? (n <= 3 ? "AY" : "IY") : "IH"); continue; }
    if (c === "c") { out.push("EIY".includes(at(i + 1).toUpperCase()) && at(i + 1) !== "" ? "S" : "K"); continue; }
    if (c === "g") { out.push("eiy".includes(at(i + 1)) && at(i + 1) !== "" && !["get", "give", "girl"].some((x) => w.startsWith(x)) ? "JH" : "G"); continue; }
    if (c === "s") { out.push(prevV && nextV ? "Z" : i === n - 1 && prevV && at(i - 1) !== "u" ? "Z" : "S"); continue; }
    if (c === "x") { out.push("K", "S"); continue; }
    if (c === "j") { out.push("JH"); continue; }
    if (c === "q") { out.push("K"); continue; }
    if (c === "h") { out.push("HH"); continue; }
    if (c === "r") { out.push("R"); continue; }
    if (c === "w") { out.push("W"); continue; }
    const direct: Record<string, string> = { b: "B", d: "D", f: "F", k: "K", l: "L", m: "M", n: "N", p: "P", t: "T", v: "V", z: "Z" };
    if (direct[c]) out.push(direct[c]!);
  }
  // stress: first vowel primary
  let seen = false;
  return out.map((p) => { if (VOWELS.has(p)) { const st = seen ? 0 : 1; seen = true; return { p, stress: st }; } return { p, stress: -1 }; });
}

export type LyricSyl = Syllable & { word: number; text: string };

/** Turns one lyric line (plus optional LLM ARPAbet) into syllables. */
export function lineToSyllables(line: string, ph?: string): LyricSyl[] {
  const words = line.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}']/gu, "")).filter(Boolean);
  let phWords = ph ? parseArpabet(ph) : [];
  if (phWords.length && phWords.length !== words.length) {
    const flat = phWords.flat();
    if (phWords.length === 1 && words.length > 1) {
      // no word boundaries given: split the stream by each word's guessed syllable count
      const counts = words.map((w) => Math.max(1, guessPhonemes(w).filter((x) => VOWELS.has(x.p)).length));
      const vowelsInFlat = flat.filter((x) => VOWELS.has(x.p)).length;
      if (counts.reduce((a, b) => a + b, 0) === vowelsInFlat) {
        phWords = []; let idx = 0;
        for (const c of counts) { let v = 0; const w: ParsedPh[] = []; while (idx < flat.length && (v < c || !VOWELS.has(flat[idx]!.p) && v === c - 0 && false)) { w.push(flat[idx]!); if (VOWELS.has(flat[idx]!.p)) v++; idx++; if (v === c) { while (idx < flat.length && !VOWELS.has(flat[idx]!.p) && (idx + 1 >= flat.length || !VOWELS.has(flat[idx + 1]!.p) || false)) { w.push(flat[idx]!); idx++; } break; } } phWords.push(w); }
      } else phWords = [flat];
    } else phWords = [];
  }
  const out: LyricSyl[] = [];
  words.forEach((word, wi) => {
    const pw = phWords.length === words.length ? phWords[wi]! : guessPhonemes(word);
    const content = !FUNCTION_WORDS.has(word.toLowerCase());
    const sy = syllabify(pw, content);
    if (!content && sy.length === 1) sy[0]!.stress = 0; // function words are never musically stressed
    for (const s of sy) out.push({ ...s, word: wi, text: word });
  });
  if (!phWords.length || phWords.length === 1) {
    // single stream fallback (no boundaries): syllabify directly
    if (phWords.length === 1) { const only = syllabify(phWords[0]!, true); if (only.length) return only.map((s) => ({ ...s, word: 0, text: line })); }
  }
  return out;
}
