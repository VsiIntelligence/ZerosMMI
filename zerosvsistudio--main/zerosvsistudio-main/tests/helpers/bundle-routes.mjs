/**
 * Bundles the server routes into plain ES modules so the tests can call their real handlers (no dev server, no network).
 * Output goes to <tmp>/zx2/<name>.mjs. esbuild ships with Vite, so it is already installed with the project.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUNDLE_DIR = join(tmpdir(), "zx2");

const ROUTES = {
  api_chat: "src/routes/api/chat.ts",
  api_billing_status: "src/routes/api/billing/status.ts",
  api_billing_checkout: "src/routes/api/billing/checkout.ts",
  api_billing_confirm: "src/routes/api/billing/confirm.ts",
  api_billing_cancel: "src/routes/api/billing/cancel.ts",
  api_billing_promo: "src/routes/api/billing/promo.ts",
  api_billing_webhook: "src/routes/api/billing/webhook.ts",
  api_generate_image: "src/routes/api/generate-image.ts",
  api_tts: "src/routes/api/tts.ts",
  api_memory: "src/routes/api/memory.ts",
  api_verify_model: "src/routes/api/verify-model.ts",
  api_verify_site: "src/routes/api/verify-site.ts",
  api_apps_index: "src/routes/api/apps/index.ts",
  api_apps_connect: "src/routes/api/apps/connect.ts",
  api_apps_permissions: "src/routes/api/apps/permissions.ts",
  api_apps_disconnect: "src/routes/api/apps/disconnect.ts",
  api_apps_tools: "src/routes/api/apps/tools.ts",
  api_connectors_call: "src/routes/api/connectors/call.ts",
  api_apps_finish: "src/routes/api/apps/finish.ts",
  api_apps_verify: "src/routes/api/apps/verify.ts",
  api_engine_health: "src/routes/api/engine-health.ts",
};

mkdirSync(BUNDLE_DIR, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(Object.entries(ROUTES).map(([name, file]) => [name, join(root, file)])),
  outdir: BUNDLE_DIR,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  tsconfig: join(root, "tsconfig.json"),
  alias: { "@tanstack/react-router": join(root, "tests/helpers/router-stub.mjs") },
  logLevel: "error",
});

export const routeUrl = (name) => new URL(`file://${join(BUNDLE_DIR, `${name}.mjs`)}`).href;
