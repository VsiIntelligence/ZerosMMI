import { PREVIEW_PRELUDE, PREVIEW_RUNTIME } from "./preview-runtime";

export type WebProject = { files: Record<string, string> };

export type AssembleOptions = {
  /** "verify" stubs alerts / IntersectionObserver so automated checks see the final page state. */
  mode?: "preview" | "verify";
  /** Element id to scroll to after load (from links like about.html#team). */
  anchor?: string;
};

/** JSON that is safe to place inside a <script> element. */
const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const LANG_MAP: Record<string, string> = {
  html: "index.html",
  css: "css/styles.css",
  js: "js/main.js",
  javascript: "js/main.js",
  json: "data/site.json",
  md: "README.md",
  markdown: "README.md",
};

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function normalizePagePath(path: string): string {
  let clean = path.replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0] ?? "";
  clean = clean.replace(/\/+$/, "");
  if (!clean || clean === ".") return "index.html";
  if (!/\.html?$/i.test(clean)) clean = `${clean}.html`;
  return clean;
}

export function assembleWebProject(project: WebProject, entry = "index.html", opts: AssembleOptions = {}): string {
  const files = project.files;
  const pages = Object.keys(files).filter((f) => /\.html$/i.test(f));
  const initial = normalizePagePath(entry);
  const html =
    files[initial] ??
    files["index.html"] ??
    (pages[0] ? files[pages[0]!] : "<!doctype html><title>Zeros project</title>");

  const find = (href: string): string | undefined => {
    const clean = href.replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0] ?? "";
    if (files[clean] !== undefined) return files[clean];
    const aliases = [
      clean,
      clean.replace(/^css\//, ""),
      clean.replace(/^js\//, ""),
      `css/${baseName(clean)}`,
      `js/${baseName(clean)}`,
      baseName(clean),
    ];
    for (const a of aliases) {
      if (files[a] !== undefined) return files[a];
    }
    const match = Object.keys(files).find((f) => baseName(f).toLowerCase() === baseName(clean).toLowerCase());
    return match ? files[match] : undefined;
  };

  const inlineAssets = (source: string): string =>
    source
      .replace(/<link[^>]*href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi, (tag, href: string) => {
        const css = find(href);
        return css !== undefined ? `<style data-zeros-inline="css">${css}</style>` : tag;
      })
      .replace(
        /<script([^>]*)src=["']([^"']+\.js(?:\?[^"']*)?)["']([^>]*)><\/script>/gi,
        (tag, before: string, src: string, after: string) => {
          const js = find(src);
          return js !== undefined ? `<script${before}${after}>${js}\n<\/script>` : tag;
        },
      );

  const resolvePage = (href: string): string | undefined => {
    const raw = (href || "").trim();
    if (!raw || /^(https?:|mailto:|tel:|javascript:)/i.test(raw)) return undefined;
    if (raw.startsWith("#") && !raw.startsWith("#zeros-route=")) return undefined;
    let candidate = raw;
    if (candidate.startsWith("#zeros-route=")) {
      const query = candidate.slice("#zeros-route=".length);
      candidate = decodeURIComponent(query.split("&")[0] || "index.html");
    }
    const clean = normalizePagePath(candidate);
    if (pages.includes(clean)) return clean;
    const cleanBase = baseName(clean).toLowerCase();
    const cleanStem = cleanBase.replace(/\.html?$/i, "");
    const cleanNoExt = clean.replace(/\.html?$/i, "").toLowerCase();
    return pages.find((page) => {
      const pageBase = baseName(page).toLowerCase();
      const pageStem = pageBase.replace(/\.html?$/i, "");
      const pageNoExt = page.replace(/\.html?$/i, "").toLowerCase();
      return (
        pageBase === cleanBase ||
        pageStem === cleanStem ||
        pageNoExt === cleanNoExt ||
        pageNoExt.endsWith("/" + cleanStem) ||
        pageStem === cleanStem + "/index"
      );
    });
  };

  const preparePage = (source: string): string => {
    let page = inlineAssets(source);
    page = page.replace(
      /href=["'](?!https?:|mailto:|tel:|javascript:|#)([^"']+)["']/gi,
      (full: string, href: string) => {
        const target = resolvePage(href);
        if (!target) return full;
        const anchor = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
        return `href="#" data-zeros-route="${target}"${anchor ? ` data-zeros-anchor="${anchor}"` : ""}`;
      },
    );
    page = page.replace(
      /data-(?:href|link|page)=["'](?!https?:|mailto:|tel:|javascript:|#)([^"']+)["']/gi,
      (full: string, href: string) => {
        const target = resolvePage(href);
        return target ? `data-zeros-route="${target}"` : full;
      },
    );
    page = page.replace(
      /(?:window\.)?location\.(?:href|assign|replace)\s*=\s*["']([^"']+)["']/gi,
      (full: string, href: string) => {
        const target = resolvePage(href);
        return target ? `window.__ZEROS_ROUTE__ && window.__ZEROS_ROUTE__("${target}")` : full;
      },
    );
    page = page.replace(
      /(?:window\.)?location\.(?:assign|replace)\(\s*["']([^"']+)["']\s*\)/gi,
      (full: string, href: string) => {
        const target = resolvePage(href);
        return target ? `(window.__ZEROS_ROUTE__ && window.__ZEROS_ROUTE__("${target}"))` : full;
      },
    );
    return page;
  };

  // Preview must equal what the user downloads: no injected fonts or base CSS, only the diagnostics runtime.
  const doc = preparePage(html ?? "");
  const data = { pages, current: initial, mode: opts.mode ?? "preview", anchor: opts.anchor ?? "" };
  const dataTag = `<script type="application/json" id="zeros-runtime-data">${safeJson(data)}</script>`;
  const preludeTag = `<script data-zeros-runtime>${PREVIEW_PRELUDE}</script>`;
  const runtimeTag = `<script data-zeros-runtime>${PREVIEW_RUNTIME}</script>`;

  let out = doc;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${dataTag}\n${preludeTag}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${dataTag}${preludeTag}</head>`);
  else out = `<!doctype html><html><head><meta charset="utf-8">${dataTag}${preludeTag}</head><body>${out}</body></html>`;

  const closeBody = out.toLowerCase().lastIndexOf("</body>");
  out = closeBody >= 0 ? `${out.slice(0, closeBody)}${runtimeTag}\n${out.slice(closeBody)}` : `${out}\n${runtimeTag}`;
  return out;
}

/**
 * "Open full" page: a tiny host that shows the sandboxed site full-window and switches pages when the
 * site asks (same message protocol as the embedded preview). Every page is pre-assembled inside it.
 */
export function buildStandaloneHost(project: WebProject, entry = "index.html", title = "Zeros site"): string {
  const pages = Object.keys(project.files).filter((f) => /\.html$/i.test(f));
  const first = pages.includes(entry) ? entry : pages.includes("index.html") ? "index.html" : (pages[0] ?? "index.html");
  const assembled: Record<string, string> = {};
  for (const page of pages) assembled[page] = assembleWebProject(project, page);
  const payload = safeJson({ pages: assembled, first });
  const esc = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title>
<style>html,body{margin:0;height:100%;background:#0b0b10}iframe{border:0;width:100%;height:100%;display:block;background:#fff}</style></head>
<body><iframe id="f" sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox"></iframe>
<script type="application/json" id="d">${payload}</script>
<script>
(function(){
  var D=JSON.parse(document.getElementById("d").textContent), f=document.getElementById("f"), cur=null;
  function show(p, anchor){
    var html=D.pages[p]; if(!html) return;
    if(anchor){ html=html.replace(/("anchor":")(")/, function(m,a,b){return a+anchor.replace(/[^A-Za-z0-9_.:-]/g,"")+b;}); }
    if(cur) URL.revokeObjectURL(cur);
    cur=URL.createObjectURL(new Blob([html],{type:"text/html;charset=utf-8"}));
    f.src=cur;
  }
  window.addEventListener("message",function(e){
    var m=e.data; if(!m||m.source!=="zeros-preview"||e.source!==f.contentWindow) return;
    if(m.type==="navigate-request") show(m.path, m.anchor);
  });
  show(D.first,"");
})();
</script></body></html>`;
}

/** Parses ```file:path fences into a file map (no HTML requirement - used for repair patches too). */
export function extractFenceFiles(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  const pattern = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  for (const match of text.matchAll(pattern)) {
    const rawLabel = (match[1] ?? "").trim().replace(/^file:/i, "").replace(/^["'`]|["'`]$/g, "");
    const body = (match[2] ?? "").trim();
    if (!body || body.length < 8) continue;
    const tokens = rawLabel.split(/\s+/).filter(Boolean);
    let name = "";
    for (const tok of tokens) {
      const cleaned = tok.replace(/^file:/i, "").replace(/^\.?\/+/, "");
      if (/\.[a-z0-9]{2,5}$/i.test(cleaned)) {
        name = cleaned;
        break;
      }
    }
    if (!name) {
      const lang = (tokens[0] ?? "").toLowerCase();
      name = LANG_MAP[lang] ?? `file-${Object.keys(files).length + 1}.txt`;
    }
    name = name.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!files[name] || body.length > (files[name]?.length ?? 0)) files[name] = body;
  }
  return files;
}

export function extractWebProject(text: string): WebProject | null {
  const files = extractFenceFiles(text);
  if (!Object.keys(files).some((f) => /\.html$/i.test(f))) {
    const htmlDoc =
      text.match(/<!doctype html[\s\S]+<\/html>/i)?.[0] ??
      text.match(/<html[\s\S]+<\/html>/i)?.[0];
    if (htmlDoc && htmlDoc.length > 80) files["index.html"] = htmlDoc.trim();
  }
  if (files["index.html"] && !files["css/styles.css"] && !files["styles.css"]) {
    const styles = [...files["index.html"].matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    if (styles.length) files["css/styles.css"] = styles.join("\n\n");
  }
  if (files["index.html"] && !files["js/main.js"] && !files["script.js"]) {
    const scripts = [...files["index.html"].matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => (m[1] ?? "").trim())
      .filter((s) => s && !s.includes("data-zeros-runtime"));
    if (scripts.length) files["js/main.js"] = scripts.join("\n\n");
  }
  const htmlFiles = Object.keys(files).filter((f) => /\.html$/i.test(f));
  if (!htmlFiles.length) return null;
  if (!files["index.html"]) {
    const first = htmlFiles[0]!;
    files["index.html"] = files[first]!;
  }
  for (const path of Object.keys(files)) {
    const normalized = path.replace(/^\.\//, "").replace(/\\/g, "/");
    if (normalized !== path) {
      const body = files[path]!;
      delete files[path];
      if (!files[normalized] || body.length > files[normalized].length) files[normalized] = body;
    }
  }
  return { files };
}

export async function downloadProjectZip(project: WebProject, name = "zeros-site") {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  Object.entries(project.files).forEach(([path, contents]) => zip.file(path, contents));
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 15_000);
}

export { buildFallbackWebProject } from "./web-fallback";
