# Weldcell Scheduler

Production-workflow scheduler for a robotic welding and thermal-spray
department. Plans the month's jobs across equipment and staff based on skills,
rosters, shifts, and leave, with drag-and-drop rescheduling, repeat-job
templates, financial tracking, and a department value report.

## Requirements

- Node.js 20 LTS or later
- npm

## Getting started

```bash
npm install
npm run dev
```

Then open http://localhost:5173 (the dev server is configured to open it for
you).

## Scripts

| Command           | Description                              |
| ----------------- | ---------------------------------------- |
| `npm run dev`     | Start the dev server with hot reload     |
| `npm run build`   | Production build into `dist/`            |
| `npm run preview` | Serve the production build locally       |

## Data & persistence

The app stores everything in your browser via `localStorage` (see
`src/storage.js`). Data persists across refreshes on the same browser, but is
**not** shared between machines yet — the office view and a workshop-monitor
view would each keep their own copy. See `CLAUDE.md` for how to add a shared
backend.

To reset all data, clear this site's localStorage in your browser dev tools
(keys are prefixed `wf::`).

## Project notes

This project was migrated from a Claude artifact. `CLAUDE.md` documents the
architecture, the scheduling invariants, and the two outstanding
integration tasks (shared multi-user persistence, and Microsoft Dynamics 365
Business Central sync). If you use Claude Code, it will read `CLAUDE.md`
automatically at the start of each session.
