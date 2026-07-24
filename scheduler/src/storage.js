/*
 * Local persistence shim.
 * ------------------------------------------------------------------
 * The scheduler component was originally written to run as a Claude
 * artifact, where a global `window.storage` object provided async
 * get/set/delete/list backed by Anthropic's artifact storage.
 *
 * That global does not exist outside the artifact runtime, so this
 * module reimplements the exact same interface on top of the browser's
 * localStorage. The component calls window.storage.* unchanged.
 *
 * INTERFACE (all async, mirroring the original):
 *   get(key, shared?)    -> { key, value, shared } | null
 *   set(key, value, shared?) -> { key, value, shared } | null
 *   delete(key, shared?) -> { key, deleted, shared } | null
 *   list(prefix?, shared?) -> { keys, prefix?, shared } | null
 *
 * NOTES / LIMITATIONS vs. the artifact version:
 *   - `shared` is accepted for signature compatibility but is a no-op
 *     here: localStorage is per-browser, per-origin, so there is no
 *     real multi-user sharing. The original app used shared=true so the
 *     office and workshop-monitor views saw the same live data. To get
 *     that behaviour back you need a real backend (see CLAUDE.md, the
 *     "Persistence / multi-user" section). This shim intentionally keeps
 *     the same interface so swapping in that backend later is a
 *     localised change to this one file.
 *   - Values are JSON strings, exactly as the component passes them.
 *   - localStorage is synchronous; we wrap in Promise.resolve to keep
 *     the async contract the component awaits on.
 */

const NS = 'wf::'; // namespace prefix to avoid clashing with anything else on the origin

function installLocalStorageShim() {
  const storage = {
    async get(key /*, shared */) {
      try {
        const raw = localStorage.getItem(NS + key);
        if (raw === null) return null;
        return { key, value: raw, shared: false };
      } catch (e) {
        console.error('[storage.get] failed', key, e);
        return null;
      }
    },

    async set(key, value /*, shared */) {
      try {
        localStorage.setItem(NS + key, value);
        return { key, value, shared: false };
      } catch (e) {
        console.error('[storage.set] failed', key, e);
        return null;
      }
    },

    async delete(key /*, shared */) {
      try {
        localStorage.removeItem(NS + key);
        return { key, deleted: true, shared: false };
      } catch (e) {
        console.error('[storage.delete] failed', key, e);
        return null;
      }
    },

    async list(prefix = '' /*, shared */) {
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
    },
  };

  return storage;
}

/*
 * Attach the shim to window.storage if (and only if) it isn't already
 * present. This means: inside a Claude artifact the real API wins; run
 * locally, the localStorage shim fills in. Import this module once, at
 * app startup, before the scheduler mounts.
 */
export function ensureStorage() {
  if (typeof window === 'undefined') return;
  if (!window.storage) {
    window.storage = installLocalStorageShim();
  }
}

export default ensureStorage;
