import { roundRect, TAU } from './util.js';

/**
 * Cargo catalogue. Everything is drawn from above with canvas primitives —
 * no image assets, so the build stays tiny and scales to any resolution.
 *
 *   w / h      footprint on the limo roof (world units)
 *   topHeavy   how badly it wants to leave: multiplies apparent load transfer
 *   density    mass per unit area — heavy cargo also drags the limo around
 */

const shade = (ctx, w, h, r, color) => {
  ctx.fillStyle = color;
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.fill();
};

export const CARGO_TYPES = {
  cake: {
    id: 'cake',
    name: 'Wedding Cake',
    w: 42,
    h: 42,
    topHeavy: 1.55,
    density: 0.0009,
    draw(ctx, t) {
      const tiers = [21, 15, 9];
      const cols = ['#fdf3ea', '#fbe8dc', '#fff8f0'];
      tiers.forEach((r, i) => {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.fillStyle = cols[i];
        ctx.fill();
        ctx.strokeStyle = 'rgba(210,160,180,0.85)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      });
      ctx.fillStyle = '#ff8fb1';
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + t * 0.4;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 17, Math.sin(a) * 17, 2.3, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#ffd86b';
      ctx.beginPath();
      ctx.arc(0, 0, 3.6, 0, TAU);
      ctx.fill();
    },
  },

  giraffe: {
    id: 'giraffe',
    name: 'Sleeping Giraffe',
    w: 96,
    h: 44,
    topHeavy: 1.9,
    density: 0.0013,
    draw(ctx, t) {
      const breathe = 1 + Math.sin(t * 1.6) * 0.02;
      ctx.save();
      ctx.scale(1, breathe);
      ctx.fillStyle = '#e2a94f';
      roundRect(ctx, -30, -19, 62, 38, 15);
      ctx.fill();
      // neck + head folded along the roof
      ctx.save();
      ctx.rotate(-0.35);
      shade(ctx, 46, 15, 7, '#e2a94f');
      ctx.translate(26, 0);
      shade(ctx, 20, 14, 6, '#eab766');
      ctx.fillStyle = '#3b2a17';
      ctx.beginPath();
      ctx.arc(4, -3, 1.9, 0, TAU);
      ctx.arc(4, 3, 1.9, 0, TAU);
      ctx.fill();
      // little sleep horns
      ctx.strokeStyle = '#7a5a2f';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-2, -5);
      ctx.lineTo(-5, -9);
      ctx.moveTo(-2, 5);
      ctx.lineTo(-5, 9);
      ctx.stroke();
      ctx.restore();
      // spots
      ctx.fillStyle = '#a8702a';
      const spots = [
        [-18, -8], [-8, 6], [2, -9], [12, 5], [20, -5], [-24, 7], [8, -2],
      ];
      for (const [sx, sy] of spots) {
        ctx.beginPath();
        ctx.ellipse(sx, sy, 5.2, 4.2, sx * 0.1, 0, TAU);
        ctx.fill();
      }
      // legs
      ctx.strokeStyle = '#d69c45';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      for (const lx of [-16, 14]) {
        ctx.beginPath();
        ctx.moveTo(lx, -14);
        ctx.lineTo(lx - 8, -26);
        ctx.moveTo(lx, 14);
        ctx.lineTo(lx - 8, 26);
        ctx.stroke();
      }
      ctx.restore();
      // ZZZ
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = 'bold 11px sans-serif';
      const zz = (Math.sin(t * 1.1) + 1) * 0.5;
      ctx.fillText('z', 34, -14 - zz * 5);
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText('z', 42, -20 - zz * 7);
    },
  },

  pool: {
    id: 'pool',
    name: 'Full Swimming Pool',
    w: 104,
    h: 52,
    topHeavy: 2.4,
    density: 0.0022,
    draw(ctx, t, tilt) {
      shade(ctx, 104, 52, 8, '#dfe6ef');
      shade(ctx, 94, 42, 5, '#0f4c75');
      // sloshing water offset by the current lean
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, -47, -21, 94, 42, 5);
      ctx.clip();
      const slosh = tilt * 14;
      const grad = ctx.createLinearGradient(-47, 0, 47, 0);
      grad.addColorStop(0, '#2ea3d8');
      grad.addColorStop(0.5, '#59c8ee');
      grad.addColorStop(1, '#2ea3d8');
      ctx.fillStyle = grad;
      ctx.fillRect(-47 + slosh, -21, 94, 42);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        const y = -12 + i * 12 + Math.sin(t * 2 + i) * 2;
        ctx.moveTo(-45, y);
        for (let x = -45; x <= 45; x += 9) {
          ctx.lineTo(x, y + Math.sin(x * 0.14 + t * 3 + i) * 2.4);
        }
        ctx.stroke();
      }
      ctx.restore();
      // inflatable flamingo, obviously
      ctx.save();
      ctx.translate(Math.sin(t * 0.8) * 10 + tilt * 8, Math.cos(t * 0.6) * 5);
      ctx.fillStyle = '#ff77a8';
      ctx.beginPath();
      ctx.ellipse(0, 0, 11, 7, 0.4, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(7, -5, 3.4, 0, TAU);
      ctx.fill();
      ctx.restore();
    },
  },

  bouncy: {
    id: 'bouncy',
    name: 'Bouncy Castle',
    w: 96,
    h: 88,
    topHeavy: 2.15,
    density: 0.0006,
    draw(ctx, t) {
      const wob = 1 + Math.sin(t * 4) * 0.03;
      ctx.save();
      ctx.scale(wob, 2 - wob);
      shade(ctx, 92, 84, 12, '#e8474c');
      shade(ctx, 72, 64, 9, '#f5d33f');
      shade(ctx, 50, 44, 7, '#3fa9f5');
      const turrets = [[-38, -34], [38, -34], [-38, 34], [38, 34]];
      turrets.forEach(([x, y], i) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = '#5cc26a';
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, TAU);
        ctx.fill();
        // flag
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(9, -9);
        ctx.stroke();
        ctx.fillStyle = i % 2 ? '#ff5ec4' : '#ffdd55';
        ctx.beginPath();
        ctx.moveTo(9, -9);
        ctx.lineTo(17, -12 + Math.sin(t * 6 + i) * 2);
        ctx.lineTo(10, -14);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
      ctx.restore();
    },
  },

  speakers: {
    id: 'speakers',
    name: 'Giant Speaker Stack',
    w: 62,
    h: 84,
    topHeavy: 2.05,
    density: 0.0019,
    draw(ctx, t) {
      shade(ctx, 60, 82, 5, '#15171d');
      for (const y of [-21, 21]) {
        ctx.save();
        ctx.translate(0, y);
        shade(ctx, 52, 36, 4, '#22252e');
        const pulse = 1 + Math.sin(t * 9 + y) * 0.09;
        ctx.save();
        ctx.scale(pulse, pulse);
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, TAU);
        ctx.fillStyle = '#33373f';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, TAU);
        ctx.fillStyle = '#0e1014';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, TAU);
        ctx.fillStyle = '#5b6270';
        ctx.fill();
        ctx.restore();
        ctx.restore();
      }
      // pumping LED strip
      const lit = (Math.sin(t * 11) + 1) * 0.5;
      ctx.fillStyle = `rgba(90,255,160,${0.35 + lit * 0.65})`;
      ctx.fillRect(-26, -2, 52, 4);
    },
  },

  ducks: {
    id: 'ducks',
    name: 'Stack of Giant Ducks',
    w: 76,
    h: 62,
    topHeavy: 1.7,
    density: 0.0005,
    draw(ctx, t) {
      const pos = [
        [-18, -14, 17], [18, -10, 15], [-8, 16, 14], [20, 18, 12],
      ];
      pos.forEach(([x, y, r], i) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 1.4 + i) * 0.14);
        ctx.fillStyle = '#ffd633';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#ffe066';
        ctx.beginPath();
        ctx.arc(-r * 0.15, -r * 0.15, r * 0.6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#ff8c1a';
        ctx.beginPath();
        ctx.moveTo(r * 0.55, 0);
        ctx.lineTo(r * 1.15, -3);
        ctx.lineTo(r * 1.15, 3);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#22242b';
        ctx.beginPath();
        ctx.arc(r * 0.35, -r * 0.3, 1.9, 0, TAU);
        ctx.arc(r * 0.35, r * 0.3, 1.9, 0, TAU);
        ctx.fill();
        ctx.restore();
      });
    },
  },

  piano: {
    id: 'piano',
    name: 'Grand Piano',
    w: 82,
    h: 66,
    topHeavy: 1.35,
    density: 0.0026,
    draw(ctx) {
      ctx.fillStyle = '#101216';
      ctx.beginPath();
      ctx.moveTo(-40, -18);
      ctx.lineTo(18, -30);
      ctx.quadraticCurveTo(44, -26, 40, 4);
      ctx.quadraticCurveTo(36, 28, 6, 30);
      ctx.lineTo(-40, 20);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#3a3f4b';
      ctx.lineWidth = 2;
      ctx.stroke();
      // keys
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(-40, -16, 15, 34);
      ctx.fillStyle = '#101216';
      for (let i = 0; i < 9; i++) ctx.fillRect(-40, -14 + i * 3.9, 9, 1.9);
      // lid highlight
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-16, -22);
      ctx.quadraticCurveTo(24, -22, 33, 2);
      ctx.stroke();
    },
  },

  chandelier: {
    id: 'chandelier',
    name: 'Ballroom Chandelier',
    w: 68,
    h: 68,
    topHeavy: 2.6,
    density: 0.0014,
    draw(ctx, t) {
      ctx.save();
      ctx.rotate(t * 0.3);
      for (let ring = 0; ring < 3; ring++) {
        const r = 12 + ring * 11;
        ctx.strokeStyle = ring === 1 ? '#f0d68a' : '#d9be74';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.stroke();
        const n = 6 + ring * 3;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + ring;
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 6);
          g.addColorStop(0, 'rgba(255,247,210,0.95)');
          g.addColorStop(1, 'rgba(255,220,140,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#fff6d2';
          ctx.beginPath();
          ctx.arc(x, y, 2.1, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 16);
      g.addColorStop(0, 'rgba(255,240,190,0.9)');
      g.addColorStop(1, 'rgba(255,220,140,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, TAU);
      ctx.fill();
    },
  },

  iceSwan: {
    id: 'iceSwan',
    name: 'Ice Swan',
    w: 58,
    h: 46,
    topHeavy: 2.2,
    density: 0.0016,
    draw(ctx, t) {
      ctx.fillStyle = 'rgba(180,235,255,0.85)';
      ctx.beginPath();
      ctx.ellipse(-4, 0, 24, 16, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(6, -2);
      ctx.quadraticCurveTo(24, -12, 20, -22);
      ctx.stroke();
      ctx.fillStyle = 'rgba(210,245,255,0.95)';
      ctx.beginPath();
      ctx.arc(20, -23, 5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffb347';
      ctx.beginPath();
      ctx.moveTo(24, -23);
      ctx.lineTo(31, -21);
      ctx.lineTo(24, -19);
      ctx.closePath();
      ctx.fill();
      // wing facets
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(-22 + i * 8, -12);
        ctx.lineTo(-14 + i * 8, 12);
        ctx.stroke();
      }
      const gl = (Math.sin(t * 2) + 1) * 0.5;
      ctx.fillStyle = `rgba(255,255,255,${0.1 + gl * 0.16})`;
      ctx.beginPath();
      ctx.ellipse(-4, 0, 24, 16, 0, 0, TAU);
      ctx.fill();
    },
  },

  hotTub: {
    id: 'hotTub',
    name: 'Occupied Hot Tub',
    w: 72,
    h: 72,
    topHeavy: 2.3,
    density: 0.002,
    draw(ctx, t, tilt) {
      ctx.fillStyle = '#6b4a2f';
      ctx.beginPath();
      ctx.arc(0, 0, 35, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#8a613d';
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * TAU;
        ctx.save();
        ctx.rotate(a);
        ctx.fillRect(30, -4, 6, 8);
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 28, 0, TAU);
      ctx.clip();
      ctx.fillStyle = '#1f7fa8';
      ctx.fillRect(-30 + tilt * 10, -30, 60, 60);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 12; i++) {
        const a = t * 1.7 + i;
        const r = 6 + ((i * 3 + t * 22) % 22);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.4, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      // relaxed passenger
      ctx.fillStyle = '#f2c49b';
      ctx.beginPath();
      ctx.arc(0, -14, 6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#3a2a1d';
      ctx.beginPath();
      ctx.arc(0, -16, 6, Math.PI, TAU);
      ctx.fill();
    },
  },

  portaloo: {
    id: 'portaloo',
    name: 'Occupied Porta-Potty',
    w: 44,
    h: 44,
    topHeavy: 2.45,
    density: 0.0009,
    draw(ctx, t) {
      const shake = Math.sin(t * 16) * 1.2;
      ctx.save();
      ctx.translate(shake, 0);
      shade(ctx, 42, 42, 4, '#2f8f6d');
      shade(ctx, 34, 34, 3, '#3aa780');
      ctx.fillStyle = '#1f6b50';
      ctx.fillRect(-16, -3, 32, 6);
      ctx.fillStyle = '#d8e8e2';
      ctx.fillRect(-7, -18, 14, 6);
      ctx.strokeStyle = '#1f6b50';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(11, 0, 3, 0, TAU);
      ctx.stroke();
      ctx.restore();
    },
  },

  champagne: {
    id: 'champagne',
    name: 'Champagne Pyramid',
    w: 54,
    h: 54,
    topHeavy: 2.7,
    density: 0.0008,
    draw(ctx, t) {
      const rings = [
        { r: 22, n: 10 },
        { r: 13, n: 6 },
        { r: 5, n: 3 },
      ];
      rings.forEach((ring, ri) => {
        for (let i = 0; i < ring.n; i++) {
          const a = (i / ring.n) * TAU + ri * 0.4;
          const x = Math.cos(a) * ring.r;
          const y = Math.sin(a) * ring.r;
          ctx.fillStyle = 'rgba(230,245,255,0.9)';
          ctx.beginPath();
          ctx.arc(x, y, 5.4, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#f2d06b';
          ctx.beginPath();
          ctx.arc(x, y, 3.4, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          ctx.arc(x + Math.sin(t * 3 + i) * 1, y - 1, 0.9, 0, TAU);
          ctx.fill();
        }
      });
    },
  },

  fishTank: {
    id: 'fishTank',
    name: 'Aquarium (Occupied)',
    w: 78,
    h: 46,
    topHeavy: 2.35,
    density: 0.0021,
    draw(ctx, t, tilt) {
      shade(ctx, 78, 46, 4, '#cfe6f2');
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, -36, -20, 72, 40, 3);
      ctx.clip();
      ctx.fillStyle = '#1c86b8';
      ctx.fillRect(-40 + tilt * 12, -20, 80, 40);
      ctx.fillStyle = '#7ad3a0';
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(-28 + i * 17, 8, 4, 12);
      }
      for (let i = 0; i < 3; i++) {
        const x = ((t * 26 + i * 30) % 76) - 38;
        const y = -8 + i * 9;
        ctx.fillStyle = ['#ff8a3d', '#ffd93d', '#ff5ec4'][i];
        ctx.beginPath();
        ctx.ellipse(x, y, 6, 3.6, 0, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - 6, y);
        ctx.lineTo(x - 11, y - 3);
        ctx.lineTo(x - 11, y + 3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = '#9fbfd0';
      ctx.lineWidth = 2.5;
      roundRect(ctx, -36, -20, 72, 40, 3);
      ctx.stroke();
    },
  },

  statue: {
    id: 'statue',
    name: 'Marble Statue',
    w: 46,
    h: 62,
    topHeavy: 2.5,
    density: 0.0029,
    draw(ctx) {
      ctx.fillStyle = '#c9cdd6';
      roundRect(ctx, -22, -30, 44, 60, 6);
      ctx.fill();
      ctx.fillStyle = '#e2e6ee';
      ctx.beginPath();
      ctx.arc(0, -14, 11, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#aeb3be';
      ctx.beginPath();
      ctx.ellipse(0, 10, 15, 17, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#9aa0ac';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-14, 2);
      ctx.lineTo(-20, -8);
      ctx.moveTo(14, 2);
      ctx.lineTo(21, -6);
      ctx.stroke();
    },
  },

  cactus: {
    id: 'cactus',
    name: 'Enormous Cactus',
    w: 52,
    h: 52,
    topHeavy: 2.15,
    density: 0.0015,
    draw(ctx) {
      ctx.fillStyle = '#8a5a3b';
      ctx.beginPath();
      ctx.arc(0, 0, 25, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#3f8f52';
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-13, -8, 8, 0, TAU);
      ctx.arc(12, 9, 7, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#d9e8b8';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 9, Math.sin(a) * 9);
        ctx.lineTo(Math.cos(a) * 15, Math.sin(a) * 15);
        ctx.stroke();
      }
      ctx.fillStyle = '#ff6f9c';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, TAU);
      ctx.fill();
    },
  },

  satellite: {
    id: 'satellite',
    name: 'Satellite Dish',
    w: 84,
    h: 84,
    topHeavy: 2.8,
    density: 0.0012,
    draw(ctx, t) {
      ctx.save();
      ctx.rotate(Math.sin(t * 0.5) * 0.15);
      ctx.fillStyle = '#dfe3ea';
      ctx.beginPath();
      ctx.arc(0, 0, 40, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#c3c9d4';
      ctx.beginPath();
      ctx.arc(0, 0, 32, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#9aa2b1';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * 38, Math.sin(a) * 38);
        ctx.stroke();
      }
      ctx.fillStyle = '#4a5262';
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#6b7383';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(22, -22);
      ctx.stroke();
      ctx.restore();
    },
  },
};

export const CARGO_ORDER = Object.keys(CARGO_TYPES);

export function getCargoType(id) {
  return CARGO_TYPES[id] || CARGO_TYPES.cake;
}

/**
 * Draws one cargo item. `lean` is the normalised tilt (-1..1 along each axis)
 * used to fake perspective: the item slides and skews in the lean direction and
 * casts a longer shadow the closer it gets to falling.
 */
export function drawCargoItem(ctx, def, { time = 0, leanX = 0, leanY = 0, tilt = 0, alpha = 1 } = {}) {
  const mag = Math.hypot(leanX, leanY);
  ctx.save();
  ctx.globalAlpha = alpha;

  // Contact shadow shifts opposite the lean — reads as "lifting off one side".
  ctx.save();
  ctx.translate(-leanX * 5, -leanY * 5);
  ctx.fillStyle = `rgba(0,0,0,${0.28 + tilt * 0.22})`;
  ctx.beginPath();
  ctx.ellipse(0, 0, def.w * 0.52, def.h * 0.52, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.translate(leanX * 9, leanY * 9);
  const skew = Math.min(mag, 1) * 0.22;
  ctx.transform(1 + skew * 0.25, leanY * skew * 0.5, leanX * skew * 0.5, 1 + skew * 0.25, 0, 0);
  def.draw(ctx, time, Math.max(-1, Math.min(1, leanX)));

  if (tilt > 0.55) {
    const pulse = (Math.sin(time * (8 + tilt * 12)) + 1) * 0.5;
    ctx.strokeStyle = `rgba(255,${Math.round(180 - tilt * 140)},60,${0.35 + pulse * 0.5})`;
    ctx.lineWidth = 3;
    roundRect(ctx, -def.w / 2 - 3, -def.h / 2 - 3, def.w + 6, def.h + 6, 8);
    ctx.stroke();
  }
  ctx.restore();
}
