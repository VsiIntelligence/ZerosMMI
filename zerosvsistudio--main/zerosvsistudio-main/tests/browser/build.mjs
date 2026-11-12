// Builds the browser bundles the checks load: the engines (kit), the Apps panel and the code block.
import * as esbuild from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const src = path.join(root, "src");
const www = path.join(here, "www");
fs.mkdirSync(www, { recursive: true });

const aliasPlugin = {
  name: "alias-at",
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      const r = await build.resolve(path.join(src, args.path.slice(2)), { kind: args.kind, resolveDir: root });
      return r.errors.length ? { errors: r.errors } : r;
    });
  },
};

// The icon library is installed in the project. Where it is not (a bare checkout), each icon the sources import becomes a plain
// SVG with its own name, so the layout can still be checked.
function iconNames() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
          for (const name of m[1].split(",")) { const clean = name.trim().split(/\s+as\s+/)[0].trim(); if (clean) found.add(clean); }
        }
      }
    }
  };
  walk(src);
  return [...found].sort();
}
const requireFromRoot = createRequire(path.join(root, "package.json"));
const installed = (name) => { try { requireFromRoot.resolve(name); return true; } catch { return false; } };
const iconFallback = {
  name: "icon-fallback",
  setup(build) {
    // undefined lets esbuild resolve the installed package as usual
    build.onResolve({ filter: /^lucide-react$/ }, () => (installed("lucide-react") ? undefined : { path: "lucide-react", namespace: "icon-stub" }));
    build.onLoad({ filter: /.*/, namespace: "icon-stub" }, () => {
      const body = 'import React from "react";\nconst make = (name) => (props) => React.createElement("svg", { ...props, "data-icon": name, width: 16, height: 16 });\n' + iconNames().map((n) => `export const ${n} = make(${JSON.stringify(n)});`).join("\n") + "\n";
      return { contents: body, loader: "jsx", resolveDir: root };
    });
  },
};

const common = { bundle: true, format: "iife", platform: "browser", target: "es2020", jsx: "automatic", logLevel: "warning", absWorkingDir: root, define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "css", ".woff2": "file", ".woff": "file", ".ttf": "file", ".png": "file", ".svg": "file" }, assetNames: "[name]", plugins: [aliasPlugin, iconFallback] };
// The zip library is only used to download a website as a file, which these checks never do, so it is left out of the bundle.
await esbuild.build({ ...common, entryPoints: [path.join(here, "kit.ts")], globalName: "Kit", outfile: path.join(www, "kit.js"), plugins: [aliasPlugin], external: ["jszip"] });
await esbuild.build({ ...common, entryPoints: [path.join(here, "entries", "apps-panel.tsx")], outfile: path.join(www, "apps-panel.js") });
await esbuild.build({ ...common, entryPoints: [path.join(here, "entries", "code-block.tsx")], outfile: path.join(www, "code-block.js") });
for (const page of fs.readdirSync(path.join(here, "pages"))) fs.copyFileSync(path.join(here, "pages", page), path.join(www, page));
console.log("browser bundles built in", path.relative(root, www));
