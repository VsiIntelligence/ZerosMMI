import type { Plan, PlanSection } from "./composer";
import type { SectionKind } from "./theory";
import { dbToGain, type Stereo } from "./dsp";

export type BusName = "vocal" | "drums" | "bass" | "chords" | "lead" | "fx";

/**
 * Level of every bus per section kind, in dB relative to a full chorus.
 * Verses are intimate, the pre-chorus builds, the chorus is wide open, the bridge drops out, the outro unwinds.
 */
const TABLE: Record<SectionKind, Record<BusName, number>> = {
  intro: { vocal: 0, drums: -5, bass: -4, chords: -2, lead: 0, fx: -1 },
  verse: { vocal: -1.2, drums: -3.5, bass: -2.5, chords: -3, lead: -5, fx: -3 },
  pre: { vocal: -0.6, drums: -2, bass: -1.5, chords: -1.5, lead: -3, fx: 0 },
  chorus: { vocal: 0, drums: 0, bass: 0, chords: 0, lead: 0, fx: 0 },
  bridge: { vocal: -1.5, drums: -6, bass: -4, chords: -2.5, lead: -4, fx: -1 },
  break: { vocal: 0, drums: -1.5, bass: -1.5, chords: -1.5, lead: 0, fx: 0 },
  outro: { vocal: -2, drums: -5, bass: -4, chords: -3, lead: -3, fx: -3 },
};

function baseDb(sec: PlanSection, bus: BusName): number {
  let db = TABLE[sec.kind]![bus]!;
  if (sec.kind === "verse" && sec.variant > 0) db += 0.8;      /* the second verse leans in */
  if (sec.last) db += bus === "fx" ? 1 : 1.0;                   /* the final chorus is the biggest moment */
  return db;
}

export type DynPoint = { t: number; db: number };

/** Piecewise-linear (in dB) automation curve for one bus across the whole arrangement. */
export function dynamicsCurve(plan: Plan, bus: BusName): DynPoint[] {
  const pts: DynPoint[] = [];
  const xfade = Math.min(plan.bar * 0.5, 1.2);
  plan.sections.forEach((sec, i) => {
    const t0 = sec.startBar * plan.bar, t1 = (sec.startBar + sec.bars) * plan.bar, next = plan.sections[i + 1];
    const base = baseDb(sec, bus);
    let startDb = base, endDb = base;
    if (sec.kind === "pre") { startDb = base - 1.2; endDb = (next ? baseDb(next, bus) : base) - 0.4; }          /* build into the chorus */
    else if (sec.kind === "bridge") { startDb = base - 0.8; endDb = Math.max(base + 2.6, (next ? baseDb(next, bus) : base) - 1.2); } /* breakdown, then climb */
    else if (sec.kind === "intro") endDb = base + 1.6;                                                              /* anticipation */
    else if (sec.kind === "outro") endDb = base - 4;                                                                /* unwind */
    else if (sec.kind === "verse" && next && (next.kind === "chorus") ) endDb = base + 1.0;                         /* verse leaning into the hook */
    const a = i === 0 ? t0 : t0 + xfade * 0.5, b = i === plan.sections.length - 1 ? t1 : t1 - xfade * 0.5;
    pts.push({ t: a, db: startDb }, { t: Math.max(a + 0.01, b), db: endDb });
  });
  return pts;
}

/** Applies the automation curve in place (exponential ramps, no per-sample pow). */
export function applyDynamics(bus: Stereo, plan: Plan, name: BusName, sr: number, depth = 1): void {
  const pts = dynamicsCurve(plan, name).map((p) => ({ t: p.t, db: p.db * depth }));
  if (!pts.length) return;
  const n = bus.l.length;
  let first = Math.min(n, Math.floor(pts[0]!.t * sr));
  const g0 = dbToGain(pts[0]!.db);
  for (let i = 0; i < first; i++) { bus.l[i]! *= g0; bus.r[i]! *= g0; }
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k]!, b = pts[k + 1]!;
    const s0 = Math.min(n, Math.floor(a.t * sr)), s1 = Math.min(n, Math.floor(b.t * sr));
    if (s1 <= s0) continue;
    let g = dbToGain(a.db);
    const ratio = Math.pow(dbToGain(b.db - a.db), 1 / (s1 - s0));
    for (let i = s0; i < s1; i++) { bus.l[i]! *= g; bus.r[i]! *= g; g *= ratio; }
    first = s1;
  }
  const gEnd = dbToGain(pts[pts.length - 1]!.db);
  for (let i = first; i < n; i++) { bus.l[i]! *= gEnd; bus.r[i]! *= gEnd; }
}

/** A short breath of silence right before the chorus lands (stop-time), for punchy genres only. */
export function preChorusDips(plan: Plan): { t: number; len: number }[] {
  if (["ballad", "lofi", "acoustic", "cinematic"].includes(plan.genre.id)) return [];
  const out: { t: number; len: number }[] = [];
  plan.sections.forEach((sec, i) => {
    const prev = plan.sections[i - 1];
    if (sec.kind === "chorus" && prev && prev.kind !== "chorus") out.push({ t: sec.startBar * plan.bar, len: Math.min(0.16, plan.beat * 0.3) });
  });
  return out;
}

export function applyDips(mix: Stereo, dips: { t: number; len: number }[], sr: number, depthDb = 8): void {
  const n = mix.l.length, dip = dbToGain(-depthDb);
  for (const d of dips) {
    const end = Math.floor(d.t * sr), start = Math.max(0, end - Math.floor(d.len * sr)), fadeIn = Math.floor(0.012 * sr);
    for (let i = start; i < Math.min(n, end); i++) {
      const edge = Math.min(1, (i - start) / Math.max(1, fadeIn)); /* fast fade into the dip, hard release at the downbeat */
      const g = 1 - (1 - dip) * edge;
      mix.l[i]! *= g; mix.r[i]! *= g;
    }
  }
}
