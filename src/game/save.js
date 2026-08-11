import { portal } from '../portal.js';

/**
 * Persistent records and settings, routed through the portal so they survive
 * a partitioned iframe. Everything is defensive: a corrupt or missing store
 * just yields defaults rather than breaking the boot.
 */

const KEY = 'limo.save.v1';

const DEFAULTS = {
  bestCash: 0,
  bestDrift: 0,
  bestFares: 0,
  totalFares: 0,
  totalDistance: 0,
  topSpeed: 0,
  shiftsPlayed: 0,
  settings: {
    quality: null,        // null = auto-detect from the device
    sound: true,
    music: true,
    volume: 0.8,
    camera: 'chase',
  },
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

class Save {
  constructor() {
    this.data = clone(DEFAULTS);
    this._loaded = false;
  }

  load() {
    if (this._loaded) return this.data;
    this._loaded = true;
    try {
      const raw = portal.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = {
          ...clone(DEFAULTS),
          ...parsed,
          settings: { ...DEFAULTS.settings, ...(parsed.settings ?? {}) },
        };
      }
    } catch {
      this.data = clone(DEFAULTS);
    }
    return this.data;
  }

  save() {
    try {
      portal.setItem(KEY, JSON.stringify(this.data));
    } catch { /* nothing we can do; the session still works */ }
  }

  get settings() {
    return this.load().settings;
  }

  setSetting(key, value) {
    this.load().settings[key] = value;
    this.save();
  }

  /**
   * Fold a finished shift into the lifetime records.
   * @returns {object} which categories set a new personal best
   */
  recordShift({ cash, fares, bestDrift, distance, topSpeed }) {
    const d = this.load();
    const records = {
      cash: cash > d.bestCash,
      drift: bestDrift > d.bestDrift,
      fares: fares > d.bestFares,
      speed: topSpeed > d.topSpeed,
    };

    d.bestCash = Math.max(d.bestCash, cash);
    d.bestDrift = Math.max(d.bestDrift, bestDrift);
    d.bestFares = Math.max(d.bestFares, fares);
    d.topSpeed = Math.max(d.topSpeed, topSpeed);
    d.totalFares += fares;
    d.totalDistance += distance;
    d.shiftsPlayed += 1;

    this.save();
    return records;
  }

  reset() {
    this.data = clone(DEFAULTS);
    this._loaded = true;
    this.save();
  }
}

export const save = new Save();
