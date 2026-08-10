import { TAU, roundRect } from './util.js';

/**
 * Garage catalogue. Cash comes from clean deliveries; everything here is
 * cosmetic so buying never gates progress.
 */

export const UNDERGLOW = {
  none: { id: 'none', name: 'No Underglow', price: 0, color: null },
  cyan: { id: 'cyan', name: 'Ice Cyan', price: 900, color: '#3fe0ff' },
  magenta: { id: 'magenta', name: 'Hot Magenta', price: 1400, color: '#ff4fd8' },
  lime: { id: 'lime', name: 'Toxic Lime', price: 1400, color: '#8dff3f' },
  gold: { id: 'gold', name: 'Solid Gold', price: 2600, color: '#ffc93f' },
  rainbow: { id: 'rainbow', name: 'Full Rainbow', price: 5200, color: 'rainbow' },
};

export const HORNS = {
  stock: { id: 'stock', name: 'Stock Horn', price: 0 },
  airhorn: { id: 'airhorn', name: 'Air Horn', price: 800 },
  duck: { id: 'duck', name: 'Rubber Duck', price: 1200 },
  trumpet: { id: 'trumpet', name: 'Fanfare', price: 1900 },
  clown: { id: 'clown', name: 'Clown Car', price: 2400 },
  moo: { id: 'moo', name: 'Distant Cow', price: 3600 },
};

export const HATS = {
  none: {
    id: 'none',
    name: 'Bare Head',
    price: 0,
    draw: null,
  },
  cap: {
    id: 'cap',
    name: "Valet Cap",
    price: 600,
    draw(ctx) {
      ctx.fillStyle = '#1d2130';
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2b3145';
      ctx.beginPath();
      ctx.ellipse(5, 0, 5, 7, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#e8c66a';
      ctx.fillRect(-1.5, -2, 3, 4);
    },
  },
  tophat: {
    id: 'tophat',
    name: 'Top Hat',
    price: 1500,
    draw(ctx) {
      ctx.fillStyle = '#14161d';
      ctx.beginPath();
      ctx.arc(0, 0, 9.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#22252f';
      ctx.beginPath();
      ctx.arc(0, 0, 6.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#b03a4a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, TAU);
      ctx.stroke();
    },
  },
  crown: {
    id: 'crown',
    name: 'Party Crown',
    price: 2800,
    draw(ctx, t) {
      ctx.fillStyle = '#ffcc3d';
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        const r = i % 2 === 0 ? 10 : 6;
        ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.45 + Math.sin(t * 5) * 0.3})`;
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, TAU);
      ctx.fill();
    },
  },
  cowboy: {
    id: 'cowboy',
    name: 'Ten Gallon',
    price: 3200,
    draw(ctx) {
      ctx.fillStyle = '#a97445';
      ctx.beginPath();
      ctx.ellipse(0, 0, 13, 9, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#8a5c34';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.5, 5, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#5d3d21';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, 9, 6.6, 0, 0, TAU);
      ctx.stroke();
    },
  },
  chef: {
    id: 'chef',
    name: 'Chef Toque',
    price: 4200,
    draw(ctx, t) {
      const puff = 1 + Math.sin(t * 2) * 0.04;
      ctx.fillStyle = '#f4f6fa';
      ctx.save();
      ctx.scale(puff, puff);
      ctx.beginPath();
      ctx.arc(-4, -3, 5.5, 0, TAU);
      ctx.arc(4, -3, 5.5, 0, TAU);
      ctx.arc(0, 4, 6, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#dfe3ea';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, TAU);
      ctx.fill();
    },
  },
  party: {
    id: 'party',
    name: 'Party Cone',
    price: 5000,
    draw(ctx, t) {
      ctx.fillStyle = '#ff5e8a';
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#4fd2e8';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + t;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 5.5, Math.sin(a) * 5.5, 2, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#ffd93d';
      ctx.beginPath();
      ctx.arc(0, 0, 2.6, 0, TAU);
      ctx.fill();
    },
  },
};

export const SLOTS = [
  { id: 'underglow', name: 'Underglow', items: UNDERGLOW },
  { id: 'horn', name: 'Horn', items: HORNS },
  { id: 'hat', name: 'Driver Hat', items: HATS },
];

export function getItem(slot, id) {
  const table = SLOTS.find((s) => s.id === slot);
  if (!table) return null;
  return table.items[id] || Object.values(table.items)[0];
}

/** Underglow colour for the current frame (rainbow cycles). */
export function underglowColor(id, time) {
  const item = UNDERGLOW[id];
  if (!item || !item.color) return null;
  if (item.color === 'rainbow') {
    const hue = (time * 90) % 360;
    return `hsl(${hue}, 100%, 60%)`;
  }
  return item.color;
}

export function drawHat(ctx, id, time) {
  const hat = HATS[id];
  if (!hat || !hat.draw) return;
  hat.draw(ctx, time);
}
