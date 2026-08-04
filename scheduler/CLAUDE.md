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
  placementScore.js   # weighted candidate scoring (OPT-IN; see its own section)
  overrides.js        # records where the user overruled the scheduler (record only)
  liveSync.js         # polls for other people's changes (shared mode)
  index.css           # Tailwind directives + light company theme
deploy/               # hand-written pieces of the deployable (SOURCE)
  serve.py serve.js   # the little host server + /api key-value store
  start-*.bat/.command# double-click launchers for the host PC
  README.txt          # end-user instructions, ships at the package root
test/                 # node:test unit tests for scheduler.js (npm test)
scripts/package.mjs   # assembles ../offline-package from dist/ + deploy/
scripts/compare-scoring.mjs # read-only diff of the two placement paths
scripts/show-overrides.mjs  # read-only dump of the captured override history
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
- `npm run compare-scoring [data.json]` — read-only side-by-side of the
  current placement path against the opt-in weighted-scoring one (see
  "Weighted placement scoring" below). Writes nothing.

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
   JavaScript with no JSX, so `node --test` loads it directly with no build
   step and no test framework. Its **one** import is `./placementScore.js`,
   which is plain ESM under the same rule. **Keep it that way** — a React or
   DOM import into either file is what would cost the whole arrangement; a
   pure sibling module is fine. It is pure in and out:
   plain data to `runScheduler`, plain data back, which is what makes the
   invariants below testable at all. The capacity maps are passed
   around as one `caps` object (`equipDayLock`, `equipShiftUsed`,
   `staffDayRemain`, `staffDayShift`, `staffLoad`) rather than five positional
   arguments.

   `src/placementScore.js` holds the **opt-in** weighted alternative to the
   best-candidate sort comparator — see "Weighted placement scoring" below.
   The app does not use it; `runScheduler`'s behaviour with five arguments is
   unchanged.
5. **Storage helpers** — `loadKey` / `saveKey` wrap `window.storage`.
6. **UI primitives** — small styled building blocks (Field, Modal, `Section`,
   MultiCheck, buttons).
7. **Main component** `WeldingScheduler` — top-level state, load/recompute/save,
   all the CRUD handlers, the header, and tab routing.
8. **Views** — ScheduleView (the gantt/drag-drop grid), BacklogView, StaffView
   (staff identity, capabilities and weekly roster/leave — merged from the
   former separate "Roster" and "Equipment & Staff" tabs, #20), TemplatesView,
   CostingView (also carries an Equipment section, since equipment ended up
   without a tab of its own once StaffView absorbed the rest of the old
   "Equipment & Staff" tab — it has no data-model link to cost centres or
   procedures, so the placement is purely a home for it, not a data
   relationship), ReportsView.
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

- A job never schedules before its `readyDate` — and a job with **no**
  `readyDate` at all doesn't schedule, full stop (#59). It used to default to
  today (in the Job modal, in the WIP-import review table, and anywhere else
  a job got created), which meant a job nobody had actually confirmed was
  ready got auto-scheduled anyway, and "ready" quietly stopped meaning
  anything. `readyDate` is now blank until a real date is entered — the Job
  modal starts blank, WIP import review defaults every row's `Ready` column
  to blank and won't let it through without a nudge (an amber warning banner,
  same pattern as the existing missing-hours one), and `whyUnscheduled`
  reports "no ready-for-processing date set yet" as its own reason rather
  than falling through to a generic capacity message. This applies to
  auto-placement, dragging a job onto the Schedule view, and the Job modal's
  manual Equipment+Planned-start-date pin — all three routes require a real
  date before they'll place anything. Editing an existing job never
  auto-fills this from today either — leave it blank and the job is exactly
  as unscheduled as it always was, which is the whole point. `fmtDate` shows
  `—` for a blank date rather than `Invalid Date`, so the Backlog table and
  anywhere else that renders it reads cleanly with nothing set. A batch
  (`batchId` — see "Batches" below) is only as ready as its least-ready
  member: if even one member has no ready date set, the *whole group's*
  computed `readyDate` is blank too, not silently the other members' real
  dates — the reduce that finds the *latest* member date has to treat "no
  date" as "unknown", not as the earliest possible value, or it'd get
  silently outvoted.
- Unpinned jobs are placed earliest-due first, using `effectiveDueDate(job)`
  (`job.departmentDueDate || job.dueDate`), not `job.dueDate` directly — see
  "Department due date" below. On an **equal** effective due date, a job
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
- **A shift's equipment capacity scales to whoever's actually rostered onto
  it, never truncates them at `SHIFT_DEFS[shift].defaultHours` (8h) — but only
  for a SINGLE person covering the block alone (#32, #45, #57).** The constant
  used to be a hard ceiling on `equipShiftUsed`, so someone rostered a 12h day
  shift got cut off at 8h on the job they were doing and the scheduler handed
  the rest of their day to an unrelated job on different equipment —
  nonsensical, since they were still working the same 12-hour day either way
  (#32). The next fix let `shiftCapacity` grow to `Math.max(defaultHours,
  ...rostered hours of everyone eligible on that shift that day)` — but that
  was a **pool-wide** max, so a completely different, ordinarily-rostered 8h
  person elsewhere in the pool (e.g. busy on another job) was enough to
  inflate the whole block to 12h, and the fill loop would then happily stitch
  that 12h together from *two different* 8h people (8h + 4h) as if one had
  handed off to the other mid-shift. They hadn't — two people each rostered a
  normal shift are present at the same clock hours as each other, not in
  relay, so that never represented anything physically real (#45).
  That #45 fix computed a `personalCap(sid)` per candidate — what *that
  person alone* could offer — and let the block's capacity (`shiftLeft`)
  stretch to whichever candidate got placed first, with anyone joining
  afterwards bounded by whatever was left of *that already-expanded* number.
  Still not right: if the first person placed was individually rostered 12h
  but only had, say, 10 of those left free that day (busy elsewhere for the
  other 2), the block's capacity had already been stretched to 12 for
  everyone, so a second, ordinarily-rostered person could still pick up the
  2h gap — 10h + 2h = 12h logged by two different people on one job in one
  day, still not physically possible: an 8-hour shift covers the *first* 8
  hours of the day, not whichever 8 (or 2) are left over once someone else's
  longer day has run (#57, reported from the shop floor as "a person works 4h
  then a second works 8h on the same job/day").
  The real fix is that a shift block's capacity is two separate pools, not
  one: `sharedLeft`, up to `defaultHours`, that **any** candidate on that
  shift can draw on (the model doesn't track literal per-person clock
  start/end times finely enough to say which of several same-length people is
  in the chair at a given hour, so the combined total across all ordinarily-
  rostered people is capped at one ordinary shift's length) — and
  `extensionLeft`, hours past `defaultHours` that exist because *some*
  candidate here is individually rostered that long. A first pass at this fix
  tied access to `extensionLeft` to the specific candidate the fill loop
  happened to place first — but that's wrong in the opposite direction: if an
  ordinarily-rostered 8h person's `contribution()` that day happened to
  outrank a genuinely longer-rostered 12h person's (e.g. the 12h person was
  partway through covering a different job that morning), the 8h person got
  placed first and the 12h person, landing second, lost access to their own
  legitimately-available overtime hours entirely — even though nothing
  stops them physically covering the back end of the day themselves,
  regardless of who filled the front end. Extension eligibility is a
  property of the *person's own roster*, not of fill order: `extensionLeft`
  is now sized once, from whoever across the **whole pool** is individually
  rostered longest — `Math.max(0, ...pool.map(myExtension))` — and each
  candidate, however far down the fill order they land, can draw on it up to
  *their own* `myExtension(sid)` ceiling (`personalCap(sid) - defaultHours`).
  An ordinarily-rostered person's ceiling there is always 0, so they still
  can never draw on it no matter who else's longer roster opened the pool up
  — that half of the invariant is unchanged. Ranking (which candidate goes
  first) still uses each candidate's `personalCap` — `Math.max(defaultHours,
  their own rostered hours that shift)` — so a genuinely available
  long-rostered person is still preferred over a same-tied ordinary one; that
  ranking now only decides who fills the shared portion first, not who's
  allowed to touch overtime at all. See `test/scheduler.test.js`, describe
  block "shift handovers stay physically plausible (#57)" — "a long-rostered
  person's own extra hours can't be topped up..." for the original
  physical-implausibility regression, "a longer-rostered person still gets
  their own overtime hours even when...fills the shared shift first" for the
  fill-order regression this second pass fixes, "two ordinarily-rostered
  people... (#45)" for the case it further tightens, and "someone rostered
  longer... works all of it" for the original, still-preserved #32 case. A
  person's own `staffDayRemain` is what actually stops them being
  double-counted across jobs — none of this touches that; it only bounds the
  *equipment*-side ceiling correctly.
- **The shared portion of a shift isn't always 8h — it's whatever's
  actually ordinary for that day (#59).** `defaultCap` (what bounds
  `sharedLeft`, above) used to be a flat `SHIFT_DEFS[shift].defaultHours`
  regardless of the day of week. That's fine on an ordinary weekday, but this
  department runs a shortened 6h Saturday — and a flat 8h ceiling meant two
  people each genuinely rostered only 6 hours that Saturday could still
  combine for up to 8 between them, the same physically-impossible
  over-combination the #57 work above fixed for weekdays, just caused by the
  shared *ceiling* itself being wrong for the day rather than by a leftover
  personal extension being reachable by the wrong person. `defaultCap` is now
  computed per shift-block from the pool of candidates actually rostered onto
  it that day — a plain mode (the most common `staffDayHours` value among
  them, smaller value winning a tie) — rather than assumed. On an ordinary
  weekday, where everyone eligible is rostered the flat 8h anyway, this
  reproduces the old constant exactly; on a shortened day it correctly comes
  out lower. Anyone individually rostered *longer* than that day's mode still
  gets their own genuine `myExtension`, same as ever — this only changes what
  counts as the shared baseline everyone else is compared against, not the
  extension mechanism itself. See `test/scheduler.test.js`, "two people
  ordinarily rostered a SHORTENED day... can't combine for more than that
  day's real window (#59)".
- **A person doesn't get handed a sub-4-hour sliver of a shift just to keep
  it fully booked (`MIN_HANDOVER_HOURS`, #57).** Once the first person on a
  shift block runs out of hours (their own roster, not the block's), whatever
  capacity is left in `sharedLeft` used to go to the next-best candidate
  regardless of size — including a leftover 1 or 2 hours. On the shop floor
  that showed up as staff being switched onto a job for the literal last two
  hours of someone else's 12-hour day, purely to use up nominal capacity that
  would have been just as well left idle. It's fine for a job to end a day
  with less than the nominal shift's worth of hours logged against it. A
  second-or-later candidate is now skipped — leaving that leftover shared
  capacity genuinely unused for the day — whenever their contribution would
  come in under `MIN_HANDOVER_HOURS` (4h) **and** neither of two conditions
  makes the short stint the honest answer rather than a workaround:
  the person's own `staffDayRemain` is itself under 4h (their day is
  naturally almost over — finishing a job with 2h left in a shift and
  spending those 2h starting the next one isn't a sliver being manufactured,
  it's literally all the time they have), or the job's own remaining need is
  itself under 4h (there's nothing bigger to offer them regardless of how
  much shared capacity is sitting there). Both exceptions came directly from
  how the department already handles this in practice. See
  `test/scheduler.test.js`, same "(#57)" describe block, for the base rule
  and both exceptions.
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
  **Overriding a busy person (#46)**: this only wins against another
  *unpinned* job automatically (placement order already favours it) — a
  **pinned** job holding that person is a standing claim `runScheduler`
  settles before the manual job gets a turn at all (pinned jobs place first,
  full stop), so it just lands unscheduled instead. `findManualAssignBlockers`
  (`WeldingScheduler.jsx`) is called right after a save that leaves a
  staff-locked job with no assignment: it looks for pinned jobs (or pinned
  parts) using that same person on or after the job's `readyDate` and, if it
  finds any, opens a dialog naming them with an "Unpin so it can move
  elsewhere" action per blocker. Unpinning doesn't hand the person over
  directly — manual assignments already place first among unpinned jobs, so
  the freed job is simply back in the pool to find another slot, operator, or
  day on the next recompute, which the dialog re-checks (in case more than
  one blocker was in the way). This is the staff-level equivalent of "a pin
  onto an occupied day is not a conflict — the incumbent slides" above, except
  surfaced as a choice rather than automatic, since unpinning is a bigger deal
  than reordering same-day claims and the user should see what's being moved.
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
- **Completing a job doesn't change the schedule, unless it finished in less
  time than estimated (#49).** A completed job is history — `runScheduler`
  used to simply drop it from the capacity maps altogether (`complete` jobs
  never went through `tryFit`/`consume`), which silently freed its
  equipment/staff claim for anything still-active to slide into, including
  rewriting a day that had already happened. It's now replayed into the
  capacity maps up front, before any active job is placed, using its own
  already-fixed `assignment.days` — nothing about a completed job's slot is
  actually up for grabs, so there's no placement search to redo, just the
  bookkeeping to reapply. The one thing allowed to give any of it back:
  finishing with `actualHours` (captured at completion time, via
  `ActualHoursModal`) less than the original `hoursTotal` estimate — only
  then is the replayed plan trimmed to that many hours, cumulative from the
  start, so the trailing time actually saved becomes free for other work, the
  same "final day" release an ordinary in-progress job already gets once its
  own hours are satisfied. Taking *longer* than estimated is not a reason to
  free anything — the job still occupied the slot for as long as it did.
- Every job mutation stamps `updatedAt` (used later for delta sync to Business
  Central).

### Department due date vs. client due date (#44)

`job.dueDate` is when the job is due to the client, or an end-of-month
target — it isn't necessarily when *this* department has to be finished with
it. A job with further scope after us (machining, assembly, a second process)
already had `needsFurtherProcessing` as a same-due-date tie-break, but that's
a boolean, not a date: it only helped when two jobs happened to share a due
date. `job.departmentDueDate` (optional, nullable) is the actual, different
date this department is really working to — the client date minus however
long the downstream work needs. `effectiveDueDate(job)` in `scheduler.js`
(`job.departmentDueDate || job.dueDate`) is what every date comparison the
engine makes actually uses — the unpinned placement sort, and `BacklogView`'s
matching sort — so setting it genuinely reprioritises the job rather than
just annotating it. `needsFurtherProcessing` still exists and still matters
independently: it's the coarse "sometime, all else equal" signal for jobs
that haven't been given a specific internal date. `JobModal` shows the field
under "Due date" in the Scheduling section, and `BacklogView`'s Due column
shows the effective date in amber (with the client date in a tooltip) when
the two differ, so it's visible at a glance which jobs are running to an
earlier, internal deadline. Split-job parts inherit it from the parent (same
as `dueDate`) since it describes the job, not a specific part.

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

**A job's lane only shows on a page whose window actually overlaps where it
was scheduled (#63).** `jobsByEquip` groups every job with an assignment by
equipment, with no date filtering — that grouping is cached across range
navigation. The per-equipment render loop then filters it down to `(j) =>
j.assignment.startDate <= d1 && j.assignment.endDate >= d0` (`d0`/`d1` being
the current page's `visibleDays` bounds), the same overlap test `totalHrs`
already used per-day, just applied to whether the row appears at all. This
used to be "completed jobs stay on the timeline forever, only a job with no
assignment at all is dropped" — meaning a completed job kept its own
permanent lane on every equipment, on every page, for as long as the
department's history went back, regardless of how long ago it actually
wrapped up. Paging back through the "Completed work — history only" pages
(see below `rangeStart`) still finds it — the moment the visible window
overlaps its own scheduled span again, its row reappears — but it's not
bloating the current view once history has moved past it. This applies
uniformly to active jobs too, not just completed ones: a job scheduled two
months out doesn't show up on today's page either, same as it never showed
on last week's — paging forward to when it's actually due finds it, exactly
like any other job. `equipJobs`/`lanes`/`totalHrs` are all computed inside
the `equipment.map()` render loop (not the `jobsByEquip` memo) specifically
so this filter has `visibleDays` in scope without widening that memo's own
dependency array on every range navigation.

**Scroll/zoom (#26, #27)**: the day header row and the job-description
column both need to stay on screen while scrolling the grid — a spreadsheet
frozen row/column. That requires a single element that actually scrolls in
both axes for `position: sticky` to stick *within*: the previous layout put
horizontal scroll on one `overflow-x-auto` div with an unbounded-height inner
content div, which per the CSS overflow spec quietly makes that div a
scrolling container in the *vertical* axis too (an explicit `overflow-x`
forces the other axis off `visible`) — except it never actually scrolls
vertically (nothing constrains its height), so it silently swallows any
`sticky top` positioning without ever visibly doing anything, and the page
itself scrolls instead. Fixed by giving the grid one `overflow-auto` wrapper
with an explicit `maxHeight` (`65vh`/`80vh` in display mode) so both axes
scroll together inside it, then `sticky top-0` on the day header row, `sticky
left-0` on the corner cell and on every job-name cell (each needs its own
*opaque* background — `bg-slate-900` — since day columns keep scrolling
underneath a sticky cell horizontally, and without a solid background they'd
show through). The per-equipment name label was already using this
`sticky left-0` trick (no top-stickiness needed there — that row scrolls away
vertically on purpose, only its horizontal position is pinned within its own
row).

Zoom (`colWidth`/`laneH` scaled by a `zoom` state, 60%–160% in 20% steps, via
+/− buttons next to the range-length picker) exists specifically so a
fully-booked machine's stacked jobs don't push the next piece of equipment
off-screen — without it, dragging a job between two machines can require
scrolling one of them out of view first. `zoom` lives in the main
`WeldingScheduler` component and is passed down as a prop, same as
`rangeStart`/`rangeLength` (#50) — it used to be local state inside
`ScheduleView` itself, which unmounts on every tab switch, so it silently
reset back to 100% each time you came back to the Schedule tab. Still not
saved to storage across a reload; a viewing preference for the session, not
schedule data.

**Job-name column width (#35)**: `JOB_COL_WIDTH` (320px, up from the original
240) is a single constant reused everywhere the column's width has to agree
with itself — the grid's `minWidth`, the day-header corner cell, the empty-lane
cell, and the job-name cell itself. 240px cut most job names off mid-word: job
number, staff-colour dots and hours all share this column with the name, so it
needed real room, not just enough space for a couple of characters before the
ellipsis. It's also a second drag handle for reassigning the job, alongside
the coloured timeline bar (#51) — `draggable`/`onDragStart`/`onDragEnd` are
wired identically to the bar's, so dropping onto an equipment/day cell works
the same way regardless of which one you grabbed. This exists because the
bar can be a sliver too thin to grab reliably for a short job (a 1-2h stint
at normal zoom), while the name cell is always the full row height and
`JOB_COL_WIDTH` wide — a much easier target for the exact same drag, not a
different interaction.

**The name cell is also a drop *target*, not just a source (#55).** The
stack of job names under one piece of equipment behaves like a reorderable
list: dropping a dragged job's name onto another job's name row calls the
exact same `onDrop(equipId, date)` a timeline-cell drop already calls,
just with the target derived from the row you dropped onto (its own
`assignment.equipmentId`/`assignment.startDate`) instead of a specific day
cell. That's the whole feature — no new placement logic. It inherits "the
most recent drop wins, the incumbent slides" for free (see the pin-onto-an-
occupied-day invariant above): the dragged job takes the target row's exact
slot, and the target (plus whatever was pinned after it) cascades forward
through the normal recompute, which is what actually produces the reorder.
Dropping onto a row in a *different* piece of equipment's list works too —
same validation (process/tags/ready date) `handleDrop` already does for any
other drop — so this single interaction covers both "reorder within this
equipment's queue" and "move to a different one," without needing to special-
case which. A drop hint (`bg-amber-500/20`, the same colour the day cells
already use for their own hint) tints the target row while dragging over
it, driven by the same `dropHint` state a timeline-cell hover sets — so
hovering a name row also highlights the exact day cell it'll land on.

Don't add a border-based hint here instead — `border-r border-slate-800` on
this cell sets the `border-color` shorthand (all four sides) with
`!important` in index.css's light-theme remap, which silently wins over any
`border-t-*` colour utility added alongside it regardless of source order or
specificity; a background tint doesn't share that property and is what the
day cells already use anyway.

**Per-staff timeline colour (#40)**: `STAFF_PALETTE` (10 hex colours) used to
be the *only* source of a staff member's colour, picked by their index in the
staff list — stable in practice, but not something anyone could choose or
change without reordering staff. `StaffModal` now has a "Timeline colour" field
(a swatch per palette entry, plus "Automatic") writing an explicit,
nullable `staff.color`. `ScheduleView`'s `staffColor` lookup prefers it and
only falls back to the palette-by-index when it's unset — `normalizeStaff`
already spread unknown fields through, so no migration was needed for
existing records.

### Blocking a piece of equipment out for a day (#53)

`equipment.unavailableDates` already existed and was already fully respected
by the engine — `buildCapacityMaps` sets `equipDayLock[e.id][day] = 'closed'`
for a date in the list, and `tryFit` refuses to place *anything* (pinned or
unpinned) on a closed day — but there was no UI to actually reach it, only a
read-only count in `EquipmentModal` ("N day(s) marked unavailable"). Without
it, dragging a job off a day left nothing stopping the very next recompute
from handing that day straight back to whichever unpinned job was next in
line — there was no way to say "leave this genuinely empty."

Each equipment's header row on the Schedule view now carries one small toggle
button per visible day (a `CalendarOff` icon, day-columned and aligned with
the day cells below it, sitting in the same sticky-left/day-column flex
layout as a job lane), right there alongside the equipment name and total
hours — clicking one adds or removes that date from `unavailableDates` via
`toggleEquipDay`, which just calls the existing `saveEquipment` and lets the
normal recompute handle the rest:
- An unpinned job that was sitting on the day gets auto-placed somewhere else
  entirely, same as any other capacity change.
- A pinned job whose day becomes blocked doesn't move or disappear — it's
  flagged `conflict: true` and stays visible where the user left it, the same
  treatment every other unplaceable pin gets (see "a pin onto an occupied day
  is not a conflict" above; this is the opposite case, a pin that's now
  genuinely lost its slot).
- `handleDrop` rejects a drop onto a blocked day outright, with a toast, the
  same way it already rejects a process mismatch or a missing capability
  tag — don't let a blocked day silently become a `conflict: true` pin when
  it can be caught before the pin is even made.

Blocked days render with a `bg-red-950/40` tint (already mapped in
`index.css` — don't reach for a fresh, unmapped opacity variant here, see the
`Section`/`bg-slate-900/40` note above) across the header cell, the lane
day-cells, and the "No jobs scheduled" empty-lane row, so a blocked day reads
the same regardless of which row you're looking at. The toggle buttons
themselves are hidden for past days and in read-only mode — there's nothing
to block once a day has already happened, and a viewer shouldn't be able to
change what the schedule will do.

### A job's equipment and start date are editable in its own modal (#28)

`JobModal` shows an "Equipment" select and a "Planned start date" input,
reflecting wherever the job currently sits (auto-placed or pinned) — the same
information the Schedule view's tiles show, but editable without the job
needing to be on-screen or draggable there first. Only equipment satisfying
the job's process + capability tags is offered (`tagOk`, same test the
scheduler applies), matching what a drag would accept.

Editing either field and saving builds the exact assignment shape
`handleDrop` builds for a drag-and-drop reassignment (`pinned: true, days:
[]`, letting the next recompute fill in the day-by-day plan) — this **is** a
manual placement, not a separate mechanism. Left untouched, the job keeps
whatever assignment it already had, pinned or not: the fields are compared
against their original values at save time, so merely opening and saving the
modal never force-pins an auto-placed job. Clearing the equipment field back
to "Automatic" unpins a pinned job the same way the existing "Unpin" button
does.

### Preferred equipment — a soft nudge, not a pin

Some jobs can technically run on any process/tag-compatible machine but are
better suited to one in particular. `job.preferredEquipmentId` (optional,
nullable) records that without pinning the job the way the Equipment field
above does — no exact day, no operator lock, and the job stays free to move
on future recomputes. It's set two ways: by hand, from a dedicated "Preferred
equipment" select in `JobModal`'s Scheduling section (deliberately a
*separate* field from the hard-pin Equipment select right above it — the two
build genuinely different assignment shapes, and conflating them risked a
picked preference silently turning into a full pin, or a template's default
preference silently overwriting a manual pin); or inherited from a job's
template (`TemplateModal` has the same field, `applyTemplate` copies it
across exactly like tags/process/hours, and `ImportJobsModal`'s
`applyTemplateToRow`/`applyBulkTemplate` do the same when a WIP import row
gets a template assigned during review).

`runScheduler` only ever consults it when auto-placing an **unpinned** job —
a pin is already a stronger, exact placement, so a pinned job's own
preference (if it has one) is simply never looked at. Among the machines that can
actually fit the job somewhere in the horizon (`candidates`, built the same
way as ever from process + `tagOk`), the preferred one wins outright if it's
among them — not just as a tie-break the way `exclusiveDemand` is — so it can
beat a machine that would otherwise finish the job sooner. It's still only a
preference: if the preferred machine isn't process/tag-compatible, or
genuinely has no free slot anywhere in the horizon, it never makes it into
`candidates` at all, and placement falls straight through to the ordinary
soonest-finish selection — the job still gets scheduled, just not where it
was preferred. Either way the resulting `assignment.preferredEquipmentUnmet`
records which happened (`false` when honoured, `true` when it had to fall
back), computed once from `best.equipId !== job.preferredEquipmentId` rather
than threaded through as extra state.

`preferredEquipmentUnmet` is deliberately not folded into `conflict` — a
missed preference isn't an overbooking, it's a "the schedule is fine, but
you might want to look at this" signal, so it gets its own amber
"Not on preferred equipment" panel on the Schedule view (next to Overbooked
and Needs scheduling) and its own small `Target` icon on the job tile,
distinct from the red `AlertTriangle` conflict marker. A split job's parts
all carry the parent's preference (same as tags/`parallelProcessing`) and
are judged individually — one part can land on its preferred machine while a
sibling part doesn't. A batch only carries a preference forward if every
member agreed on the same equipment, same reasoning as batch `staffId`; a
mixed batch places as if no preference were set at all, and the per-member
`preferredEquipmentUnmet` on expansion is still judged against each member's
own preference, not the batch's (possibly absent) unanimous one.

### Locked equipment — a hard restriction, not a pin

Sits between the two mechanisms above: stronger than `preferredEquipmentId`
(which the scheduler will happily abandon if the preferred machine can't take
the job), but lighter than the Equipment field's full pin (which also fixes
the exact day and stops the operator moving). `job.lockedEquipmentId`
(optional, nullable) confines a job to one machine — the scheduler waits for
it rather than quietly using a free one — while still auto-choosing the day
and the operator on every recompute, exactly like an ordinary unpinned job.
It's the equipment equivalent of `job.staffId`: same kind of hard
restriction, just naming a machine instead of a person, and it's implemented
that way — `eligibleEquipment(job, equipment)` (`scheduler.js`) narrows the
process/tag-compatible fleet down to just the locked machine before
placement is even attempted, the same way `eligibleStaffIds` narrows to a
named person. Set from a dedicated "Locked equipment" select in `JobModal`'s
Scheduling section, positioned between the Equipment field and Preferred
equipment so the three read in order of strength.

Because it's a straight restriction on `eligibleEquipment`, not a step
`runScheduler` special-cases, it composes for free with everything already
built on that function: `exclusiveDemand` counts a locked job as exclusively
demanding its one machine (same as a job with only one process-compatible
machine to begin with), the unpinned placement sort gives it the same
first-call priority a manually-assigned (`staffId`) job gets — it only has
one resource to draw on — and a pinned job's own lock is never consulted,
same reasoning as a pinned job's own preference: pinning is already a
stronger, exact placement. If the locked machine genuinely can't take the
job anywhere in the horizon (no capacity, or it's no longer process/tag
compatible), the job lands in "Needs scheduling" naming the machine
specifically (`whyUnscheduled`), rather than silently falling back to
another machine the way a missed preference does — that fallback is exactly
what a lock is for *not* doing. Split-job parts all inherit the parent's
lock (same as `tags`/`preferredEquipmentId`); a batch only carries it
forward if every member agreed on the same machine, same reasoning as batch
`staffId`/`preferredEquipmentId` — a mixed group places as if unrestricted.

**The equipment equivalent of "Overriding a busy person" (#46)**: a lock
only wins against another *unpinned* job automatically (placement order
already favours it, same as `staffId`) — a **pinned** job already sitting on
the locked machine for the days this one needs is a standing claim
`runScheduler` settles before the locked job gets a turn at all (pinned jobs
place first, full stop), so it lands unscheduled instead.
`findEquipmentLockBlockers` (`WeldingScheduler.jsx`) is called right after a
save that leaves a locked job with no assignment: it looks for pinned jobs
(or pinned parts) sitting on that same machine on or after the job's
`readyDate` and, if it finds any, opens a "Machine already committed
elsewhere" dialog naming them with an "Unpin so it can move elsewhere"
action per blocker — the direct equipment-side mirror of
`findManualAssignBlockers`/`checkManualAssignConflict`/
`unpinForManualAssign`, right down to unpinning only freeing the blocker to
be re-placed (not handing the machine over directly), since a locked job
already places before automatic ones among the unpinned.

A small `Lock` marker (amber, same treatment as the `UserCheck` staff-lock
marker) shows on a locked job's Schedule-view tile and its Backlog row,
suppressed whenever the job is actually pinned — a pin already implies a
fixed machine, so showing both markers would be redundant.

### Weighted placement scoring (`src/placementScore.js`) — OPT-IN, off by default

**Status: the app does not use this.** All three `runScheduler` call sites in
`WeldingScheduler.jsx` pass five arguments, which is the legacy path,
unchanged. Nothing below affects the running tool until someone passes
`{ weights }`. That is deliberate — the scheduler is in daily production use,
so the new path was built alongside the old one rather than replacing it.

**The problem it solves.** `runScheduler` decides two separate things about an
unpinned job: which candidates are *eligible*, and which of those is *best*.
Eligibility is a filter (process, `tagOk`, `lockedEquipmentId`, `staffId`,
`readyDate`, `equipDayLock`) and stays exactly where it is — hard has to mean
never, and a score can always be outvoted by a big enough number, so folding a
hard constraint into a weight would silently downgrade a guarantee to a
preference. **Never move an eligibility rule into the weights.**

The *best-candidate* half was a strict lexicographic sort comparator: finishes
soonest, then earliest start, then least exclusively-demanded machine, then
staff continuity, then fewest handovers, then fewest chunks — where each
signal only got a say if everything above it was *exactly* tied. That
structure cannot express "prefer this, but not at any cost", which is why
preferred equipment had to be bolted on as a `wins outright` branch *above*
the whole cascade (a preferred machine booked solid for a fortnight still beat
an identical machine free tomorrow). Every future soft nuance would have
needed the same kind of carve-out, and those carve-outs are what eventually
conflict with one another.

`placementScore.js` replaces the comparator with one weighted sum:
`score = Σ weights[term] × features[term]`, ranked best-first by
`rankCandidates`. Signals now trade off instead of strictly overriding.

**Features and weights are kept separate on purpose, and must stay that way.**
`scoreCandidate` returns `features` (raw, opinion-free measurements — "this
plan spans 3 days", "2 operator changes"), `contributions` (per-term
`w × x`) and the summed `score`. The separation is the design, not
bookkeeping: it makes a disagreement between the scheduler and the user
*measurable*. When the user overrides a placement, both feature vectors are
known and `featureDelta(userPick, schedulerPick)` gives exactly which terms
were mis-weighted and in which direction — the gradient of a standard
structured-prediction update, and the intended substrate for learning from
corrections. **Don't collapse features and weights into a single number**;
doing so removes the only hook a learning pass has.

`runScheduler`'s optional sixth argument carries both switches, each off by
default: `{ weights }` opts into scoring, `{ trace }` collects a per-job
record of *every* candidate considered with its score and features (not just
the winner — the rejected ones are what an override gets compared against).

**Two behavioural changes the scoring path deliberately makes**, both
impossible to express in the cascade:
- Preferred equipment stops winning outright and competes on its weight
  (`+60` ≈ worth about six days of delay, since `finishDelay` is `-10/day`),
  so a preferred machine booked solid now loses to one free tomorrow.
- A `lateness` term (`-25`/day past `effectiveDueDate`) exists at all. The
  cascade ranked purely on finishing soonest, which is only a proxy for being
  on time.

**`npm run compare-scoring`** runs both paths over the same input and prints
only what differs, with a term-by-term "because" line. It is read-only and
takes an optional path to a real `scheduler-data.json` (shared-mode host file,
`{version, entries}` with JSON-string values) or a plain `{wf_jobs,
wf_equipment, wf_staff}` object; with no argument it uses a built-in demo
workload. This is the safety mechanism that replaces "prove parity" — exact
parity with the cascade is *not* achievable or desirable, since reproducing a
lexicographic order requires place-value-separated weights (1000×, 100×, 10×…)
which would make every term un-tradeable and defeat the point.

**That script has already caught one real defect, which is why it exists.**
`exclusiveDemand` (how many *other* pending jobs have no alternative to this
machine) only ever broke exact ties under the cascade, so its magnitude had
never been under any pressure at all. Scored at a token `-5` it promptly lost
to a two-day saving and parked a general job on the only tagged cell — exactly
what the signal was introduced to prevent. Corrected to `-25` (≈ the delay it
imposes on the job being displaced). Pinned by *"a flexible job does not camp
on the one machine an inflexible job needs"* in `test/placementScore.test.js`.
Expect other weights to need the same treatment when the path is first run
against real data: a signal that has only ever been a tie-break has never had
to justify its magnitude.

The *job ordering* sort (`unpinned.sort` — manual/locked first, then
`effectiveDueDate`, then `needsFurtherProcessing`) is a separate cascade of
the same shape and is **not** touched by any of this. It could get the same
treatment later if it starts feeling the same pressure.

### Override capture (`src/overrides.js`, `wf_overrides`) — record only

Every drag, modal pin, or lock is the user correcting the scheduler. That
correction used to be applied and forgotten. `wf_overrides` now keeps one
record per correction, pairing **what the scheduler chose** with **what the
user chose**, both described by the same weight-free feature vector, so
`featureDelta` over a pile of them says which terms are systematically
mis-weighted and in which direction.

**Nothing reads this back into scheduling, and nothing should** until the data
has actually been looked at. A pattern being detectable is not the same as the
scheduler being right to act on it.

**`trace` is orthogonal to `weights`, and that is load-bearing.** Tracing is
observation; scoring is behaviour. `runScheduler` emits a trace on the
**default** path too — otherwise capture would have required opting into the
scoring path's behaviour change first, which is exactly backwards. Asking for
a trace never moves a job (pinned by *"the trace works on the DEFAULT path
too, without changing what it picks"*).

**The ordering trick.** Once a job is pinned it stops generating candidates, so
the only run that knows what the automatic choice *would* have been is the one
that already happened. `lastTraceRef` holds it; `recordOverride` is called
**before** the recompute that applies the override. A ref, not state: nothing
renders from it and it must be readable synchronously mid-event.

**Every `runScheduler` call site in the component must go through
`runSchedulerTraced`.** The first version traced only inside `recompute`,
silently missing the initial load and `reloadFromStore` — so on a freshly
opened page the ref was empty and the first correction of a session, the one
most worth having, recorded nothing. Unit tests cannot see that; it took the
browser. If another call site is ever added, route it through the helper.

**Not recording is the common, correct outcome.** Pinning a job exactly where
it already sat is a confirmation, not a correction — `buildOverrideRecord`
returns `null`. Logging those would flood the history with zero-signal records
that drag every average toward "no disagreement".

**A delta is refused unless the two placements are genuinely comparable.**
`runScheduler` evaluates exactly one placement per machine — its earliest
feasible slot — so a job moved to a *different day* has no feature vector for
where it actually landed. Rather than difference against the wrong row,
`comparable` is false and `delta` is null; the record is still kept in full,
because a timing correction is real evidence, just not of the same kind, and
reading it needs a different method than differencing feature vectors. A wrong
delta doesn't announce itself — it quietly drags learned weights sideways.
`summariseOverrides` reports `notComparable` broken down by cause, so
"everything is `movedToUnevaluatedDay`" is legible as "the disagreement is
about timing" rather than an unexplained gap.

**Direction matters.** `featureDelta(user, scheduler)` is user-minus-scheduler:
positive means the user's pick had *more* of that term, so its weight should
rise. Backwards, and a future learning pass trains away from the user — a bug
that looks like the tool slowly getting worse with nothing obviously broken.

`source` (`drag` / `modal-pin` / `lock`) is kept because these are not equal
evidence: a drag is about one job on one day, a lock is a standing statement
about where that work belongs. Job names are denormalised so a record outlives
its job. Capped at `MAX_OVERRIDES` (500, oldest dropped) since shared mode
writes this to the host PC; a year-old correction describes a department that
no longer exists. Content is ids, dates, job names and the job descriptors
below — no costs, values or WIP.

#### Two different kinds of learning, and `record.job` is what enables the second

The feature deltas above support exactly ONE kind: tuning the **global**
weights, which apply equally to every job. They cannot express "jobs of *this
kind* belong on *that* machine", because nothing in a feature vector says what
kind of work it was.

`record.job` — `templateId`, `process`, `procedureId`, `tags`, plus the job's
own `preferredEquipmentId`/`lockedEquipmentId` at the time — is what makes the
second kind possible. `attributeAffinity(list, key)` groups equipment-changing
corrections by any of those and reports which machine the work keeps landing
on. In practice this is the more useful one to reach first: its output is a
concrete value for a field the scheduler **already honours**
(`template.preferredEquipmentId`), so acting on it is filling in something you
would otherwise type by hand — a far lower bar for trust than accepting a
learned number. "7 of 9 Bracket Weld moves went to Robot 2" is also a claim a
person can check against memory; a weight is not.

**These MUST be captured at correction time.** The feature vectors are a
snapshot of a capacity state that's gone, and a job's template or process can
be edited afterwards, so none of it can be backfilled onto old records with
any confidence about what the job looked like then. Any future attribute worth
learning from has to be added to `record.job` *before* the data accumulates,
not after.

Two derived rules that matter when reading the output:

- **Only equipment-changing corrections count.** A timing-only move says
  nothing about which machine the work belongs on, and including it dilutes
  every share toward meaninglessness.
- **An existing preference inverts the conclusion.** `existingPreferences`
  reports what the jobs in a group already preferred. If the group's top
  machine is one they *already* prefer, that is NOT a suggestion to record a
  preference — it is evidence the scheduler keeps failing to honour one, which
  is a weights problem. Identical-looking counts, opposite fixes;
  `show-overrides` prints them differently for that reason.

`share`'s denominator is equipment-changing corrections *in that group*, not
all jobs of that kind — the history alone can't know the latter. A consumer
wanting "7 of 9 Bracket Weld **jobs**" has to bring its own denominator;
conflating the two would overstate every finding.

**`npm run show-overrides -- path/to/scheduler-data.json`** prints what has
accumulated: counts by source, which machines work is moved off and onto, the
per-template/process/procedure/tag affinities (with the
"already prefers" vs "consider setting" distinction above), and the mean
feature delta. Step 1 deliberately ships no UI, so this is the only way to
look — and data being collected that nobody has eyeballed is precisely how a
learning system ends up confidently trained on a bug.

### Parallel processing (#30)

By default the scheduler never double-books an operator — `tryFit` requires
`staffDayRemain[sid][date] > 0` before it'll use someone, so two jobs
genuinely needing the same person at the same time is a real, unresolvable
conflict, not something the engine papers over. A pinned job that loses that
contest doesn't just vanish, though: it still renders where it was placed,
`assignment.conflict = true`, with an unassigned (`staffId: null`) day-plan —
same handling as any other overbooked pin.

**The escape hatch is `job.parallelProcessing`** — a plain boolean, off by
default, meaning "this job is automated enough that an operator can mind a
second job on other equipment at the same time." Where set, `tryFit`/
`consume` skip the `staffDayRemain` check and the corresponding deduction
entirely for that job: it still needs someone qualified *rostered* onto the
shift (and the equipment's own shift capacity is completely unaffected —
this only relaxes the *staff* constraint), but it no longer competes for the
shared pool of that person's hours. This is why it has to be opt-in and
per-job rather than a scheduling strategy: turning it on for the wrong job
would let the engine silently double-book someone who's actually needed
elsewhere.

Deliberately **not** wired into automatic (unpinned) placement's own
decision-making beyond that — the auto-scheduler never goes looking for an
opportunity to double-book an operator just because a job *could* tolerate
it; the tag only ever matters when a job that has it actually lands
alongside something else needing the same person, which in practice means a
manual placement (drag, or the job modal's Equipment/Planned start date
fields — #28) triggered it.

**Surfacing the conflict**: `handleDrop` and `addOrUpdateJob` both call
`checkParallelConflict(result, jobId)` right after `recompute()` — but only
for the specific job just placed, never a blanket scan, so an unrelated
recompute (an equipment edit, say) can't dredge up some job that's been
sitting conflicted for unrelated reasons. The tricky part: the job that ends
up `conflict: true` isn't necessarily the one just placed — pinned jobs sort
by `claimOrder`, and a fresh manual placement has none yet (`?? -1`), so it
outranks whatever incumbent was already sitting on that slot (see "the pin
that has none places first" in runScheduler) and the **incumbent** is what
gets bumped into conflict instead. `checkParallelConflict` checks both
directions: every currently-conflicted pinned job to see if our action is
what it's contending with, then falls back to the placed job itself.

`findStaffConflictJobs(conflictedJob, jobs, staff)` (scheduler.js, pure and
tested) names what a conflicted job is actually contending with: it scans
every other active job's real day-by-day plan for an entry on one of the
conflicted dates staffed by someone in the conflicted job's eligible pool —
i.e. whoever it was actually fighting over, not just "everyone qualified for
this process." Feeds the "Overbooked — same operator needed at once" dialog
(`parallelConflict` state), which lists the placed job and every candidate
as its own "Allow parallel processing on…" button — either side of the pair
can be the automated one — plus "Leave overbooked" to decline outright.

The tag itself is a completely ordinary job field from there: visible and
directly toggleable via a checkbox in `JobModal` (so it doesn't only exist as
a side effect of hitting a conflict), shown on the Schedule view via a small
icon, and threaded onto every part of a split job during flatten (same as
`tags`) since the automation is a property of the work, not of which part
triggered the tag. It survives a move to different equipment/day/pairing
untouched — it was never scoped to "these two specific jobs," which is the
whole point: an operator sharing a job with A today can just as well share
the same job with C next week without re-granting anything.

### JobModal layout: `Section` and the two-column grid (#33)

`JobModal` grew a field at a time over several rounds of work (#28, #30,
capability tags, value/costing…) until it was a long single-column form at
the default `Modal` width — mostly scrolling past sections you weren't
touching. Two changes, independent of each other:

- `Modal size="lg"` (1024px, same tier `ImportJobsModal` uses) instead of
  the default `md`, with the main fields laid out `grid md:grid-cols-2` —
  identity/description on the left (name, capability tags, process,
  quantity/hours, notes), scheduling and money on the right (`Scheduling`
  and `Value & costing`, see below).
- `Section` (`title`, `defaultOpen`, `children`) — a named, collapsible
  block: a header button with a chevron that toggles local `open` state,
  wrapping any group of fields. Replaces the ad-hoc "▸ text button + `{show
  && <div>}`" pattern `showSplit`/`showBcLink` used to hand-roll (both
  states are gone — `Section` owns its own now). Reused for `Template`,
  `Scheduling`, `Value & costing`, `Split job into two parts`, and
  `Business Central linking`.

**`defaultOpen` matters and isn't uniform** — it should reflect whether a
section already holds something worth seeing at a glance, not just alternate
for variety:
- `Scheduling` and `Value & costing`: always open. These are what a job-edit
  session is usually *for*.
- `Template`: open only for a **new** job (`defaultOpen={isNew}`) — picking
  a template is the first thing you do starting from nothing, but re-browsing
  templates mid-edit of an existing job is rare.
- `Split job into two parts`: always closed (`defaultOpen={false}`) — an
  occasional action, not a thing to look at on every open.
- `Business Central linking`: open only if the job already has a `bcJobNo`
  or `bcJobTaskNo` (`defaultOpen={!!(job?.bcJobNo || job?.bcJobTaskNo)}`) —
  same logic the old `showBcLink` initial state used, just moved onto the
  `Section` that replaced it.

Parts (when the job is already split) stay a plain, always-visible block —
not a `Section` — since they're the primary content of the modal at that
point, not something to tuck away.

**Sticky footer (#36)**: the footer (Delete/Unpin/Mark-complete/Save) is
`sticky bottom-0 bg-slate-900`, not just the last thing in the form — once the
modal grew tall enough for `Section` to matter at all, reaching Save meant
scrolling past whatever else was open first. `-mx-5 px-5`/`-mb-5 pb-5`
counteract the dialog's own `p-5` so the sticky bar still spans edge-to-edge,
matching the header's existing sticky treatment.

**"100% to department" (#37)**: a one-click shortcut in the Value & costing
section that sets the department-value field to the job's total value, for
the common case where this department did all the work on a job and nobody
wants to retype the total. It's the first "act as a modal-level button" case
this codebase hit, and it exposed a real bug rather than being simple to add
— see `DirtyButton` below.

### `DirtyButton` — why a plain `onClick` button inside JobModal/StaffModal can't self-report dirty (#37, #40)

`useContext` only resolves against a `Provider` that is an **ancestor** of the
calling component in the React tree. `Modal` wraps its `children` in
`DirtyContext.Provider`, but `JobModal`/`StaffModal` are the components that
*render* `<Modal>` — they sit above the Provider, not below it, so a bare
`const markDirty = useContext(DirtyContext)` declared at their own top level
always reads the context's default (a no-op) and silently never marks the
modal dirty. This is not how `TagEditor`/`MultiCheck` get away with the exact
same call: they're real child components instantiated as JSX *within* what
becomes `children`, so they're genuine descendants of the Provider.

The bug was invisible under a normal test (click the button, click Save,
confirm the value persisted — that path never touches `markDirty` at all). It
only surfaced by testing the *dirty-tracking* path itself: click the button,
then click the backdrop, and check for "Discard unsaved changes?" — which
didn't appear, because the click had never registered as a change.

Fix: `DirtyButton` (`onClick`, `className`, `style`, `title`, `children`) is a
tiny wrapper — `useContext(DirtyContext)` inside its own body, called on
click alongside the real handler — used wherever JobModal/StaffModal need a
plain button (not a native input, so no DOM `change` event bubbles) to count
as an edit: the "100% to department" button and StaffModal's colour swatches.
Any future button added directly inside a component that itself renders
`<Modal>` needs this wrapper, not a raw `useContext` call at that component's
own top level.

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

### A new job starts with no template pre-selected (#59)

`JobModal` used to seed a brand-new job's `templateId`, `name`, `process`,
`hoursPerUnit`, `totalValue` and `departmentValue` from `templates[0]` — the
first template in the list — the instant the modal opened, before the user
had touched anything. The "Set up a custom (one-off) job instead" toggle
looked like the way out, but it only cleared `templateId` on save; the
fields it had already copied in from template #1 stayed exactly as they
were, so there was no way to actually land on a blank job — "custom" just
meant "whatever template #1 happened to be, with the label torn off."

Fixed by not defaulting any of those fields from `templates[0]` for a new
job — `templateId`/`name` start `''`, `process` falls back to `processes[0]`
(a plain default, not a template's), `hoursPerUnit` to `1`, and
`totalValue`/`departmentValue` to `0`. The Category and Template drop-downs
both gained a `— Select … —` placeholder option so a blank `templateId`
renders as genuinely unselected rather than the browser silently defaulting
to whichever `<option>` happens to be first. Editing an **existing** job is
untouched — it still opens on whatever template (or none) it already has;
this only changes what a *new* job starts with. Picking a template (or
category, or a search result) still fills everything in via `applyTemplate`
exactly as before — the fix is purely about not doing that automatically.

### A template's "equipment this can run on" is derived, not stored (#23)

`TemplateModal` used to have a manual `MultiCheck` for this, saved as
`template.equipmentIds` — and defaulting to *every* process-capable machine
if left untouched. It looked like a scoping decision the user made, but the
scheduler never read it: `runScheduler`/`whyUnscheduled` only ever place a
job by `job.process` + `tagOk(job, equip)` (capability tags), which come
from the template's `process`/`tags`, not `equipmentIds`. A template edited
to require a positioner tag, then left with its old (untouched) equipment
list, would still show a machine without that positioner as "this can run
on" — actively wrong, not just unused.

Fixed by deleting the field. `equipmentForTemplate(t, equipment)` (used by
`TemplatesView`'s card and `TemplateModal`'s read-only "Equipment this can
run on" display) runs the same `equipment.processes.includes(t.process) &&
tagOk(t, e)` test the engine does, live against the in-progress `process`
and `tags` in the modal — so the list updates as you edit either, and can
never drift from what the scheduler will actually do. If it comes back
empty because a tag is unsatisfiable, the modal says so instead of silently
showing nothing. Don't reintroduce a stored, user-picked equipment list here
— if a *narrower* restriction than process+tags is ever wanted, model it as
another capability tag, not a second parallel mechanism the scheduler has to
consult.

### Roster availability

**Saturday defaults to a shortened 6h day, not the ordinary 8h shift
(#59).** The weekly roster table (Staff view) pre-fills a day's `hours` from
`SHIFT_DEFS[shift].defaultHours` (8) the moment it's switched from "Off" to
"Day"/"Afternoon" — reasonable for a weekday, but Saturday on the shop floor
genuinely runs a shorter day, so leaving it at the flat 8h default (unless
someone remembered to change it by hand) meant Saturday work quietly got
scheduled as if it were a full day. `updateDay`'s `onChange` now special-cases
`key === 'sat'` to default to `6` instead of `SHIFT_DEFS[v].defaultHours` —
still just a default, not a hard cap: the hours field is the same free-typed
number input as every other day, so an individual can still be set to a
different Saturday length by hand if that's genuinely their roster.

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

**Editable, not just deletable (#41)**: `StaffView` used to only ever append a
new `leavePeriods` entry — fixing a typo in a reason, or a wrong date, meant
deleting the entry and re-entering it from scratch. `openEditLeave(period)`
opens the same absence modal pre-filled from an existing entry (tracked via
`editingLeaveId`); `saveLeave()` replaces the matching entry by `id` when one
is being edited, and only appends when it isn't, so editing can't turn into a
duplicate. The leave table's row actions gained an Edit (pencil) button
alongside the existing Delete.

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
for one. This bit `Section` too (#43): it used `bg-slate-900/40`, the one
opacity variant in the whole file that wasn't one of the mapped ones — every
other boxed panel already used the correctly-mapped `bg-slate-800/50` or
`/60` — so an open `Section` (the "Scheduling" block in JobModal, most
visibly) rendered as a washed-out mid-grey box with its own text unreadable
against it. Fixed by switching `Section` to `bg-slate-800/50` to match every
other panel, rather than adding yet another one-off hex mapping.

### Costing: cost centres and procedures (#61)

`CostCentreEditor` (a machine's depreciation+interest rate) and
`ProcedureEditor` (a weld/coat procedure's full hourly operating cost —
powder, gas, electricity, spares, maintenance, consumables, labour, QA) are
both dense, grid-of-inputs forms. Two things worth knowing if either grows:

- **Every column needs its own persistent header — a placeholder isn't
  enough.** `ProcedureEditor`'s row sections used to label a field with only
  its input `placeholder`, on the theory that "$/kg", "g/min" etc. would
  read fine sitting in the empty box. That breaks in two ways: a placeholder
  vanishes the instant the field has *any* value, including the department's
  own typed-in figure, and every numeric column here defaults to a real `0`
  (not an empty string), so those placeholders never rendered even once —
  the user saw a bare `0` with nothing saying what it was. `sec()` — the
  shared row-renderer behind gases/spares/maintenance/consumables/labour/qa
  — now renders a small uppercase header row (`c.label`, one per column)
  above the grid, always, matching the pattern `CostCentreEditor`'s capital
  assets table already used. The hand-rolled Powder and Electricity blocks
  (not built through `sec()`, since they're single fixed-shape rows rather
  than an add/remove list) got the same header row added directly. Any new
  section needs both a `placeholder` (a light hint of the expected format,
  e.g. `"m³"`) **and** a `label` (what the column actually is) — they're
  allowed to read the same, but don't rely on one to stand in for the other.
- **`CostCentreEditor` opens `wide` (1024px), not the plain default
  (448px).** Its capital-assets table is 4 real columns plus a delete
  button; the old default squeezed all of that (and the interest
  rate/annual hours row above it) into a modal barely wider than one long
  asset name. Matches `ProcedureEditor`, which already opened `wide` for
  the same reason.

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

### Batches (#47)

The mirror image of splitting: several separately-listed jobs that are really
the same scope (identical components, same process) and should run back to
back on **one** piece of equipment instead of being scattered across whichever
machine the scheduler finds room on first. `job.batchId` groups them,
`job.batchOrder` fixes the run sequence — set from the Job Backlog by ticking
2+ active, non-split, not-yet-batched rows with the **same process** and
clicking "Batch N jobs" (`createBatch` in the main component; disabled unless
the process matches). "Remove from batch" (the `X` on a row's `batch #N` chip)
clears just that one job's `batchId`/`batchOrder`, leaving the rest of the
group intact.

Splitting flattens one job into many schedulable units; batching does the
reverse — **combine, then slice** — in `runScheduler` (`scheduler.js`):

- `groupBatches(jobsIn)` only combines a group when it's safe to treat as one:
  2+ members, all unpinned, none split (`.parts`), all the same `process`.
  Anything that doesn't qualify — a member pinned on its own, a split job, a
  mismatched process — falls back to being scheduled independently rather
  than guessing; there's no single slot left to negotiate for a group like
  that. This runs *before* the split-job flatten, and batch members are
  excluded from the ordinary per-job pass.
- Each qualifying group becomes **one pseudo-unit** (`id: "batch:<batchId>"`,
  `_batchId`) with combined `hoursTotal` (sum), `tags` (union — the one
  equipment has to satisfy every member's requirement for the whole run),
  `readyDate` (the *latest* of the members' — the run can't start until
  everyone's ready, and starting earlier would just imply a gap; **or blank
  if even one member has no ready date set at all** (#59) — a missing date
  isn't "earliest", it's "unknown", so it has to block the whole group rather
  than being silently outvoted by the other members' real dates), effective
  due date (the *earliest* of the members' — the group is only as un-urgent
  as its most urgent member), `staffId` (only if every member happens to name
  the same person, otherwise automatic), and `parallelProcessing`/
  `needsFurtherProcessing` combined conservatively (needs **every** member's
  agreement to share an operator, but **any** member's downstream scope is
  enough to prioritise). This pseudo-unit goes through the exact same
  unpinned-placement logic — equipment choice, `tryFit`, staff continuity — as
  any ordinary job; no changes were needed there, which is the point of
  combining first.
- Once placed (or not), `sliceBatchPlan(plan, members)` distributes the one
  combined day-by-day plan across members in `batchOrder`, splitting a single
  plan entry across a member boundary when the hours don't land on a day/shift
  edge — the same operator finishing one member and immediately starting the
  next, same day, same equipment. Each member gets back an ordinary-shaped
  `assignment` (own `startDate`/`endDate`/`days`, same `equipmentId` as every
  other member, `pinned: false`). An unplaceable batch leaves **every**
  member unscheduled together, sharing the one `unschedReason` — never a
  partial placement.
- Continuity across recomputes has nothing of its own to seed from (the
  pseudo-unit is rebuilt fresh every run), so it borrows whichever member most
  recently had a primary operator (`members.map(primaryStaffOf).find(Boolean)`)
  as `seedStaffId`.

Known simplification, accepted rather than engineered around: using the
*latest* ready date as the combined floor can start the whole group a little
later than strictly necessary if members have staggered ready dates, in
exchange for guaranteeing the run stays genuinely contiguous rather than
implying a gap partway through. Not worth a more elaborate per-member
readiness model for what's meant to be a same-scope batch in the first place.

**A batched job's `batchId`/`batchOrder` must be carried through by hand
anywhere a job gets saved (#59).** `JobModal.handleSave()` builds a fresh
`data` object from its own local state rather than merging into the existing
job, and `addOrUpdateJob` replaces the stored job with that object wholesale
(`jobs.map((j) => (j.id === stamped.id ? stamped : j))`) — so any field the
modal doesn't explicitly know about is gone the moment the job is saved, not
just left at its old value. `batchId`/`batchOrder` aren't editable from this
modal (that only happens from the Backlog row's batch controls), so they're
exactly the kind of field this silently drops: saving *any* unrelated edit —
notes, hours, due date, anything — used to knock a job out of its batch as a
side effect. Fixed by explicitly carrying `job?.batchId ?? null` /
`job?.batchOrder ?? null` through in the saved `data`, the same way
`actualHours` and `completedDate` already were. If a new field is ever added
to the job shape that isn't surfaced in this modal, it needs the same
treatment — the fresh-object pattern is a trap by default, not a merge.

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
`wf_wipparked`, `wf_categories`, `wf_timelog`, `wf_overrides` (each a JSON
blob).

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
- **`Modal` locks `document.body`'s scroll for its own lifetime** (#25), on
  top of its own dialog having `overflow-y-auto overscroll-contain`. Without
  the lock, wheeling over the backdrop (not inside the dialog, which has
  nothing scrollable there to catch the event) scrolled the page underneath;
  without `overscroll-contain`, wheeling inside the dialog past its own
  top/bottom edge "chained" the rest of the scroll to the page behind it —
  both are real, independent leaks and both are needed.
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
- **Each widget's Add button also needs `onMouseDown={(e) =>
  e.preventDefault()}` (#39)**, or clicking it while the text input is
  focused races the input's own `onBlur`-commit against the button's
  `onClick` — `blur` fires first (the browser shifts focus off the input
  before the click lands), so both handlers tried to add the same chip from
  what was, by the second one, a stale closure. Usually harmless, but
  occasionally the second write landed after the first and the chip that had
  just appeared vanished again — the "capability requirement flickers and
  disappears" bug. `preventDefault` on `mousedown` stops the browser from
  moving focus at all, so only one commit ever fires.
- Deleting a process (Templates page) cascades: `saveProcesses` strips it from
  every piece of equipment and every staff member. Templates and jobs keep
  their process string on purpose — it records what the work is, and blanking
  it would silently unschedule them — so the toast names how many still refer
  to it. `MultiCheck`'s opt-in `showOrphans` renders a selected value that is
  no longer an option so it can still be unticked, which is how data saved
  before the cascade existed gets repaired. Leave it off where options are
  filtered dynamically (TemplateModal's equipment list narrows by process, and
  an id outside that list is ordinary filtering, not stale data).
- **Renaming a process (#38) is the opposite case from deleting one, and
  cascades everywhere on purpose.** Unlike deletion, a rename has a direct 1:1
  replacement, so there's no reason to leave anything pointing at the old
  string: `renameProcess(oldName, newName)` swaps it in the process list,
  every equipment/staff capability array, every template, and every job's
  `process` field, then recomputes so the schedule reflects it immediately.
  `TemplatesView` edits a process in place (pencil icon → inline input, Enter
  or the check button commits, Escape or the X cancels) rather than only ever
  offering delete-and-re-add.
- Work on a branch and commit checkpoints before large refactors.
- After changes, run `npm run dev` and verify the Schedule, Roster, Backlog and
  Reports tabs still render and that data persists across a refresh.
