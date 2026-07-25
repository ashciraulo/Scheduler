# CLAUDE.md — Weldcell Workspace

This workspace holds the tooling for a robotic welding / thermal-spray
department. Read this for orientation, then read `scheduler/CLAUDE.md` — the
detailed one — before working in the app.

## Layout

### `scheduler/` — Weldcell Scheduler
A Vite + React app for planning the month's jobs across equipment and staff,
respecting skills, rosters, shifts and leave, with drag-and-drop rescheduling,
repeat-job templates, capability tags, cost/margin tracking and a department
value report. It also reads Business Central WIP exports (`.xlsx`) directly.
See `scheduler/CLAUDE.md`.

### `offline-package/` — the deployable
The built app plus a small dependency-free server (`serve.py` / `serve.js`) so
one PC on the local network hosts the shared schedule and everyone else just
opens a browser.

**It is entirely build output. Never edit it — run `npm run package` in
`scheduler/`, which overwrites it from `dist/` + `scheduler/deploy/`.** The
server, launchers and end-user README are source and live in
`scheduler/deploy/`.

## Importing from Business Central

`BC WIP export (.xlsx)` → **scheduler** (Job Backlog → "Import from BC WIP
export")

The scheduler reads BC's `.xlsx` itself: the XLSX reader, keyword matching,
dedupe, completion flagging and job building all live in
`scheduler/src/wipImport.js`, driven by `ImportJobsModal`. The user picks the
export, reviews what matched, assigns templates for the hours BC can't supply,
and imports.

### Retired: the standalone WIP importer

`wip-importer/wip-importer.html` was a single-file, offline, zero-dependency
tool that did the spreadsheet half of this and exported a `.json` for the
scheduler to read. It was **retired** once the scheduler could read `.xlsx`
directly — keeping it meant maintaining two copies of the same matching/dedupe
logic, which would have drifted. Its engine was ported into
`scheduler/src/wipImport.js`, comments and hard-won behavioural rules intact.

It is preserved in git history (`git log -- wip-importer/`) if the standalone,
run-from-a-USB-stick property is ever wanted again. The scheduler still accepts
the `.json` it produced, so any old exports still import.

Two properties that tool was built around **still apply to `wipImport.js` and
must not be regressed**:
- **No network.** `.xlsx` is parsed in-browser (ZIP of XML via
  `DecompressionStream` + `DOMParser`) with no library and no upload. WIP data
  is commercially sensitive and must never leave the machine.
- **The spreadsheet is never persisted.** Its contents — the parsed rows, the
  analysis records, every unmapped column — live in component state and are
  gone when the modal closes. Saved instead are the keyword settings
  (`wf_wipsettings`) and, since the parked list was added, the **job-shaped**
  records of rows an import left behind (`wf_wipparked`): exactly the fields a
  matched row contributes to a job, so a job whose scope later grows into the
  department can be pulled in without re-running the import. That one
  narrow exception is deliberate — don't widen it to the raw rows, which in
  shared mode would put the whole export on the host PC for the network to
  read.

## Working here

- Nearly all work is in `scheduler/` — honour `scheduler/CLAUDE.md`.
- Never hand-edit `offline-package/`; run `npm run package` to regenerate it.
- Use Git branches and commit checkpoints before large changes.

## Background

The scheduler and the importer were originally built as Claude artifacts and
moved into local projects for development in VSCodium with Claude Code. For a
period the repo held only the scheduler's *compiled* bundle and changes were
made by patching it; that was corrected by restoring the real Vite + React
source, which is now the single source of truth.
