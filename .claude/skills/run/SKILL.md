---
name: run
description: Launch and drive the Weldcell Scheduler (Vite/React dev server) or open the WIP Importer (static HTML) to verify a change actually works in the browser.
---

This workspace has two runnable surfaces — see the root `CLAUDE.md` for what
each one is. Pick the one your change touched.

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

`chromium-cli` isn't installed here. Use the `playwright` npm package
directly instead, installed in your scratchpad (not the project — don't add
it to `scheduler/package.json`):

```bash
cd /path/to/scratchpad
npm init -y >/dev/null 2>&1   # once
npm install playwright         # once
npx playwright install chromium   # once — omit --with-deps, it needs sudo
                                    # and isn't available in this sandbox
```

Then a plain Node script with `require('playwright')`, `chromium.launch({
args: ['--no-sandbox'] })`, `browser.newPage()`, `page.goto('http://localhost:5173')`.
Prefer one script that drives a full flow end-to-end over a REPL — see
`scheduler/CLAUDE.md` for what each tab/modal does.

One representative interaction to confirm the app is alive:

```js
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('text=WELDCELL SCHEDULER');
await page.click('nav >> text=Job Backlog');
await page.screenshot({ path: 'backlog.png', fullPage: true });
```

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
- **Persistence is `localStorage`-backed** (see `src/storage.js`). To check a
  change survives reload, `page.reload({ waitUntil: 'networkidle' })` in the
  *same* page/context — a fresh `chromium.launch()` starts a blank profile
  with nothing in storage, so cross-script "does it persist" checks will give
  false negatives. Keep the whole scenario (including reload checks) in one
  script/session.
- **Seed data**: first-ever load with empty storage seeds 4 demo jobs, 6
  equipment, 7 staff — expect them in screenshots/assertions unless storage
  was pre-populated.

## wip-importer/ — single offline HTML file

No dev server, no build. Open the file directly:

```bash
xdg-open /path/to/wip-importer/wip-importer.html   # or a browser's file:// URL
```

To drive it headlessly with Playwright, `page.goto('file:///…/wip-importer.html')`
works the same way as the scheduler steps above (same locator/gotcha notes
apply). After any change here, also grep for `http`/`fetch(`/`XMLHttpRequest`
per `wip-importer/CLAUDE.md`'s offline requirement — driving it with a browser
won't itself catch a network dependency that only fires on a code path you
didn't exercise.
