// Builds the browser bundles, starts the local page server, runs every browser check and reports the result.
// Needs Chromium for Playwright: `npx playwright install chromium`. Takes about five minutes (the film render is the longest step).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (script) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script], { cwd: here, env: process.env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ code, out }));
});
const failed = (result) => result.code !== 0 || /\bFAIL(ED)?\b/.test(result.out) || /page errors: \[/.test(result.out);

const built = await run("build.mjs");
if (built.code !== 0) { console.log(built.out); process.exit(1); }
const server = await startServer(path.join(here, "www"), 8765);
const checks = ["check-bundles.mjs", "run-code.mjs", "run-codeblock.mjs", "run-panel.mjs", "run-song.mjs", "run-3d.mjs", "run-3d-build.mjs", "run-site.mjs", "run-site-nav.mjs", "run-video.mjs"];
let bad = 0;
try {
  for (const script of checks) {
    const started = Date.now();
    const result = await run(script);
    const ok = !failed(result);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${script} (${Math.round((Date.now() - started) / 1000)}s)`);
    if (!ok) console.log(result.out.split("\n").map((l) => "      " + l).join("\n"));
  }
} finally {
  server.close();
}
console.log(bad ? `${bad} browser check file(s) failed` : `all ${checks.length} browser check files passed`);
process.exitCode = bad ? 1 : 0;
