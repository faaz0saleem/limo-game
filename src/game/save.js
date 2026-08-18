import { getItem, setItem, setLocalItem, hydrate as hydrateStore } from '../storage.js';

/**
 * Persistent records and settings. Everything is defensive: a corrupt or
 * missing store just yields defaults rather than breaking the boot.
 *
 * The store underneath is asynchronous when a platform SDK is present, but
 * nothing in the game should have to await a save, so this stays synchronous:
 * `data` is the live copy, `load()` seeds it from the local mirror instantly at
 * boot, and `hydrate()` later adopts the platform's copy if one exists.
 */

const KEY = 'limo.save.v1';

/* Device-local, deliberately outside the synced blob — see storage.js. */
const QUALITY_KEY = 'limo.quality';

const DEFAULTS = {
  wallet: 0,              // cash banked across shifts, spent in the garage
  owned: ['classic'],
  car: 'classic',
  adProgress: {},         // car id -> rewarded ads watched toward unlocking it
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
    this._adopt(getItem(KEY));
    return this.data;
  }

  /**
   * Adopt the platform's copy of the save, if there is one.
   *
   * @param {() => boolean} [skipIf] checked immediately before the swap. The
   *   platform read races the player: if they have already pressed START, their
   *   shift is running against the local copy and replacing it underneath them
   *   would move the wallet mid-game. The local copy is written up on the next
   *   save either way, so nothing is lost by keeping it.
   * @returns {Promise<boolean>} whether the in-memory save actually changed.
   */
  async hydrate(skipIf) {
    const before = JSON.stringify(this.data);
    let raw;
    try {
      raw = await hydrateStore(KEY);
    } catch {
      return false;
    }
    if (skipIf?.()) return false;

    this._loaded = true;
    this._adopt(raw);
    return JSON.stringify(this.data) !== before;
  }

  /** Merge a stored JSON blob over the defaults, tolerating anything. */
  _adopt(raw) {
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      this.data = parsed
        ? {
          ...clone(DEFAULTS),
          ...parsed,
          settings: { ...DEFAULTS.settings, ...(parsed.settings ?? {}) },
        }
        : clone(DEFAULTS);
    } catch {
      this.data = clone(DEFAULTS);
    }
    // The graphics preset never travels between devices.
    const q = getItem(QUALITY_KEY);
    if (q) this.data.settings.quality = q;
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
    if (key === 'quality') setLocalItem(QUALITY_KEY, value);
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

  /**
   * Credit one watched rewarded ad toward a car, and hand it over once the
   * count is met.
   *
   * @returns {{watched: number, needed: number, unlocked: boolean}}
   */
  creditAd(car, needed) {
    const d = this.load();
    if (d.owned.includes(car.id)) {
      return { watched: needed, needed, unlocked: false };
    }
    const watched = Math.min(needed, (d.adProgress[car.id] ?? 0) + 1);
    d.adProgress[car.id] = watched;

    const unlocked = watched >= needed;
    if (unlocked) {
      d.owned.push(car.id);
      d.car = car.id;
      delete d.adProgress[car.id];
    }
    this.save();
    return { watched, needed, unlocked };
  }

  /** How many ads are already banked toward a car. */
  adsWatched(carId) {
    return this.load().adProgress[carId] ?? 0;
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
