#!/usr/bin/env node
/**
 * Creates the two monthly PayPal billing plans for ZerosX2.0 and prints the ids to put in the server settings.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... [PAYPAL_ENV=sandbox] node scripts/paypal-create-plans.mjs [--dry-run]
 *
 * Bronze is $25 USD every month and Gold is $50 USD every month, with no end date and no trial. Run it once per PayPal
 * environment (sandbox, then live). It is safe to run again: PayPal answers repeated requests with the same objects.
 */
const dry = process.argv.includes("--dry-run");
const sandbox = process.env.PAYPAL_ENV === "sandbox";
const base = sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

const PLANS = [
  { key: "bronze", env: "PAYPAL_PLAN_ID_BRONZE", name: "ZerosX2.0 Bronze (monthly)", price: "25.00", description: "100 requests every 24 hours. Billed monthly." },
  { key: "gold", env: "PAYPAL_PLAN_ID_GOLD", name: "ZerosX2.0 Gold (monthly)", price: "50.00", description: "500 requests every 24 hours and Complex reasoning. Billed monthly." },
];

const product = { name: "ZerosX2.0", description: "ZerosX2.0 monthly subscription", type: "SERVICE", category: "SOFTWARE" };
const planBody = (productId, p) => ({
  product_id: productId,
  name: p.name,
  description: p.description,
  status: "ACTIVE",
  billing_cycles: [{
    frequency: { interval_unit: "MONTH", interval_count: 1 },
    tenure_type: "REGULAR",
    sequence: 1,
    total_cycles: 0,
    pricing_scheme: { fixed_price: { value: p.price, currency_code: "USD" } },
  }],
  payment_preferences: {
    auto_bill_outstanding: true,
    setup_fee: { value: "0", currency_code: "USD" },
    setup_fee_failure_action: "CANCEL",
    payment_failure_threshold: 3,
  },
});

if (dry) {
  console.log(`Would call ${base}\n\nPOST /v1/catalogs/products\n${JSON.stringify(product, null, 2)}\n`);
  for (const p of PLANS) console.log(`POST /v1/billing/plans\n${JSON.stringify(planBody("<product id>", p), null, 2)}\n`);
  process.exit(0);
}

const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first (and PAYPAL_ENV=sandbox to test).");
  process.exit(1);
}

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
  return json;
}

const token = (await call("/v1/oauth2/token", {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
})).access_token;
const headers = (requestId) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation", "PayPal-Request-Id": requestId });

const created = await call("/v1/catalogs/products", { method: "POST", headers: headers(`zeros-product-v1${sandbox ? "-sandbox" : ""}`), body: JSON.stringify(product) });
console.log(`Product: ${created.id}\n`);
for (const p of PLANS) {
  const plan = await call("/v1/billing/plans", { method: "POST", headers: headers(`zeros-plan-${p.key}-v1${sandbox ? "-sandbox" : ""}`), body: JSON.stringify(planBody(created.id, p)) });
  console.log(`${p.env}=${plan.id}`);
}
console.log("\nAdd those two lines to your server settings, then redeploy.");
