/*
 * Persistence seam.
 * ------------------------------------------------------------------
 * The scheduler component was originally written to run as a Claude
 * artifact, where a global `window.storage` object provided async
 * get/set/delete/list. That global doesn't exist outside the artifact
 * runtime, so this module provides the same interface. The component
 * calls window.storage.* unchanged — treat this file as the ONLY place
 * that knows where data actually lives.
 *
 * There are two backends, chosen at startup by probing the server:
 *
 *   SHARED   When the page is served by the offline-package's serve.py /
 *            serve.js, a small key/value API lives at /api. Everyone on
 *            the network then reads and writes ONE schedule on the host
 *            PC, which is the whole point of the shared deployment.
 *
 *   LOCAL    Otherwise (vite dev, a plain static host, a file:// open),
 *            fall back to this browser's localStorage. The app still
 *            works, it's just per-browser.
 *
 * The probe matters: without it, "the API isn't here" and "that key
 * doesn't exist yet" both look like a failed fetch, and the app would
 * quietly use localStorage on a machine that has a perfectly good shared
 * store. It's checked ONCE and every method awaits the result.
 *
 * INTERFACE (all async, mirroring the original):
 *   get(key, shared?)        -> { key, value, shared } | null
 *   set(key, value, shared?) -> { key, value, shared } | null
 *   delete(key, shared?)     -> { key, deleted, shared } | null
 *   list(prefix?, shared?)   -> { keys, prefix, shared } | null
 *
 * The `shared` argument is accepted for signature compatibility and
 * ignored — which backend is in use is decided by the probe, not per
 * call. The returned `shared` flag reports what actually happened.
 *
 * HISTORY: this adapter used to be an inline <script> hand-injected into
 * offline-package/scheduler/index.html, which meant re-injecting it (and
 * fixing Vite's content-hashed asset names) by hand after every build.
 * Getting that wrong failed silently — the app fell back to localStorage
 * and looked fine while quietly not sharing anything. Living here, it is
 * built like the rest of the app and `dist/` is the deployable verbatim.
 */

const NS = 'wf::';       // localStorage namespace, to avoid clashes on the origin
const KV = '/api/kv/';
const VERSION_URL = '/api/version';
const KEYS_URL = '/api/keys';

// The shared store's version counter — bumped by the server on every write.
// Tracking it lets liveSync tell "someone else changed something" from "that
// was my own write coming back".
let lastKnownVersion = null;
let sharedActive = false;

export function getLastKnownVersion() { return lastKnownVersion; }
export function isShared() { return sharedActive; }

/**
 * Resolves true once we know a shared store is present, false if there isn't
 * one. Await this rather than reading isShared() — the probe is a real network
 * round trip, so isShared() is false until it lands and anything that checks
 * it too early concludes "local" on a machine that is in fact shared.
 */
export function storageReady() { return probeApi(); }

/**
 * Record a version we already know about (our own write, or one liveSync has
 * just applied), so it isn't mistaken for someone else's change.
 */
export function noteVersion(v) {
  if (typeof v !== 'number') return;
  if (lastKnownVersion === null || v > lastKnownVersion) lastKnownVersion = v;
}

/* ---------------- localStorage backend ---------------- */

function lsGet(key) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? null : { key, value: raw, shared: false };
  } catch (e) {
    console.error('[storage.get] failed', key, e);
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(NS + key, value);
    return { key, value, shared: false };
  } catch (e) {
    console.error('[storage.set] failed', key, e);
    return null;
  }
}
function lsDelete(key) {
  try {
    localStorage.removeItem(NS + key);
    return { key, deleted: true, shared: false };
  } catch (e) {
    console.error('[storage.delete] failed', key, e);
    return null;
  }
}
function lsList(prefix = '') {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (full && full.startsWith(NS)) {
        const bare = full.slice(NS.length);
        if (bare.startsWith(prefix)) keys.push(bare);
      }
    }
    return { keys, prefix, shared: false };
  } catch (e) {
    console.error('[storage.list] failed', prefix, e);
    return null;
  }
}

/* ---------------- shared (/api) backend ---------------- */

// Probed once, awaited by every method. Resolves true only if /api/version
// answers with a real version number.
let apiReady = null;
function probeApi() {
  if (apiReady) return apiReady;
  apiReady = (async () => {
    try {
      const r = await fetch(VERSION_URL, { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      if (typeof j.version !== 'number') return false;
      lastKnownVersion = j.version;
      sharedActive = true;
      return true;
    } catch (e) {
      return false;
    }
  })();
  return apiReady;
}

const storage = {
  async get(key /* , shared */) {
    if (!(await probeApi())) return lsGet(key);
    try {
      const r = await fetch(KV + encodeURIComponent(key), { cache: 'no-store' });
      if (r.status === 404) return null; // key genuinely absent, not an outage
      if (!r.ok) throw new Error(`GET ${key} -> ${r.status}`);
      const j = await r.json();
      return { key, value: j.value, shared: true };
    } catch (e) {
      // The host went away mid-session; keep working against localStorage
      // rather than losing the user's work.
      console.warn('[storage.get] shared store unreachable, using local copy', key, e);
      return lsGet(key);
    }
  },

  async set(key, value /* , shared */) {
    if (!(await probeApi())) return lsSet(key, value);
    try {
      const r = await fetch(KV + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: value,
      });
      if (!r.ok) throw new Error(`PUT ${key} -> ${r.status}`);
      const j = await r.json();
      noteVersion(j.version);
      return { key, value, shared: true };
    } catch (e) {
      console.warn('[storage.set] shared store unreachable, saving locally', key, e);
      return lsSet(key, value);
    }
  },

  async delete(key /* , shared */) {
    if (!(await probeApi())) return lsDelete(key);
    try {
      const r = await fetch(KV + encodeURIComponent(key), { method: 'DELETE' });
      if (!r.ok) throw new Error(`DELETE ${key} -> ${r.status}`);
      const j = await r.json();
      noteVersion(j.version);
      return { key, deleted: true, shared: true };
    } catch (e) {
      console.warn('[storage.delete] shared store unreachable, deleting locally', key, e);
      return lsDelete(key);
    }
  },

  async list(prefix = '' /* , shared */) {
    if (!(await probeApi())) return lsList(prefix);
    try {
      const r = await fetch(`${KEYS_URL}?prefix=${encodeURIComponent(prefix)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`GET keys -> ${r.status}`);
      const j = await r.json();
      return { keys: j.keys, prefix: j.prefix, shared: true };
    } catch (e) {
      console.warn('[storage.list] shared store unreachable, listing locally', prefix, e);
      return lsList(prefix);
    }
  },
};

/*
 * Attach to window.storage if (and only if) it isn't already present. Inside a
 * Claude artifact the real API wins; everywhere else this fills in. Import
 * once, at app startup, before the scheduler mounts.
 */
export function ensureStorage() {
  if (typeof window === 'undefined') return;
  if (!window.storage) {
    window.storage = storage;
    probeApi(); // start the probe now so the first read isn't waiting on it
  }
}

export default ensureStorage;
