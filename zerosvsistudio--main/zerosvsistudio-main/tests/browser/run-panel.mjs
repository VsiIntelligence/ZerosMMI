import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 220)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 220)); });
const calls = [];
const item = (slug, name, extra = {}) => ({ slug, name, logo: "", description: `${name} integration`, categories: [{ slug: "productivity", name: "Productivity" }], connection: null, enabled: false, allowWrites: false, ...extra });
const items = [
  item("github", "GitHub", { connection: { id: "ca_gh", status: "ACTIVE" }, enabled: true, allowWrites: true }),
  item("slack", "Slack", { connection: { id: "ca_sl", status: "ACTIVE" }, enabled: false }),
  item("discord", "Discord", { connection: { id: "ca_di", status: "ACTIVE" }, enabled: true, allowWrites: false }),
  item("notion", "Notion", { attention: "reconnect" }),
  item("airtable", "Airtable"),
];
const verification = {
  checkedAt: new Date().toISOString(), summary: ["GitHub: ready (live test read answered in 210 ms).", "Slack: needs a quick look.", "Discord: not working."], fixed: [],
  results: [
    { toolkit: "github", name: "GitHub", connection: "active", useInChat: true, allowChanges: true, actions: { total: 462, reads: 301, changes: 161 }, probe: { tool: "GITHUB_GET_THE_AUTHENTICATED_USER", ok: true, ms: 210, detail: "{\"login\":\"octo\"}" }, status: "ready", fixes: [], notes: ["The expired sign-in was renewed automatically."] },
    { toolkit: "slack", name: "Slack", connection: "active", useInChat: false, allowChanges: false, actions: { total: 13, reads: 9, changes: 4 }, probe: null, status: "attention", fixes: ["Use in chat is OFF for Slack, so Zeros will not touch it yet."], notes: [], autoFix: "enable" },
    { toolkit: "discord", name: "Discord", connection: "active", useInChat: true, allowChanges: false, actions: { total: 5, reads: 4, changes: 1 }, probe: { tool: "DISCORD_GET_CURRENT_USER", ok: false, ms: 80, detail: "401 Unauthorized: the token was revoked" }, status: "broken", fixes: ["Discord refused the request: 401 Unauthorized. Reconnect Discord and approve every permission it asks for."], notes: ["Read-only: Allow changes is OFF, so Zeros will look but not change anything."] },
  ],
};
await page.route("**/api/apps**", async (route) => {
  const url = new URL(route.request().url());
  calls.push(url.pathname + url.search);
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.pathname === "/api/apps") {
    const view = url.searchParams.get("view") ?? "all";
    const list = view === "connected" ? items.filter((i) => i.connection || i.attention) : items;
    return json({ configured: true, items: list, total: list.length, nextOffset: null, categories: [{ slug: "productivity", name: "Productivity", count: 5 }], connectedCount: 3, catalogError: null });
  }
  if (url.pathname === "/api/apps/verify") {
    if (url.searchParams.get("fix") === "1") return json({ ...verification, fixed: ["slack"], results: verification.results.map((r) => (r.toolkit === "slack" ? { ...r, useInChat: true, status: "ready", fixes: [], autoFix: undefined } : r)) });
    return json(verification);
  }
  if (url.pathname === "/api/apps/tools") return json({ toolkit: "github", tools: [{ name: "GITHUB_LIST_REPOS", description: "List repositories", write: false }] });
  return json({ error: "not mocked" }, 404);
});
await page.goto("http://127.0.0.1:8765/panel.html");
const step = async (label, fn) => { try { await fn(); console.log("OK   ", label); } catch (e) { console.log("FAIL ", label, "-", e.message.split("\n")[0].slice(0, 160)); } };
await step("the panel lists the apps with their states", async () => {
  await page.getByText("GitHub", { exact: true }).first().waitFor({ timeout: 8000 });
  await page.getByText("Reconnect", { exact: true }).first().waitFor({ timeout: 8000 });
});
await step("Test all connected apps runs live checks and shows each result", async () => {
  await page.getByRole("button", { name: /Test all connected apps/ }).click();
  await page.getByText("GitHub: working", { exact: false }).first().waitFor({ timeout: 8000 });
  await page.getByText(/Discord: not working/).first().waitFor({ timeout: 8000 });
  await page.getByText(/Reconnect Discord/).first().waitFor({ timeout: 8000 });
});
await step("Switch on for chat turns the app on and says so", async () => {
  await page.getByRole("button", { name: "Switch on for chat" }).first().click();
  await page.getByText("Switched on for chat").first().waitFor({ timeout: 8000 });
});
await step("opening an app shows its detail with a Test this app action", async () => {
  await page.getByRole("button", { name: "Manage" }).first().click();
  await page.getByRole("button", { name: /Test this app/ }).waitFor({ timeout: 8000 });
});
await step("Test this app checks just that app", async () => {
  await page.getByRole("button", { name: /Test this app/ }).click();
  await page.getByText(/GitHub: working/).first().waitFor({ timeout: 8000 });
});
await page.screenshot({ path: "out/apps-panel.png", fullPage: false });
console.log("API calls:", calls.join(" | "));
console.log("errors:", errors.length ? errors : "none");
await browser.close();
