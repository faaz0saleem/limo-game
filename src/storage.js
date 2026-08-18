/**
 * Persistent storage.
 *
 * Two layers, and the split matters:
 *
 * - **The Bridge** is the record of truth for progress. Portals require saves to
 *   go through their SDK rather than through `localStorage`, and it is also the
 *   only way a player keeps their garage when they come back on another device
 *   or when the embed partitions storage.
 * - **`localStorage` is a mirror**, kept because the Bridge is asynchronous and
 *   may not be there at all. It lets the game boot with real data instead of
 *   defaults while the platform read is still in flight, and it is the whole
 *   store when the game runs on a plain static host.
 *
 * The mirror is written synchronously so nothing in the game has to await a
 * save. Platform writes are coalesced onto a short timer — a purchase and an
 * end-of-shift can land together — and flushed when the page goes away.
 *
 * Memory backs both, because embedding sites routinely block `localStorage`
 * outright and touching it there *throws* rather than returning null, so even
 * the read needs a guard.
 */

const memory = new Map();

let bridge = null;          // the Playgama Bridge, once it has initialised
let storageType = null;     // the type it wants us to use, if it names one
const dirty = new Set();
let flushTimer = 0;

const FLUSH_DELAY = 800;

/* -------------------------------------------------------------- local layer */

export function getItem(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch { /* blocked */ }
  return memory.get(key) ?? null;
}

function writeLocal(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* blocked; memory holds it */ }
}

/**
 * Device-local only — never synced to the platform.
 *
 * The graphics preset lives here: a phone must not inherit the `ultra` its
 * owner picked on a desktop, and the game reads it at boot, before the Bridge
 * could possibly have answered.
 */
export function setLocalItem(key, value) {
  writeLocal(key, String(value));
}

/** Written to the mirror now and to the platform shortly. */
export function setItem(key, value) {
  writeLocal(key, String(value));
  if (bridge) {
    dirty.add(key);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DELAY);
  }
}

/* ------------------------------------------------------------- Bridge layer */

/** Called by the Playgama adapter once `bridge.initialize()` has resolved. */
export function attachBridge(b) {
  if (!b?.storage) return;
  bridge = b;
  // The Bridge picks the right backing store per platform; if it does not name
  // one we simply omit the argument and let it apply its own default.
  try { storageType = b.storage.defaultType ?? null; } catch { storageType = null; }
}

const withType = (args) => (storageType ? [...args, storageType] : args);

/**
 * Read a key back from the platform and adopt it.
 *
 * @returns {Promise<string|null>} the platform's value, or the local mirror
 *   when there is no platform to ask or it could not answer.
 */
export async function hydrate(key) {
  if (!bridge?.storage?.get) return getItem(key);

  let value;
  try {
    value = await bridge.storage.get(...withType([key]));
  } catch (err) {
    console.warn('[storage] platform read failed', err);
    return getItem(key);
  }

  // Some platforms answer a single key with a one-element array, and some hand
  // back the parsed object rather than the string that was written.
  if (Array.isArray(value)) value = value[0];
  if (value === null || value === undefined) {
    /*
     * Nothing up there yet — either a new player, or one who played before the
     * SDK was integrated. Push the local save up so that progress is adopted
     * rather than orphaned; this is the only migration path they have.
     */
    const local = getItem(key);
    if (local) setItem(key, local);
    return local;
  }

  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  writeLocal(key, raw);
  return raw;
}

/** Push every pending key to the platform now. */
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!bridge?.storage?.set) { dirty.clear(); return; }

  for (const key of [...dirty]) {
    dirty.delete(key);
    const value = memory.get(key);
    if (value === undefined) continue;
    try {
      const p = bridge.storage.set(...withType([key, value]));
      p?.catch?.((err) => console.warn('[storage] platform write failed', err));
    } catch (err) {
      console.warn('[storage] platform write failed', err);
    }
  }
}

/*
 * A shift can end seconds before the player closes the tab, so the debounce
 * needs an escape hatch. `pagehide` and a hidden `visibilitychange` are the two
 * events that actually fire on mobile — `beforeunload` does not.
 */
if (typeof window !== 'undefined') {
  const onLeave = () => flush();
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
  });
}
