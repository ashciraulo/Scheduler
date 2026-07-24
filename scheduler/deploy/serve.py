#!/usr/bin/env python3
"""
Serves this folder so the Weldcell Scheduler can load correctly, and hosts
the shared schedule data so every computer on your network sees the same
information. (The app can't just be opened as a file:// URL — the built app
uses ES modules and absolute asset paths, which browsers block/mis-resolve
without a real HTTP server.)

No installation and no internet access required — this uses only Python's
standard library. It listens on your local network so other computers in
the workshop/office can open the scheduler too; nothing is ever sent
outside your network. Shared data is stored in scheduler-data.json next to
this file — back that file up and you've backed up the schedule.

Usage:
    python3 serve.py [port]            (default port: 8080)
    python3 serve.py --local [port]    (old behaviour: this machine only,
                                        data stays in the browser)
"""
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import urllib.parse

args = [a for a in sys.argv[1:]]
LOCAL_ONLY = "--local" in args
args = [a for a in args if a != "--local"]
PORT = int(args[0]) if args else 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DIRECTORY, "scheduler-data.json")

_lock = threading.Lock()


def _load():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
            if isinstance(d, dict) and isinstance(d.get("entries"), dict):
                return {"version": int(d.get("version", 0)), "entries": d["entries"]}
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"Warning: could not read {DATA_FILE}: {e}")
    return {"version": 0, "entries": {}}


_data = _load()


def _save():
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_data, f)
    os.replace(tmp, DATA_FILE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        pass  # keep the console quiet

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api_key(self):
        # /api/kv/<key> -> key (url-decoded), else None
        p = urllib.parse.urlparse(self.path)
        if p.path.startswith("/api/kv/"):
            return urllib.parse.unquote(p.path[len("/api/kv/"):])
        return None

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/version":
            with _lock:
                return self._json(200, {"version": _data["version"]})
        if p.path == "/api/keys":
            q = urllib.parse.parse_qs(p.query)
            prefix = (q.get("prefix") or [""])[0]
            with _lock:
                keys = [k for k in _data["entries"] if k.startswith(prefix)]
            return self._json(200, {"keys": keys, "prefix": prefix})
        key = self._api_key()
        if key is not None:
            with _lock:
                if key in _data["entries"]:
                    return self._json(200, {"key": key, "value": _data["entries"][key]})
            return self._json(404, {"error": "not found", "key": key})
        return super().do_GET()

    def do_PUT(self):
        key = self._api_key()
        if key is None:
            return self._json(404, {"error": "unknown endpoint"})
        length = int(self.headers.get("Content-Length") or 0)
        value = self.rfile.read(length).decode("utf-8")
        with _lock:
            _data["entries"][key] = value
            _data["version"] += 1
            _save()
            v = _data["version"]
        return self._json(200, {"ok": True, "key": key, "version": v})

    def do_DELETE(self):
        key = self._api_key()
        if key is None:
            return self._json(404, {"error": "unknown endpoint"})
        with _lock:
            _data["entries"].pop(key, None)
            _data["version"] += 1
            _save()
            v = _data["version"]
        return self._json(200, {"ok": True, "key": key, "version": v})


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return None


def main():
    bind = "127.0.0.1" if LOCAL_ONLY else "0.0.0.0"
    with ThreadingTCPServer((bind, PORT), Handler) as httpd:
        print(f"Weldcell Scheduler running at http://localhost:{PORT}")
        if not LOCAL_ONLY:
            ip = _lan_ip()
            if ip:
                print(f"Other computers on your network can open:  http://{ip}:{PORT}")
            print(f"Shared schedule data is saved to: {DATA_FILE}")
        print("Leave this window open while the scheduler is in use. Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
