# Weldcell Workspace

Two tools for managing production workflow in a robotic welding / thermal-spray
department.

## Projects

- **`scheduler/`** — the Weldcell Scheduler: a Vite + React app that plans jobs
  across equipment and staff. Has a build step. See `scheduler/README.md` to run
  it (`npm install` then `npm run dev`).

- **`wip-importer/`** — an offline, single-file tool that converts a Business
  Central WIP Excel export into jobs for the scheduler. No install — just open
  `wip-importer/wip-importer.html` in a browser. See `wip-importer/README.md`.

## The workflow

```
Business Central WIP export (.xlsx)
        │
        ▼
   wip-importer   ── produces ──▶  jobs (.json)
                                        │
                                        ▼
                                   scheduler
```

The importer's JSON export feeds the scheduler directly: the scheduler's Job
Backlog tab has an "Import from WIP export" screen that reads it, checks for
already-imported jobs, and lets you assign a template per job before adding
them to the schedule.

## Working on these

Open this folder in your editor (VSCodium is set up with recommended
extensions). If you use Claude Code, it will read `CLAUDE.md` here and in each
subproject automatically. Please skim the relevant `CLAUDE.md` before making
changes — the importer in particular has firm constraints (it must stay offline,
single-file and dependency-free).
