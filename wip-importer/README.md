# WIP Importer

An offline tool that turns a Business Central WIP export into jobs for the
Weldcell Scheduler.

## Using it

Open `wip-importer.html` in any modern browser (Chrome, Edge, Firefox, or
Safari). That's it — there is nothing to install and no server to run.

1. **Load** the `.xlsx` WIP worksheet exported from Business Central.
2. **Keywords** — set the words that identify your department's jobs (matched
   against the Description column), plus optional exclusions and combination
   rules.
3. **Column mapping** — auto-detected from the file; adjust if needed.
4. **Review** — every matched job is shown with the reason it matched.
   Duplicates, held-for-review, and already-complete jobs are separated out.
   Tick/untick anything; nothing is exported unless it's ticked.
5. **Export** — download a `.json` file of jobs for the scheduler, or a `.csv`
   review copy.

## Offline & privacy

This tool makes **no network requests**. Your WIP file is read locally in the
browser and never uploaded. You can confirm this by opening DevTools → Network
and watching nothing happen when you load a file — or just disconnect from the
network and use it as normal. The uploaded file is held in memory only and is
gone when you close the tab. Only your keyword settings are saved (to this
browser's local storage).

## Moving your settings

Your keyword lists and combination rules live in this browser. Use **Save
settings to file** / **Load settings from file** (in step 2) to copy them to
another browser or computer. The settings file contains only keywords and rules
— no WIP data — so it is safe to share or store.

## Relationship to the scheduler

This tool's JSON export is designed to be imported by the Weldcell Scheduler
(the sibling project in this workspace). See `CLAUDE.md` for the exact export
contract and the reasoning behind fields that are intentionally left blank
(hours, process, department value).

## Editing it

Everything is in the single file `wip-importer.html` — HTML, CSS and JavaScript
inline. There is no build step. Open it in an editor, change it, refresh the
browser. Please read `CLAUDE.md` before making changes: it documents the hard
constraints (chiefly: it must stay offline, single-file, and dependency-free)
and the behavioural rules that encode past bug fixes.
