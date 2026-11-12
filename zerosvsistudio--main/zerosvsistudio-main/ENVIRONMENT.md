# ZerosX2.0: server settings

Set these as **secrets on the server** (Cloudflare Pages secrets, or `.dev.vars` for local development). They are read only by server code and are never sent to the browser. Keep this repository private.

## Reasoning engines

Zeros answers through up to three engines, behind one interface. The code names no company, address, model or voice: all of that comes from the settings below, so the people who use Zeros can never see it, in the browser or in this repository.

| Setting | Required | What it is |
|---|---|---|
| `ZEROS_A_KEYS` | yes (or B) | API keys of engine A, comma-separated. Engine A does text, JSON, vision, images and voice. |
| `ZEROS_A_URL` | with A | Base address of engine A. |
| `ZEROS_A_KEY_HEADER` | with A | Name of the HTTP header that carries engine A's key. |
| `ZEROS_A_MODELS` | with A | Text models, comma-separated, **strongest first**. Each is tried in turn until one answers. |
| `ZEROS_A_FAST_MODELS` | optional | Text models, **quickest first**. Defaults to `ZEROS_A_MODELS`. |
| `ZEROS_A_IMAGE_MODELS` | for pictures | Image models of engine A, preferred first. |
| `ZEROS_A_VOICE_MODELS` | for narration | Speech models of engine A, preferred first. |
| `ZEROS_A_VOICE_MALE`, `ZEROS_A_VOICE_FEMALE` | for narration | The voice names used for the video narrator. |
| `ZEROS_B_KEYS` | yes (or A) | API keys of engine B (very fast text), comma-separated. |
| `ZEROS_B_URL` | with B | Base address of engine B. |
| `ZEROS_B_MODELS` | with B | Text models, strongest first. |
| `ZEROS_B_FAST_MODELS` | optional | Text models, quickest first. Defaults to `ZEROS_B_MODELS`. |
| `ZEROS_B_IMAGE_MODELS` | optional | Picture models of engine B (its picture endpoint), preferred first. Zeros also asks each engine which picture models it offers, so this is only needed to pin a choice. |
| `ZEROS_C_KEYS` | optional | API keys of engine C, a slower agent used first by Medium and Complex. Without it those levels start at A. |
| `ZEROS_C_URL`, `ZEROS_C_KEY_HEADER`, `ZEROS_C_PROFILE` | with C | Base address, key header name and the agent profile to run. |
| `ZEROS_I_KEY`, `ZEROS_I_URL`, `ZEROS_I_MODEL` or `ZEROS_I_MODELS` | optional | A dedicated image engine. Set `ZEROS_I_MODEL` for one model or `ZEROS_I_MODELS` to a comma-separated fallback list (best first). Pictures use it first and engine A's image models as the fallback. `ZEROS_I_QUERY` may add extra query parameters. |
| `ZEROS_ENGINE_BACKOFF_MS` | optional | The pause before a busy or briefly unavailable engine is asked again. Default 400 ms, lengthening with each try. Tests set it to 1. |
| `ZEROS_HIDE_TERMS` | recommended | Comma-separated names that Zeros must never use to describe itself. If a model ever answers "I'm &lt;name&gt;" or "powered by &lt;name&gt;", the name is replaced with "Zeros" before anyone reads it. Only sentences where the assistant talks about itself are changed. |

At least one engine must be configured. With none set, chat replies that Zeros could not reach its reasoning engine, and nobody is charged.

## Plans, payments and promo access

| Setting | Required | What it is |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | A REST app from the PayPal developer dashboard. |
| `PAYPAL_ENV` | optional | `sandbox` for test payments; anything else is live. |
| `PAYPAL_PLAN_ID_BRONZE` | yes | The PayPal billing plan that charges **$25 USD every month**. |
| `PAYPAL_PLAN_ID_GOLD` | yes | The PayPal billing plan that charges **$50 USD every month**. |
| `PAYPAL_WEBHOOK_ID` | recommended | The id of your PayPal webhook, so cancellations and refunds are applied at once. Without it nothing is trusted from webhooks, and access still follows PayPal through the lazy re-check described below. |
| `PROMO_CODE` | optional | The promo code. A person who types exactly this value gets **free, unlimited access** on their account. Leave it out to switch promo access off. Use a long random value (16+ characters). |
| `SUPABASE_URL` (or `VITE_SUPABASE_URL`) | yes | Your project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server only. Without it, nothing that costs money runs (fail closed). |
| `PUBLIC_APP_URL` | optional | Your public address, e.g. `https://zeros.example.com`. Defaults to the address the request arrived on. |
| `COMPOSIO_CONNECTOR_KEY` (or legacy `COMPOSIO_API_KEY`), `COMPOSIO_API_BASE` | for apps | App connections and the live Composio directory. |
| `FIREBASE_WEB_API_KEY` | optional | The public web key is already built in. |

### Setting up the two monthly plans

Run this once with your PayPal app keys (add `PAYPAL_ENV=sandbox` to test first):

```sh
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-create-plans.mjs
```

It creates the Bronze and Gold plans and prints the two ids for `PAYPAL_PLAN_ID_BRONZE` and `PAYPAL_PLAN_ID_GOLD`. (`--dry-run` prints what it would send and sends nothing.) You can also create them by hand in the PayPal dashboard: Subscriptions, Create plan, regular billing cycle every **1 month**, **no end date**, **no trial**, USD **25** and **50**.

To test, set `PAYPAL_ENV=sandbox`, use the sandbox app's keys and sign in with a sandbox buyer account.

Zeros checks the plan with PayPal before every checkout. A plan that is not exactly monthly, USD, open-ended, trial-free and the right price is refused, so a mistake in the dashboard can never sell a plan for the wrong money.

### Webhook (recommended)

In the PayPal dashboard, create a webhook for `https://YOUR-DOMAIN/api/billing/webhook` with these events, then put its id in `PAYPAL_WEBHOOK_ID`:
`BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.RE-ACTIVATED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`.

## Apps

People browse the live directory in Settings → Apps, press Connect, sign in to the app, and return to Zeros. After connecting, enable “Use in chat” to let Zeros use that app; enable “Allow changes” separately only if you want it to modify data. The Apps page lists available actions from Composio and marks them as reads or changes. Zeros checks the signed-in person’s actual connections and saved permissions before using tools in chat.

When an app has no auth configuration in your Composio project, Zeros creates one automatically using Composio's own managed sign-in, so most apps connect with no dashboard work. Apps that only work with your own OAuth credentials need an auth configuration created in the Composio dashboard; until then Zeros says so plainly. `COMPOSIO_CONNECTOR_KEY` is the preferred server secret. The legacy `COMPOSIO_API_KEY` remains supported. `COMPOSIO_API_BASE` is optional.

## GitHub account authorization (per-user OAuth)

GitHub repository-list requests use a **user access token**, not a shared installation token. Each person authorizes their own GitHub account. GitHub limits this token to resources the user can access and permissions the GitHub App has been granted. Composio remains available for the separate live action catalog and other app actions.

| Setting | Required | What it is |
|---|---|---|
| `GITHUB_CLIENT_ID` | yes | The GitHub App's OAuth client ID. |
| `GITHUB_CLIENT_SECRET` | yes | The GitHub App's OAuth client secret. Server only. |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | yes | A base64-encoded, random 32-byte key used for AES-256-GCM encryption of stored access and refresh tokens. Generate it with `openssl rand -base64 32`; keep it stable and server-only. |
| `PUBLIC_APP_URL` | recommended | The production origin, e.g. `https://zeros-ai.pages.dev`. Must match the GitHub App callback configuration. |

In the GitHub App settings, configure the callback URL as `https://zeros-ai.pages.dev/api/github/callback` (or the exact origin configured by `PUBLIC_APP_URL`). Grant only the GitHub App permissions required for your product; repository metadata is needed to list repositories. Users must authorize the app themselves. The app's private key and app ID are not used for this per-user OAuth flow; they should remain server-side if other server-to-server GitHub App features use them.

Tokens are encrypted before being written to Supabase. Never place GitHub tokens in browser storage or logs. If you rotate `GITHUB_TOKEN_ENCRYPTION_KEY`, existing encrypted connections cannot be decrypted; users will need to reconnect GitHub. Access tokens are refreshed server-side when possible, and users must reconnect after a refresh token expires or authorization is revoked.

The new table is `zeros_github_user_tokens`; apply the migration listed below before enabling the OAuth flow. The OAuth path currently covers repository listing. Other GitHub actions in the live Composio catalog still require the person's separate Composio connection.

## Database

Run the migrations once, in order, in the Supabase SQL editor:

1. `20260819133911_41101f26-0806-4ab6-81f3-a362db331b46.sql`, `20260921000000_zeros_durable_firebase_data.sql` and `20260923000000_zeros_chat_assets.sql` (chats, memories, files)
2. `20261017000000_zeros_billing.sql` (plans, usage and the daily-allowance function)
3. `20261018000000_zeros_app_permissions.sql` (per-app permissions)
4. `20261020000000_zeros_subscriptions.sql` (**monthly subscriptions, promo access, per-account settings**)
5. `20261023_github_user_tokens.sql` (**encrypted per-user GitHub OAuth tokens**)

`20261019000000_remove_mai.sql` is optional. It drops the table of the retired MAI feature and **permanently deletes the messages in it**. Zeros no longer uses that table, so you can leave the file un-run.

## How access works

Access has exactly three sources. There is no free tier.

1. **A monthly plan.** Bronze ($25) allows 100 requests every 24 hours, Gold ($50) 500 requests every 24 hours plus Complex reasoning. The plan works for the month that was paid for. PayPal bills again every month by itself. If the payment does not arrive, access ends (after a 2-day grace while PayPal retries). Cancelling stops the next payment and keeps the paid month.
2. **A promo redemption.** Typing the value of `PROMO_CODE` gives that account unlimited access, free. Only a fingerprint of the code is stored; **changing or removing `PROMO_CODE` ends access for everyone who used the old code.** Wrong guesses are rate-limited per account and per network address.
3. **Nothing.** No plan and no promo means no access: every route that costs money answers 401 (signed out) or 402 (no plan) before any engine is called.

What counts against the 24-hour allowance: a chat message 1 (1.2 with apps turned on), a picture 1, a 3D or website review 0.5, a narration clip 0.3, a memory check 0.1. A call that could not be completed is refunded. Promo accounts are never counted.

Everything that makes access is verified with PayPal from the server. The browser can only ask; it can never grant.

### Revoking access by hand

```sql
-- end one account's plan now
update public.zeros_billing set paid_through = now() - interval '1 second', status = 'REVOKED' where user_id = '<firebase uid>';
-- end one account's promo access
delete from public.zeros_promo where user_id = '<firebase uid>';
```

## What is saved per Google account

Everything a person makes or chooses belongs to their Google account, on every device, and is never shown to another account on the same browser: chats and messages, memories and the memory switch, connected apps and their permissions, the wallpaper (presets or an uploaded image), the reasoning level, and the plan. Database rows are protected by row-level security that matches the signed-in account; settings are cached in the browser under the account's id only, and are cleared when someone signs out or another account signs in. Guests are never stored.

## Checks

- `npm run typecheck` checks the types. `npm test` runs every suite (billing, promo, access on every route, engines, the identity filter, per-account settings, apps).
- `npm run check:clean` scans the repository and the build output for names that must never appear. Set `ZEROS_BANNED_TERMS` to a comma-separated list first. After `npm run build`, `ZEROS_BANNED_TERMS=... node scripts/check-clean.mjs --dist-only` checks exactly what visitors can download.

## Diagnostics

- `ZEROS_ADMIN_TOKEN` (optional, at least 16 characters) enables `GET /api/engine-health` for the owner, sent as a bearer token. Without it the address answers 404. The report lists what is configured and the recent engine failures, with every key removed. Add `?discover=1` to ask each engine which models it offers, and `?probe=1` to make live test calls on the chat, fast, 3D and picture paths (those calls cost provider usage).
- Apps: action calls, the raw API proxy and token refresh use the connector service's v3.1 endpoints. The app directory and connection status use v3.

## Route tree

`src/routeTree.gen.ts` is generated and already lists every route. It regenerates itself on `npm run dev` and `npm run build`.
