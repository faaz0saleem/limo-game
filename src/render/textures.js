import * as THREE from 'three';
import { clamp, mulberry32 } from '../util.js';

/* Every texture in the game is generated on a 2D canvas at boot — the repo
 * ships no image assets, so the whole thing loads instantly and offline. */

const cache = new Map();
const memo = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d') };
}

function finish(c, { repeat = 1, srgb = false, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ noise */

/** Tileable value noise, summed over octaves. Returns a [0,1] sampler grid. */
function fbmField(size, octaves, seed) {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;

  for (let o = 0; o < octaves; o++) {
    const cells = 2 << o; // 2, 4, 8 … keeps the field tileable
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();

    const scale = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / scale;
      const y0 = Math.floor(gy) % cells;
      const y1 = (y0 + 1) % cells;
      const fy = gy - Math.floor(gy);
      const sy = fy * fy * (3 - 2 * fy);

      for (let x = 0; x < size; x++) {
        const gx = x / scale;
        const x0 = Math.floor(gx) % cells;
        const x1 = (x0 + 1) % cells;
        const fx = gx - Math.floor(gx);
        const sx = fx * fx * (3 - 2 * fx);

        const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
        const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
        const top = a + (b - a) * sx;
        const bot = c + (d - c) * sx;
        out[y * size + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }

  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Grayscale canvas from a field, with an optional per-sample transform. */
function fieldToCanvas(field, size, shape = (v) => v) {
  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const v = clamp(shape(field[i], i), 0, 1) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { c, ctx };
}

/** Sobel a height field into a tangent-space normal map. */
function normalFromField(field, size, strength = 2.2) {
  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const at = (x, y) => field[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------- road / tarmac */

/**
 * Wet night asphalt. The roughness map is the star: broad low-roughness
 * patches read as standing water and pick up mirror-sharp reflections of the
 * skyline, while the coarse grain keeps the dry areas from looking like vinyl.
 */
export function asphaltMaps() {
  return memo('asphalt', () => {
    const S = 512;
    const grain = fbmField(S, 6, 1337);
    const puddles = fbmField(S, 3, 99);

    // Albedo: near-black with subtle mottling and a few oil sheens.
    const { c: albedo, ctx } = fieldToCanvas(grain, S, (v) => 0.10 + v * 0.10);
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.25;
    for (let i = 0; i < 40; i++) {
      const rand = mulberry32(i * 7 + 3);
      const x = rand() * S, y = rand() * S, r = 18 + rand() * 60;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(70,90,130,.7)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Roughness: wet patches drop to ~0.08, dry grain sits around 0.7.
    const { c: rough } = fieldToCanvas(grain, S, (v, i) => {
      const wet = clamp((puddles[i] - 0.46) * 4.2, 0, 1);
      return (0.42 + v * 0.42) * (1 - wet) + 0.07 * wet;
    });

    return {
      map: finish(albedo, { srgb: true }),
      roughnessMap: finish(rough),
      normalMap: finish(normalFromField(grain, S, 1.5)),
    };
  });
}

/** Painted lane markings, drawn once and tiled down the length of a road. */
export function laneMarkingTexture() {
  return memo('lane', () => {
    const { c, ctx } = canvas2d(64, 512);
    ctx.clearRect(0, 0, 64, 512);
    ctx.fillStyle = 'rgba(238,236,214,.85)';
    for (let y = 20; y < 512; y += 128) ctx.fillRect(26, y, 12, 76);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  });
}

/* -------------------------------------------------------------- buildings */

const WINDOW_TINTS = [
  [255, 214, 152], [255, 186, 120], [214, 236, 255],
  [150, 214, 255], [255, 240, 214], [186, 255, 236],
];

/**
 * A facade strip: dark cladding plus a grid of windows, a fraction of which
 * are lit. Returns matched albedo + emissive canvases so only the lit panes
 * glow (and therefore only they bleed into the bloom pass).
 */
export function facadeMaps(variant) {
  return memo('facade' + variant, () => {
    const W = 256, H = 512;
    const rand = mulberry32(variant * 977 + 17);

    const base = canvas2d(W, H);
    const glow = canvas2d(W, H);

    const clad = 18 + Math.floor(rand() * 16);
    base.ctx.fillStyle = `rgb(${clad},${clad + 3},${clad + 8})`;
    base.ctx.fillRect(0, 0, W, H);
    glow.ctx.fillStyle = '#000';
    glow.ctx.fillRect(0, 0, W, H);

    // Vertical mullions give the facade some structure at a distance.
    base.ctx.fillStyle = 'rgba(0,0,0,.35)';
    for (let x = 0; x < W; x += 32) base.ctx.fillRect(x, 0, 3, H);

    const cols = 4 + Math.floor(rand() * 3);
    const rows = 16 + Math.floor(rand() * 8);
    const cw = W / cols, ch = H / rows;
    const winW = cw * 0.62, winH = ch * 0.5;
    const litRate = 0.28 + rand() * 0.42;

    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        const x = cI * cw + (cw - winW) / 2;
        const y = r * ch + (ch - winH) / 2;
        const lit = rand() < litRate;

        if (!lit) {
          base.ctx.fillStyle = 'rgba(10,14,24,.95)';
          base.ctx.fillRect(x, y, winW, winH);
          continue;
        }

        const [tr, tg, tb] = WINDOW_TINTS[Math.floor(rand() * WINDOW_TINTS.length)];
        const bright = 0.45 + rand() * 0.55;
        base.ctx.fillStyle = `rgb(${tr * bright | 0},${tg * bright | 0},${tb * bright | 0})`;
        base.ctx.fillRect(x, y, winW, winH);

        glow.ctx.fillStyle = `rgb(${tr * bright | 0},${tg * bright | 0},${tb * bright | 0})`;
        glow.ctx.fillRect(x, y, winW, winH);

        // A blocked-out silhouette in some windows sells the scale.
        if (rand() < 0.18) {
          glow.ctx.fillStyle = 'rgba(0,0,0,.55)';
          const bw = winW * (0.2 + rand() * 0.3);
          glow.ctx.fillRect(x + rand() * (winW - bw), y + winH * 0.35, bw, winH * 0.65);
        }
      }
    }

    return {
      map: finish(base.c, { srgb: true, repeat: 1 }),
      emissiveMap: finish(glow.c, { srgb: true, repeat: 1 }),
    };
  });
}

/** Rooftop / sidewalk concrete. */
export function concreteMaps() {
  return memo('concrete', () => {
    const S = 256;
    const f = fbmField(S, 5, 4242);
    const { c } = fieldToCanvas(f, S, (v) => 0.16 + v * 0.14);
    return { map: finish(c, { srgb: true, repeat: 4 }), normalMap: finish(normalFromField(f, S, 1.1), { repeat: 4 }) };
  });
}

/* ---------------------------------------------------------------- sprites */

/** Soft round particle used for tire smoke and dust. */
export function smokeSprite() {
  return memo('smoke', () => {
    const S = 128;
    const { c, ctx } = canvas2d(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    // Break the perfect circle up so puffs don't look like billiard balls.
    ctx.globalCompositeOperation = 'destination-out';
    const rand = mulberry32(7);
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2;
      const d = 22 + rand() * 40;
      const r = 8 + rand() * 20;
      const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
      const h = ctx.createRadialGradient(x, y, 0, x, y, r);
      h.addColorStop(0, 'rgba(0,0,0,.5)');
      h.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = h;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/** Tight glow used for headlights, taillights and pickup beacons. */
export function glowSprite() {
  return memo('glow', () => {
    const S = 128;
    const { c, ctx } = canvas2d(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,255,255,.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/** Blob shadow that sits under the limo so it never looks like it's floating. */
export function blobShadowTexture() {
  return memo('blob', () => {
    const S = 128;
    const { c, ctx } = canvas2d(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,.62)');
    g.addColorStop(0.55, 'rgba(0,0,0,.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  });
}

/** Vertical neon sign panel — pure emissive, drives most of the street colour. */
export function neonSignTexture(seed) {
  return memo('neon' + seed, () => {
    const rand = mulberry32(seed * 31 + 5);
    const W = 128, H = 256;
    const { c, ctx } = canvas2d(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const hue = Math.floor(rand() * 360);
    ctx.strokeStyle = `hsl(${hue} 100% 68%)`;
    ctx.fillStyle = `hsl(${hue} 100% 62%)`;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';

    const style = Math.floor(rand() * 3);
    if (style === 0) {
      for (let i = 0; i < 5; i++) {
        const y = 34 + i * 42;
        ctx.beginPath();
        ctx.moveTo(20, y);
        ctx.lineTo(20 + 30 + rand() * 60, y);
        ctx.stroke();
      }
    } else if (style === 1) {
      ctx.strokeRect(20, 26, W - 40, H - 52);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 34, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(24, H - 30);
      for (let i = 0; i < 6; i++) ctx.lineTo(24 + i * 16, H - 30 - rand() * (H - 70));
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

export function disposeTextureCache() {
  for (const v of cache.values()) {
    if (v instanceof THREE.Texture) v.dispose();
    else if (v && typeof v === 'object') Object.values(v).forEach((t) => t?.dispose?.());
  }
  cache.clear();
}
