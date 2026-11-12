#!/usr/bin/env node
/**
 * Proves that names which must never be visible do not appear anywhere people could find them.
 *
 *   ZEROS_BANNED_TERMS="name one,name two" node scripts/check-clean.mjs [--dist-only] [extra paths...]
 *
 * The names are given in the environment on purpose: this file, like the rest of the repository, never contains them.
 * It scans the repository's own files and, when it exists, the build output in ./dist (what visitors download).
 * --dist-only scans just the build output. Exit code 1 means something was found.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const terms = (process.env.ZEROS_BANNED_TERMS ?? "").split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2);
if (!terms.length) {
  console.error('Set ZEROS_BANNED_TERMS to a comma-separated list of the names to look for, for example ZEROS_BANNED_TERMS="name one,name two".');
  process.exit(2);
}

const args = process.argv.slice(2);
const distOnly = args.includes("--dist-only");
const extra = args.filter((a) => !a.startsWith("--"));
const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".git", ".wrangler", ".tanstack", ".nitro", ".output", ".vinxi"]);
/* Binary files are never read, but their NAMES are always checked: a logo called after a banned name is a leak too. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|glb|zip|pdf|wasm)$/i;

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const roots = distOnly ? ["dist"] : [".", ...extra];
const hits = [];
let scanned = 0;
for (const root of roots) {
  const abs = join(ROOT, root);
  const info = await stat(abs).catch(() => null);
  if (!info) { if (distOnly) console.error(`No ${root} folder: run "npm run build" first.`); continue; }
  const files = info.isDirectory() ? walk(abs) : (async function* () { yield abs; })();
  for await (const file of files) {
    if (!distOnly && file.includes(`${ROOT}/dist/`)) continue;
    const name = relative(ROOT, file).toLowerCase();
    const text = BINARY.test(file) ? "" : (await readFile(file, "utf8").catch(() => "")).toLowerCase();
    scanned++;
    for (const term of terms) {
      const inText = text.split(term).length - 1;
      if (inText || name.includes(term)) hits.push({ file: relative(ROOT, file), term, count: inText + (name.includes(term) ? 1 : 0) });
    }
  }
}

if (hits.length) {
  console.error(`Found ${hits.length} match${hits.length === 1 ? "" : "es"} in ${scanned} files:`);
  for (const h of hits) console.error(`  ${h.file}  (${h.count}x)`);
  process.exit(1);
}
console.log(`Clean: ${scanned} files scanned, none of the ${terms.length} names found.`);
