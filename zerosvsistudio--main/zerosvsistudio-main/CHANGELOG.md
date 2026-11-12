# Changelog

## Unreleased: apps that work, reliable pictures and 3D, edits that remember, runnable code

### Apps
- Connected apps are checked, not assumed. "Test all connected apps" and "Test this app" make a live, read-only call through each app and say what to fix: reconnect, switch on for chat, or a permission that is missing. Expired sign-ins are renewed automatically when the service allows it.
- The action for a request is found by matching the request against the app's full action list, with synonyms, a search the assistant can use when the first list misses, and arguments converted to each action's own types before anything is sent. Large answers are trimmed to whole items.
- Changes are refused unless the person asked for one and "Allow changes" is on. Deleting, cancelling and refunding need explicit words. Requests that only read never change anything.
- Every app can reach its own web API as a last resort, so anything the person's account can do is reachable. GitHub can be authorized directly, without the connector service.
- Signing in finishes before an app is switched on, so an app shows as connected only when it really works.

### Pictures
- A picture no longer fails with "no picture models are set". Picture models are found by asking the engine what it offers, a second engine's picture endpoint is tried, and as a last resort a drawn illustration is returned, marked as drawn. The request is charged once.
- "Make it night" changes the previous picture, using the prompt it was made from and the picture itself when it can be read.

### 3D models
- A busy or briefly unavailable engine is asked again (rate limits, server errors, dropped connections). Models the engine no longer offers are skipped and remembered for five minutes.
- A 3D request falls back to the agent when every text engine is down. Failed requests are not charged.
- A new model gets its planning step; an edit reuses the previous model's code. The reviewer is asked again before a review is given up.
- The downloadable GLB, OBJ, PLY and STL files are checked by reading them back: vertex and face counts match the measured mesh, every edge is shared by two faces, normals are unit length.

### Songs and films
- A length the person asks for is honoured. "A 30 second song" renders as a 30-second track: the lyric is shortened to a verse excerpt and the hook. Songs of 45 seconds and up keep their arrangement.
- Songs and films revise the previous one when a request changes it. The earlier artifact is chosen by what the request mentions.
- The built-in film template keeps its 45-second layout and says so when another length was asked for.

### Code
- Code blocks in replies can be copied. JavaScript can be run: it executes in a sandbox with no page, storage or network access, its output is shown, and a run that goes past its time limit is stopped. HTML can be previewed in a frame with no network access. Other languages are shown as code only.

### Owner diagnostics and tests
- A diagnostics address reports what is configured and the recent engine failures, with no keys shown (see ENVIRONMENT.md).
- New suites: artifact memory, length rules, code runner, the app checks, engine behaviour and 3D delivery.
- Browser checks (`npm run test:browser`, see tests/browser/README.md) run the code runner, code blocks, the Apps panel, a song, the 3D viewer and full build, a website and its host, and a film in Chromium.

## v5: monthly plans, promo access, one account = one set of data, a private engine room

### Billing
- **Bronze ($25) and Gold ($50) are monthly subscriptions**, billed by PayPal every month until cancelled. The old one-time purchase (which unlocked a plan forever) is gone.
- A plan works for the month that was paid for. When the next payment does not arrive, access ends (2-day grace while PayPal retries). The server re-reads PayPal near the end of each month, and PayPal webhooks (renewals, cancellations, refunds) are applied at once.
- Zeros checks the PayPal plan before every checkout (monthly, USD, no end, no trial, exact price) and each payment after it (exact amount, right account, active). Nothing unlocks from what the browser says.
- Upgrading Bronze to Gold starts Gold and cancels Bronze so nobody is charged twice. Gold cannot be bought down to Bronze on top of itself. Cancelling stops future payments and keeps the paid month. Settings, Account shows the renewal date and a Cancel button.
- Plans bought under the old one-time model (which had no end date) keep access for a 30-day transition counted from the day the migration runs, then must subscribe monthly. The length is one line in the migration.

### Promo code
- Setting `PROMO_CODE` on the server lets anyone who types that exact value use Zeros free and unlimited, on their own account. The value is compared in constant time on the server and is never sent to the browser. Guessing is rate-limited per account and per address. Changing or removing the variable ends access for everyone who used the old code.

### No plan, no access
- Image generation, narration, memory, the 3D and website reviews had **no sign-in and no plan check**; anyone on the internet could spend the engines. All of them now require a signed-in account with a plan or a promo, and every one counts against the 24-hour allowance (Bronze 100, Gold 500). The public GET form of image generation is removed.
- One shared access check is used by every route that costs money, with refunds when the work could not be done.

### Data belongs to the Google account
- The wallpaper (including an uploaded image), the reasoning level and the memory switch were stored once per browser and shared by every account on it. They are now saved with the account (any device) and cached under the account's id; signing out or switching accounts clears the previous account's cache. Guests are never stored.
- The plan status in the page is reset whenever the signed-in account changes.

### A private engine room
- Engine addresses, key header names, model names and voice names are now server-side settings (see ENVIRONMENT.md); none is written in the code.
- Responses no longer carry the provider and model headers. Errors shown to people are plain and name nothing. An output filter replaces any name the assistant uses to describe itself with "Zeros" (`ZEROS_HIDE_TERMS`).
- Browser code, tests, docs and configuration contain no engine or tool names. `npm run check:clean` proves it.

## Earlier versions
Songs, 3D, voice, websites, video, the settings window, the apps directory and the plan sheet were built in versions 1 to 4.
