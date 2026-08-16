import * as THREE from 'three';
import { mulberry32 } from '../util.js';

/**
 * Builds the night sky as an equirectangular canvas, then runs it through
 * PMREM so the limo's paint and chrome reflect a real environment instead of
 * a flat ambient term. This is what makes the car read as metal rather than
 * as coloured plastic — it's the single highest-value graphics call here.
 */
export function buildNightEnvironment(renderer) {
  /*
   * This texture is *only* the reflection probe — the visible sky is drawn by
   * the dome shader in post.js, which does its own stars and sun. So it needs
   * the broad distribution of light and nothing else.
   *
   * It used to be a 2048x1024 canvas with 2,600 individually stroked stars,
   * and PMREM-ing that cost ~2.5s of a ~5s load: half the loading screen spent
   * on detail that is blurred into irrelevance by the convolution anyway.
   * A small, smooth gradient produces the same reflections.
   */
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

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

  // A few horizon glow domes: distant districts burning neon. These are what
  // actually show up in the chrome.
  const rand = mulberry32(20260810);
  for (let i = 0; i < 10; i++) {
    const x = rand() * W;
    const r = 18 + rand() * 46;
    const hue = rand() < 0.5 ? 20 + rand() * 30 : 190 + rand() * 130;
    const g = ctx.createRadialGradient(x, H * 0.735, 0, x, H * 0.735, r);
    g.addColorStop(0, `hsla(${hue},85%,62%,${0.18 + rand() * 0.2})`);
    g.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, H * 0.735 - r, r * 2, r * 2);
  }

  // Moon glow, as a soft blob — the disc itself is drawn by the sky dome.
  const mx = W * 0.72, my = H * 0.20;
  const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 26);
  halo.addColorStop(0, 'rgba(220,232,255,.65)');
  halo.addColorStop(1, 'rgba(90,120,220,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - 26, my - 26, 52, 52);

  const equirect = new THREE.CanvasTexture(c);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();
  equirect.dispose();

  return { envMap, background: null };
}

/** Layered fog so distant towers fade into the skyline instead of popping in. */
export function buildFog(scene, { near = 60, far = 620, color = 0x0a1024 } = {}) {
  scene.fog = new THREE.Fog(color, near, far);
  return scene.fog;
}
