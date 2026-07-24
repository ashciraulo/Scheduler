/*
 * Live sync for the shared deployment.
 * ------------------------------------------------------------------
 * When the app is served by the offline-package's serve.py / serve.js,
 * several people have the schedule open at once. The server keeps a
 * version counter that it bumps on every write, so a viewer can tell
 * cheaply — one tiny GET — whether anything has changed since it last
 * looked, without pulling the whole schedule down each time.
 *
 * This module does that polling and calls back when the version moves
 * ahead of what we already know about. It does NOT decide what to do
 * about it; the app re-reads its data into state (see `reloadFromStore`
 * in WeldingScheduler).
 *
 * HISTORY: this used to `location.reload()` the whole page on every
 * change, which meant re-downloading and re-parsing the bundle, and
 * losing which tab you were on — so there was a sessionStorage dance to
 * save and restore the tab and scroll position afterwards. Re-reading
 * into React state instead makes all of that unnecessary: no flicker on
 * the shop-floor display screens, no lost UI state, no reload hack.
 *
 * In local (localStorage) mode there's no /api to poll, so the probe in
 * storage.js reports not-shared and this quietly does nothing.
 */

import { getLastKnownVersion, noteVersion, storageReady } from './storage.js';

const DEFAULT_INTERVAL = 4000;

/**
 * Poll the shared store for changes made by other people.
 *
 * @param {() => void} onRemoteChange  called when the server version has
 *        advanced past what we know about. May be called repeatedly; the
 *        app is expected to coalesce (e.g. defer while a dialog is open).
 * @param {number} intervalMs
 * @returns {() => void} stop function
 */
export function startLiveSync(onRemoteChange, intervalMs = DEFAULT_INTERVAL) {
  let stopped = false;
  let timer = null;

  async function poll() {
    if (stopped) return;
    // Don't poll a tab nobody is looking at — it wakes laptops and costs the
    // host PC requests for nothing. The visibilitychange handler below polls
    // immediately on return, so coming back is still instant.
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (!r.ok) return;
      const { version } = await r.json();
      if (typeof version !== 'number') return;
      const known = getLastKnownVersion();
      if (known === null) {
        noteVersion(version);
        return;
      }
      if (version > known) {
        // Record it before calling back, so a slow re-read doesn't cause the
        // next tick to report the same change again.
        noteVersion(version);
        onRemoteChange();
      }
    } catch (e) {
      // Host asleep, network blip, server restarting — try again next tick.
    }
  }

  function onVisible() { if (!document.hidden) poll(); }

  // Only worth running at all against a shared store. Await the probe itself —
  // it's a real network round trip, so checking a synchronous "are we shared"
  // flag here would read false on a shared host and silently never poll.
  (async () => {
    const shared = await storageReady();
    if (stopped || !shared) return;
    timer = setInterval(poll, intervalMs);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    poll();
  })();

  return function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}

export default startLiveSync;
