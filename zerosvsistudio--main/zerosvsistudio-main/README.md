# Zeros AI Studio

ZerosX2.0 by VsiStudio: chat, web search, images, 3D models, songs, websites and videos, with memory, connected apps and a wallpaper that all follow each person's Google account.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Plans

| Plan | Price | Allowance |
|---|---|---|
| Bronze | $25 / month | 100 requests every 24 hours |
| Gold | $50 / month | 500 requests every 24 hours, plus Complex reasoning |

Plans renew every month through PayPal until cancelled. Nothing is free except accounts that redeem the promo code, which are unlimited.

## Before you launch

1. Set the server settings listed in [ENVIRONMENT.md](./ENVIRONMENT.md): engines, PayPal, Supabase and `PROMO_CODE`.
2. Run the database migrations in `supabase/migrations/`, in the order given in ENVIRONMENT.md.
3. Create the two monthly PayPal plans with `npm run paypal:plans`, first in sandbox (`PAYPAL_ENV=sandbox`), then live.
4. Add the PayPal webhook that points at `/api/billing/webhook` and set `PAYPAL_WEBHOOK_ID`.
5. Test a purchase, a cancellation and a promo code end to end in sandbox before you take payments.
6. Run `npm run build`, then check the build output with `ZEROS_BANNED_TERMS=... node scripts/check-clean.mjs --dist-only`.

## Working on Zeros

- `npm run dev` / `npm run build`: run or build the app.
- `npm run typecheck`: type-check the project.
- `npm test`: run every test suite. No browser, keys or network are needed. It covers billing, promo codes, access on every route, the engines, the identity filter, per-account settings, apps, songs, video and website generation.
- `npm run check:clean`: scan the repository for names that must never appear.
- [CHANGELOG.md](./CHANGELOG.md) lists what changed in each version.
- [ENVIRONMENT.md](./ENVIRONMENT.md) lists every server setting and explains how plans, promo codes and connected apps work.
