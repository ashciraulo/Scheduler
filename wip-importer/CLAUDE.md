# CLAUDE.md — WIP Importer

Project memory for Claude Code. Read this first at the start of every session.

## What this is

A single-file, offline tool that takes an Excel WIP export from Microsoft
Dynamics 365 Business Central, removes duplicates, identifies jobs belonging to
this welding/thermal-spray department by keyword, pulls through the data the
scheduler needs, and exports a JSON file of jobs for the Weldcell Scheduler
(the sibling project in this workspace).

The entire tool is ONE file: `wip-importer.html`. HTML, CSS and JavaScript are
all inline. There is no build step, no framework, no package.json, and no
dependencies. You open the file in a browser and it runs.

## Hard constraints — do not break these

1. **Completely offline.** The tool must make ZERO network requests. No
   `<script src>`, no `<link href>`, no CDN, no `fetch`/`XMLHttpRequest` to any
   remote host, no remote fonts, no analytics. The WIP data is commercially
   sensitive and must never leave the user's machine. This is the whole reason
   the tool exists in this form. Any change that introduces a network dependency
   is unacceptable, even a "harmless" one like a web font or a CDN library.
   - The only acceptable "http" strings in the file are XML namespace
     identifiers (labels, not fetched) and explanatory comments.
   - Verify after any change: open DevTools > Network, load a file, confirm zero
     requests; or grep the file for `http`, `src=`, `fetch(`, `XMLHttpRequest`.

2. **Single self-contained file.** Do not split it into modules, add a bundler,
   or pull in npm packages. Its portability (email it, drop it on a shared
   drive, run it from a USB stick with no install) depends on staying one file.
   If shared helpers are ever justified, they still go inline in this file.

3. **No third-party libraries for XLSX.** The tool parses `.xlsx` from scratch:
   an `.xlsx` is a ZIP of XML, unzipped with the browser-native
   `DecompressionStream` and parsed with the browser-native `DOMParser`. This is
   deliberate — it avoids bundling SheetJS or fetching it from a CDN. Keep it
   dependency-free.

4. **Never write WIP data to disk / storage.** The uploaded file is read into
   memory and discarded when the tab closes. Only *settings* (keyword lists and
   combination rules) are persisted, to localStorage. Do not start persisting
   job data.

## How the file is organised (top to bottom)

- **Offline-by-construction comment** — the promise above, and how to verify it.
- **CSS** — dark slate theme, amber accents. All inline in `<style>`.
- **HTML** — the 5 steps: load file, keyword matching, column mapping, review,
  export.
- **JavaScript** (in one `<script>`):
  - `state` object and keyword/combo defaults.
  - `LS` — localStorage helper for settings (namespaced `wipimp::`).
  - **XLSX reader** — `inflateRaw`, `unzip`, `colToIndex`, `serialToISO`,
    `parseXlsx`, plus namespace-agnostic DOM helpers `els`/`firstEl`/`attr`.
  - **Field detection** — `FIELDS`, `autoMap`.
  - **Analysis** — `analyse()`: matching, duplicate detection, completion
    resolution, warnings, default selection.
  - **Render** — chips, mapping grid, stats, review table, export bar.
  - **Export** — `buildSchedulerJobs`, `exportJson`, `exportCsv`.
  - **Settings portability** — `exportSettings` / `importSettings`.
  - **Wire-up** — the init IIFE at the bottom.

## Behavioural rules that encode hard-won bug fixes — keep them

These are not arbitrary; each fixed a real bug. Don't regress them.

- **XLSX reading must tolerate real BC output**, which differs from Excel-saved
  files: cells/rows may omit the `r=` reference attribute (fall back to
  positional order), tags may be namespace-prefixed like `<x:row>` (match by
  local name, not literal tag), and empty rows are omitted entirely (place rows
  by their real row number, not sequentially).
- **Empty dates.** BC writes an empty date as the serial number `0`.
  `serialToISO` must reject `0` and out-of-range serials — converting `0` yields
  "1899-12-30", which is truthy and silently corrupts due dates and completion
  flags. Empty dates must read as "no date".
- **Actual Completion Date is NOT trusted on its own.** BC has been observed
  populating it on jobs that have not started. A job counts as genuinely
  complete (auto-unticked, tagged "complete") ONLY when a completion date
  appears together with a corroborating status in `DONE_STATUSES` (ready for
  dispatch / ready for invoicing / finance to invoice / complete). A date with
  an "unstarted" status is flagged as a contradiction; any other date is flagged
  to check. A completion date NEVER, on its own, deselects a job or maps to the
  scheduler's completion status. Every exported job is `status: 'active'`,
  `completedDate: null`; the BC date is recorded in notes marked "unverified".
- **Duplicate keeper choice** excludes the Actual Completion Date column from the
  completeness score, so a row can't win just by carrying a bogus date.
- **Keyword matching** is on the `Description` column only (not `Job Task
  Description`, which holds WIP progress text like "WIP 50%"). Include/exclude
  keywords match as substrings; **combination rules match whole words** (so a
  "body" rule doesn't fire on "bodywork").
- **Combination rules** hold a job for review (it appears under "Not matched")
  rather than auto-including or discarding it — for cases like "body OR elbow is
  ours, but body AND elbow together is a different part".
- **The "Not matched" view excludes duplicates**, so it only shows genuine
  keyword gaps to audit.
- **Nothing is dropped silently.** Duplicates, held, and complete jobs are all
  visible in their views/counts and remain tickable; only ticked jobs export.

## The export contract (keep in sync with the scheduler)

`buildSchedulerJobs` must emit objects matching the scheduler's job shape:
`name, process, quantity, hoursTotal, readyDate, dueDate, templateId, notes,
totalValue, departmentValue, percentComplete, status, completedDate, bcJobNo,
bcJobTaskNo, updatedAt, assignment`. Notable deliberate choices:
- `hoursTotal: 0` and `process: ''` — BC WIP has no shop-floor hours; these come
  from a scheduler template or are set per job. The scheduler can't plan a job
  at 0 hours, so this is expected to be filled in there.
- `departmentValue: 0` — BC's Total Contract Value is the whole-job value to the
  company, not this department's share. Guessing a split would corrupt the
  scheduler's value report, so it is left for the user to set.
- `totalValue` — carried through from BC's Total Contract Value (LCY).
- `status: 'active'`, `completedDate: null` — always (see completion rule above).

If you change the scheduler's job shape, update this function to match, and vice
versa. The two projects are coupled only through this JSON contract.

## Downstream: the scheduler's import UI

The scheduler now has an "Import from WIP export" screen (`ImportJobsModal` in
`scheduler/src/WeldingScheduler.jsx`) that reads the JSON this tool exports —
either the `{ jobs: [...] }` wrapper this tool produces, or a bare array. It
dedupes against existing jobs by `bcJobNo` + `bcJobTaskNo`, and lets the user
assign a template per row (or bulk) to fill in the `process`/`hoursTotal` this
tool deliberately leaves blank/zero. See `scheduler/CLAUDE.md` → "Importing
jobs from the WIP importer". If you change `buildSchedulerJobs`'s output shape
here, update that modal to match, and vice versa.

## Testing

There is no test framework here. To verify changes, open `wip-importer.html` in
a browser and load a sample export. During development this tool was tested by
driving it with a headless browser (Playwright) against xlsx files crafted to
mimic BC's output quirks (missing `r=` attributes, namespace prefixes, empty `0`
dates, unreliable completion dates). If you have a browser automation tool
available, that is the highest-value way to check the XLSX parser and the
matching/dedupe logic; otherwise, manual checks in the browser are fine. Always
re-verify the zero-network-requests property after touching anything.
