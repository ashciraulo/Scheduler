# End-to-end suites

Browser tests for the scheduler, run by `.github/workflows/ci.yml` on every
pull request and push to `main`.

They live in their own package rather than in `scheduler/` so the app gains no
test dependencies — `scheduler/package.json` stays exactly what ships.

## Running them

The suites drive a server you start yourself; they don't start one.

```bash
cd scheduler && npm run build && npx vite preview --port 4173 --strictPort &
cd e2e && npm install && npx playwright install chromium
npm test
```

`BASE_URL` defaults to `http://localhost:4173` (the production preview, which
is what CI exercises). Point it at `http://localhost:5173` to run against the
dev server instead.

Filter to one suite by passing a substring: `npm test -- parked`.

### In the Claude Code sandbox

Chromium is preinstalled outside the package, so skip `playwright install` and
point the harness at it:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium npm test
```

## Layout

```
run.mjs                 # runs every suite, aggregates into one exit code
lib/harness.mjs         # browser setup, check(), error + off-origin collectors
fixtures/               # generates the throwaway BC-style .xlsx
specs/                  # one file per area
artifacts/              # screenshots (gitignored, uploaded by CI)
```

## Notes

- **Each suite gets a fresh browser context.** Every one of them relies on the
  app seeding its demo data into an empty `localStorage` on first load, so
  sharing a context would leave the second suite looking at the first's edits.
- **The fixture is generated, never committed.** Real WIP exports are
  commercially sensitive; `*.xlsx` is gitignored. `fixtures/make-wip-xlsx.mjs`
  writes one that reproduces the quirks the parser exists to handle —
  namespace-prefixed tags, missing `r=` attributes, serial `0` for an empty
  date, a repeated job number, a completion date on a not-started row, and
  rows matching no keyword at all.
- **Every suite asserts no request leaves the origin.** The spreadsheet is
  parsed in-browser and must never be uploaded; a suite that loads an `.xlsx`
  and sees an outbound request has caught a real regression.
- **A suite that throws counts as a failure**, not a pass with fewer
  assertions — it hasn't proven the checks it never reached.
