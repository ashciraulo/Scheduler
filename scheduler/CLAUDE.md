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
  WeldingScheduler.jsx# the React application (large; ~4300 lines)
  scheduler.js        # the scheduling engine + roster/date model (pure, no JSX)
  wipImport.js        # BC .xlsx reader + keyword/dupe analysis (see below)
  storage.js          # window.storage: shared /api store, else localStorage
  liveSync.js         # polls for other people's changes (shared mode)
  index.css           # Tailwind directives + light company theme
deploy/               # hand-written pieces of the deployable (SOURCE)
  serve.py serve.js   # the little host server + /api key-value store
  start-*.bat/.command# double-click launchers for the host PC
  README.txt          # end-user instructions, ships at the package root
test/                 # node:test unit tests for scheduler.js (npm test)
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
- `npm test` — unit tests for the scheduling engine (`node --test`, no
  framework and no build step)

Browser end-to-end suites live in `../e2e` and run against a preview server —
see `e2e/README.md`. CI (`.github/workflows/ci.yml`) runs the unit tests, the
build, an `offline-package` staleness check, and the e2e suites on every PR.

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
4. **Scheduling engine** — lives in `src/scheduler.js`, not here:
   `buildCapacityMaps`, `tryFit`, `consume`, `runScheduler`, plus the
   roster/date model they run on (`getStaffDayInfo`, `isOnLeave`,
   `generateCalendarDays`, the shift constants). Capacity is tracked per
   equipment/day/shift and per staff/day. `runScheduler` places pinned
   (manually dragged) jobs first, then auto-schedules the rest earliest-due
   first, choosing the machine that finishes each job soonest and keeping one
   person on a job for continuity where possible.

   It was pulled out of this file so it can be unit-tested: it is plain
   JavaScript with no JSX and no imports, so `node --test` loads it directly
   with no build step and no test framework. **Keep it that way** — a React or
   DOM import here would cost the whole arrangement. It is pure in and out:
   plain data to `runScheduler`, plain data back, which is what makes the
   invariants below testable at all. The capacity maps are passed
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
2. **WIP review** (`.xlsx` only) — counts, the keyword chip editors, a
   collapsible column-mapping panel, and Ours / Not matched / Duplicates / All
   row views with search. Keyword hits are highlighted in the description so
   it's obvious *why* a row matched. Only ticked rows go on.

   The editors sit in a **fixed-width left rail that scrolls internally**, and
   the row table has a **fixed** height, not a max-height. Both are deliberate:
   the dialog used to grow and shrink as chips and rows came and went, and
   because it is centred, that moved the whole thing under the pointer
   mid-edit. Don't restore auto-sizing here.

   There are three keyword lists: include, exclude, and **combination rules**
   (`settings.combos`) — two or more whole words that must all appear, for the
   "include *body*, include *elbow*, but not a row that is both" case. A fired
   rule excludes the row into "Not matched", where it stays visible and
   tickable. The engine always had these; the editor did not exist until
   recently, so `DEFAULT_COMBOS` is empty and any rules are the user's own.

   Changing a keyword or mapping re-analyses and recomputes the default tick
   set, then **re-applies the user's own ticks and unticks on top**
   (`tickOverrides`). Rows the user has never touched still follow the current
   keywords — that's an exclude keyword doing its job — but a decision made by
   hand is never undone. This deliberately departs from the standalone tool,
   which reset every tick; that was not a behaviour worth preserving, just one
   nobody had noticed, and it threw away a long review the moment another
   keyword was added. Don't "restore" it. Overrides are keyed by record id — a
   row index into the parsed sheet — so they are cleared whenever a different
   file is loaded.
3. **Set hours** — the same review table both sources land on: assign a
   Template per row (or bulk-apply one to all ticked rows without one), which
   fills `process` and `hoursTotal` from `hoursPerUnit`/
   `departmentValuePerUnit` × quantity. Neither source carries shop-floor
   hours (BC's WIP has none), so both arrive with `process: ''` and
   `hoursTotal: 0`.

   Row names are editable here, and a row can be **split into independent
   jobs** (`splitRow`) for a BC line covering several components, or stages
   scheduled separately. This is not the job-level `parts` split: parts share
   one name and one backlog row, which is the opposite of what's wanted when
   the pieces are different components. Quantity, hours and both $ figures
   divide across the pieces so the totals still match what BC exported, and
   every piece keeps the same BC job/task number. Pieces are numbered past the
   highest suffix in the group, not by group size, so splitting an already-split
   row can't reissue a number.

Rows are matched against existing jobs by `bcJobNo` + `bcJobTaskNo` and
flagged/unticked (not hidden) as probable duplicates, so re-importing the same
export doesn't create copies unless the user deliberately re-ticks them.
Imported jobs get fresh `id`s and go through the normal `recompute`/scheduler
pass like any other job.

### The parked list

Rows an import left behind are kept under `wf_wipparked` so a job whose scope
later grows into our work can be pulled in without re-running the whole import
for it. The Backlog shows a "Parked N" button when the list is non-empty;
opening it reuses `ImportJobsModal` via its `initialRows` prop, landing
straight on the review table — same template assignment, same splitting, same
`+proc`, so there is only one review flow to maintain. Nothing is ticked by
default there (the point is to find the one job that changed), and a row that
gets imported is dropped from the list via the `parkId` carried through as
`_parkId`.

The list is **replaced wholesale by each import**, so it always describes the
most recent export rather than accumulating rows that no longer exist in BC.
It is written on import commit, and only for the `.xlsx` path — a `.json`
export carries no notion of "unmatched", and a parked-list session has no
analysis of its own.

### What is and isn't persisted

The keyword lists (`wf_wipsettings`) and the parked list (`wf_wipparked`)
persist. **The spreadsheet itself never does** — the parsed rows, the analysis
records and every unmapped column live in component state and are gone when
the modal closes. Keep that property.

The parked list is the one deliberate exception, and a narrow one: it stores
exactly the job-shaped record an imported row becomes (what `buildSchedulerJobs`
emits, plus a `parkId`) — the same fields a matched row contributes, nothing
more. Don't widen it to the raw rows. In shared mode this lands in
`scheduler-data.json` on the host PC, readable by everyone on the network, so
the difference between "the fields we'd import anyway" and "the whole
commercially sensitive export" is the whole point.

`buildSchedulerJobs` is the job-shape contract: if the job shape changes,
update it too, and check `toReviewRows` in the modal still reads old `.json`
exports sensibly.

### Scheduling invariants (don't break these)

- A job never schedules before its `readyDate`.
- Unpinned jobs are placed earliest-due first. On an **equal** due date, a job
  flagged `needsFurtherProcessing` goes first — it still faces machining or
  manual work after this department, so the same due date leaves it strictly
  less slack than one that ships straight from here. `BacklogView` sorts the
  same way so the list reads in the order work is taken up.
- Pinned jobs keep the slot the user dropped them on; only unpinned jobs are
  auto-placed. A pin that **can't be honoured** — before the job's ready date,
  onto equipment that no longer exists, or with nobody signed off on the
  process — keeps its slot and is flagged `conflict: true` rather than moved
  or silently dropped.
- **A pin onto an occupied day is not a conflict — the incumbent slides.**
  Dropping a job where another one already sits is the user saying this job
  matters more than what is there, so the newly dropped job takes the slot and
  the job already there is rescheduled forward (still pinned, `conflict:
  false`). Refusing the drop, or flagging it, would be arguing with a decision
  the user just made.
  The most recent drop wins because `claimOrder` is stamped on every
  assignment at the end of each run, so a pin *without* one is a drop the
  scheduler hasn't seen yet and sorts first. The default for a missing
  `claimOrder` must stay **-1, not 0**: 0 is a real value (the first job placed
  last run), and `?? 0` made a fresh drop tie with it, handing the day to
  whichever came first in the jobs array — arbitrary, and wrong half the time.
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

### Template categories

Categories are a managed list (`wf_categories`), not free text typed per
template: the template modal offers a drop-down. On first load the list is
**seeded from whatever categories the existing templates already use**, so
nothing an existing user set up disappears. Removing a category cascades — the
templates using it move to Uncategorised — exactly like `saveProcesses`, and
for the same reason: a value the drop-down can no longer offer is a value with
no way back out. A template whose stored category has since been removed keeps
it selectable while its modal is open, so merely opening an old template can't
silently reassign it.

### Capability requirements follow the template

`applyTemplate` copies a template's `tags` onto a job when the template is
picked, and the job never consulted the template again — so editing a
template's capability requirements left every existing job on the old set.
`saveTemplate` now pushes changed tags onto the open jobs made from that
template.

A job whose tags have since been **edited by hand keeps them**: a manual
decision is the more specific instruction here, the same principle as pinning,
a hand-assigned person, or a WIP tick override. The toast reports both counts,
so a customised job that ought to follow the template can be fixed
deliberately instead of being silently overwritten. Only tags propagate —
pushing `hoursPerUnit` or `process` retroactively would rewrite jobs already
being worked to a plan.

### Roster availability

A roster day is `{ working, production, shift, hours }`. `production: false`
means **rostered on but not available for scheduled production work** —
training, covering the office, on the tools elsewhere. `getStaffDayInfo`
treats it exactly like a day off, so the scheduler never places work there;
the difference is that the roster still shows the person is in. It exists
because the only ways to express this before were booking leave or zeroing
someone's hours, both of which say something untrue. The flag post-dates the
roster, so `normalizeStaff` defaults it to `true` when absent — absent has to
mean available, or every roster saved before this would read as non-production.

Absence periods (still `leavePeriods`, for back-compat) carry a `kind` from
`ABSENCE_KINDS` — leave / sick / training / other duties. All of them make
someone unavailable; the kind is for the record, so a course doesn't have to
be booked as annual leave. `normalizeStaff` defaults `kind` to `'leave'`.

### The daily hours log

`wf_timelog` holds one row per job per day: `{ id, jobId, date, hours,
staffId, note }`. Reconstructing a total weeks later at completion time is
guesswork; this is entered while it's still fresh, and `ActualHoursModal`
then **pre-fills from the logged total** instead of asking (falling back to a
stored actual, then the estimate). The Backlog shows the running logged total
against the estimate, amber-coloured once it exceeds it, so drift is visible
before completion.

`TimeLogModal` opens on a date and lists the jobs the schedule expected that
day, so the common case is confirming numbers rather than hunting for jobs;
any other active job can be added for when reality differed from the plan.
Saving **replaces every entry for that date** with what the dialog showed, so
clearing a row to blank removes its entry rather than leaving a stale one.
Entries are keyed by `jobId`, not by assignment, so a day's work stays
attached to the right job when the plan it was entered against later moves.
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
gets `job.parts = [{ id, name, hoursTotal, percentComplete, status,
assignment }, ...]` and its own top-level `hoursTotal`/`percentComplete`/
`status`/`assignment` become **derived, not authoritative** — see below.

- A split job is still **one row** in the Backlog and **one entity** everywhere
  outside the scheduler — `id`, process, dates, notes, and $ values all stay at
  the job level, unsplit.
- **Each part has its own `name`**, independent of the parent's and of the
  other part(s) (#18) — pre-filled as `"<job name> (Part N)"` when the split is
  made, but a real, independently editable field from then on, not a label
  recomputed at render time. A part saved before this field existed has no
  `name`; every render site that shows one falls back to the same computed
  `"<name> (Part N)"` label in that case, so old data still reads sensibly.
  **`name` must survive `runScheduler`'s flatten/collapse round trip** or the
  very next recompute — which happens on nearly every action, not just a
  drag — would silently overwrite whatever the user just typed. Collapse
  writes back the *original* `parent.parts[i].name` (possibly `undefined`),
  never the flattened unit's computed fallback — round-tripping the fallback
  would permanently bake the bare parent name onto every legacy part on its
  first recompute, erasing the "(Part 1)"/"(Part 2)" distinction the UI
  depends on `name` being absent to derive. See
  `'a custom part name survives repeated recomputes'` in
  `test/scheduler.test.js`.
- Each part is scheduled as its own independent unit. `runScheduler` flattens
  every split job's parts into separate schedulable pseudo-units up front
  (carrying the parent's process, dates, `tags` and `needsFurtherProcessing` —
  they describe the work, so they apply to every part of it; omitting `tags`
  meant `tagOk` saw no requirements and let a part onto any machine), runs the
  normal pinned/unpinned
  placement logic on them exactly like regular jobs (no special-casing there),
  then collapses the results back: the parent's `hoursTotal` becomes the sum
  of parts, `percentComplete` an hours-weighted average, `status` is
  `'complete'` only when every part is, and the parent's own `assignment` is
  always `null` (look at `job.parts[i].assignment` instead).
- `ScheduleView` renders each active part as its own block, labelled with
  `part.name` (falling back to `"<job name> (Part N)"` for a part with none),
  tied back to the parent job for editing — clicking any part opens the
  parent's `JobModal`, not a separate view. Complete parts don't render, same
  as any complete job.
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
`wf_jobs`, `wf_costcentres`, `wf_procedures`, `wf_actuals`, `wf_wipsettings`,
`wf_wipparked`, `wf_categories`, `wf_timelog` (each a JSON blob).

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
- The shared `Modal` closes on a backdrop click only when the gesture both
  **started and ended** on the backdrop. A plain `onClick={onClose}` there is
  wrong: `click` fires on the nearest common ancestor of mousedown and mouseup,
  so selecting text inside a dialog and releasing outside it discarded the
  edit. Don't simplify it back.
- **A genuine backdrop click or the header ✕ asks before discarding a
  changed modal** (#19). `Modal` tracks a `dirtyRef`, set by a blanket
  `onChange` on the content wrapper (catches typing, checkboxes, selects and
  range sliders in every modal for free, via ordinary DOM bubbling from
  whatever native input a modal's content renders — no per-modal wiring) plus
  `DirtyContext`, which `MultiCheck` and the chip editors (`TagEditor`,
  `KeywordChips`, `ComboChips`) call explicitly for the interactions native
  bubbling can't see: their state changes on a `<button onClick>`, not a
  native form control, so toggling a `MultiCheck` option or removing a chip
  fires no DOM change event on its own.
  `requestClose()` closes immediately if nothing changed; otherwise it shows
  an in-modal "Discard unsaved changes?" prompt (Keep editing / Discard
  changes) instead of calling `onClose`. **Deliberately not wired onto the
  explicit "Cancel" button every modal's content provides** — clicking Cancel
  is already the unambiguous choice to discard, not an accidental dismissal,
  and gating it too would put a confirmation in front of a decision the user
  already made on purpose. `JobModal` has no Cancel button at all (only ✕ and
  backdrop), so this is its only protection.
  Known imprecision, accepted rather than engineered around: a modal whose
  fields only ever *filter* rather than *enter* data — `ImportJobsModal`'s
  row search box, its keyword editors (already persisted the instant a
  keyword is added, independent of the modal's own lifecycle) — still flags
  dirty on typing, since the tracking can't distinguish "this native input's
  value is form data" from "this native input's value is a live filter" at
  the `Modal` level. Worst case is one spurious "Discard changes?" click on a
  search box that had nothing to lose; not worth per-field opt-outs for.
- `Modal` takes a `size` prop (`'md'` default, `'lg'` = the old `wide` boolean,
  `'xl'` for a dense multi-column table like the WIP import) via the
  `MODAL_WIDTH` map. When a table inside a modal still looks cramped after
  bumping the dialog's own width, check whether that's the real cause first:
  `table-auto` doesn't stretch a column to fill left-over space on its own —
  give the one free-text column (`Description`, a name field, …) `w-full` on
  its `<th>` so it absorbs whatever the fixed-width columns don't need, and
  pair it with `truncate w-0 min-w-full` on the cell's inner div (needs a
  bounded width to actually clip against; a bare `max-w-[Npx]` cap just moves
  the wasted space inside the column instead of removing it).
- The three chip/tag input widgets (`TagEditor`, `KeywordChips`, `ComboChips`)
  commit on blur, not just on Enter/Add. Typing a value and clicking straight
  to Save — a completely natural thing to do — used to discard it silently:
  no error, nothing in the saved record, which is exactly what "this doesn't
  do anything" looks like from the outside (#9). `onBlur={() => { if
  (input.trim()) add(); }}` on the text input fixes all three; keep that
  guard (not a bare `onBlur={add}`) so blurring an empty field doesn't fire a
  no-op `onChange` on every unrelated click around the form.
- Deleting a process (Templates page) cascades: `saveProcesses` strips it from
  every piece of equipment and every staff member. Templates and jobs keep
  their process string on purpose — it records what the work is, and blanking
  it would silently unschedule them — so the toast names how many still refer
  to it. `MultiCheck`'s opt-in `showOrphans` renders a selected value that is
  no longer an option so it can still be unticked, which is how data saved
  before the cascade existed gets repaired. Leave it off where options are
  filtered dynamically (TemplateModal's equipment list narrows by process, and
  an id outside that list is ordinary filtering, not stale data).
- Work on a branch and commit checkpoints before large refactors.
- After changes, run `npm run dev` and verify the Schedule, Roster, Backlog and
  Reports tabs still render and that data persists across a refresh.
