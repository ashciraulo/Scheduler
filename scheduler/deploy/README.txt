WELDCELL SCHEDULER
==================

The scheduler is shared across computers on your local network, so a
planner and everyone viewing the schedule all see the same live data.


WHAT'S IN HERE
--------------

scheduler/              The scheduler app. This is "served" from one PC and
                        opened from any computer on the network (see below).

The separate WIP importer tool is no longer needed and is no longer
included: the scheduler now reads the Business Central WIP .xlsx export
itself, under Job Backlog > "Import from BC WIP export". Your keyword
settings are asked for again the first time you use it.


HOW TO RUN THE SCHEDULER (SHARED — the normal way now)
-------------------------------------------------------

Pick ONE computer to be the "host" — it stays on and runs the little
server. Everyone else just opens a browser; nothing is installed on the
other computers. A good host is a PC that's usually left on, or a small
always-on machine in the office. It could also be a link you add to your
SharePoint site that points at this host's address.

On the HOST computer:

  Windows:      double-click  scheduler\start-windows.bat
  Mac / Linux:  double-click  scheduler/start-mac-linux.command
                (or, in a terminal: ./start-mac-linux.command)

Either script finds Python or Node.js automatically and starts the server.
The window will show two addresses, e.g.:

  Weldcell Scheduler running at http://localhost:8080
  Other computers on your network can open:  http://192.168.1.42:8080

Leave that window open while the scheduler is in use — closing it stops the
server for everyone. Press Ctrl+C in that window to stop it.

On EVERY OTHER computer (and on the host too):

  Open the "Other computers on your network" address shown above
  (http://192.168.1.42:8080 in the example — your number will differ) in
  Chrome, Firefox, or Edge. That's it. Everyone sharing that address sees
  and edits the same schedule.

TIP: bookmark that address, or add it to your SharePoint site navigation,
so people can get to it in one click. The host's address usually stays the
same, but if it ever changes (see the note under DATA below), update the
bookmark/link to the new one.

If double-clicking doesn't work on the host, open a terminal / command
prompt in the scheduler folder and run one of:

  python3 serve.py       (Mac/Linux, most common)
  python serve.py        (Windows, or older Python installs)
  node serve.js          (if Node.js is installed instead of Python)

Add a port number if 8080 is already taken, e.g. `python3 serve.py 8090`,
then use http://<host-address>:8090 instead.

If NEITHER Python nor Node.js is on the host PC, install one of them first
(python.org or nodejs.org). Nothing needs installing on the other
computers.


RUNNING IT JUST ON ONE PC (the old single-computer way)
--------------------------------------------------------

If you'd rather keep it to one machine (no other computer can reach it),
start it with --local:

  python3 serve.py --local
  node serve.js --local

Then use http://localhost:8080 on that PC only. Data is still saved to
scheduler/scheduler-data.json on that machine — it's just not shared out to
anyone else, because the server only listens to this PC.


HOW MULTIPLE PEOPLE EDITING WORKS
----------------------------------

- Everyone sees the same jobs, equipment, staff, roster and templates,
  served from the host PC.
- When someone makes a change, other screens update to show it within a
  few seconds. The update happens in place — the page doesn't reload, so
  you stay exactly where you were, on the same tab and scroll position.
- It waits if you're in the middle of something: while you have a window
  open or a job part-way dragged, the update is held back and applied the
  moment you're finished. You can't lose something you're typing.
- This is designed for one or two people planning while others watch. If
  two people edit the very same thing at the very same moment, the most
  recent save wins. The "Editing / View only" and "Display mode" buttons at
  the top right are handy for setting shop-floor screens to view-only.


DATA / BACKUP / PRIVACY NOTES
------------------------------

- In shared mode, all scheduler data lives in ONE file on the host PC:
  scheduler/scheduler-data.json. Back that file up (copy it somewhere safe
  on a schedule) and you've backed up the whole schedule. To move the
  scheduler to a different host, copy this file across too.
- The host's network address (the 192.168.x.x number) is assigned by your
  network. It usually stays put, but if the host reboots and the number
  changes, tell people the new address (or ask IT to reserve a fixed
  address / DNS name for the host if you want it to never change).
- Traffic stays on your local network — the scheduler still makes no
  connections out to the internet. It's "offline" in that sense; it just
  now talks between computers inside your own network so they can share.
- In --local mode, the same scheduler-data.json file is used, but the
  server only listens to this PC, so nothing leaves the machine and no
  other computer can reach it. (If you ever open the app served by some
  other web server that doesn't provide this data store, it automatically
  falls back to that browser's own local storage, exactly like the original
  single-computer version.)
- Importing a WIP export never saves the spreadsheet itself — only your
  keyword settings are remembered. Closing the import window discards the
  loaded spreadsheet completely, and it is read inside your browser, so it
  is never uploaded anywhere.


REBUILDING THIS PACKAGE LATER
------------------------------
This whole folder is generated — don't edit anything in it by hand, as it
all gets overwritten. To produce a new copy after the app changes, run:

  npm run package

in the scheduler project. That builds the app and rebuilds this folder.
Then copy it to the host PC, keeping the host's existing
scheduler/scheduler-data.json (that file is your schedule — the packaging
step leaves it alone, but a copy from another machine would overwrite it,
so back it up first).
