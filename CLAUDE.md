# CLAUDE.md — Weldcell Workspace

This workspace holds two related tools for a robotic welding / thermal-spray
department. Read this for orientation, then read the `CLAUDE.md` inside whichever
project you're working in — each has its own detailed one.

## The two projects

### `scheduler/` — Weldcell Scheduler
A Vite + React app for planning the month's jobs across equipment and staff,
respecting skills, rosters, shifts and leave, with drag-and-drop rescheduling,
repeat-job templates, financial tracking, and a department value report. Has a
build step and dependencies. See `scheduler/CLAUDE.md`.

### `wip-importer/` — WIP Importer
A single self-contained, **offline**, zero-dependency HTML file that turns a
Business Central WIP Excel export into a JSON file of jobs for the scheduler.
No build step, no framework, no npm. See `wip-importer/CLAUDE.md`.

These are intentionally different kinds of artifact. The `.html` file must stay
standalone — its value is in running offline with nothing installed. Don't fold
it into the scheduler's build.

## How they connect

The everyday flow is now **one tool**:

`BC WIP export (.xlsx)` → **scheduler** (Job Backlog → "Import from BC WIP
export")

The scheduler reads BC's `.xlsx` directly: the importer's engine was ported to
`scheduler/src/wipImport.js` (XLSX reader, keyword matching, dedupe, completion
flagging, job building), driven by `ImportJobsModal`. The user picks the export,
reviews what matched, assigns templates for the hours BC can't supply, and
imports — no second tool, no file shuffling.

The original path still works, for portability and for anyone already used to
it:

`BC WIP export (.xlsx)` → **wip-importer** → `jobs (.json)` → **scheduler**

**The cost of this is two copies of the same logic**, which is accepted
deliberately (the standalone file cannot import a module without losing the
property that makes it worth having). A change to matching, dedupe, completion
handling or the job shape in either place must be mirrored in the other:

- `wip-importer/wip-importer.html` — `analyse`, `buildSchedulerJobs`
- `scheduler/src/wipImport.js` — the same functions, same rules, commented

Both `CLAUDE.md` files spell out the shared contract and the behavioural rules.

## Working here

- Work in whichever subproject the task belongs to, and honour that project's
  `CLAUDE.md` — especially the importer's hard constraints (offline, single-file,
  dependency-free).
- Use Git branches and commit checkpoints before large changes.
- The two projects don't share code or dependencies. The couplings to watch are
  the job shape and the duplicated WIP logic described above.

## Background

Both tools were originally built as Claude artifacts and moved into local
projects for development in VSCodium with Claude Code. Some history and rationale
lives in the per-project `CLAUDE.md` files.
