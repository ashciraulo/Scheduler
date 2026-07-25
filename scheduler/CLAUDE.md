# CLAUDE.md — Weldcell Scheduler

Project memory for Claude Code. Read this first at the start of every session.

## What this app is

A production-workflow scheduler for a robotic welding + thermal-spray
department. The user identifies the month's jobs, and the app plans them across
equipment (welding robots + thermal-spray cells) and staff, respecting each
person's roster, shift, skills, and leave. It supports drag-and-drop
rescheduling, repeat-job templates, per-job financial tracking, and a value
report showing the department's contribution.

It began life as a single-file Claude artifact and has just been moved into a
local Vite + React project. Most of the app is one large component file.

## Tech stack

- Vite + React 18 (JavaScript, not TypeScript)
- Tailwind CSS (utility classes only; config scans `./src`)
- lucide-react for icons
- No router, no state library — one component, React hooks, local state
- Persistence via `window.storage` (see "Persistence" below)

## Layout

```
index.html
src/
  main.jsx            # entry; installs window.storage, mounts <App/>
  App.jsx             # renders <WeldingScheduler/>
  WeldingScheduler.jsx# the entire application (large; ~3900 lines)
  wipImport.js        # BC .xlsx reader + keyword/dupe analysis (see below)
  storage.js          # window.storage: shared /api store, else localStorage
  liveSync.js         # polls for other people's changes (shared mode)
  index.css           # Tailwind directives + light company theme
deploy/               # hand-written pieces of the deployable (SOURCE)
  serve.py serve.js   # the little host server + /api key-value store
  start-*.bat/.command# double-click launchers for the host PC
  README.txt          # end-user instructions, ships at the package root
scripts/package.mjs   # assembles ../offline-package from dist/ + deploy/
tailwind.config.js
postcss.config.js
vite.config.js
```

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — preview the production build
- `npm run package` — build, then assemble `../offline-package/` (the folder
  that gets copied to the host PC)

### offline-package is BUILD OUTPUT

Everything in `../offline-package/` comes from `dist/` or `deploy/`. **Never
edit it directly — `npm run package` overwrites it.** Edit `deploy/` for the
server, launchers or end-user README; edit `src/` for the app.

It used to require hand-editing: after each build you copied `dist/` across and
re-injected a shared-storage adapter into `index.html` against Vite's freshly
content-hashed asset filenames. That adapter is now `src/storage.js`, built
into the bundle, so `dist/` is the deployable verbatim. The script preserves
`scheduler-data.json` (the live schedule on a host machine) if present.

## How WeldingScheduler.jsx is organised

Top-to-bottom, the single component file contains:

1. **Data-model reference comment** — maps app fields to Microsoft Dynamics 365
   Business Central concepts, for a future integration. Keep it in sync if you
   change the job/resource shape.
2. **Constants & seed data** — shifts, default weekly roster, seed equipment /
   staff / templates / jobs. Seed data is only used on first run when storage is
   empty.
3. **Date helpers** — ISO date maths, calendar-day generation, roster/leave
   lookups.
4. **Scheduling engine** — `buildCapacityMaps`, `tryFit`, `consume`,
   `runScheduler`. This is the core. Capacity is tracked per
   equipment/day/shift and per staff/day. `runScheduler` places pinned
   (manually dragged) jobs first, then auto-schedules the rest earliest-due
   first, choosing the machine that finishes each job soonest and keeping one
   person on a job for continuity where possible. The capacity maps are passed
   around as one `caps` object (`equipDayLock`, `equipShiftUsed`,
   `staffDayRemain`, `staffDayShift`, `staffLoad`) rather than five positional
   arguments.
5. **Storage helpers** — `loadKey` / `saveKey` wrap `window.storage`.
6. **UI primitives** — small styled building blocks (Field, Modal, MultiCheck,
   buttons).
7. **Main component** `WeldingScheduler` — top-level state, load/recompute/save,
   all the CRUD handlers, the header, and tab routing.
8. **Views** — ScheduleView (the gantt/drag-drop grid), BacklogView, RosterView,
   TemplatesView, ResourcesView, ReportsView.
9. **Modals** — JobModal, ImportJobsModal, TemplateModal, EquipmentModal, StaffModal.

## Importing jobs from a Business Central WIP export

The Job Backlog tab's "Import from BC WIP export" button (`ImportJobsModal`)
reads BC's WIP **`.xlsx` directly**, via `src/wipImport.js`. The `.json`
produced by the old standalone importer is still accepted so existing exports
keep working, but that tool has been **retired** — `wipImport.js` is now the
only copy of this logic. (See the workspace root `CLAUDE.md`; the tool is in
git history if it's ever wanted back.)

`src/wipImport.js` is pure logic, no UI: `parseXlsx` (ZIP-of-XML read with the
browser-native `DecompressionStream` + `DOMParser` — **no SheetJS, no CDN, no
network**, because WIP data is commercially sensitive), `FIELDS`/`autoMap`
(header → logical field detection), `analyse` (keyword matching, duplicate
detection, completion resolution, warnings, default tick set) and
`buildSchedulerJobs` (the job-shape contract).

**The rules commented through that file each fixed a real bug against real BC
output — don't regress them:** BC writes an empty date as serial `0` (which
naively converts to a truthy "1899-12-30"); BC's Actual Completion Date is not
trusted on its own and only counts as complete alongside a corroborating
status; rows may omit `r=` attributes and use namespace-prefixed tags like
`<x:row>`; keywords match on `Description` only (Job Task Description holds WIP
progress text like "WIP 50%"); combination rules match whole words; the
duplicate-keeper score ignores the completion-date column; and nothing is ever
dropped silently — duplicates, held and complete rows stay visible and
tickable, only the default *selection* changes.

The modal is three steps:

1. **Pick a file** — `.xlsx` (BC export) or `.json` (standalone importer).
2. **WIP review** (`.xlsx` only) — counts, the include/exclude keyword chip
   editors, a collapsible column-mapping panel, and Ours / Not matched /
   Duplicates / All row views with search. Keyword hits are highlighted in the
   description so it's obvious *why* a row matched. Changing a keyword or a
   mapping re-analyses and resets the ticks to the new default selection, same
   as the standalone tool. Only ticked rows go on.
3. **Set hours** — the same review table both sources land on: assign a
   Template per row (or bulk-apply one to all ticked rows without one), which
   fills `process` and `hoursTotal` from `hoursPerUnit`/
   `departmentValuePerUnit` × quantity. Neither source carries shop-floor
   hours (BC's WIP has none), so both arrive with `process: ''` and
   `hoursTotal: 0`.

Rows are matched against existing jobs by `bcJobNo` + `bcJobTaskNo` and
flagged/unticked (not hidden) as probable duplicates, so re-importing the same
export doesn't create copies unless the user deliberately re-ticks them.
Imported jobs get fresh `id`s and go through the normal `recompute`/scheduler
pass like any other job.

The keyword lists persist under `wf_wipsettings`; **the WIP data itself is
never written to storage** — it lives in component state and is gone when the
modal closes. Keep that property.

`buildSchedulerJobs` is the job-shape contract: if the job shape changes,
update it too, and check `toReviewRows` in the modal still reads old `.json`
exports sensibly.

### Scheduling invariants (don't break these)

- A job never schedules before its `readyDate`.
- Pinned jobs keep the slot the user dropped them on; only unpinned jobs are
  auto-placed. Overbooked pinned jobs are flagged `conflict: true`, not moved.
- Auto-placement picks the compatible machine that **finishes soonest**. When
  multiple machines finish a job equally soon (a genuine tie — never at the
  cost of the current job's own completion time), it prefers whichever
  machine fewer *other* pending jobs are exclusively stuck with (see
  `exclusiveDemand` in `runScheduler`), so a flexible job doesn't camp on the
  one machine a less-flexible job has no alternative to. Remaining ties break
  on fewer staff handovers / fewer chunks.
- Within one job, the same person stays on it across days where their roster
  allows; a handover only happens when they're genuinely unavailable — but
  "available" means *able to cover as much of the job today as anyone else
  could*, not merely having a few minutes left. Holding a job for someone with
  half an hour spare used to stretch it across days while a colleague with a
  whole free shift sat idle. If one person can't fill the shift, the rest of
  the equipment's shift capacity is topped up from the next-best person rather
  than left idle.
- **Staff assignment is sticky across recomputes.** Every recompute re-derives
  assignments from scratch, so without this the people on a job were free to
  change for no visible reason — most obviously when dragging a job to another
  machine, which makes it pinned, moves it to the front of the placement order,
  and used to cascade a reshuffle through everything else. `runScheduler`
  captures each unit's previous primary person (`primaryStaffOf`) up front and
  feeds it back into `tryFit` as `seedStaffId`. A drag throws the day plan away,
  so `handleDrop` carries the person forward explicitly on
  `assignment.seedStaffId`; don't drop that field.
- **A genuine tie between people is broken by who has least on so far**
  (`staffLoad` in the caps object), never by the order of the staff list.
  List order was the de-facto tie-break and it handed a whole queue of jobs to
  whoever sat at the top of Equipment & Staff while everyone else sat idle.
- **`job.staffId` is a manual staff assignment and a hard restriction.** When
  set, `eligibleStaffIds` narrows the job to that one person: the scheduler
  waits for them rather than handing the work to someone else, and the job
  shows a `UserCheck` marker on the timeline. If they can't take it the job
  lands in "Needs scheduling" with a reason naming them — `whyUnscheduled`
  covers "no longer on staff" and "not signed off on this process". Manually
  assigned jobs place *before* automatic ones in the unpinned phase, since they
  have only one person to draw on. Split jobs carry the lock at job level; it
  applies to every part.
- Pinned jobs are placed **earliest-start-first**, not in array order, so a
  pinned job starting sooner gets first call on the roster.
- **Equipment is exclusively "set up" for one job at a time, for that job's
  entire contiguous span.** Once a job claims a piece of equipment, no other
  job may use it — not even an idle shift or gap day within that span — until
  the first job is finished. Physical cells/robots need fixturing/program
  changeover per job, so it's not realistic to interleave a different job into
  spare hours mid-job just because the capacity math would technically fit.
  This is enforced by `equipDayLock` in `buildCapacityMaps`/`tryFit`/`consume`
  — don't reintroduce shared per-shift hour pools across *unfinished* jobs on
  the same equipment. (A user can still manually drag a job onto an
  already-claimed slot; that's a deliberate `conflict: true` overbooking, not
  scheduler-driven interleaving, and stays visible rather than silently
  vanishing.)
- **The one exception to equipment exclusivity: a job's own *final* day.**
  Once a job's hours are fully satisfied partway through a day (it's
  genuinely done, not paused), whatever's left of that day/shift is free for
  the next job immediately — no need to wait for the next calendar day. This
  is tracked separately via `equipShiftUsed` (hours actually spent) vs.
  `equipDayLock` (full-day exclusivity for days a job hasn't finished on).
  It's what lets a 5-hour job and a 3-hour job share one day cleanly.
- Every job mutation stamps `updatedAt` (used later for delta sync to Business
  Central).

### Schedule view rendering

Each equipment row is a **single lane** — jobs are never stacked into extra
rows. A day column represents one shift's worth of hours (8h); a job's block
width is proportional to the hours it actually has that day/shift, not a
fixed per-day slot, so same-day handoffs (see above) render as adjacent
proportional segments in one lane rather than overlapping or stacking. If a
day genuinely has both shifts in play, the column splits into two halves. See
`buildEquipRowSegments`: it also fills in gap days inside a job's own
still-in-progress span (e.g. an unstaffed weekday) as a full-width
continuation of that job, so its bar doesn't show a hole. `assignment.days`
entries need a `claimOrder` (stamped in `runScheduler`) so segments that share
a day render left-to-right in the order they were actually claimed.

**Layout**: the timeline is full-width; the "Overbooked"/"Needs scheduling"
panels always render in a row *below* it (never a side column), so the grid
never loses horizontal space to a sidebar. Don't reintroduce an `xl:flex-row`
split here — that was the previous layout and is exactly what this replaced.

**Date range**: `WeldingScheduler` holds `rangeStart` (an index into
`workingDays`) and `rangeLength` (days shown at once, from `RANGE_PRESETS` —
1/2 weeks, 1/2 months); `visibleDays = workingDays.slice(rangeStart,
rangeStart + rangeLength)`. Prev/next page by `rangeLength`, clamped to
`[0, workingDays.length]`. This replaced fixed calendar-month paging
(`monthGroups`/`viewMonthIdx`/`monthKey`/`monthLabel`, all removed) — the
grid no longer cares about calendar month boundaries at all, just an
arbitrary contiguous window the user controls, from a detailed few days up to
a couple of months for a broad workload view.

**The timeline includes the past.** `workingDays` starts `HISTORY_DAYS` (90)
*behind* today and runs to the forward `HORIZON_DAYS` horizon; `todayIdx` is
today's index in it, and `rangeStart` opens there. It used to begin at today,
so work dropped off the left edge as its dates passed and there was no way to
look back at what the department actually ran. Past columns are shaded and the
header shows a "Completed work — history only" note plus a **Today** button
whenever today is off screen.

`todayIdx` is also passed to `runScheduler` as `earliestIdx`: **nothing is ever
auto-placed into the past** (a job's `floorIdx` is the later of `earliestIdx`
and its `readyDate`). Pinned jobs are deliberately exempt — a job the user
dropped on a past date is a record of what happened and keeps that slot. If you
add another `runScheduler` call site, pass `todayIdx`; omitting it defaults to
0 and lets the scheduler backfill history.

Note `.bg-slate-950/30` (used for past day cells) needed an explicit entry in
`index.css` — that file remaps only the specific dark-slate utilities the app
uses, so any *new* opacity variant falls through to raw Tailwind dark slate and
renders as a heavy grey block in the light theme. Add a mapping when you reach
for one.

## Assigning staff by hand

A job's people are normally derived by the scheduler and shown, not chosen. The
JobModal's **Assigned to** select (below the ready/due dates, with the other
scheduling constraints) sets `job.staffId`, which overrides that — see the
scheduling invariants above for what the engine does with it. The select lists
staff signed off on the job's process, plus, if the lock points at someone who
no longer qualifies, that person as a visible bad option rather than silently
reverting to automatic. Empty string in the UI, `null` on the job.

### Splitting a job

For when a job has to come off equipment before it's done (an urgent job
pre-empts it) and the remainder needs to be rescheduled separately, possibly
on different equipment or at a different time. From the job's edit modal,
"Split job into two parts" divides `hoursTotal` into two hour amounts; the job
gets `job.parts = [{ id, hoursTotal, percentComplete, status, assignment },
...]` and its own top-level `hoursTotal`/`percentComplete`/`status`/
`assignment` become **derived, not authoritative** — see below.

- A split job is still **one row** in the Backlog and **one entity** everywhere
  outside the scheduler — `id`, name, process, dates, notes, and $ values all
  stay at the job level, unsplit.
- Each part is scheduled as its own independent unit. `runScheduler` flattens
  every split job's parts into separate schedulable pseudo-units up front
  (carrying the parent's process/dates), runs the normal pinned/unpinned
  placement logic on them exactly like regular jobs (no special-casing there),
  then collapses the results back: the parent's `hoursTotal` becomes the sum
  of parts, `percentComplete` an hours-weighted average, `status` is
  `'complete'` only when every part is, and the parent's own `assignment` is
  always `null` (look at `job.parts[i].assignment` instead).
- `ScheduleView` renders each active part as its own block (labelled
  `"<name> (Part N)"`), tied back to the parent job for editing — clicking any
  part opens the parent's `JobModal`, not a separate view. Complete parts
  don't render, same as any complete job.
- **Parts are individually draggable**, exactly like a whole job. Drag
  identity is the part's own `id`; `findDragTarget` in the main component
  resolves a dragged id back to either a whole job or a `{ job, partIndex }`
  pair, and `handleDrop`/the "Needs scheduling" sidebar operate on whichever
  it finds. Dragging a part pins *that part only* — the other part(s) of the
  same job are untouched. A pinned part can be released back to auto-schedule
  via the per-part "Unpin" control in the parts editor (`onUnpinPart`).
- `BacklogView` shows an aggregate "N/M parts scheduled" in place of a single
  equipment name, and hides the one-click "mark complete" toggle for split
  jobs (completion is per-part, via the modal) — same reasoning as hiding
  Unpin for a job with no single assignment.
- "Merge parts back into one job" clears `parts`, folds the aggregate hours/%
  back onto the job, and re-enters normal single-unit scheduling.
- If you change the job shape, keep `mkJob`, the `runScheduler` flatten/
  collapse step, `JobModal`'s save path, and `jobsByEquip` in `ScheduleView`
  in sync — they all assume the same `parts` shape.

## Persistence — IMPORTANT

The app calls `window.storage.get/set/delete/list` (async). That global only
exists inside a Claude artifact; `src/storage.js` provides the same interface
everywhere else, installed by `main.jsx` before mount. **Treat `window.storage`
as the persistence seam** — component code should never touch localStorage or
`fetch` a data endpoint directly.

`src/storage.js` picks one of two backends at startup by probing the server:

- **Shared** — when served by `deploy/serve.py` / `serve.js`, a small key/value
  API lives at `/api`. Everyone on the network reads and writes ONE schedule on
  the host PC. This is the normal deployment.
- **Local** — otherwise (vite dev, a plain static host), this browser's
  localStorage, namespaced `wf::`. Per-browser, no sharing.

**The probe is load-bearing.** Without it, "no API here" and "that key doesn't
exist yet" both look like a failed request, and a shared host would silently
fall back to localStorage — everyone quietly editing their own private copy,
with nothing visibly wrong. It runs once; every method awaits it. Note that a
static host with SPA fallback answers `/api/version` with 200 + HTML, so the
probe requires a numeric `version` field, not just a 2xx.

Anything needing to know the mode must `await storageReady()`, **not** read
`isShared()` — the probe is a real network round trip, so the synchronous flag
reads false until it lands. That exact mistake made live sync silently never
start.

Data keys: `wf_equipment`, `wf_staff`, `wf_templates`, `wf_processes`,
`wf_jobs`, `wf_costcentres`, `wf_procedures`, `wf_actuals`, `wf_wipsettings`
(each a JSON blob).

### Live sync (shared mode)

The server bumps a version counter on every write. `src/liveSync.js` polls
`/api/version` every 4s and calls back when it moves past what we know about;
`WeldingScheduler` responds by **re-reading the data keys into state**
(`reloadFromStore`). It deliberately does **not** save afterwards — a save
would bump the version, which every other screen would see as a change, and
so on around the loop forever.

The update is held back while `busyEditing` (any modal open, or a drag in
progress) and applied as soon as the user is done, so a dialog's in-progress
edits aren't pulled out from under them.

This used to `location.reload()` instead, which re-downloaded the bundle,
flickered shop-floor displays, and lost the active tab — hence a sessionStorage
dance to save and restore tab + scroll position. All of that is gone. Don't
reintroduce a reload here.

## Future: Business Central integration (not built yet)

Jobs carry `bcJobNo` / `bcJobTaskNo`; resources carry `bcResourceNo`; jobs have
`percentComplete` and `updatedAt`. The intended path is a server-side
middleware using Azure AD OAuth2, likely a custom AL API page for the
department-specific fields. NOTE: the app's `percentComplete` is a status field,
NOT Business Central's calculated WIP % (which BC derives from posted
cost/sales entries). Don't conflate them. Nothing here talks to BC yet — these
fields exist so a future sync layer has a clean contract.

## Conventions & guardrails

- Keep it JavaScript + hooks; don't introduce TypeScript, a router, or a state
  library without being asked.
- Tailwind utility classes only (no separate CSS beyond index.css). The theme is
  dark slate with amber accents; match it.
- Don't use browser storage APIs directly in components — go through
  `window.storage` / the storage.js seam.
- Work on a branch and commit checkpoints before large refactors.
- After changes, run `npm run dev` and verify the Schedule, Roster, Backlog and
  Reports tabs still render and that data persists across a refresh.
