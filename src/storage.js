/**
 * Persistent storage.
 *
 * Wrapped because embedding sites routinely partition or block third-party
 * storage — touching `localStorage` there throws rather than returning null,
 * so even the read needs a guard. Falls back to memory, which keeps a session
 * working even when nothing can be saved.
 */

const memory = new Map();

export function getItem(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch { /* blocked */ }
  return memory.get(key) ?? null;
}

export function setItem(key, value) {
  const v = String(value);
  memory.set(key, v);
  try { localStorage.setItem(key, v); } catch { /* blocked; memory holds it */ }
}
