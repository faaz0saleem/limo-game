import { clamp, lerp } from './util.js';
import { CONFIG } from './config.js';

/**
 * Two-button controls: steer left/right, tap boost.
 * Keyboard + touch, with an analog-feeling ramp on the steer axis so taps
 * feather the limo instead of snapping it.
 */
export class Input {
  constructor(target = window) {
    this.left = false;
    this.right = false;
    this.boostHeld = false;
    this.handbrake = false;
    this.steer = 0;
    this.raw = 0;
    this._pressed = new Set();
    this._touchZones = [];

    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', () => this.releaseAll());
  }

  _key(e, down) {
    const code = e.code;
    let handled = true;
    switch (code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = down;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = down;
        break;
      case 'Space':
        this.boostHeld = down;
        if (down) this._pressed.add('boost');
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'ArrowDown':
      case 'KeyS':
        this.handbrake = down;
        break;
      case 'KeyH':
        if (down) this._pressed.add('horn');
        break;
      case 'KeyR':
        if (down) this._pressed.add('restart');
        break;
      case 'KeyM':
        if (down) this._pressed.add('mute');
        break;
      case 'Escape':
      case 'KeyP':
        if (down) this._pressed.add('pause');
        break;
      case 'Enter':
        if (down) this._pressed.add('confirm');
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  /** Bind on-screen buttons (mobile). */
  bindTouch(el, action) {
    if (!el) return;
    const set = (v) => (ev) => {
      ev.preventDefault();
      if (action === 'left') this.left = v;
      else if (action === 'right') this.right = v;
      else if (action === 'boost') {
        this.boostHeld = v;
        if (v) this._pressed.add('boost');
      } else if (action === 'handbrake') this.handbrake = v;
      else if (action === 'horn' && v) this._pressed.add('horn');
    };
    el.addEventListener('pointerdown', set(true));
    el.addEventListener('pointerup', set(false));
    el.addEventListener('pointercancel', set(false));
    el.addEventListener('pointerleave', set(false));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this._touchZones.push(el);
  }

  releaseAll() {
    this.left = this.right = this.boostHeld = this.handbrake = false;
  }

  update(dt) {
    const target = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    this.raw = target;
    const rate = clamp(dt * CONFIG.limo.steerInputRamp, 0, 1);
    this.steer = lerp(this.steer, target, target === 0 ? rate * 1.7 : rate);
    if (Math.abs(this.steer) < 0.002) this.steer = 0;
  }

  /** True once per press. */
  consume(name) {
    if (this._pressed.has(name)) {
      this._pressed.delete(name);
      return true;
    }
    return false;
  }

  clearPresses() {
    this._pressed.clear();
  }
}
