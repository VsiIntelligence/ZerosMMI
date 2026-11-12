// Every file the app and its pages depend on must resolve: a missing export or a wrong path fails here, before any browser runs.
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const src = path.join(root, "src");
const alias = { name: "alias-at", setup(build) { build.onResolve({ filter: /^@\// }, async (args) => { const r = await build.resolve(path.join(src, args.path.slice(2)), { kind: args.kind, resolveDir: root }); return r.errors.length ? { errors: r.errors } : r; }); } };
const entries = [
  "src/routes/chat-page-impl.tsx", "src/components/ReturnHandlers.tsx", "src/components/settings/AppsPanel.tsx", "src/components/ForgeViewer.tsx", "src/components/ModelViewer.tsx",
  "src/components/CodeBlock.tsx", "src/lib/ai-client.ts", "src/lib/run-song.ts", "src/lib/run-video-build.ts", "src/lib/run-model-forge.ts", "src/lib/apps-client.ts",
  "src/lib/chat-attachments.ts", "src/lib/render-video.ts", "src/lib/song.ts", "src/lib/forge/forge-client.ts", "src/lib/artifact-memory.ts", "src/lib/code-run.ts",
  "src/lib/composio-api.server.ts", "src/lib/app-agent.server.ts", "src/lib/app-verify.server.ts", "src/lib/engine.server.ts", "src/lib/zeros-route.server.ts",
  "src/lib/image-fallback.server.ts", "src/lib/github-oauth.server.ts", "src/lib/app-permissions.server.ts", "src/routeTree.gen.ts",
  "src/routes/api/chat.ts", "src/routes/api/generate-image.ts", "src/routes/api/verify-model.ts", "src/routes/api/engine-health.ts",
  "src/routes/api/apps/index.ts", "src/routes/api/apps/permissions.ts", "src/routes/api/apps/finish.ts", "src/routes/api/apps/verify.ts", "src/routes/api/connectors/call.ts",
];
let failures = 0;
for (const entry of entries) {
  try {
    await esbuild.build({ entryPoints: [path.join(root, entry)], bundle: true, write: false, format: "esm", platform: "neutral", jsx: "automatic", logLevel: "silent", packages: "external", plugins: [alias], absWorkingDir: root, loader: { ".css": "empty" } });
  } catch (e) {
    failures++;
    console.log("FAIL", entry, "\n  " + e.errors.slice(0, 3).map((x) => x.text).join("\n  "));
  }
}
console.log(failures ? `${failures} file(s) do not resolve` : `all ${entries.length} entry files resolve`);
process.exitCode = failures ? 1 : 0;
