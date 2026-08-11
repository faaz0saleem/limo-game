import { clamp, damp, formatMoney } from '../util.js';
import { GRID, PITCH, HALF_CITY, roadLine } from '../world/city.js';

/* DOM + 2D-canvas HUD. Kept entirely off the WebGL path so it costs nothing
 * in the render loop and stays crisp at any DPI. */

const TAU = Math.PI * 2;

export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.el = {
      fareLabel: document.getElementById('fare-label'),
      fareName: document.getElementById('fare-name'),
      fareFill: document.getElementById('fare-timer-fill'),
      fareDist: document.getElementById('fare-dist'),
      cash: document.getElementById('stat-cash'),
      fares: document.getElementById('stat-fares'),
      best: document.getElementById('stat-best'),
      driftBanner: document.getElementById('drift-banner'),
      driftScore: document.getElementById('drift-score'),
      driftMult: document.getElementById('drift-mult'),
      driftWord: document.getElementById('drift-word'),
      toast: document.getElementById('toast'),
    };

    this.dial = document.getElementById('dial');
    this.dialCtx = this.dial.getContext('2d');
    this.minimap = document.getElementById('minimap');
    this.mapCtx = this.minimap.getContext('2d');

    this._dpr = Math.min(window.devicePixelRatio, 2);
    this._sizeCanvas(this.dial, 320);
    this._sizeCanvas(this.minimap, 220);

    this._needle = 0;
    this._toastTimer = 0;
    this._driftVisible = false;
    this._sub = '';
    this._mapCache = null;
  }

  /**
   * Size only the backing store — the on-screen size comes from CSS. While the
   * HUD is still hidden the element measures 0, so fall back to the stylesheet
   * default and re-measure once it is actually visible.
   */
  _sizeCanvas(canvas, cssSize) {
    const css = canvas.getBoundingClientRect().width || cssSize;
    canvas.width = Math.round(css * this._dpr);
    canvas.height = Math.round(css * this._dpr);
    canvas._css = css;
  }

  show() {
    this.root.classList.remove('hidden');
    this.resize();          // now measurable, so lock in the real backing size
  }
  hide() { this.root.classList.add('hidden'); }

  /* --------------------------------------------------------------- fares */

  setFare({ label, name, sub, timer }) {
    this.el.fareLabel.textContent = label;
    this.el.fareName.textContent = name;
    this._sub = sub ?? '';
    this.el.fareFill.style.width = timer === null ? '100%' : '100%';
    this.el.fareFill.parentElement.style.opacity = timer === null ? '0.25' : '1';
  }

  setFareProgress({ distance, timer, seconds, needSlow }) {
    if (timer !== null && timer !== undefined) {
      this.el.fareFill.style.width = `${clamp(timer, 0, 1) * 100}%`;
      const urgent = timer < 0.25;
      this.el.fareFill.style.background = urgent
        ? 'linear-gradient(90deg,#ff2f6d,#ff8a5c)'
        : 'linear-gradient(90deg,#38e6ff,#ffcb5c)';
    }

    const d = distance >= 1000
      ? `${(distance / 1000).toFixed(2)} km`
      : `${Math.round(distance)} m`;

    let line = `${d}  ·  ${this._sub}`;
    if (needSlow) line = 'SLOW DOWN TO STOP';
    if (seconds !== null && seconds !== undefined) {
      line = `${d}  ·  ${seconds.toFixed(1)}s`;
      if (needSlow) line = 'SLOW DOWN TO STOP';
    }
    this.el.fareDist.textContent = line;
    this.el.fareDist.style.color = needSlow ? '#ffcb5c' : '';
  }

  setStats({ cash, fares, best }) {
    this.el.cash.textContent = formatMoney(cash);
    this.el.fares.textContent = fares;
    this.el.best.textContent = best.toLocaleString('en-US');
  }

  flashCash() {
    this.el.cash.animate(
      [{ transform: 'scale(1.35)', filter: 'brightness(2)' }, { transform: 'scale(1)', filter: 'brightness(1)' }],
      { duration: 420, easing: 'ease-out' },
    );
  }

  /* --------------------------------------------------------------- drift */

  showDrift(score, mult) {
    const b = this.el.driftBanner;
    if (!this._driftVisible) {
      b.classList.remove('hidden');
      this._driftVisible = true;
    }
    b.classList.remove('is-bank');
    this.el.driftScore.textContent = score.toLocaleString('en-US');
    this.el.driftMult.textContent = `x${mult.toFixed(1)}`;
    this.el.driftWord.textContent =
      mult > 5 ? 'LEGENDARY' : mult > 3.2 ? 'SUBLIME' : mult > 2 ? 'STYLISH' : 'DRIFT';
  }

  bankDrift(total) {
    const b = this.el.driftBanner;
    b.classList.remove('hidden');
    this.el.driftScore.textContent = `+${total.toLocaleString('en-US')}`;
    this.el.driftWord.textContent = 'BANKED';
    b.classList.remove('is-bank');
    void b.offsetWidth;           // restart the animation
    b.classList.add('is-bank');
    this._driftVisible = true;
    clearTimeout(this._driftHide);
    this._driftHide = setTimeout(() => this.hideDrift(), 950);
  }

  hideDrift() {
    this.el.driftBanner.classList.add('hidden');
    this._driftVisible = false;
  }

  /* -------------------------------------------------------------- toasts */

  toast(text, kind = '') {
    const t = this.el.toast;
    t.textContent = text;
    t.className = `toast is-on ${kind}`;
    this._toastTimer = 2.4;
  }

  /* ---------------------------------------------------------------- dial */

  /** Speedometer, tacho arc, gear, boost bar and drift-angle indicator. */
  drawDial(vehicle, dt) {
    const c = this.dialCtx;
    const S = this.dial._css;
    const dpr = this._dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);

    const cx = S / 2, cy = S / 2, R = S * 0.42;
    const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
    const MAX_KMH = 260;

    this._needle = damp(this._needle, clamp(vehicle.kmh / MAX_KMH, 0, 1), 12, dt);

    // Track.
    c.lineWidth = S * 0.045;
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(120,150,220,.14)';
    c.beginPath();
    c.arc(cx, cy, R, START, START + SWEEP);
    c.stroke();

    // Filled speed arc, gradient from cyan to red.
    const grad = c.createLinearGradient(0, 0, S, S);
    grad.addColorStop(0, '#38e6ff');
    grad.addColorStop(0.55, '#ffcb5c');
    grad.addColorStop(1, '#ff2f6d');
    c.strokeStyle = grad;
    c.beginPath();
    c.arc(cx, cy, R, START, START + SWEEP * this._needle);
    c.stroke();

    // Redline zone.
    c.strokeStyle = 'rgba(255,47,109,.35)';
    c.lineWidth = S * 0.012;
    c.beginPath();
    c.arc(cx, cy, R + S * 0.038, START + SWEEP * 0.82, START + SWEEP);
    c.stroke();

    // Ticks.
    c.strokeStyle = 'rgba(200,220,255,.35)';
    for (let i = 0; i <= 13; i++) {
      const a = START + (i / 13) * SWEEP;
      const major = i % 2 === 0;
      const r0 = R - S * 0.035, r1 = R - S * (major ? 0.085 : 0.062);
      c.lineWidth = major ? 2.2 : 1.2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      c.stroke();
    }

    // Needle.
    const a = START + SWEEP * this._needle;
    c.save();
    c.translate(cx, cy);
    c.rotate(a);
    c.fillStyle = '#ff2f6d';
    c.shadowColor = 'rgba(255,47,109,.9)';
    c.shadowBlur = 14;
    c.beginPath();
    c.moveTo(-S * 0.02, -S * 0.012);
    c.lineTo(R - S * 0.05, -S * 0.004);
    c.lineTo(R - S * 0.05, S * 0.004);
    c.lineTo(-S * 0.02, S * 0.012);
    c.closePath();
    c.fill();
    c.restore();
    c.shadowBlur = 0;

    // Hub + numerals.
    c.fillStyle = 'rgba(10,14,24,.9)';
    c.beginPath();
    c.arc(cx, cy, S * 0.055, 0, TAU);
    c.fill();

    c.textAlign = 'center';
    c.fillStyle = '#fff';
    c.font = `700 ${S * 0.17}px ui-monospace, Menlo, monospace`;
    c.fillText(Math.round(vehicle.kmh), cx, cy + S * 0.03);
    c.fillStyle = 'rgba(150,170,210,.85)';
    c.font = `600 ${S * 0.045}px Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif`;
    c.fillText('KM/H', cx, cy + S * 0.085);

    // Gear.
    c.fillStyle = vehicle.boosting ? '#ff2f6d' : '#ffcb5c';
    c.font = `800 ${S * 0.075}px ui-monospace, Menlo, monospace`;
    c.fillText(vehicle.gear === 0 ? 'R' : String(vehicle.gear), cx, cy - S * 0.145);

    // Boost bar along the bottom of the dial.
    const bw = S * 0.42, bh = S * 0.022;
    const bx = cx - bw / 2, by = cy + S * 0.20;
    c.fillStyle = 'rgba(120,150,220,.18)';
    c.fillRect(bx, by, bw, bh);
    c.fillStyle = vehicle.boostCharge > 0.25 ? '#38e6ff' : '#ff2f6d';
    c.fillRect(bx, by, bw * clamp(vehicle.boostCharge, 0, 1), bh);

    // Drift angle: a small bar that swings with the slide.
    const slip = clamp(vehicle.slipAngle / 0.9, -1, 1);
    const sx = cx + slip * bw * 0.5;
    c.fillStyle = Math.abs(slip) > 0.2 ? '#ffcb5c' : 'rgba(150,170,210,.5)';
    c.fillRect(sx - 2, by + bh + 5, 4, S * 0.018);
  }

  /* ------------------------------------------------------------- minimap */

  _drawMapBase(S) {
    // The street grid never changes, so rasterise it once.
    const off = document.createElement('canvas');
    off.width = off.height = S;
    const c = off.getContext('2d');
    const scale = S / (HALF_CITY * 2);

    c.fillStyle = 'rgba(8,11,20,.0)';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = 'rgba(120,160,255,.30)';
    c.lineWidth = Math.max(2, S * 0.016);
    for (let i = 0; i <= GRID; i++) {
      const p = (roadLine(i) + HALF_CITY) * scale;
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, S); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(S, p); c.stroke();
    }
    return off;
  }

  drawMinimap(vehicle, objective, traffic) {
    const S = this.minimap._css;
    const dpr = this._dpr;
    const c = this.mapCtx;
    if (!this._mapCache) this._mapCache = this._drawMapBase(256);

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);

    const R = S / 2;
    const view = 190;                 // metres across the minimap
    const scale = S / view;

    c.save();
    c.beginPath();
    c.arc(R, R, R - 3, 0, TAU);
    c.clip();

    c.fillStyle = 'rgba(6,9,18,.75)';
    c.fillRect(0, 0, S, S);

    // Rotate the world so the car always points up.
    c.translate(R, R);
    c.rotate(-vehicle.heading + Math.PI);
    c.scale(scale, scale);
    c.translate(-vehicle.position.x, -vehicle.position.z);

    // Street grid, drawn as lines directly (the cached bitmap is only used
    // as a fallback for very wide views).
    c.strokeStyle = 'rgba(120,160,255,.34)';
    c.lineWidth = 7;
    c.lineCap = 'butt';
    for (let i = 0; i <= GRID; i++) {
      const p = roadLine(i);
      if (Math.abs(p - vehicle.position.x) < view) {
        c.beginPath(); c.moveTo(p, -HALF_CITY); c.lineTo(p, HALF_CITY); c.stroke();
      }
      if (Math.abs(p - vehicle.position.z) < view) {
        c.beginPath(); c.moveTo(-HALF_CITY, p); c.lineTo(HALF_CITY, p); c.stroke();
      }
    }

    // Traffic blips.
    if (traffic) {
      c.fillStyle = 'rgba(200,215,245,.7)';
      for (const car of traffic.cars) {
        const dx = car.pos.x - vehicle.position.x;
        const dz = car.pos.z - vehicle.position.z;
        if (Math.abs(dx) > view || Math.abs(dz) > view) continue;
        c.beginPath();
        c.arc(car.pos.x, car.pos.z, 2.6, 0, TAU);
        c.fill();
      }
    }

    // Objective.
    if (objective) {
      c.fillStyle = '#ffcb5c';
      c.beginPath();
      c.arc(objective.x, objective.z, 5.5, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(255,203,92,.55)';
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(objective.x, objective.z, 11, 0, TAU);
      c.stroke();
    }

    c.restore();

    // Player arrow, fixed at the centre.
    c.save();
    c.translate(R, R);
    c.fillStyle = '#fff';
    c.shadowColor = 'rgba(120,200,255,.9)';
    c.shadowBlur = 9;
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(5.5, 7);
    c.lineTo(0, 4);
    c.lineTo(-5.5, 7);
    c.closePath();
    c.fill();
    c.restore();

    // Off-screen objective indicator on the rim.
    if (objective) {
      const dx = objective.x - vehicle.position.x;
      const dz = objective.z - vehicle.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist * scale > R - 12) {
        const a = Math.atan2(dx, dz) - vehicle.heading;
        // Screen space: up is -Y, and the map is rotated by PI.
        const px = R + Math.sin(a) * (R - 11);
        const py = R - Math.cos(a) * (R - 11);
        c.fillStyle = '#ffcb5c';
        c.beginPath();
        c.arc(px, py, 4.5, 0, TAU);
        c.fill();
      }
    }

    // Rim.
    c.strokeStyle = 'rgba(120,160,255,.35)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(R, R, R - 3, 0, TAU);
    c.stroke();
  }

  /* --------------------------------------------------------------- frame */

  update(dt, vehicle, objective, traffic) {
    this.drawDial(vehicle, dt);
    this.drawMinimap(vehicle, objective, traffic);

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.el.toast.classList.remove('is-on');
    }
  }

  resize() {
    this._dpr = Math.min(window.devicePixelRatio, 2);
    this._sizeCanvas(this.dial, 320);
    this._sizeCanvas(this.minimap, 220);
  }
}
