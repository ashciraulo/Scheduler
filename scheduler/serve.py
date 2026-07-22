#!/usr/bin/env python3
"""
Serves this folder at http://localhost:PORT so the Weldcell Scheduler can
load correctly. (It can't just be opened as a file:// URL — the built app
uses ES modules and absolute asset paths, which browsers block/mis-resolve
without a real HTTP server.)

No installation and no internet access required — this uses only Python's
standard library, and only ever listens on 127.0.0.1 (this machine only,
never reachable from the network), matching the "runs fully offline" design
of this tool. All app data stays in this browser's local storage; nothing
here reads, writes, or transmits it anywhere else.

Usage:
    python3 serve.py [port]      (default port: 8080)
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        pass  # keep the console quiet


def main():
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"Weldcell Scheduler running at {url}")
        print("Open that address in your browser. Leave this window open while you use it.")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
