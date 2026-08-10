import * as THREE from 'three';
import { mulberry32 } from '../util.js';

/**
 * Builds the night sky as an equirectangular canvas, then runs it through
 * PMREM so the limo's paint and chrome reflect a real environment instead of
 * a flat ambient term. This is what makes the car read as metal rather than
 * as coloured plastic — it's the single highest-value graphics call here.
 */
export function buildNightEnvironment(renderer) {
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const rand = mulberry32(20260810);

  // Zenith → horizon gradient. The warm band at the bottom is the city's
  // light pollution bouncing off the cloud deck.
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0.00, '#03040a');
  sky.addColorStop(0.32, '#080e22');
  sky.addColorStop(0.52, '#122043');
  sky.addColorStop(0.62, '#2a2f5e');
  sky.addColorStop(0.68, '#5b3a63');
  sky.addColorStop(0.72, '#8a4152');
  sky.addColorStop(0.76, '#3a2340');
  sky.addColorStop(1.00, '#05060d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Stars, thinning out toward the horizon haze.
  for (let i = 0; i < 2600; i++) {
    const x = rand() * W;
    const y = Math.pow(rand(), 1.7) * H * 0.55;
    const r = rand() * 1.5 + 0.25;
    const a = (1 - y / (H * 0.55)) * (0.25 + rand() * 0.75);
    ctx.fillStyle = `rgba(${210 + rand() * 45 | 0},${220 + rand() * 35 | 0},255,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Moon, plus its halo — the key light in the scene points from here.
  const mx = W * 0.72, my = H * 0.20;
  const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 190);
  halo.addColorStop(0, 'rgba(220,232,255,.55)');
  halo.addColorStop(0.25, 'rgba(150,180,255,.16)');
  halo.addColorStop(1, 'rgba(90,120,220,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - 200, my - 200, 400, 400);
  ctx.fillStyle = '#eef3ff';
  ctx.beginPath();
  ctx.arc(mx, my, 21, 0, Math.PI * 2);
  ctx.fill();

  // Uneven glow domes along the horizon: distant districts burning neon.
  for (let i = 0; i < 22; i++) {
    const x = rand() * W;
    const r = 120 + rand() * 320;
    const hue = rand() < 0.5 ? 20 + rand() * 30 : 190 + rand() * 130;
    const g = ctx.createRadialGradient(x, H * 0.735, 0, x, H * 0.735, r);
    g.addColorStop(0, `hsla(${hue},85%,62%,${0.16 + rand() * 0.2})`);
    g.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, H * 0.735 - r, r * 2, r * 2);
  }

  const equirect = new THREE.CanvasTexture(c);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();

  return { envMap, background: equirect };
}

/** Layered fog so distant towers fade into the skyline instead of popping in. */
export function buildFog(scene, { near = 60, far = 620, color = 0x0a1024 } = {}) {
  scene.fog = new THREE.Fog(color, near, far);
  return scene.fog;
}
