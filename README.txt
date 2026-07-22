WELDCELL SCHEDULER + WIP IMPORTER — OFFLINE PACKAGE
====================================================

Everything in this folder runs entirely on this PC. Nothing here makes
any network connection, and nothing is sent anywhere else — that's a
hard requirement both tools are built to, not just a setting.


WHAT'S IN HERE
--------------

wip-importer.html      The WIP importer. Just double-click it — it opens
                        in your browser directly, no setup needed.

scheduler/              The scheduler app. This one needs to be "served"
                        (see below) rather than opened directly, because
                        of how the built files are packaged.


HOW TO RUN THE SCHEDULER
-------------------------

The scheduler can't just be double-clicked open like the importer can —
modern browsers won't load it correctly straight off disk. It needs a
tiny local web server, which is what serve.py / serve.js do. Either one
works identically; use whichever language happens to already be on this
PC. Neither needs installing anything else, and both only ever listen on
this machine (127.0.0.1) — nothing on the network can reach them.

Easiest way:

  Windows:      double-click  scheduler\start-windows.bat
  Mac / Linux:  double-click  scheduler/start-mac-linux.command
                (or, in a terminal: ./start-mac-linux.command)

Either script finds Python or Node.js automatically and starts the
server. A window will open saying:

  Weldcell Scheduler running at http://localhost:8080

Open that address in your browser (Chrome, Firefox, Edge — any modern
browser works) and use the app normally. Leave that window open while
you're using the scheduler; closing it stops the server. To stop it
yourself, press Ctrl+C in that window.

If double-clicking doesn't work on this PC, open a terminal / command
prompt in the scheduler folder and run one of:

  python3 serve.py       (Mac/Linux, most common)
  python serve.py        (Windows, or older Python installs)
  node serve.js           (if Node.js is installed instead of Python)

Add a port number if 8080 is already taken by something else, e.g.
`python3 serve.py 8090`, then open http://localhost:8090 instead.

If NEITHER Python nor Node.js is on this PC, install one of them first
(python.org or nodejs.org — pick whichever's easier to get approved/
installed here) and try again. No other setup is required either way.


DATA / PRIVACY NOTES
---------------------

- The scheduler saves its data (jobs, equipment, staff, roster) in the
  browser's local storage, tied to this PC and this browser. It doesn't
  sync anywhere. Different browser = a separate empty copy of the app.
- The WIP importer never saves the WIP data it reads at all — only your
  keyword/mapping *settings* are remembered (also local-only). Closing
  the tab discards the loaded spreadsheet completely.
- To double check either tool truly makes no network calls: open your
  browser's DevTools (F12) → Network tab, use the app for a bit, and
  confirm the request list stays empty (aside from the initial page
  load from localhost, for the scheduler).


REBUILDING THIS PACKAGE LATER
-------------------------------
This is a built snapshot of the scheduler, not the source code — it's
meant for running/demoing, not editing. If the source changes later,
this folder needs to be regenerated (`npm run build` in the scheduler
project, then copy scheduler/dist/* over scheduler/ in this package) to
pick up the changes. Ask Claude Code to do that from the source project
if/when needed.
