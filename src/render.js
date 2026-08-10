import { CONFIG, COLORS } from './config.js';
import { clamp, lerp, TAU, roundRect, formatTime } from './util.js';
import { drawCargoItem } from './cargoTypes.js';
import { TRAFFIC_KINDS } from './traffic.js';
import { underglowColor, drawHat } from './customize.js';

/**
 * All drawing. World-space rendering runs under the camera transform; the HUD
 * is drawn afterwards in screen space.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this._minimap = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.width = w;
    this.height = h;
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  beginWorld(camera) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    camera.apply(ctx);
  }

  endWorld() {
    this.ctx.restore();
  }

  beginScreen() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  endScreen() {
    this.ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* World                                                             */
  /* ---------------------------------------------------------------- */

  drawGround(bounds) {
    const ctx = this.ctx;
    const grid = 160;
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    ctx.strokeStyle = 'rgba(255,255,255,0.022)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor(bounds.minX / grid) * grid;
    const y0 = Math.floor(bounds.minY / grid) * grid;
    for (let x = x0; x < bounds.maxX; x += grid) {
      ctx.moveTo(x, bounds.minY);
      ctx.lineTo(x, bounds.maxY);
    }
    for (let y = y0; y < bounds.maxY; y += grid) {
      ctx.moveTo(bounds.minX, y);
      ctx.lineTo(bounds.maxX, y);
    }
    ctx.stroke();
  }

  drawBuildings(track, bounds, time) {
    const ctx = this.ctx;
    for (const b of track.buildings) {
      if (b.x < bounds.minX - 200 || b.x > bounds.maxX + 200) continue;
      if (b.y < bounds.minY - 200 || b.y > bounds.maxY + 200) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(ctx, -b.w / 2 + 5, -b.h / 2 + 6, b.w, b.h, 4);
      ctx.fill();
      ctx.fillStyle = b.color;
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, 4);
      ctx.fill();
      // roof detail + lit windows
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      roundRect(ctx, -b.w / 2 + 7, -b.h / 2 + 7, b.w - 14, b.h - 14, 3);
      ctx.fill();
      const cw = (b.w - 20) / b.cols;
      const ch = (b.h - 20) / b.rows;
      for (let r = 0; r < b.rows; r++) {
        for (let c = 0; c < b.cols; c++) {
          const n = ((b.seed + r * 31 + c * 17) % 100) / 100;
          if (n > 0.55) continue;
          const flicker = n < 0.06 ? (Math.sin(time * 3 + r + c) > 0 ? 1 : 0.2) : 1;
          ctx.fillStyle = `rgba(255,214,140,${(0.18 + n * 0.5) * flicker})`;
          ctx.fillRect(-b.w / 2 + 10 + c * cw + 1, -b.h / 2 + 10 + r * ch + 1, cw - 2, ch - 2);
        }
      }
      ctx.restore();
    }
  }

  _visibleRanges(track, bounds) {
    const ranges = [];
    let start = -1;
    const pad = 240;
    for (let i = 0; i < track.samples.length; i++) {
      const s = track.samples[i];
      const vis =
        s.x > bounds.minX - pad &&
        s.x < bounds.maxX + pad &&
        s.y > bounds.minY - pad &&
        s.y < bounds.maxY + pad;
      if (vis && start < 0) start = i;
      else if (!vis && start >= 0) {
        ranges.push([Math.max(0, start - 1), i]);
        start = -1;
      }
    }
    if (start >= 0) ranges.push([Math.max(0, start - 1), track.samples.length - 1]);
    return ranges;
  }

  drawRoad(track, bounds) {
    const ctx = this.ctx;
    const ranges = this._visibleRanges(track, bounds);
    const left = track.leftEdge;
    const right = track.rightEdge;
    if (!left || !right) return;

    for (const [a, b] of ranges) {
      // Kerb (drawn slightly wider underneath the asphalt).
      ctx.beginPath();
      ctx.moveTo(left[a].x, left[a].y);
      for (let i = a + 1; i <= b; i++) ctx.lineTo(left[i].x, left[i].y);
      for (let i = b; i >= a; i--) ctx.lineTo(right[i].x, right[i].y);
      ctx.closePath();
      ctx.fillStyle = COLORS.curb;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 18;
      ctx.strokeStyle = COLORS.curb;
      ctx.stroke();
      ctx.fillStyle = COLORS.asphalt;
      ctx.fill();

      // Subtle tarmac banding so speed reads.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = COLORS.asphaltAlt;
      for (let i = a; i <= b; i += 2) {
        const s = track.samples[i];
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.a);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(-CONFIG.track.step / 2, -s.w / 2, CONFIG.track.step, s.w);
        ctx.restore();
      }
      ctx.restore();

      // Centre line dashes.
      ctx.save();
      ctx.strokeStyle = COLORS.lane;
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = 3.5;
      ctx.setLineDash([22, 26]);
      ctx.beginPath();
      ctx.moveTo(track.samples[a].x, track.samples[a].y);
      for (let i = a + 1; i <= b; i++) ctx.lineTo(track.samples[i].x, track.samples[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Edge lines.
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2.5;
      for (const edge of [left, right]) {
        ctx.beginPath();
        ctx.moveTo(edge[a].x, edge[a].y);
        for (let i = a + 1; i <= b; i++) ctx.lineTo(edge[i].x, edge[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawZones(track, bounds, time) {
    const ctx = this.ctx;
    for (const z of track.zones) {
      if (z.x < bounds.minX - 150 || z.x > bounds.maxX + 150) continue;
      if (z.y < bounds.minY - 150 || z.y > bounds.maxY + 150) continue;
      ctx.save();
      ctx.translate(z.x, z.y);
      if (z.type === 'oil') {
        ctx.fillStyle = 'rgba(12,10,18,0.88)';
        ctx.beginPath();
        ctx.ellipse(0, 0, z.r, z.r * 0.78, 0.4, 0, TAU);
        ctx.fill();
        const g = ctx.createRadialGradient(-z.r * 0.2, -z.r * 0.2, 2, 0, 0, z.r);
        g.addColorStop(0, `hsla(${(time * 40) % 360},80%,60%,0.35)`);
        g.addColorStop(0.6, `hsla(${(time * 40 + 120) % 360},80%,55%,0.16)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(0, 0, z.r, z.r * 0.78, 0.4, 0, TAU);
        ctx.fill();
      } else if (z.type === 'ramp') {
        ctx.rotate(z.a);
        const w = z.len;
        const h = z.w;
        const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
        g.addColorStop(0, '#3a3f4b');
        g.addColorStop(1, '#6d768c');
        ctx.fillStyle = g;
        roundRect(ctx, -w / 2, -h / 2, w, h, 4);
        ctx.fill();
        ctx.fillStyle = '#f2c14e';
        for (let i = -2; i <= 2; i++) {
          ctx.save();
          ctx.translate(0, (i * h) / 5.2);
          ctx.beginPath();
          ctx.moveTo(-w / 2 + 6, -h / 16);
          ctx.lineTo(w / 2 - 6, 0);
          ctx.lineTo(-w / 2 + 6, h / 16);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      } else if (z.type === 'boost') {
        ctx.rotate(z.a);
        const pulse = (Math.sin(time * 6) + 1) * 0.5;
        ctx.fillStyle = `rgba(80,200,255,${0.25 + pulse * 0.3})`;
        roundRect(ctx, -z.r, -z.r * 0.7, z.r * 2, z.r * 1.4, 8);
        ctx.fill();
        ctx.fillStyle = `rgba(180,240,255,${0.6 + pulse * 0.4})`;
        for (let i = 0; i < 3; i++) {
          ctx.save();
          ctx.translate(-z.r * 0.5 + i * z.r * 0.5, 0);
          ctx.beginPath();
          ctx.moveTo(-8, -14);
          ctx.lineTo(8, 0);
          ctx.lineTo(-8, 14);
          ctx.lineTo(-3, 0);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      } else if (z.type === 'bump') {
        ctx.rotate(z.a);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#454b5c';
        for (let gx = -z.r; gx < z.r; gx += 15) {
          for (let gy = -z.r; gy < z.r; gy += 15) {
            if (gx * gx + gy * gy > z.r * z.r) continue;
            roundRect(ctx, gx + 1.5, gy + 1.5, 12, 12, 3);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    // Checkpoint gates
    for (const cp of track.checkpoints) {
      if (cp.x < bounds.minX - 200 || cp.x > bounds.maxX + 200) continue;
      if (cp.y < bounds.minY - 200 || cp.y > bounds.maxY + 200) continue;
      ctx.save();
      ctx.translate(cp.x, cp.y);
      ctx.rotate(cp.a);
      const half = cp.w / 2;
      const pulse = cp.taken ? 0 : (Math.sin(time * 4) + 1) * 0.5;
      ctx.fillStyle = cp.taken ? 'rgba(90,255,160,0.16)' : `rgba(255,210,90,${0.14 + pulse * 0.14})`;
      ctx.fillRect(-9, -half, 18, cp.w);
      ctx.fillStyle = cp.taken ? '#3ecf80' : '#ffd25a';
      ctx.fillRect(-6, -half - 12, 12, 22);
      ctx.fillRect(-6, half - 10, 12, 22);
      ctx.restore();
    }

    // Finish line
    const f = track.finish;
    if (f.x > bounds.minX - 300 && f.x < bounds.maxX + 300 && f.y > bounds.minY - 300 && f.y < bounds.maxY + 300) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a);
      const w = CONFIG.track.roadWidth;
      const sq = 16;
      for (let r = 0; r < 3; r++) {
        for (let c = -Math.ceil(w / (2 * sq)); c < Math.ceil(w / (2 * sq)); c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? '#f4f6fa' : '#1a1c24';
          ctx.fillRect(r * sq - sq * 1.5, c * sq, sq, sq);
        }
      }
      ctx.restore();
    }
  }

  drawProps(track, bounds, time) {
    const ctx = this.ctx;
    for (const p of track.props) {
      const b = p.body;
      if (b.position.x < bounds.minX - 60 || b.position.x > bounds.maxX + 60) continue;
      if (b.position.y < bounds.minY - 60 || b.position.y > bounds.maxY + 60) continue;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.arc(2, 3, p.r, 0, TAU);
      ctx.fill();
      if (p.kind === 'cone') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#f7f7fa';
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 0.62, 0, TAU);
        ctx.fill();
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 0.3, 0, TAU);
        ctx.fill();
      } else if (p.kind === 'barrel') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 0.65, 0, TAU);
        ctx.stroke();
      } else if (p.kind === 'bin') {
        ctx.fillStyle = p.color;
        roundRect(ctx, -p.r, -p.r, p.r * 2, p.r * 2, 5);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(-p.r + 3, -2, p.r * 2 - 6, 4);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 0.7, 0, TAU);
        ctx.fill();
        ctx.fillRect(-p.r, -3, p.r * 2, 6);
      }
      ctx.restore();
    }
  }

  drawTraffic(traffic, bounds) {
    const ctx = this.ctx;
    for (const car of traffic.cars) {
      const b = car.body;
      if (b.position.x < bounds.minX - 120 || b.position.x > bounds.maxX + 120) continue;
      if (b.position.y < bounds.minY - 120 || b.position.y > bounds.maxY + 120) continue;
      const spec = TRAFFIC_KINDS[car.kind] || TRAFFIC_KINDS.sedan;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      roundRect(ctx, -spec.w / 2 + 3, -spec.h / 2 + 4, spec.w, spec.h, 7);
      ctx.fill();
      ctx.fillStyle = spec.color;
      roundRect(ctx, -spec.w / 2, -spec.h / 2, spec.w, spec.h, 7);
      ctx.fill();
      ctx.fillStyle = spec.roof;
      roundRect(ctx, -spec.w * 0.24, -spec.h * 0.34, spec.w * 0.46, spec.h * 0.68, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(30,40,60,0.85)';
      roundRect(ctx, spec.w * 0.24, -spec.h * 0.32, spec.w * 0.12, spec.h * 0.64, 3);
      ctx.fill();
      roundRect(ctx, -spec.w * 0.36, -spec.h * 0.32, spec.w * 0.1, spec.h * 0.64, 3);
      ctx.fill();
      // lights
      ctx.fillStyle = '#fff4c9';
      ctx.fillRect(spec.w / 2 - 4, -spec.h / 2 + 3, 4, 5);
      ctx.fillRect(spec.w / 2 - 4, spec.h / 2 - 8, 4, 5);
      ctx.fillStyle = car.spun > 0 ? '#ff5a5a' : '#c0392b';
      ctx.fillRect(-spec.w / 2, -spec.h / 2 + 3, 4, 5);
      ctx.fillRect(-spec.w / 2, spec.h / 2 - 8, 4, 5);
      if (car.kind === 'taxi') {
        ctx.fillStyle = '#1d2130';
        ctx.fillRect(-6, -spec.h * 0.36, 12, 5);
      }
      ctx.restore();
    }
  }

  drawLimo(limo, { time, underglow, hat, boosting }) {
    const ctx = this.ctx;
    const L = CONFIG.limo;
    const glow = underglowColor(underglow, time);

    // Underglow pass (additive, under everything).
    if (glow) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const seg of limo.segments) {
        const b = seg.body;
        ctx.save();
        ctx.translate(b.position.x, b.position.y);
        ctx.rotate(b.angle);
        const g = ctx.createRadialGradient(0, 0, 4, 0, 0, L.segLength * 0.75);
        g.addColorStop(0, glow);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(0, 0, L.segLength * 0.72, L.segWidth * 1.25, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    // Shadows
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    for (const seg of limo.segments) {
      const b = seg.body;
      const lift = seg.air > 0 ? 8 : 0;
      ctx.save();
      ctx.translate(b.position.x + 5 + lift, b.position.y + 7 + lift);
      ctx.rotate(b.angle);
      roundRect(ctx, -L.segLength / 2, -L.segWidth / 2, L.segLength, L.segWidth, 9);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // Joint sleeves so the limo reads as one continuous car.
    ctx.save();
    ctx.strokeStyle = '#0b0d13';
    ctx.lineWidth = L.segWidth * 0.82;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(limo.segments[0].body.position.x, limo.segments[0].body.position.y);
    for (let i = 1; i < limo.segments.length; i++) {
      const b = limo.segments[i].body;
      ctx.lineTo(b.position.x, b.position.y);
    }
    if (limo.segments.length > 1) ctx.stroke();
    ctx.restore();

    for (let i = limo.segments.length - 1; i >= 0; i--) {
      const seg = limo.segments[i];
      const b = seg.body;
      const air = seg.air > 0 ? 1 + Math.sin(clamp(seg.air / 0.6, 0, 1) * Math.PI) * 0.11 : 1;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);
      ctx.scale(air, air);

      // Wheels
      ctx.fillStyle = '#0a0b10';
      for (const ax of [-1, 1]) {
        for (const side of [-1, 1]) {
          ctx.save();
          ctx.translate(ax * L.segLength * 0.33, side * L.segWidth * 0.5);
          if (seg.isCab && ax === 1) ctx.rotate(clamp(limo.steerVisual || 0, -0.5, 0.5));
          roundRect(ctx, -8, -4, 16, 8, 3);
          ctx.fill();
          ctx.restore();
        }
      }

      // Body
      const bodyGrad = ctx.createLinearGradient(0, -L.segWidth / 2, 0, L.segWidth / 2);
      bodyGrad.addColorStop(0, '#22252f');
      bodyGrad.addColorStop(0.35, COLORS.limoBody);
      bodyGrad.addColorStop(1, '#080a0f');
      ctx.fillStyle = bodyGrad;
      roundRect(ctx, -L.segLength / 2, -L.segWidth / 2, L.segLength, L.segWidth, seg.isCab ? 10 : 6);
      ctx.fill();

      // Gold trim strip
      ctx.fillStyle = COLORS.limoTrim;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(-L.segLength / 2 + 2, -1.4, L.segLength - 4, 2.8);
      ctx.globalAlpha = 1;

      if (seg.isCab) {
        // Windshield + driver
        ctx.fillStyle = COLORS.glass;
        ctx.globalAlpha = 0.55;
        roundRect(ctx, 6, -L.segWidth / 2 + 4, 16, L.segWidth - 8, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Driver + hat
        ctx.save();
        ctx.translate(-2, 0);
        ctx.fillStyle = '#f0c49a';
        ctx.beginPath();
        ctx.arc(0, 0, 5.2, 0, TAU);
        ctx.fill();
        drawHat(ctx, hat, time);
        ctx.restore();
        // Headlights
        ctx.fillStyle = '#fff6d0';
        ctx.fillRect(L.segLength / 2 - 4, -L.segWidth / 2 + 3, 4, 6);
        ctx.fillRect(L.segLength / 2 - 4, L.segWidth / 2 - 9, 4, 6);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const hg = ctx.createRadialGradient(L.segLength / 2, 0, 2, L.segLength / 2, 0, 120);
        hg.addColorStop(0, 'rgba(255,240,190,0.30)');
        hg.addColorStop(1, 'rgba(255,240,190,0)');
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.moveTo(L.segLength / 2, 0);
        ctx.lineTo(L.segLength / 2 + 130, -58);
        ctx.lineTo(L.segLength / 2 + 130, 58);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        // Passenger windows
        ctx.fillStyle = COLORS.glass;
        ctx.globalAlpha = 0.32;
        const n = 3;
        for (let k = 0; k < n; k++) {
          const wx = -L.segLength / 2 + 8 + k * ((L.segLength - 16) / n);
          roundRect(ctx, wx, -L.segWidth / 2 + 4, (L.segLength - 22) / n, L.segWidth - 8, 3);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      if (i === limo.segments.length - 1) {
        // Tail lights + plate
        ctx.fillStyle = boosting ? '#ff9a4a' : '#d2453c';
        ctx.fillRect(-L.segLength / 2, -L.segWidth / 2 + 3, 4, 6);
        ctx.fillRect(-L.segLength / 2, L.segWidth / 2 - 9, 4, 6);
        ctx.fillStyle = '#e8e8ee';
        ctx.fillRect(-L.segLength / 2 + 2, -5, 8, 10);
        ctx.fillStyle = '#1a1c24';
        ctx.font = 'bold 5px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(-L.segLength / 2 + 6, 0);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('VALET', 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }

    // Boost flames from the tail.
    if (boosting) {
      const tail = limo.segments[limo.segments.length - 1].body;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(tail.position.x, tail.position.y);
      ctx.rotate(tail.angle);
      const len = 34 + Math.sin(time * 40) * 10;
      for (const side of [-1, 1]) {
        const g = ctx.createLinearGradient(-L.segLength / 2, 0, -L.segLength / 2 - len, 0);
        g.addColorStop(0, 'rgba(255,230,150,0.85)');
        g.addColorStop(0.4, 'rgba(255,140,60,0.5)');
        g.addColorStop(1, 'rgba(255,60,40,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-L.segLength / 2, side * 3);
        ctx.lineTo(-L.segLength / 2 - len, side * 7);
        ctx.lineTo(-L.segLength / 2 - len * 0.6, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawCargo(rig, time) {
    const ctx = this.ctx;
    for (const item of rig.items) {
      const st = item.renderState();
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(st.angle);
      drawCargoItem(ctx, item.def, {
        time,
        leanX: st.leanX,
        leanY: st.leanY,
        tilt: st.tilt,
        alpha: st.alpha,
      });
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  _buildMinimap(track) {
    const b = track.bounds();
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const size = 150;
    const scale = Math.min(size / w, size / h);
    const path = new Path2D();
    track.samples.forEach((s, i) => {
      const x = (s.x - b.minX) * scale;
      const y = (s.y - b.minY) * scale;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    this._minimap = {
      path,
      scale,
      minX: b.minX,
      minY: b.minY,
      w: w * scale,
      h: h * scale,
      track,
    };
    return this._minimap;
  }

  drawMinimap(track, limo, x, y) {
    const ctx = this.ctx;
    let mm = this._minimap;
    if (!mm || mm.track !== track) mm = this._buildMinimap(track);
    const pad = 10;
    ctx.save();
    ctx.translate(x - mm.w - pad, y + pad);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(10,12,18,0.55)';
    roundRect(ctx, -pad, -pad, mm.w + pad * 2, mm.h + pad * 2, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.stroke(mm.path);
    ctx.strokeStyle = 'rgba(232,198,106,0.75)';
    ctx.lineWidth = 2;
    ctx.stroke(mm.path);

    const f = track.finish;
    ctx.fillStyle = '#5affa0';
    ctx.beginPath();
    ctx.arc((f.x - mm.minX) * mm.scale, (f.y - mm.minY) * mm.scale, 4, 0, TAU);
    ctx.fill();

    const p = limo.cab.position;
    ctx.fillStyle = '#ff5e8a';
    ctx.beginPath();
    ctx.arc((p.x - mm.minX) * mm.scale, (p.y - mm.minY) * mm.scale, 4.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawHud(state) {
    const ctx = this.ctx;
    const { limo, rig, track, time, timeLeft, timeLimit, score, level, levelName, progress } = state;
    const W = this.width;
    const H = this.height;
    const pad = 18;

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // --- Top left: contract -----------------------------------------
    ctx.fillStyle = 'rgba(10,12,18,0.5)';
    roundRect(ctx, pad, pad, 258, 62, 12);
    ctx.fill();
    ctx.fillStyle = COLORS.limoTrim;
    ctx.font = 'bold 13px "Trebuchet MS", sans-serif';
    ctx.fillText(`LEVEL ${level}`, pad + 14, pad + 11);
    ctx.fillStyle = '#f2f4f8';
    ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
    ctx.fillText(levelName, pad + 14, pad + 29);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '12px "Trebuchet MS", sans-serif';
    ctx.fillText(`${limo.segmentCount} segments · ${rig.total} items`, pad + 14, pad + 52);

    // --- Top centre: timer + progress -------------------------------
    const urgent = timeLeft < 8;
    ctx.textAlign = 'center';
    ctx.font = `bold ${urgent ? 44 : 40}px "Trebuchet MS", sans-serif`;
    ctx.fillStyle = urgent
      ? `rgba(255,90,90,${0.65 + Math.abs(Math.sin(time * 7)) * 0.35})`
      : '#f2f4f8';
    ctx.fillText(formatTime(timeLeft), W / 2, pad + 4);

    const barW = Math.min(420, W * 0.42);
    const barX = W / 2 - barW / 2;
    const barY = pad + 54;
    ctx.fillStyle = 'rgba(10,12,18,0.55)';
    roundRect(ctx, barX, barY, barW, 10, 5);
    ctx.fill();
    ctx.fillStyle = COLORS.limoTrim;
    roundRect(ctx, barX, barY, Math.max(6, barW * progress), 10, 5);
    ctx.fill();
    ctx.fillStyle = '#5affa0';
    ctx.beginPath();
    ctx.arc(barX + barW, barY + 5, 6, 0, TAU);
    ctx.fill();

    // --- Score ------------------------------------------------------
    ctx.textAlign = 'right';
    ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#f2f4f8';
    ctx.fillText(Math.round(score).toLocaleString('en-US'), W - pad - 14, pad + 88);
    ctx.font = '11px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('SCORE', W - pad - 14, pad + 112);

    this.drawMinimap(track, limo, W - pad, pad);

    // --- Cargo balance meter ----------------------------------------
    const meterW = 240;
    const meterX = pad;
    const meterY = H - pad - 74;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(10,12,18,0.5)';
    roundRect(ctx, meterX, meterY, meterW, 74, 12);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = 'bold 11px "Trebuchet MS", sans-serif';
    ctx.fillText('CARGO BALANCE', meterX + 14, meterY + 10);

    const worst = rig.worstTilt;
    const gaugeW = meterW - 28;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, meterX + 14, meterY + 27, gaugeW, 12, 6);
    ctx.fill();
    const hue = lerp(140, 0, clamp(worst, 0, 1));
    ctx.fillStyle = `hsl(${hue}, 85%, 55%)`;
    roundRect(ctx, meterX + 14, meterY + 27, Math.max(4, gaugeW * clamp(worst, 0, 1)), 12, 6);
    ctx.fill();
    // danger notch
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(meterX + 14 + gaugeW * 0.8, meterY + 24, 2, 18);

    // Per-item pips
    const pipW = Math.min(20, (gaugeW - (rig.total - 1) * 4) / Math.max(1, rig.total));
    rig.items.forEach((item, i) => {
      const px = meterX + 14 + i * (pipW + 4);
      if (item.attached) {
        const t = clamp(item.tilt, 0, 1);
        ctx.fillStyle = `hsl(${lerp(140, 0, t)}, 80%, ${50 + t * 12}%)`;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
      }
      roundRect(ctx, px, meterY + 47, pipW, 14, 4);
      ctx.fill();
    });

    // --- Boost + speed ----------------------------------------------
    const bW = 190;
    const bX = W - pad - bW;
    const bY = H - pad - 74;
    ctx.fillStyle = 'rgba(10,12,18,0.5)';
    roundRect(ctx, bX, bY, bW, 74, 12);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = 'bold 11px "Trebuchet MS", sans-serif';
    ctx.fillText('TURBO  [SPACE]', bX + 14, bY + 10);
    const boostPct = clamp(limo.boost / CONFIG.limo.boostCapacity, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, bX + 14, bY + 27, bW - 28, 12, 6);
    ctx.fill();
    const bg = ctx.createLinearGradient(bX + 14, 0, bX + bW - 14, 0);
    bg.addColorStop(0, '#4fd2e8');
    bg.addColorStop(1, '#a06bff');
    ctx.fillStyle = limo.boosting ? '#ffd35a' : bg;
    roundRect(ctx, bX + 14, bY + 27, Math.max(4, (bW - 28) * boostPct), 12, 6);
    ctx.fill();

    ctx.font = 'bold 20px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#f2f4f8';
    ctx.fillText(`${Math.round(limo.speed * 11)}`, bX + 14, bY + 46);
    ctx.font = '11px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('KM/H', bX + 52, bY + 54);

    // --- Drift callout ----------------------------------------------
    if (limo.driftAngle > 0.22 && limo.speed > 3.4) {
      const deg = Math.round((limo.driftAngle * 180) / Math.PI);
      const t = clamp((limo.driftAngle - 0.22) / 1.0, 0, 1);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.translate(W / 2, H * 0.72);
      ctx.rotate(Math.sin(time * 18) * 0.02 * t);
      ctx.font = `bold ${28 + t * 22}px "Trebuchet MS", sans-serif`;
      ctx.fillStyle = `hsla(${lerp(50, 320, t)}, 100%, ${60 + t * 10}%, ${0.6 + t * 0.4})`;
      ctx.fillText(`DRIFT  ${deg}°`, 0, 0);
      ctx.restore();
    }

    // --- Cargo loss flash -------------------------------------------
    if (state.flash > 0) {
      ctx.fillStyle = `rgba(255,70,70,${state.flash * 0.28})`;
      ctx.fillRect(0, 0, W, H);
    }

    // --- Toast messages ---------------------------------------------
    if (state.toast && state.toast.life > 0) {
      const a = clamp(state.toast.life, 0, 1);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.globalAlpha = a;
      ctx.font = 'bold 30px "Trebuchet MS", sans-serif';
      ctx.fillStyle = state.toast.color || '#ffd35a';
      ctx.fillText(state.toast.text, W / 2, H * 0.3 - (1 - a) * 30);
      ctx.restore();
    }
  }
}
