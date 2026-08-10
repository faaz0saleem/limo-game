import { clamp, TAU } from './util.js';

/**
 * Pooled particle system. One flat array, reused slots, drawn in a single pass
 * per blend mode so long limos throwing a lot of smoke stay cheap.
 */
const MAX = 900;

const TINTS = {
  smoke: [235, 235, 240],
  oil: [40, 38, 48],
  dust: [190, 170, 140],
  spark: [255, 200, 90],
  fire: [255, 120, 40],
  water: [110, 200, 240],
  confetti: null, // uses its own colour
};

export class Particles {
  constructor() {
    this.pool = new Array(MAX);
    for (let i = 0; i < MAX; i++) {
      this.pool[i] = { alive: false };
    }
    this.cursor = 0;
    this.skids = [];
    this.maxSkids = 320;
  }

  _acquire() {
    for (let i = 0; i < MAX; i++) {
      const idx = (this.cursor + i) % MAX;
      if (!this.pool[idx].alive) {
        this.cursor = (idx + 1) % MAX;
        return this.pool[idx];
      }
    }
    // Everything busy: recycle the oldest slot.
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX;
    return p;
  }

  spawn(opts) {
    const p = this._acquire();
    p.alive = true;
    p.x = opts.x;
    p.y = opts.y;
    p.vx = opts.vx || 0;
    p.vy = opts.vy || 0;
    p.life = opts.life || 0.6;
    p.maxLife = p.life;
    p.size = opts.size || 8;
    p.grow = opts.grow == null ? 1.5 : opts.grow;
    p.drag = opts.drag == null ? 0.94 : opts.drag;
    p.tint = opts.tint || 'smoke';
    p.color = opts.color || null;
    p.spin = opts.spin || 0;
    p.rot = opts.rot || 0;
    p.shape = opts.shape || 'circle';
    p.alpha = opts.alpha == null ? 0.55 : opts.alpha;
    p.additive = !!opts.additive;
    return p;
  }

  smoke(x, y, o = {}) {
    return this.spawn({
      x,
      y,
      vx: o.vx,
      vy: o.vy,
      life: o.life || 0.7,
      size: o.size || 12,
      grow: 22,
      drag: 0.9,
      tint: o.tint || 'smoke',
      alpha: o.tint === 'oil' ? 0.4 : 0.32,
    });
  }

  burst(x, y, count, o = {}) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = (o.speed || 3) * (0.4 + Math.random());
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: (o.life || 0.6) * (0.6 + Math.random() * 0.8),
        size: o.size || 6,
        grow: o.grow == null ? -3 : o.grow,
        drag: o.drag == null ? 0.9 : o.drag,
        tint: o.tint || 'spark',
        color: o.color || null,
        alpha: o.alpha == null ? 0.9 : o.alpha,
        additive: o.additive != null ? o.additive : o.tint === 'spark',
        shape: o.shape || 'circle',
        spin: (Math.random() - 0.5) * 12,
      });
    }
  }

  confetti(x, y, count = 26) {
    const cols = ['#ff5e8a', '#ffd93d', '#5affa0', '#4fd2e8', '#c78bff'];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = 2 + Math.random() * 5;
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1.1 + Math.random() * 0.9,
        size: 4 + Math.random() * 4,
        grow: 0,
        drag: 0.955,
        tint: 'confetti',
        color: cols[(Math.random() * cols.length) | 0],
        alpha: 1,
        shape: 'rect',
        spin: (Math.random() - 0.5) * 16,
      });
    }
  }

  skid(x, y, angle, strength) {
    this.skids.push({ x, y, a: angle, s: clamp(strength, 0, 1), life: 6 });
    if (this.skids.length > this.maxSkids) this.skids.shift();
  }

  update(dt) {
    for (let i = 0; i < MAX; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.size = Math.max(0.5, p.size + p.grow * dt);
      p.rot += p.spin * dt;
    }
    for (let i = this.skids.length - 1; i >= 0; i--) {
      this.skids[i].life -= dt;
      if (this.skids[i].life <= 0) this.skids.splice(i, 1);
    }
  }

  drawSkids(ctx) {
    ctx.save();
    for (const s of this.skids) {
      ctx.globalAlpha = clamp(s.life / 6, 0, 1) * 0.32 * s.s;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.a);
      ctx.fillStyle = '#0a0a0e';
      ctx.fillRect(-4, -2.6, 8, 5.2);
      ctx.restore();
    }
    ctx.restore();
  }

  draw(ctx) {
    ctx.save();
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalCompositeOperation = pass === 0 ? 'source-over' : 'lighter';
      for (let i = 0; i < MAX; i++) {
        const p = this.pool[i];
        if (!p.alive) continue;
        if (!!p.additive !== (pass === 1)) continue;
        const t = clamp(p.life / p.maxLife, 0, 1);
        ctx.globalAlpha = p.alpha * (p.tint === 'confetti' ? Math.min(1, t * 2) : t);
        if (p.color) {
          ctx.fillStyle = p.color;
        } else {
          const c = TINTS[p.tint] || TINTS.smoke;
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        }
        if (p.shape === 'rect') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  clear() {
    for (const p of this.pool) p.alive = false;
    this.skids.length = 0;
  }
}
