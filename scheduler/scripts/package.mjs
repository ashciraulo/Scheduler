#!/usr/bin/env node
/*
 * Assemble ../offline-package — the folder that actually gets copied to the
 * host PC. Run it with `npm run package` (which builds first).
 *
 * offline-package/ is BUILD OUTPUT. Everything in it comes from either
 * `dist/` (the built app) or `deploy/` (the server, launchers and README,
 * which are hand-written source). Nothing in offline-package/ should ever be
 * edited directly — this script overwrites it.
 *
 * This exists because the previous process was manual: build, copy dist over,
 * then re-inject a shared-storage adapter into index.html by hand against
 * Vite's freshly content-hashed asset filenames. That adapter now lives in
 * src/storage.js and is built into the bundle, so `dist/` is the deployable
 * verbatim and this script is just a copy.
 *
 * Deliberately dependency-free (node: builtins only) so it can't rot.
 */

import { cp, mkdir, rm, readdir, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schedulerDir = path.resolve(here, '..');
const distDir = path.join(schedulerDir, 'dist');
const deployDir = path.join(schedulerDir, 'deploy');
const outRoot = path.resolve(schedulerDir, '..', 'offline-package');
const outApp = path.join(outRoot, 'scheduler');

// Runtime data written by the host's server. It is the live schedule — never
// delete it when re-packaging on a machine that has been serving.
const PRESERVE = new Set(['scheduler-data.json', 'scheduler-data.json.tmp']);

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function main() {
  if (!(await exists(distDir))) {
    console.error('No dist/ found — run `npm run build` first (or use `npm run package`).');
    process.exit(1);
  }

  // Clear the app folder, keeping any live data file.
  if (await exists(outApp)) {
    for (const entry of await readdir(outApp)) {
      if (PRESERVE.has(entry)) continue;
      await rm(path.join(outApp, entry), { recursive: true, force: true });
    }
  }
  await mkdir(outApp, { recursive: true });

  // The built app, exactly as Vite emitted it.
  await cp(distDir, outApp, { recursive: true });

  // The server, launchers and the user-facing README.
  const readme = 'README.txt';
  for (const entry of await readdir(deployDir)) {
    const dest = entry === readme ? path.join(outRoot, entry) : path.join(outApp, entry);
    await cp(path.join(deployDir, entry), dest);
  }

  // Launchers have to be double-clickable on the host.
  for (const script of ['start-mac-linux.command', 'serve.py']) {
    const p = path.join(outApp, script);
    if (await exists(p)) await chmod(p, 0o755);
  }

  const assets = await readdir(path.join(outApp, 'assets')).catch(() => []);
  console.log(`Packaged offline-package/ — ${assets.length} asset file(s) from dist/, server + launchers from deploy/.`);
  console.log('Copy the whole offline-package folder to the host PC.');
}

main().catch((e) => { console.error(e); process.exit(1); });
