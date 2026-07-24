# Weldcell Workspace

Production-workflow tooling for a robotic welding / thermal-spray department.

## Projects

- **`scheduler/`** — the Weldcell Scheduler: a Vite + React app that plans jobs
  across equipment and staff, tracks cost and margin, and reads Business
  Central WIP exports directly. Has a build step. See `scheduler/README.md` to
  run it (`npm install` then `npm run dev`).

- **`offline-package/`** — the deployable snapshot: the built app plus a small
  Python/Node server so one PC on the network can host the shared schedule for
  everyone else. Generated from `scheduler/`, not edited by hand.

## The workflow

```
Business Central WIP export (.xlsx)
        │
        ▼
   scheduler  ──  Job Backlog → "Import from BC WIP export"
```

The scheduler reads BC's `.xlsx` itself: it finds the department's jobs by
keyword, drops duplicates, flags anything questionable, checks for
already-imported jobs, and lets you assign a template per job to supply the
hours BC doesn't carry.

> A standalone single-file WIP importer (`wip-importer/wip-importer.html`) used
> to do the spreadsheet half of this as a separate tool. It was retired once the
> scheduler could read `.xlsx` directly — its engine now lives in
> `scheduler/src/wipImport.js`. It remains in git history if it's ever needed
> again. The scheduler still accepts the `.json` that tool produced, so old
> exports keep working.

## Working on these

Open this folder in your editor (VSCodium is set up with recommended
extensions). If you use Claude Code, it will read `CLAUDE.md` here and in each
subproject automatically. Please skim the relevant `CLAUDE.md` before making
changes.
