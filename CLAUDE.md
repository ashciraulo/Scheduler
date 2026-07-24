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

These are intentionally different kinds of artifact. Do not try to fold the
importer into the scheduler's build — its value is in being a standalone file
that runs offline with nothing installed. Keep them separate.

## How they connect

The importer produces a JSON file whose job objects match the shape the
scheduler consumes. That JSON is the only coupling between them. Both
`CLAUDE.md` files describe this export contract; if you change the job shape in
one, update the other.

The end-to-end flow the user wants:
`BC WIP export (.xlsx)` → **wip-importer** → `jobs (.json)` → **scheduler**.

This loop is now closed: the scheduler's Job Backlog tab has an "Import from
WIP export" screen that reads the importer's JSON, dedupes against existing
jobs, and lets the user assign a template per job to fill in the process/hours
the importer can't know. See `scheduler/CLAUDE.md` → "Importing jobs from the
WIP importer" for how it works and what to keep in sync.

## Working here

- Work in whichever subproject the task belongs to, and honour that project's
  `CLAUDE.md` — especially the importer's hard constraints (offline, single-file,
  dependency-free).
- Use Git branches and commit checkpoints before large changes.
- The two projects don't share code or dependencies; a change in one usually
  doesn't affect the other except through the JSON contract.

## Background

Both tools were originally built as Claude artifacts and moved into local
projects for development in VSCodium with Claude Code. Some history and rationale
lives in the per-project `CLAUDE.md` files.
