#!/usr/bin/env node
/*
 * Serves this folder at http://localhost:PORT so the Weldcell Scheduler can
 * load correctly. (It can't just be opened as a file:// URL — the built app
 * uses ES modules and absolute asset paths, which browsers block/mis-resolve
 * without a real HTTP server.)
 *
 * No installation and no internet access required — this uses only Node's
 * built-in modules, and only ever listens on 127.0.0.1 (this machine only,
 * never reachable from the network), matching the "runs fully offline"
 * design of this tool. All app data stays in this browser's local storage;
 * nothing here reads, writes, or transmits it anywhere else.
 *
 * Usage:
 *     node serve.js [port]      (default port: 8080)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Weldcell Scheduler running at http://localhost:${PORT}`);
  console.log('Leave this window open while you use it. Press Ctrl+C to stop.');
});
