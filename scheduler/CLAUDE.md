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
  main.jsx            # entry; installs storage shim, mounts <App/>
  App.jsx             # renders <WeldingScheduler/>
  WeldingScheduler.jsx# the entire application (large; ~2000 lines)
  storage.js          # localStorage-backed window.storage shim
  index.css           # Tailwind directives + dark base background
tailwind.config.js
postcss.config.js
vite.config.js
```

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — preview the production build

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
   person on a job for continuity where possible.
5. **Storage helpers** — `loadKey` / `saveKey` wrap `window.storage`.
6. **UI primitives** — small styled building blocks (Field, Modal, MultiCheck,
   buttons).
7. **Main component** `WeldingScheduler` — top-level state, load/recompute/save,
   all the CRUD handlers, the header, and tab routing.
8. **Views** — ScheduleView (the gantt/drag-drop grid), BacklogView, RosterView,
   TemplatesView, ResourcesView, ReportsView.
9. **Modals** — JobModal, ImportJobsModal, TemplateModal, EquipmentModal, StaffModal.

## Importing jobs from the WIP importer

The Job Backlog tab has an "Import from WIP export" button (`ImportJobsModal`)
that reads the JSON file produced by `wip-importer/wip-importer.html`. It
accepts either `{ jobs: [...] }` (the importer's actual export shape) or a bare
array, for robustness. Flow: pick file → preview table (one row per job,
ticked by default) → optionally assign a Template per row (or bulk-apply one to
all ticked rows without one), which fills in `process` and `hoursTotal` from
the template's `hoursPerUnit`/`departmentValuePerUnit` × quantity — because the
importer always exports `process: ''` and `hoursTotal: 0` (BC's WIP has no
shop-floor hours) → click Import. Rows are matched against existing jobs by
`bcJobNo` + `bcJobTaskNo` and flagged/unticked (not hidden) as probable
duplicates if a match is found, so re-importing the same export doesn't create
copies unless the user deliberately re-ticks them. Imported jobs get fresh
`id`s and go through the normal `recompute`/scheduler pass like any other job.
This is the "closes the loop" piece described in the workspace root
`CLAUDE.md` — keep it in sync with `buildSchedulerJobs` in the importer if the
job shape changes.

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
  allows; a handover only happens when they're genuinely unavailable.
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
exists inside a Claude artifact. Locally, `src/storage.js` installs a
**localStorage-backed shim** with the same interface, activated in `main.jsx`
before mount. The component code is unchanged and should stay that way — treat
`window.storage` as the persistence seam.

### Known limitation to solve next: multi-user sync

In the artifact the storage was **shared**, so the office view and the
read-only workshop-monitor view saw the same live data. localStorage is
per-browser, so that shared behaviour is currently lost — each browser has its
own copy.

When the user wants real shared/live data:
- Build a small backend (e.g. Node/Express + SQLite/Postgres, or a hosted DB).
- Replace the body of `src/storage.js` with calls to that backend, keeping the
  same `get/set/delete/list` async interface so nothing else changes.
- Consider websockets / polling so the workshop monitor updates live.
- Data keys currently used: `wf_equipment`, `wf_staff`, `wf_templates`,
  `wf_processes`, `wf_jobs` (each a JSON blob).

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
