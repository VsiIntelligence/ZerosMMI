# Browser checks

These checks run Zeros' screens and engines in a real browser (Chromium, through Playwright), with WebGL and audio. They prove the
code paths and the screens work end to end on this machine. They do not call a live model provider or a live connector account:
engines are simulated and connector responses are mocked, so run the Settings → Apps check against your own account for that.

## Run

1. `npm install`
2. `npm install --save-dev playwright` and `npx playwright install chromium`
3. `npm run test:browser` (about two minutes; the film render is the longest step)

## What each check covers

- **check-bundles**: every file the app and its pages depend on resolves (a missing export or a wrong path fails here).
- **run-code**: JavaScript runs in its own worker. Output and errors are reported, a loop that never ends is stopped at its
  time limit with the page still responsive, network access is refused, and the code cannot reach the page.
- **run-codeblock**: a code block in a reply offers Copy, Run for JavaScript and Preview for HTML; Python gets plain code only.
- **run-panel**: the Apps panel with mocked connector responses: the list, test all connected apps, switch an app on, open an app
  and test it.
- **run-song**: a song asked for 30 seconds renders as a 30-second, audible WAV that decodes in the browser.
- **run-3d** and **run-3d-build**: a real model renders through the worker and the WebGL viewer (the picture is saved to `out/`), and a
  full build plans a new model and skips the plan for an edit.
- **run-site** and **run-site-nav**: a two-page website runs its scripts and styles, and the shipped host switches pages.
- **run-video**: a short film renders to a playable file with real frames.

## Notes

- `www/` (the bundles and pages) and `out/` (screenshots) are build output and are git-ignored.
- The Apps panel is shown with the design system's own styles. The app's Tailwind utility classes are not loaded here.
- Film and song timings are from software rendering and will differ on a device.
