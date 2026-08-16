import { getItem, setItem } from '../storage.js';

/**
 * Persistent records and settings. Everything is defensive: a corrupt or
 * missing store just yields defaults rather than breaking the boot.
 */

const KEY = 'limo.save.v1';

const DEFAULTS = {
  wallet: 0,              // cash banked across shifts, spent in the garage
  owned: ['classic'],
  car: 'classic',
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
      const raw = getItem(KEY);
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
      setItem(KEY, JSON.stringify(this.data));
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
    d.wallet += Math.max(0, Math.round(cash));
    d.totalFares += fares;
    d.totalDistance += distance;
    d.shiftsPlayed += 1;

    this.save();
    return records;
  }

  /** @returns {boolean} whether the purchase went through */
  buy(car) {
    const d = this.load();
    if (d.owned.includes(car.id)) return true;
    if (d.wallet < car.price) return false;
    d.wallet -= car.price;
    d.owned.push(car.id);
    d.car = car.id;
    this.save();
    return true;
  }

  equip(id) {
    const d = this.load();
    if (!d.owned.includes(id)) return false;
    d.car = id;
    this.save();
    return true;
  }

  reset() {
    this.data = clone(DEFAULTS);
    this._loaded = true;
    this.save();
  }
}

export const save = new Save();
