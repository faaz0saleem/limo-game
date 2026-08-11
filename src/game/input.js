import { clamp, approach } from '../util.js';

/**
 * Keyboard + gamepad + touch, normalised into one analogue input record.
 * Keyboard steering is ramped rather than binary so the limo doesn't snap
 * from lock to lock.
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = false;
    this.boost = false;

    this.pressed = new Set();   // edge-triggered, cleared each frame
    this._touch = { steer: 0, throttle: 0, brake: 0, handbrake: false };

    this._onDown = (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      this.pressed.add(k);
      // Stop the page scrolling out from under the game.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
        e.preventDefault();
      }
    };
    this._onUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    target.addEventListener('keydown', this._onDown, { passive: false });
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);

    this._bindTouch();
  }

  has(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  /** True once, on the frame the key went down. */
  tapped(...codes) {
    return codes.some((c) => this.pressed.has(c));
  }

  _bindTouch() {
    // `ontouchstart` is also true on touch-capable laptops, which have a
    // keyboard and don't want a thumb pad over the view. A coarse pointer is
    // the signal that actually means "phone or tablet".
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
    if (!coarse) return;
    const zones = document.createElement('div');
    zones.id = 'touch-zones';
    zones.innerHTML = `
      <button class="tz tz-left"  data-act="left">◀</button>
      <button class="tz tz-right" data-act="right">▶</button>
      <button class="tz tz-gas"   data-act="gas">▲</button>
      <button class="tz tz-brake" data-act="brake">▼</button>
      <button class="tz tz-hb"    data-act="hb">HB</button>`;
    Object.assign(zones.style, {
      position: 'fixed', inset: '0', zIndex: '25', pointerEvents: 'none',
    });
    document.body.appendChild(zones);

    const style = document.createElement('style');
    style.textContent = `
      .tz{position:fixed;pointer-events:auto;width:74px;height:74px;border-radius:50%;
        border:1px solid rgba(140,175,255,.35);background:rgba(12,16,28,.55);
        color:#dce6ff;font-size:20px;backdrop-filter:blur(4px);touch-action:none}
      .tz:active{background:rgba(80,120,220,.5)}
      .tz-left{left:18px;bottom:104px}.tz-right{left:104px;bottom:104px}
      .tz-gas{right:18px;bottom:150px}.tz-brake{right:104px;bottom:104px}
      .tz-hb{right:18px;bottom:36px;width:64px;height:64px;font-size:13px}`;
    document.head.appendChild(style);

    const set = (act, on) => {
      if (act === 'left') this._touch.steer = on ? -1 : 0;
      if (act === 'right') this._touch.steer = on ? 1 : 0;
      if (act === 'gas') this._touch.throttle = on ? 1 : 0;
      if (act === 'brake') this._touch.brake = on ? 1 : 0;
      if (act === 'hb') this._touch.handbrake = on;
    };

    for (const btn of zones.querySelectorAll('.tz')) {
      const act = btn.dataset.act;
      const down = (e) => { e.preventDefault(); set(act, true); };
      const up = (e) => { e.preventDefault(); set(act, false); };
      btn.addEventListener('touchstart', down, { passive: false });
      btn.addEventListener('touchend', up, { passive: false });
      btn.addEventListener('touchcancel', up, { passive: false });
    }
    this.touchZones = zones;
  }

  _gamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (p && p.connected) return p;
    }
    return null;
  }

  update(dt) {
    const pad = this._gamepad();
    const dead = (v) => (Math.abs(v) < 0.14 ? 0 : v);

    let steerTarget = 0;
    if (this.has('KeyA', 'ArrowLeft')) steerTarget -= 1;
    if (this.has('KeyD', 'ArrowRight')) steerTarget += 1;
    steerTarget += this._touch.steer;
    if (pad) steerTarget += dead(pad.axes[0] ?? 0);
    steerTarget = clamp(steerTarget, -1, 1);

    // Ramp toward the target; snap back to centre faster than we turn in.
    const rate = steerTarget === 0 ? 5.5 : 3.4;
    this.steer = approach(this.steer, steerTarget, rate * dt);
    if (steerTarget !== 0 && Math.sign(steerTarget) !== Math.sign(this.steer)) {
      // Reversing lock — let it cross zero quickly for countersteering.
      this.steer = approach(this.steer, steerTarget, rate * 2.2 * dt);
    }

    let gas = (this.has('KeyW', 'ArrowUp') ? 1 : 0) + this._touch.throttle;
    let brk = (this.has('KeyS', 'ArrowDown') ? 1 : 0) + this._touch.brake;
    if (pad) {
      gas = Math.max(gas, pad.buttons[7]?.value ?? 0);
      brk = Math.max(brk, pad.buttons[6]?.value ?? 0);
    }

    this.throttle = clamp(gas, 0, 1);
    this.brake = clamp(brk, 0, 1);
    this.handbrake = this.has('Space') || this._touch.handbrake ||
      !!(pad && (pad.buttons[0]?.pressed || pad.buttons[1]?.pressed));
    this.boost = this.has('ShiftLeft', 'ShiftRight') ||
      !!(pad && pad.buttons[2]?.pressed);
  }

  endFrame() {
    this.pressed.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
    this.touchZones?.remove();
  }
}
