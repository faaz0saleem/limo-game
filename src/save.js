/**
 * Persistent state. Uses the Poki SDK's storage-friendly localStorage when
 * available and degrades to an in-memory object when storage is blocked
 * (private browsing, sandboxed iframes).
 */

const KEY = 'limo-drift-save-v1';

const DEFAULTS = {
  cash: 0,
  bestLevel: 1,
  levelUnlocked: 1,
  highScore: 0,
  levelScores: {},
  totalDeliveries: 0,
  longestLimo: 1,
  bestDriftAngle: 0,
  owned: { underglow: ['none'], horn: ['stock'], hat: ['none'] },
  equipped: { underglow: 'none', horn: 'stock', hat: 'none' },
  muted: false,
  seenTutorial: false,
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const bv = out[k];
    const pv = patch[k];
    if (bv && pv && typeof bv === 'object' && typeof pv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

class SaveStore {
  constructor() {
    this.memoryOnly = false;
    this.data = deepMerge(DEFAULTS, this._read());
  }

  _read() {
    try {
      const raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      this.memoryOnly = true;
      return null;
    }
  }

  save() {
    if (this.memoryOnly) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (err) {
      this.memoryOnly = true;
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  addCash(amount) {
    this.data.cash = Math.max(0, Math.round(this.data.cash + amount));
    this.save();
    return this.data.cash;
  }

  spendCash(amount) {
    if (this.data.cash < amount) return false;
    this.data.cash -= amount;
    this.save();
    return true;
  }

  owns(slot, id) {
    return (this.data.owned[slot] || []).includes(id);
  }

  unlock(slot, id) {
    if (!this.data.owned[slot]) this.data.owned[slot] = [];
    if (!this.data.owned[slot].includes(id)) this.data.owned[slot].push(id);
    this.save();
  }

  equip(slot, id) {
    this.data.equipped[slot] = id;
    this.save();
  }

  recordRun({ level, score, driftAngle, segments, delivered }) {
    const d = this.data;
    const prev = d.levelScores[level] || 0;
    if (score > prev) d.levelScores[level] = score;
    if (score > d.highScore) d.highScore = score;
    if (driftAngle > d.bestDriftAngle) d.bestDriftAngle = driftAngle;
    if (segments > d.longestLimo) d.longestLimo = segments;
    if (delivered) {
      d.totalDeliveries += 1;
      if (level >= d.levelUnlocked) d.levelUnlocked = level + 1;
      if (level + 1 > d.bestLevel) d.bestLevel = level + 1;
    }
    this.save();
  }

  reset() {
    this.data = deepMerge(DEFAULTS, {});
    this.save();
  }
}

export const Save = new SaveStore();
