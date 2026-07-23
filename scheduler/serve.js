#!/usr/bin/env node
/*
 * Serves this folder so the Weldcell Scheduler can load correctly, and hosts
 * the shared schedule data so every computer on your network sees the same
 * information. (The app can't just be opened as a file:// URL — the built app
 * uses ES modules and absolute asset paths, which browsers block/mis-resolve
 * without a real HTTP server.)
 *
 * No installation and no internet access required — this uses only Node's
 * built-in modules. It listens on your local network so other computers in
 * the workshop/office can open the scheduler too; nothing is ever sent
 * outside your network. Shared data is stored in scheduler-data.json next to
 * this file — back that file up and you've backed up the schedule.
 *
 * Usage:
 *     node serve.js [port]            (default port: 8080)
 *     node serve.js --local [port]    (old behaviour: this machine only,
 *                                      data stays in the browser)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rawArgs = process.argv.slice(2);
const LOCAL_ONLY = rawArgs.includes('--local');
const args = rawArgs.filter((a) => a !== '--local');
const PORT = Number(args[0]) || 8080;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'scheduler-data.json');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let data = { version: 0, entries: {} };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  if (d && typeof d === 'object' && d.entries && typeof d.entries === 'object') {
    data = { version: Number(d.version) || 0, entries: d.entries };
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.log(`Warning: could not read ${DATA_FILE}: ${e.message}`);
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function apiKey(pathname) {
  const p = '/api/kv/';
  return pathname.startsWith(p) ? decodeURIComponent(pathname.slice(p.length)) : null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(u.pathname);

  if (pathname === '/api/version' && req.method === 'GET') {
    return sendJson(res, 200, { version: data.version });
  }
  if (pathname === '/api/keys' && req.method === 'GET') {
    const prefix = u.searchParams.get('prefix') || '';
    const keys = Object.keys(data.entries).filter((k) => k.startsWith(prefix));
    return sendJson(res, 200, { keys, prefix });
  }

  const key = apiKey(pathname);
  if (key !== null) {
    if (req.method === 'GET') {
      if (Object.prototype.hasOwnProperty.call(data.entries, key)) {
        return sendJson(res, 200, { key, value: data.entries[key] });
      }
      return sendJson(res, 404, { error: 'not found', key });
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        data.entries[key] = body;
        data.version += 1;
        save();
        sendJson(res, 200, { ok: true, key, version: data.version });
      });
      return;
    }
    if (req.method === 'DELETE') {
      delete data.entries[key];
      data.version += 1;
      save();
      return sendJson(res, 200, { ok: true, key, version: data.version });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // static files
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

const bind = LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0';
server.listen(PORT, bind, () => {
  console.log(`Weldcell Scheduler running at http://localhost:${PORT}`);
  if (!LOCAL_ONLY) {
    const ip = lanIp();
    if (ip) console.log(`Other computers on your network can open:  http://${ip}:${PORT}`);
    console.log(`Shared schedule data is saved to: ${DATA_FILE}`);
  }
  console.log('Leave this window open while the scheduler is in use. Press Ctrl+C to stop.');
});
