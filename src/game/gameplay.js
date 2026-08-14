import * as THREE from 'three';
import { Beacon } from '../render/effects.js';
import { clamp, mulberry32 } from '../util.js';

/* Fare loop: drive to a waiting passenger, then deliver them to a destination
 * before the meter runs out. Style points come from drifting; the multiplier
 * is what makes taking the scenic, sideways line worth it. */

const PASSENGERS = [
  { name: 'Vivienne Marchetti', tag: 'Opera House', tip: 1.35 },
  { name: 'The Kessler Twins', tag: 'Rooftop Party', tip: 1.2 },
  { name: 'Don Ferraro', tag: 'Don\'t. Spill. Anything.', tip: 1.6 },
  { name: 'Ambassador Reyes', tag: 'Diplomatic Plates', tip: 1.4 },
  { name: 'Suki Nakamura', tag: 'Late For The Set', tip: 1.5 },
  { name: 'Mayor Halloran', tag: 'Discreetly, Please', tip: 1.45 },
  { name: 'Lux & Entourage', tag: 'Six Of Them', tip: 1.25 },
  { name: 'Mr. Sixty-Two', tag: 'No Questions', tip: 1.8 },
];

export const PICKUP_RADIUS = 6.5;

export class Gameplay {
  constructor(scene, city, hud, opts = {}) {
    this.city = city;
    this.hud = hud;
    this.rand = mulberry32(opts.seed ?? 5150);
    // Fired for anything the rest of the game may want to react to (audio,
    // camera, achievements). Kept as a callback so gameplay stays unaware of
    // the audio engine.
    this.onEvent = opts.onEvent ?? (() => {});

    this.beacon = new Beacon(scene, 0xffcb5c);

    this.cash = 0;
    this.fares = 0;
    this.bestDrift = 0;
    this.state = 'seeking';       // 'seeking' | 'carrying'
    this.target = null;
    this.passenger = null;
    this.timeLeft = 0;
    this.timeTotal = 1;

    // Drift scoring.
    this.driftScore = 0;
    this.driftMult = 1;
    this.driftBank = 0;
    this.driftActive = false;
    this._driftCooldown = 0;
    this.comboWindow = 0;

    this.stats = { distance: 0, topSpeed: 0, crashes: 0, longestDrift: 0 };
    this._driftTimer = 0;

    this.nextFare(new THREE.Vector3());
  }

  /** Wipe the shift back to zero and hand out a fresh fare. */
  reset(playerPos) {
    this.cash = 0;
    this.fares = 0;
    this.bestDrift = 0;
    this.driftScore = 0;
    this.driftMult = 1;
    this.driftBank = 0;
    this.driftActive = false;
    this._driftCooldown = 0;
    this._driftTimer = 0;
    this.stats = { distance: 0, topSpeed: 0, crashes: 0, longestDrift: 0, pedestriansHit: 0 };
    this.hud.hideDrift();
    this.nextFare(playerPos);
  }

  /* ------------------------------------------------------------- fares */

  nextFare(playerPos) {
    this.state = 'seeking';
    this.passenger = PASSENGERS[Math.floor(this.rand() * PASSENGERS.length)];
    this.target = this.city.randomSpawn(this.rand, playerPos, 70);
    this.beacon.setColor(0x38e6ff);
    this.beacon.place(this.target);
    this.timeLeft = 0;
    this.hud.setFare({
      label: 'PICK UP',
      name: this.passenger.name,
      sub: this.passenger.tag,
      timer: null,
    });
  }

  _startDelivery(playerPos) {
    this.state = 'carrying';
    this.target = this.city.randomSpawn(this.rand, playerPos, 120);

    const dist = this.target.distanceTo(playerPos);
    // Generous but not free: roughly 22 m/s average including corners.
    this.timeTotal = clamp(dist / 22 + 12, 18, 75);
    this.timeLeft = this.timeTotal;

    this.beacon.setColor(0xffcb5c);
    this.beacon.place(this.target);
    this.hud.setFare({
      label: 'DROP OFF',
      name: this.passenger.name,
      sub: this.passenger.tag,
      timer: 1,
    });
    this.hud.toast(`${this.passenger.name} aboard`, 'good');
    this.onEvent('picked-up');
  }

  _completeDelivery() {
    const timeBonus = clamp(this.timeLeft / this.timeTotal, 0, 1);
    const base = 220 + Math.round(this.timeTotal * 6);
    const payout = Math.round(base * this.passenger.tip * (1 + timeBonus * 0.8));

    this.cash += payout;
    this.fares += 1;
    this.hud.toast(`FARE PAID  +$${payout}`, 'good');
    this.hud.flashCash();
    this.onEvent('fare-paid', { payout });
    return payout;
  }

  _failDelivery() {
    this.hud.toast('FARE LOST — they took a cab', 'bad');
    this.cash = Math.max(0, this.cash - 120);
    this.onEvent('fare-lost');
  }

  /* ------------------------------------------------------------ drifting */

  _updateDrift(vehicle, dt) {
    const slip = Math.abs(vehicle.slipAngle);
    const speed = Math.abs(vehicle.speed);
    const scoring = slip > 0.16 && speed > 8;

    if (scoring) {
      // Points scale with how sideways *and* how fast — a slow slide is
      // worth almost nothing, a fast one at 40° is worth a lot.
      const quality = clamp((slip - 0.13) / 0.72, 0, 1.35);
      this.driftScore += quality * speed * 5.2 * dt;
      // Multiplier grows the longer you hold the slide.
      this.driftMult = clamp(1 + this._driftTimer * 0.35, 1, 8);
      this._driftTimer += dt;
      this._driftCooldown = 1.1;
      this.driftActive = true;
      this.stats.longestDrift = Math.max(this.stats.longestDrift, this._driftTimer);
    } else if (this.driftActive) {
      this._driftCooldown -= dt;
      if (this._driftCooldown <= 0) this._bankDrift();
    }

    if (this.comboWindow > 0) this.comboWindow -= dt;
  }

  _bankDrift() {
    const total = Math.round(this.driftScore * this.driftMult);
    if (total > 40) {
      this.driftBank += total;
      this.cash += Math.round(total * 0.35);
      this.bestDrift = Math.max(this.bestDrift, total);
      this.hud.bankDrift(total);
      this.onEvent('drift-banked', { total });
    } else {
      this.hud.hideDrift();
    }
    this.driftScore = 0;
    this.driftMult = 1;
    this._driftTimer = 0;
    this.driftActive = false;
  }

  /**
   * The player clipped someone on the pavement. It costs them: a fine, and the
   * drift they were building. A chauffeur who drives like this does not get
   * tipped.
   */
  registerPedestrianHit(count, vehicle) {
    const fine = 150 * count;
    this.cash = Math.max(0, this.cash - fine);
    this.stats.pedestriansHit = (this.stats.pedestriansHit ?? 0) + count;
    this.breakDrift();
    this.hud.toast(`PEDESTRIAN HIT  −$${fine}`, 'bad');
    this.onEvent('pedestrian-hit', { count, fine });
  }

  /** A crash cancels the drift you were building. Land it or lose it. */
  breakDrift() {
    if (!this.driftActive && this.driftScore < 1) return;
    if (this.driftScore > 300) this.hud.toast('DRIFT LOST', 'bad');
    this.driftScore = 0;
    this.driftMult = 1;
    this._driftTimer = 0;
    this.driftActive = false;
    this.hud.hideDrift();
  }

  /* -------------------------------------------------------------- frame */

  update(dt, vehicle) {
    this._updateDrift(vehicle, dt);

    this.stats.distance += Math.abs(vehicle.speed) * dt;
    this.stats.topSpeed = Math.max(this.stats.topSpeed, vehicle.kmh);

    const pos = vehicle.position;
    this.beacon.update(dt, pos);

    if (this.state === 'carrying') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this._failDelivery();
        this.nextFare(pos);
      }
    }

    if (this.target) {
      const flat = Math.hypot(pos.x - this.target.x, pos.z - this.target.z);
      const slowEnough = Math.abs(vehicle.speed) < 14;

      if (flat < PICKUP_RADIUS && slowEnough) {
        if (this.state === 'seeking') this._startDelivery(pos);
        else {
          this._completeDelivery();
          this.nextFare(pos);
        }
      }

      this.hud.setFareProgress({
        distance: flat,
        timer: this.state === 'carrying' ? this.timeLeft / this.timeTotal : null,
        seconds: this.state === 'carrying' ? this.timeLeft : null,
        needSlow: flat < PICKUP_RADIUS * 2.2 && !slowEnough,
      });
    }

    this.hud.setStats({
      cash: this.cash,
      fares: this.fares,
      best: this.bestDrift,
    });

    if (this.driftActive) {
      this.hud.showDrift(Math.round(this.driftScore), this.driftMult);
    }
  }

  /** Direction to the current objective, for the on-screen arrow + minimap. */
  get objective() {
    return this.target;
  }
}
