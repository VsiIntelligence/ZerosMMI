import { researchBlock, researchTopic, type Research } from "@/lib/research";
import { lintSite, type SiteLint } from "@/lib/web/lint";
import { VOCAB, normalizeBrief, type Brief, type PageSpec } from "@/lib/web/kit";
import { assembleSite } from "@/lib/web/site";
import type { Msg } from "@/lib/ai-client";
import type { ZeroMode } from "@/lib/zeros";
import {
  buildFallbackWebProject,
  extractFenceFiles,
  extractWebProject,
  type WebProject,
} from "@/lib/web-project";
import { issuesForRepair, runSiteChecks, type SiteReport } from "@/lib/site-verifier";

type StreamChat = (
  messages: Msg[],
  mode: ZeroMode,
  memories: string[],
  onDelta: (full: string) => void,
) => Promise<string>;

export type WebBuildResult = {
  project: WebProject;
  report: SiteReport | null;
  witty: string;
  repairRounds: number;
  usedFallback: boolean;
  /** the final static verification (links, structure, accessibility, CSS, JS, buttons) of the delivered files */
  lint: SiteLint | null;
  research: Research | null;
  brief: Brief | null;
  notes: string[];
};

const MAX_REPAIR_ROUNDS = 2;

/* ---------------------------------------------------------------- helpers */

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** First non-code line the model wrote (its witty opener). */
export function wittyLine(text: string): string {
  const clean = text.replace(/```[\s\S]*?(?:```|$)/g, "").trim();
  const line = clean.split("\n").map((l) => l.trim()).find((l) => l.length > 3 && !l.startsWith("{") && !l.startsWith("[["));
  return (line ?? "").slice(0, 200);
}

/** True when a file looks cut off or syntactically broken (checked without executing anything). */
export function fileLooksBroken(path: string, source: string): string | null {
  const s = source.trim();
  if (/\.html?$/i.test(path)) {
    if (!/<\/html>\s*$/i.test(s)) return "HTML is cut off (no closing </html>)";
    if (!/<body[\s>]/i.test(s)) return "HTML has no <body>";
    return null;
  }
  if (/\.css$/i.test(path)) {
    const open = (s.match(/{/g) ?? []).length;
    const close = (s.match(/}/g) ?? []).length;
    return open !== close ? "CSS braces are unbalanced (file cut off?)" : null;
  }
  if (/\.m?js$/i.test(path)) {
    try {
      // Parses only - never called.
      new Function(s);
      return null;
    } catch (e) {
      return `JavaScript syntax error: ${(e as Error).message}`;
    }
  }
  return null;
}

export function brokenFiles(project: WebProject): { path: string; reason: string }[] {
  return Object.entries(project.files)
    .map(([path, src]) => ({ path, reason: fileLooksBroken(path, src) }))
    .filter((x): x is { path: string; reason: string } => !!x.reason);
}

function mergeFiles(base: WebProject, patch: Record<string, string>): { project: WebProject; rejected: string[] } {
  const files = { ...base.files };
  const rejected: string[] = [];
  for (const [path, src] of Object.entries(patch)) {
    const reason = fileLooksBroken(path, src);
    if (reason && files[path] !== undefined && !fileLooksBroken(path, files[path]!)) {
      rejected.push(`${path}: ${reason}`);
      continue; // keep the previous good version
    }
    files[path] = src;
  }
  return { project: { files }, rejected };
}

function describeSite(project: WebProject): string {
  const list = Object.entries(project.files).map(([p, c]) => `${p} (${c.length} chars)`).join(", ");
  const idx = (project.files["index.html"] ?? "").slice(0, 1400);
  const css = (project.files["css/styles.css"] ?? project.files["styles.css"] ?? "").slice(0, 700);
  return `EXISTING SITE FILES: ${list}\n\nindex.html (start):\n${idx}\n\nstyles (start):\n${css}`;
}

function dumpFiles(project: WebProject, maxChars = 140_000): string {
  let budget = maxChars;
  const parts: string[] = [];
  for (const [path, src] of Object.entries(project.files)) {
    if (/\.(md|txt)$/i.test(path)) continue;
    const body = src.length > budget ? src.slice(0, Math.max(0, budget)) + "\n/* ...truncated for length... */" : src;
    parts.push("```file:" + path + "\n" + body + "\n```");
    budget -= body.length;
    if (budget <= 0) break;
  }
  return parts.join("\n\n");
}

function progressStatus(text: string): string {
  const names = [...text.matchAll(/```file:([^\s\n`]+)/g)].map((m) => m[1]!);
  if (!names.length) return "Designing the look…";
  return `Writing ${names[names.length - 1]} (${names.length} file${names.length === 1 ? "" : "s"} so far)…`;
}

/* ------------------------------------------------------------------- main */


/** Inner HTML of <main>, tolerating a model that returns a whole document, a body, or just fragments. */
export function mainOf(raw: string): string {
  let h = raw.trim();
  const m = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h);
  if (m) return m[1]!.trim();
  const b = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(h);
  if (b) h = b[1]!;
  return h.replace(/<(script|style|header|footer)\b[\s\S]*?<\/\1>/gi, "").replace(/<\/?(?:!doctype|html|head|body|title|meta|link)[^>]*>/gi, "").trim();
}
const chunk = <T,>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
/** Problems the model is better placed to fix than the linter (copy, structure, behaviour), not mechanical ones. */
const MODEL_FIXABLE = /^(placeholder|class-undefined|dead-button|dead-form|form-status|label|behaviour-target|js-syntax|empty-link|empty-button|thin-home|thin-content|heading-order)$/;

export async function buildWebsite(args: {
  prompt: string;
  history: Msg[];
  previous: WebProject | null;
  memories: string[];
  streamChat: StreamChat;
  onStatus: (s: string) => void;
}): Promise<WebBuildResult> {
  const { prompt, history, previous, memories, streamChat, onStatus } = args;
  const context = history.slice(-6, -1); // earlier turns for continuity, excluding the current prompt

  const notes: string[] = [];
  /* 0 - research: a time-boxed web search (never blocks, never invents) */
  let research: Research | null = null;
  if (!previous) { onStatus("Researching the industry…"); research = await researchTopic({ kind: "website", request: prompt, streamChat, memories }); if (!research.found) notes.push("No public information was found about this subject, so the site is built from your request alone."); }

  /* 1 - design brief */
  onStatus("Planning the site and the art direction…");
  let brief: Record<string, unknown> | null = null;
  let briefText = "";
  try {
    briefText = await streamChat(
      [...context, { role: "user", content: `[[BRIEF]]\nUser request: ${prompt}\n\n${research ? researchBlock(research) + "\n\n" : ""}${previous ? describeSite(previous) : "There is no existing site."}` }],
      "web",
      memories,
      () => {},
    );
    brief = extractJson(briefText);
  } catch {
    /* the build can still run without a brief */
  }
  const isEdit = !!previous && brief?.["intent"] === "edit";
  const kit: Brief = normalizeBrief(brief ?? {}, prompt);
  const briefJson = brief ? JSON.stringify(brief) : "(none - decide the art direction yourself)";

  /* 2 - build (or edit) */
  let project: WebProject | null = null;
  let witty = "";
  let usedFallback = false;

  if (isEdit && previous) {
    onStatus("Editing your site…");
    const full = await streamChat(
      [...context, { role: "user", content: `[[REPAIR]]\nThe user wants this change to the existing site: ${prompt}\n\nDESIGN BRIEF: ${briefJson}\n\nCURRENT FILES:\n${dumpFiles(previous)}\n\nReturn only the changed files, each as a complete fenced file block.` }],
      "web",
      memories,
      (t) => onStatus(progressStatus(t)),
    );
    witty = wittyLine(full);
    project = mergeFiles(previous, extractFenceFiles(full)).project;
  } else {
    /* Zeros writes the design system and the page chrome itself; the model writes the pages (batched, in parallel) */
    onStatus(`Generating the design system for ${kit.name}…`);
    const pages = kit.pages, batches = chunk(pages, 3);
    const briefForPrompt = { name: kit.name, tagline: kit.tagline, description: kit.description, audience: kit.audience, tone: kit.tone, industry: kit.industry, archetype: kit.archetype, palette: kit.palette, cta: kit.cta, contact: kit.contact, pages: pages.map((p) => ({ file: p.file, title: p.title, purpose: p.purpose })), research: research?.facts ?? [] };
    const request = (batch: PageSpec[], first: boolean): string => `[[PAGES]]\nUser request: ${prompt}\n\n${research ? researchBlock(research) + "\n\n" : ""}BRIEF (follow it): ${JSON.stringify(briefForPrompt)}\n\nWrite these pages now: ${batch.map((p) => `${p.file} (${p.title}: ${p.purpose || "your call"}; section ideas: ${(kit.sections[p.file] ?? []).join("; ") || "your call"})`).join(" | ")}\n\nEvery page in the site (internal links may only point to these): ${[...pages.map((p) => p.file), "404.html"].join(", ")}\n\nCOMPONENT VOCABULARY:\n${VOCAB}\n\n${first ? "This is the FIRST batch: also return css/pages.css (and js/extras.js only if truly needed)." : "Do NOT return css/pages.css or js/extras.js."}`;
    onStatus(`Writing ${pages.length} pages in the ${kit.archetype} style…`);
    const replies = await Promise.all(batches.map((b2, i) => streamChat([...context.slice(-2), { role: "user", content: request(b2, i === 0) }], "web", memories, (t) => { if (i === 0) onStatus(progressStatus(t)); }).catch(() => "")));
    const mains: Record<string, string> = {};
    let pagesCss = "", extraJs = "";
    replies.forEach((full, i) => {
      if (i === 0) witty = wittyLine(full);
      const asked = new Set((batches[i] ?? []).map((p2) => p2.file));
      for (const [path, content] of Object.entries(extractFenceFiles(full))) {
        const key = path.replace(/^\.?\//, "");
        if (/\.html?$/i.test(key)) { const m = mainOf(content); if (m.length > 600 && asked.has(key.toLowerCase())) mains[key.toLowerCase()] = m; }
        else if (/(^|\/)pages\.css$/i.test(key)) pagesCss = content;
        else if (/(^|\/)extras\.js$/i.test(key)) extraJs = content;
      }
    });
    const written = pages.filter((p) => mains[p.file]).length;
    usedFallback = written === 0;
    if (usedFallback) notes.push("The page writer was unavailable, so Zeros built the pages from its studio template using your brief.");
    else if (written < pages.length) notes.push(`${pages.length - written} page(s) used the studio template because the writer did not finish them.`);
    project = { files: assembleSite(kit, { mains, pagesCss, extraJs, notes }) };

    /* 2b - static verification with auto-fix, then ONE targeted repair of what only the model can fix */
    onStatus("Verifying links, structure, accessibility and buttons…");
    let lint = lintSite(project.files);
    project = { ...project, files: lint.files };
    const fixable = lint.issues.filter((i) => i.severity === "error" && !i.fixed && MODEL_FIXABLE.test(i.code));
    if (!usedFallback && fixable.length) {
      onStatus(`Fixing ${fixable.length} issue${fixable.length === 1 ? "" : "s"} found by static checks…`);
      try {
        const affected = [...new Set(fixable.map((i) => i.file).filter((f) => /\.html$/i.test(f)))];
        const dump = affected.map((f) => `\`\`\`file:${f}\n${mainOf(project!.files[f] ?? "")}\n\`\`\``).join("\n");
        const fixed = await streamChat(
          [{ role: "user", content: `[[REPAIR]]\nDESIGN BRIEF: ${briefJson}\n\nZeros' static checks found problems:\n${fixable.slice(0, 12).map((i, n) => `${n + 1}. ${i.file}: ${i.message}`).join("\n")}\n\nCURRENT PAGES (inner <main> HTML only):\n${dump}\n\nReturn the corrected pages as fenced file blocks containing ONLY the inner <main> HTML. Use only classes from the component vocabulary or x- classes you also add to css/pages.css (return that file too if you add any).\n\nVOCABULARY:\n${VOCAB}` }],
          "web", memories, (t) => onStatus(progressStatus(t)),
        );
        const m2 = { ...mains }; let css2 = pagesCss, js2 = extraJs;
        for (const [path, content] of Object.entries(extractFenceFiles(fixed))) { const key = path.replace(/^\.?\//, "").toLowerCase(); if (/\.html?$/i.test(key)) { const m = mainOf(content); if (m.length > 600) m2[key] = m; } else if (/pages\.css$/i.test(key)) css2 = content; else if (/extras\.js$/i.test(key)) js2 = content; }
        const candidate = lintSite(assembleSite(kit, { mains: m2, pagesCss: css2, extraJs: js2, notes }));
        if (candidate.score >= lint.score) { project = { files: candidate.files }; lint = candidate; }
      } catch { /* keep the verified version we already have */ }
    }
  }

  /* 2c - finish anything that got cut off (edit path) */
  if (!usedFallback && project && isEdit) {
    const broken = brokenFiles(project);
    if (broken.length) {
      onStatus("Finishing files that were cut off…");
      try {
        const full = await streamChat(
          [{ role: "user", content: `[[REPAIR]]\nThese files are broken or cut off:\n${broken.map((b2) => `- ${b2.path}: ${b2.reason}`).join("\n")}\n\nDESIGN BRIEF: ${briefJson}\n\nCURRENT FILES:\n${dumpFiles(project)}\n\nReturn the complete fixed files as fenced blocks.` }],
          "web",
          memories,
          (t) => onStatus(progressStatus(t)),
        );
        project = mergeFiles(project, extractFenceFiles(full)).project;
      } catch {
        /* keep what we have */
      }
    }
  }

  /* 3 - verify -> repair loop */
  let report: SiteReport | null = null;
  let rounds = 0;
  try {
    report = await runSiteChecks(project, { brief: `${prompt}\n${briefJson}`, onStatus });
    while (report && !report.ok && rounds < MAX_REPAIR_ROUNDS && !usedFallback) {
      rounds++;
      const todo = issuesForRepair(report);
      if (!todo.length) break;
      onStatus(`Zeros found ${todo.length} issue${todo.length === 1 ? "" : "s"} - fixing (round ${rounds})…`);
      const list = todo
        .map((i, n) => `${n + 1}. [${i.severity.toUpperCase()} - ${i.source}] ${i.page}: ${i.problem}${i.fix ? `\n   FIX: ${i.fix}` : ""}`)
        .join("\n");
      const full = await streamChat(
        [{ role: "user", content: `[[REPAIR]]\nDESIGN BRIEF: ${briefJson}\n\nYou built this site and Zeros' verifier (real browser frames + screenshots) found problems:\n${list}\n\nCURRENT FILES:\n${dumpFiles(project)}\n\nFix EVERY issue. Keep the art direction. Return only the changed files, each complete.` }],
        "web",
        memories,
        (t) => onStatus(progressStatus(t)),
      );
      const patch = extractFenceFiles(full);
      if (!Object.keys(patch).length) break;
      project = mergeFiles(project, patch).project;
      project = { ...project, files: lintSite(project.files).files };
      witty = witty || wittyLine(full);
      report = await runSiteChecks(project, { brief: `${prompt}\n${briefJson}`, onStatus });
    }
  } catch {
    /* verification must never block delivery */
  }

  const lintFinal = project ? lintSite(project.files, { autofix: false }) : null;
  return { project: project!, report, witty, repairRounds: rounds, usedFallback, lint: lintFinal, research, brief: isEdit ? null : kit, notes };
}
