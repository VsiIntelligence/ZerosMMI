import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
await page.goto("http://127.0.0.1:8765/codeblock.html");
const step = async (label, fn) => { try { await fn(); console.log("PASS", label); } catch (e) { console.log("FAIL", label, "-", e.message.split("\n")[0].slice(0, 160)); } };
await step("a JavaScript block offers Copy and Run, and Run shows its output", async () => {
  await page.getByRole("button", { name: "Copy" }).first().waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Run" }).first().click();
  await page.locator(".zx-code__out").first().getByText("the answer is 42").waitFor({ timeout: 8000 });
});
await step("an HTML block previews in a sandboxed frame with no network policy", async () => {
  await page.getByRole("button", { name: "Preview" }).first().click();
  const frame = page.locator('iframe[title="HTML preview"]').first();
  await frame.waitFor({ timeout: 8000 });
  const sandbox = await frame.getAttribute("sandbox");
  if (sandbox !== "allow-scripts") throw new Error("sandbox is " + sandbox);
  await page.frameLocator('iframe[title="HTML preview"]').locator("#preview-title").getByText("Preview works").waitFor({ timeout: 8000 });
});
await step("Show code returns to the code view", async () => {
  await page.getByRole("button", { name: "Show code" }).first().click();
  await page.locator(".zx-code__pre").first().getByText("const answer").waitFor({ timeout: 8000 });
});
await step("a Python block is shown as plain code with no Run or Preview", async () => {
  const blocks = page.locator(".zx-code");
  const last = blocks.nth(2);
  if (await last.getByRole("button", { name: "Run" }).count()) throw new Error("Run offered for python");
  if (await last.getByRole("button", { name: "Preview" }).count()) throw new Error("Preview offered for python");
  await last.locator(".zx-code__pre").getByText("plain code, no runner").waitFor({ timeout: 4000 });
});
await page.screenshot({ path: "out/codeblock.png", fullPage: true });
console.log("page errors:", errors.length ? errors : "none");
await browser.close();
