---
name: run
description: Launch and drive the Weldcell Scheduler in a browser — dev server, production preview, or the packaged shared-mode server — to verify a change actually works.
---

Three ways to run it, depending on what you changed:

| What you changed | Run it as |
|---|---|
| App code (`src/`) | dev server (below) |
| Anything you'll ship | `npm run package`, then the shared server |
| Storage, sync, multi-user | **must** be the shared server — dev/preview have no `/api` |

## scheduler/ — Vite + React dev server

First run only: `cd scheduler && npm install` (also generates
`package-lock.json`, which is committed).

Start:

```bash
cd scheduler
npm run dev > /tmp/scheduler-dev.log 2>&1 &
echo $! > /tmp/scheduler-dev.pid
timeout 30 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
```

Stop: `kill $(cat /tmp/scheduler-dev.pid)` or `pkill -f vite` — do this before
relaunching, or the next run hits `EADDRINUSE`.

### Driving it — no `chromium-cli` in this environment

`chromium-cli` isn't installed here, but **playwright and Chromium are already
installed globally** — nothing to `npm install`. Run scripts from the
scratchpad with the global module path, and point Chromium at the preinstalled
binary:

```bash
NODE_PATH=/opt/node22/lib/node_modules node myscript.js
```

```js
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
```

Do **not** run `npx playwright install` (the browser is already there) and do
not add playwright to `scheduler/package.json`. Prefer one script that drives a
full flow end-to-end over a REPL — see `scheduler/CLAUDE.md` for what each
tab/modal does.

One representative interaction to confirm the app is alive:

```js
await page.goto('http://localhost:5173', { waitUntil: 'load' });
await page.waitForSelector('text=WELDCELL SCHEDULER');
await page.click('nav >> text=Job Backlog');
await page.screenshot({ path: 'backlog.png', fullPage: true });
```

Use `waitUntil: 'load'`, not `'networkidle'` — in shared mode the app polls
`/api/version` every 4s, so the network is never idle and `networkidle` times
out.

Always check `page.on('console', m => m.type() === 'error' && ...)` /
`page.on('pageerror', ...)` before declaring success — a blank-looking pass
can still have thrown.

### Gotchas specific to this app

- **Modals overlay the page, they don't replace it.** A selector like
  `table tbody tr` matches rows in the page *and* in an open modal — Playwright
  will time out waiting for a unique match. Scope to the modal:
  `page.locator('.fixed.inset-0.bg-black\\/60')` then `.locator(...)` within
  it (see `Modal` in `WeldingScheduler.jsx`).
- **File upload inputs** (e.g. the Job Backlog → "Import from WIP export"
  modal) — use `page.locator('input[type="file"]').setInputFiles(path)`, not
  DOM manipulation.
- **React controlled inputs/selects** — use Playwright's `fill` / `selectOption`
  / `click`, not `eval el.value = …`, or React's `onChange` won't fire.
- **The "Job name" field is not the first input in JobModal** — "Search
  templates" is. `input[type=text]` + `.first()` silently types into the search
  box and you get a job with no name. Use `getByLabel(/job name/i)`.
- **JobModal has no Cancel button and no Escape handler** — close it with the
  header ✕ (`div.fixed.inset-0 > div > div:first-child button`) or a backdrop
  click.
- **Persistence is `localStorage`-backed** (see `src/storage.js`). To check a
  change survives reload, `page.reload({ waitUntil: 'networkidle' })` in the
  *same* page/context — a fresh `chromium.launch()` starts a blank profile
  with nothing in storage, so cross-script "does it persist" checks will give
  false negatives. Keep the whole scenario (including reload checks) in one
  script/session.
- **Seed data**: first-ever load with empty storage seeds 4 demo jobs, 6
  equipment, 7 staff — expect them in screenshots/assertions unless storage
  was pre-populated.

## Shared mode — the packaged server

`npm run dev` and `npm run preview` have **no `/api`**, so `storage.js` falls
back to localStorage and `liveSync` never starts. Multi-user behaviour cannot
be tested there at all. Use the real thing:

```bash
cd scheduler && npm run package
cd ../offline-package/scheduler
rm -f scheduler-data.json          # start from a clean schedule
python3 serve.py 8091 &
curl -s http://127.0.0.1:8091/api/version    # {"version": 0} = shared store is live
```

Beware: `vite preview` answers `/api/version` with **200 + the SPA fallback
HTML**, not a 404. The probe survives it (it requires a numeric `version`
field), but it means a 200 alone doesn't prove the store is there — check the
body.

To test sync, use **two browser contexts**, not two pages — separate contexts
get separate localStorage, so anything they agree on genuinely came from the
server:

```js
const A = await (await browser.newContext()).newPage();
const B = await (await browser.newContext()).newPage();
```

Assert it updated **without a reload** — that's the whole design — by planting
a marker that a reload would destroy:

```js
await B.evaluate(() => { window.__noReload = 'alive'; });
// … A makes a change, wait for B to show it …
await B.evaluate(() => window.__noReload) === 'alive';  // must still be true
```

Also worth asserting: B stays on its tab, and a change arriving while B has a
dialog open is **held** until the dialog closes, then applied.

## Testing the BC WIP import

The standalone `wip-importer.html` is retired; its engine is now
`scheduler/src/wipImport.js`, reached from Job Backlog → "Import from BC WIP
export". Test it through the app like any other feature.

You need a `.xlsx` to drive it, and real WIP exports must never be committed
(`*.xlsx` is gitignored). Generate a throwaway one in the scratchpad with
Python's `zipfile` — an `.xlsx` is just a ZIP of XML, so no library is needed.
Worth reproducing BC's quirks, since they're what the parser exists to handle:
namespace-prefixed tags (`<x:row>`, `<x:c>`), **no** `r=` attributes on rows or
cells, empty dates written as the serial `0`, a repeated Job No., and a
completion date on a row whose status says it hasn't started.

Scope Playwright locators to the modal — `page.locator('div.fixed.inset-0 >
div')` — or `table tbody tr` and `button:has-text("Import")` will also match the
Job Backlog table and buttons behind the overlay, which silently gives you the
wrong element (or a click that the overlay intercepts until it times out).

After changes, confirm no request leaves the origin: the spreadsheet is parsed
in-browser and must never be uploaded.
`page.on('request', r => …)` asserting every URL is same-origin catches it.
