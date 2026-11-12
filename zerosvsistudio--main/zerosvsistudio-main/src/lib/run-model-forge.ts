import type { Msg } from "@/lib/ai-client";
import type { ZeroMode } from "@/lib/zeros";
import { deviceProfile, forgeShape, type ForgeMesh, type ForgeStats } from "@/lib/forge/forge-client";
import { ForgeRenderer } from "@/lib/forge/forge-render";
import { extractForgeCode, forgeWitty, parseForgePlan, planToText, type ForgePlan } from "@/lib/forge/forge-prompt";
import { authHeaders } from "@/lib/auth-token";

type StreamChat = (messages: Msg[], mode: ZeroMode, memories: string[], onDelta: (full: string) => void) => Promise<string>;

export type ModelReview = {
  score: number;
  matches: boolean;
  summary: string;
  issues: { severity: "blocker" | "major" | "minor"; problem: string; fix?: string }[];
};

export type ModelIssue = { severity: "blocker" | "major" | "minor"; problem: string; fix: string };

export type ForgeBuild = {
  code: string;
  mesh: ForgeMesh;
  stats: ForgeStats;
  review: ModelReview | null;
  witty: string;
  rounds: number;
  warnings: string[];
  plan: ForgePlan | null;
  candidates: number;
  /** "hyper" when the refined high-detail pass succeeded, otherwise the fast draft. */
  quality: "hyper" | "draft";
  features: { surface: boolean; displace: boolean; primitives: number };
  /** Plain-language facts about what was built, used for the commentary and the result card. */
  facts: string[];
};

const stillsOf = (mesh: ForgeMesh): { name: string; dataUrl: string }[] => {
  if (typeof document === "undefined") return [];
  const canvas = document.createElement("canvas");
  canvas.width = 448; canvas.height = 448;
  let r: ForgeRenderer | null = null;
  try {
    r = new ForgeRenderer(canvas);
    r.setMesh(mesh);
    const views: [string, number, number][] = [["front three-quarter", 0.7, 0.25], ["left side", Math.PI / 2, 0.08], ["back three-quarter", Math.PI + 0.6, 0.3]];
    return views.map(([name, yaw, pitch]) => ({ name, dataUrl: r!.capture(yaw, pitch, 448) }));
  } catch {
    return [];
  } finally {
    r?.dispose();
  }
};

/** What the program uses (cheap lexical scan - the worker runs the real thing). */
export function codeFeatures(code: string): { surface: boolean; displace: boolean; primitives: number } {
  const prims = code.match(/\b(sphere|box|roundBox|cylinder|roundCylinder|capsule|taperedCapsule|torus|cone|cappedCone|roundCone|hexPrism|octahedron|pyramid|ellipsoid|curveTube|lathe)\s*\(/g) ?? [];
  return { surface: /function\s+surface\s*\(/.test(code), displace: /function\s+displace\s*\(/.test(code), primitives: prims.length };
}

/** Measured problems a reviewer would also notice. Blockers send the code back for repair. */
export function staticModelIssues(stats: ForgeStats, code = ""): ModelIssue[] {
  const out: ModelIssue[] = [];
  const size = stats.bounds.max.map((v, i) => v - stats.bounds.min[i]!);
  const longest = Math.max(...size), shortest = Math.min(...size);
  if (stats.boundaryEdges > 0) out.push({ severity: "major", problem: `The mesh has ${stats.boundaryEdges} open edges (holes) - part of the shape is cut off or has zero thickness.`, fix: "Keep every part inside about 2.5 units of the origin, make thin parts at least 0.03 thick, and set a generous bounds box." });
  if (stats.nonManifoldEdges > 4) out.push({ severity: "minor", problem: `${stats.nonManifoldEdges} non-manifold edges (parts touching along a hairline).`, fix: "Overlap touching parts by at least 0.03 or blend them with smin." });
  if (stats.keptComponents > 1) out.push({ severity: stats.keptComponents > 3 ? "major" : "minor", problem: `The model is ${stats.keptComponents} separate floating pieces instead of one solid.`, fix: "Make the parts overlap or join them with smin(...) / short connecting capsules so the model is one connected body." });
  if (longest < 0.9) out.push({ severity: "minor", problem: "The model is very small inside its box.", fix: "Scale the whole model up so the longest side is about 2 units." });
  if (longest > 3.4) out.push({ severity: "minor", problem: "The model is oversized.", fix: "Scale the model so its longest side is about 2.2 units." });
  if (shortest < longest * 0.03) out.push({ severity: "major", problem: "The model is almost flat (paper-thin in one direction).", fix: "Give the model real depth in every direction." });
  if (stats.vertices < 3000) out.push({ severity: "minor", problem: "The surface is very low-detail.", fix: "Add secondary forms (ears, panels, trims, eyes) and a displace() function so there is more to see." });
  if (stats.badQuadPct > 10) out.push({ severity: "minor", problem: `${stats.badQuadPct}% of quads are stretched.`, fix: "Avoid extremely thin features and extreme non-uniform scaling." });
  if (code) {
    const f = codeFeatures(code);
    if (!f.surface && !f.displace) out.push({ severity: "major", problem: "The program has no surface() materials and no displace() micro-detail, so the model will look like smooth uniform plastic.", fix: "Add function surface(x,y,z) returning [metallic, roughness, emissive] per region, and function displace(x,y,z) with fur/grain/panel/rivet/scale detail suited to the subject." });
    else if (!f.surface) out.push({ severity: "minor", problem: "No per-region PBR materials (surface()).", fix: "Add function surface(x,y,z) so metals, glass, cloth, skin and lights each get a real material." });
    else if (!f.displace) out.push({ severity: "minor", problem: "No micro-detail (displace()).", fix: "Add function displace(x,y,z) with subtle grain, seams, scales or fur." });
    if (f.primitives < 8) out.push({ severity: "minor", problem: `Only ${f.primitives} primitives - the model is too simple.`, fix: "Add 12-30 secondary forms: trims, panels, features, accessories." });
  }
  return out;
}

const staticScore = (issues: ModelIssue[]): number => Math.max(0, 94 - issues.reduce((s, i) => s + (i.severity === "blocker" ? 40 : i.severity === "major" ? 18 : 5), 0));

async function review(request: string, mesh: ForgeMesh, notes: string[]): Promise<ModelReview | null> {
  const views = stillsOf(mesh);
  if (!views.length) return null;
  try {
    const res = await fetch("/api/verify-model", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ request: request.slice(0, 800), stats: { ...mesh.stats, bounds: mesh.stats.bounds, samples: undefined }, views, notes }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<ModelReview> & { issues?: ModelReview["issues"] };
    if (typeof j.score !== "number") return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(j.score))),
      matches: j.matches !== false,
      summary: String(j.summary ?? "").slice(0, 300),
      issues: (Array.isArray(j.issues) ? j.issues : []).slice(0, 6).map((i) => ({ severity: i.severity === "blocker" || i.severity === "major" ? i.severity : "minor", problem: String(i.problem ?? "").slice(0, 260), ...(i.fix ? { fix: String(i.fix).slice(0, 260) } : {}) })),
    };
  } catch {
    return null;
  }
}

const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Cancelled."); };

/** A failure that is the engines being busy or briefly unreachable (worth another try), not a limit, a plan or a sign-in problem. */
export function isTransientFailure(message: string): boolean {
  if (/limit|plan|subscription|sign.?in|log.?in|promo|requests every|not allowed|forbidden|unauthori[sz]ed|Cancelled/i.test(message)) return false;
  return /could not reach|reasoning engine|try (?:it )?again|temporar|timed? ?out|time-?out|network|failed to fetch|load failed|overloaded|busy|unavailable|\b50[234]\b|\b429\b|resource limit|1102|worker exceeded/i.test(message);
}

/**
 * Runs one engine call, asking again (after a pause) when the engines were only busy or briefly unreachable. A request that fails is
 * never charged, so patience costs nothing. Cancelling stops at once.
 */
export async function withPatience<T>(work: () => Promise<T>, o: { signal?: AbortSignal; tries?: number; pauseMs?: number } = {}): Promise<T> {
  const tries = o.tries ?? 3, pause = o.pauseMs ?? 1800;
  let last: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    throwIfAborted(o.signal);
    try {
      return await work();
    } catch (e) {
      last = e;
      const message = e instanceof Error ? e.message : String(e);
      if (!isTransientFailure(message) || attempt === tries - 1) break;
      await new Promise((resolve) => setTimeout(resolve, pause * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

type Candidate = { code: string; mesh: ForgeMesh; label: string; issues: ModelIssue[]; review: ModelReview | null; score: number; witty: string };

export async function buildModel(args: {
  prompt: string;
  previousCode: string | null;
  memories: string[];
  streamChat: StreamChat;
  onStatus: (s: string) => void;
  signal?: AbortSignal;
}): Promise<ForgeBuild> {
  const { prompt, previousCode, memories, onStatus, signal } = args;
  /** Every engine call in this build is patient: a busy moment never turns into a failed model. */
  const streamChat: StreamChat = (messages, mode, mem, onDelta) => withPatience(() => args.streamChat(messages, mode, mem, onDelta), { ...(signal ? { signal } : {}) });
  const warnings: string[] = [];
  const device = deviceProfile();
  const progress = (tag: string) => (f: number, label: string) => onStatus(`${tag}${label}… ${Math.round(f * 100)}%`);
  const edit = !!previousCode;

  /* 1. blueprint ---------------------------------------------------------------------- */
  let plan: ForgePlan | null = null;
  if (!edit) {
    onStatus("Sketching the blueprint: parts, proportions and materials…");
    try {
      const planText = await streamChat([{ role: "user", content: `[[PLAN]] ${prompt}` }], "model", memories, () => {});
      plan = parseForgePlan(planText);
    } catch {
      plan = null;
    }
    throwIfAborted(signal);
  }
  const planBlock = plan ? `\n\nBUILD PLAN (follow it, improve on it where you see fit):\n${planToText(plan)}` : "";
  const prevBlock = previousCode ? `\n\n(If this changes the previous model, edit the previous program below keeping everything that works; if it is a new subject, write a fresh program.)\nPREVIOUS PROGRAM:\n\`\`\`js\n${previousCode.slice(0, 12000)}\n\`\`\`` : "";

  /* 2. candidates (two competing takes on a capable device) ----------------------------- */
  const wanted = edit || device.mobile || device.cores < 4 ? 1 : 2;
  const variations = [
    "",
    "\n\nALTERNATIVE TAKE: choose a distinctly different design interpretation from the most obvious one (different proportions, silhouette details and colour scheme) while still matching the request exactly.",
  ];

  const askCode = async (i: number): Promise<{ code: string; witty: string } | null> => {
    const base = `${prompt}${planBlock}${prevBlock}${variations[i] ?? ""}`;
    let text = await streamChat([{ role: "user", content: base }], "model", memories, () => {});
    let code = extractForgeCode(text);
    let witty = forgeWitty(text);
    if (!code) {
      text = await streamChat([{ role: "user", content: `${base}\n\nReturn ONE witty line and exactly one \`\`\`js block that defines function sdf(x, y, z).` }], "model", memories, () => {});
      code = extractForgeCode(text);
      witty = witty || forgeWitty(text);
    }
    return code ? { code, witty } : null;
  };

  const repair = async (code: string, why: string): Promise<string | null> => {
    const text = await streamChat(
      [{ role: "user", content: `[[REPAIR]] The request was: ${prompt}\n\nYour shape program has a problem:\n${why}\n\nCURRENT PROGRAM:\n\`\`\`js\n${code}\n\`\`\`\n\nReturn the COMPLETE corrected program in one js block.` }],
      "model", memories, () => {},
    );
    return extractForgeCode(text);
  };

  onStatus(wanted > 1 ? "Writing two competing shape programs…" : "Writing the shape program…");
  const produce = async (i: number): Promise<Candidate | null> => {
    const label = wanted > 1 ? `Take ${String.fromCharCode(65 + i)}: ` : "";
    const got = await askCode(i);
    throwIfAborted(signal);
    if (!got) return null;
    let { code } = got;
    let mesh: ForgeMesh | null = null, lastError = "";
    for (let attempt = 0; attempt < 3 && !mesh; attempt++) {
      try {
        mesh = await forgeShape(code, { quality: "draft", onProgress: progress(label), ...(signal ? { signal } : {}) });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (lastError === "Cancelled.") throw e;
        if (attempt === 2) break;
        onStatus(`${label}fixing the shape code (${lastError.slice(0, 60)})…`);
        const fixed = await repair(code, `It failed to run: ${lastError}`);
        if (!fixed) break;
        code = fixed;
      }
    }
    if (!mesh) return null;
    const issues = staticModelIssues(mesh.stats, code);
    return { code, mesh, label, issues, review: null, score: staticScore(issues), witty: got.witty };
  };

  const results = (await Promise.allSettled(Array.from({ length: wanted }, (_, i) => produce(i)))).map((r) => (r.status === "fulfilled" ? r.value : null));
  throwIfAborted(signal);
  let pool = results.filter((r): r is Candidate => !!r);
  if (!pool.length) {
    /* every candidate failed: one last single attempt so the person still gets a model */
    onStatus("Trying once more with a simpler approach…");
    let lastProblem = "";
    try {
      const last = await produce(0);
      if (last) pool = [last];
    } catch (e) {
      if (e instanceof Error && e.message === "Cancelled.") throw e;
      lastProblem = e instanceof Error ? e.message : String(e);
    }
    if (!pool.length && lastProblem && isTransientFailure(lastProblem)) {
      throw new Error("Zeros could not get its 3D shape program written because its reasoning engines did not answer, even after several patient tries. Nothing was charged. Please send it again in a minute.");
    }
  }
  if (!pool.length) throw new Error("The shape program kept failing. Please try again - a simpler or more specific description often helps.");

  /* 3. inspect the drafts and pick the winner ----------------------------------------- */
  let rounds = 0;
  let best: Candidate = pool[0]!;
  try {
    onStatus(pool.length > 1 ? "Zeros is judging both takes from three angles…" : "Zeros is inspecting the model from three angles…");
    await Promise.all(pool.map(async (c) => { c.review = await review(prompt, c.mesh, c.issues.map((n) => n.problem)); }));
    for (const c of pool) c.score = c.review ? Math.round(c.review.score * 0.7 + staticScore(c.issues) * 0.3) - (c.review.matches ? 0 : 12) : staticScore(c.issues) - 4;
    best = pool.reduce((a, b) => (b.score > a.score ? b : a));
    if (pool.length > 1) warnings.push(`Two takes were built; Zeros kept ${best.label.replace(": ", "").toLowerCase() || "the better one"} (${best.score} vs ${pool.filter((p) => p !== best).map((p) => p.score).join("/")}).`);

    const needsWork = (c: Candidate) => c.issues.some((x) => x.severity === "blocker") || (c.review ? c.review.score < 74 || !c.review.matches : c.issues.some((x) => x.severity === "major"));
    if (needsWork(best)) {
      rounds = 1;
      const list = [
        ...best.issues.map((n) => `- [${n.severity}] ${n.problem} FIX: ${n.fix}`),
        ...(best.review?.issues ?? []).filter((i) => i.severity !== "minor" || (best.review?.score ?? 100) < 70).map((i) => `- [${i.severity}] ${i.problem}${i.fix ? ` FIX: ${i.fix}` : ""}`),
      ].slice(0, 12).join("\n");
      onStatus("Found issues - improving the model…");
      const fixed = await repair(best.code, `A 3D reviewer looked at renders of your model${best.review ? ` (score ${best.review.score}/100: ${best.review.summary})` : ""} and measured the mesh:\n${list || "- general quality should be higher"}\nKeep what works; fix these.`);
      if (fixed && fixed !== best.code) {
        try {
          const mesh2 = await forgeShape(fixed, { quality: "draft", onProgress: progress("Revision: "), ...(signal ? { signal } : {}) });
          onStatus("Re-inspecting the improved model…");
          const issues2 = staticModelIssues(mesh2.stats, fixed);
          const rev2 = await review(prompt, mesh2, issues2.map((n) => n.problem));
          const s2 = rev2 ? Math.round(rev2.score * 0.7 + staticScore(issues2) * 0.3) - (rev2.matches ? 0 : 12) : staticScore(issues2) - 4;
          if (s2 >= best.score) best = { code: fixed, mesh: mesh2, label: best.label, issues: issues2, review: rev2, score: s2, witty: best.witty };
          else warnings.push("The first version scored better than the revision, so it was kept.");
        } catch (e) {
          if (e instanceof Error && e.message === "Cancelled.") throw e;
          warnings.push(`Revision failed (${e instanceof Error ? e.message.slice(0, 80) : "error"}); kept the first version.`);
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message === "Cancelled.") throw e;
    /* inspection is a bonus - never block delivery */
  }

  /* 4. hyper-detail pass: high-resolution field, 4x quad refinement, real micro-displacement ----- */
  let finalMesh = best.mesh, quality: "hyper" | "draft" = "draft";
  try {
    onStatus("Hyper-detail pass: sampling the field at high resolution…");
    const hyper = await forgeShape(best.code, { quality: "hyper", onProgress: progress("Hyper-detail: "), ...(signal ? { signal } : {}) });
    if (hyper.stats.boundaryEdges <= best.mesh.stats.boundaryEdges + 2 && hyper.stats.keptComponents <= best.mesh.stats.keptComponents) { finalMesh = hyper; quality = "hyper"; }
    else warnings.push("The hyper-detail pass was less clean than the draft, so the draft was kept.");
  } catch (e) {
    if (e instanceof Error && e.message === "Cancelled.") throw e;
    warnings.push("The hyper-detail pass was skipped on this device (kept the fast draft).");
  }

  const features = codeFeatures(best.code);
  const st = finalMesh.stats;
  const facts = [
    `${st.vertices.toLocaleString("en-US")} vertices, ${st.quads.toLocaleString("en-US")} pure quads (${st.regularPct}% regular valence-4 vertices, average quad aspect ${st.quadAspect}:1)`,
    `${st.watertight ? "Watertight, manifold" : "Not fully watertight"}${st.genus >= 0 ? `, genus ${st.genus}` : ""}, ${st.keptComponents} solid piece${st.keptComponents === 1 ? "" : "s"}`,
    `${quality === "hyper" ? `Hyper-detail pass: ${st.refineLevels} quad-refinement level${st.refineLevels === 1 ? "" : "s"} on a ${st.resolution}-voxel field` : "Fast draft (the hyper-detail pass was skipped)"}`,
    `${st.creaseVertices.toLocaleString("en-US")} crease-split vertices keep hard edges crisp`,
    `${features.primitives} primitives${features.surface ? ", per-region PBR materials (metallic / roughness / emissive)" : ""}${features.displace ? ", real displaced micro-detail" : ""}`,
    ...(plan?.subject ? [`Blueprint: ${plan.subject}${plan.parts?.length ? ` with ${plan.parts.length} planned parts` : ""}`] : []),
    ...(best.review ? [`Reviewer score ${best.review.score}/100: ${best.review.summary}`] : []),
    ...(pool.length > 1 ? [`Two competing takes were generated and judged; the winner scored ${best.score}`] : []),
    ...(rounds ? ["One revision round fixed issues found in review"] : []),
  ];

  return { code: best.code, mesh: finalMesh, stats: finalMesh.stats, review: best.review, witty: best.witty, rounds, warnings, plan, candidates: pool.length, quality, features, facts };
}
