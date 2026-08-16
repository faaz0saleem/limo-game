import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util.js';

/**
 * Day/night cycle.
 *
 * A full rotation takes `cycleMinutes`, split evenly: roughly 20 minutes of
 * daylight, then 20 of night, with a few minutes of dawn and dusk in between.
 * Everything visual is driven off one number — `daylight`, 0 at midnight and
 * 1 at noon — so the sky, the fog, the key light, the building windows and the
 * car's headlights all stay in agreement.
 */

const PALETTE = {
  night: {
    top: 0x03040a, horizon: 0x131c3e, glow: 0x6a3a5c,
    fog: 0x0b1020, key: 0xa8c0ff, keyIntensity: 1.7,
    ambientSky: 0x3a4a80, ambientGround: 0x1a1018, ambientIntensity: 1.1,
    windows: 1.35, exposure: 1.08, starFade: 1,
  },
  dawn: {
    top: 0x1b2b55, horizon: 0xd98352, glow: 0xff9d5c,
    fog: 0x40405e, key: 0xffb37a, keyIntensity: 3.4,
    ambientSky: 0x8a9cc8, ambientGround: 0x40342e, ambientIntensity: 2.1,
    windows: 0.65, exposure: 1.0, starFade: 0.15,
  },
  day: {
    top: 0x4a7fb8, horizon: 0xc2d4e2, glow: 0xe8eef2,
    fog: 0xb6c6d2, key: 0xfff2df, keyIntensity: 4.6,
    ambientSky: 0xc6d8ee, ambientGround: 0x9a8f7e, ambientIntensity: 3.0,
    windows: 0.04, exposure: 1.0, starFade: 0,
  },
  dusk: {
    top: 0x1d2450, horizon: 0xc9615c, glow: 0xff7a54,
    fog: 0x4a3a54, key: 0xff9a6a, keyIntensity: 3.0,
    ambientSky: 0x7a7ab0, ambientGround: 0x3a2a30, ambientIntensity: 1.9,
    windows: 0.8, exposure: 1.02, starFade: 0.3,
  },
};

/** Blend two palettes into `out`, avoiding per-frame allocation. */
function blend(a, b, t, out) {
  out.top.lerpColors(a._top, b._top, t);
  out.horizon.lerpColors(a._horizon, b._horizon, t);
  out.glow.lerpColors(a._glow, b._glow, t);
  out.fog.lerpColors(a._fog, b._fog, t);
  out.key.lerpColors(a._key, b._key, t);
  out.ambientSky.lerpColors(a._ambientSky, b._ambientSky, t);
  out.ambientGround.lerpColors(a._ambientGround, b._ambientGround, t);
  out.keyIntensity = lerp(a.keyIntensity, b.keyIntensity, t);
  out.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity, t);
  out.windows = lerp(a.windows, b.windows, t);
  out.exposure = lerp(a.exposure, b.exposure, t);
  out.starFade = lerp(a.starFade, b.starFade, t);
  return out;
}

for (const p of Object.values(PALETTE)) {
  for (const k of ['top', 'horizon', 'glow', 'fog', 'key', 'ambientSky', 'ambientGround']) {
    p['_' + k] = new THREE.Color(p[k]);
  }
}

export class DayNight {
  /**
   * @param {number} cycleMinutes  full day+night, in minutes of play
   * @param {number} startAt       0..1 phase; 0.5 = noon, 0 = midnight
   */
  constructor({ cycleMinutes = 40, startAt = 0.02 } = {}) {
    this.cycleSeconds = cycleMinutes * 60;
    this.phase = startAt;
    this.current = {
      top: new THREE.Color(), horizon: new THREE.Color(), glow: new THREE.Color(),
      fog: new THREE.Color(), key: new THREE.Color(),
      ambientSky: new THREE.Color(), ambientGround: new THREE.Color(),
      keyIntensity: 1, ambientIntensity: 1, windows: 1, exposure: 1, starFade: 1,
    };
    this._sunDir = new THREE.Vector3();
    this._evaluate();
  }

  /** 0 at midnight, 1 at noon. */
  get daylight() {
    return smoothstep(clamp((Math.sin((this.phase - 0.25) * Math.PI * 2) + 1) / 2, 0, 1));
  }

  get isNight() {
    return this.daylight < 0.32;
  }

  /** Human-readable clock, for the HUD. */
  get clock() {
    const totalMin = this.phase * 24 * 60;
    const h = Math.floor(totalMin / 60) % 24;
    const m = Math.floor(totalMin % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Direction the key light travels, i.e. from the sun toward the ground. */
  get sunDirection() {
    const a = (this.phase - 0.25) * Math.PI * 2;
    return this._sunDir.set(Math.cos(a) * 0.6, Math.sin(a), Math.cos(a) * 0.55).normalize();
  }

  _evaluate() {
    // phase: 0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk
    const p = this.phase;
    let a, b, t;
    if (p < 0.25) { a = PALETTE.night; b = PALETTE.dawn; t = p / 0.25; }
    else if (p < 0.5) { a = PALETTE.dawn; b = PALETTE.day; t = (p - 0.25) / 0.25; }
    else if (p < 0.75) { a = PALETTE.day; b = PALETTE.dusk; t = (p - 0.5) / 0.25; }
    else { a = PALETTE.dusk; b = PALETTE.night; t = (p - 0.75) / 0.25; }
    blend(a, b, smoothstep(t), this.current);
  }

  update(dt) {
    this.phase = (this.phase + dt / this.cycleSeconds) % 1;
    this._evaluate();
    return this.current;
  }

  /** Push the current state into the scene. Called once per frame. */
  apply({ scene, sky, key, ambient, renderer, facadeMaterials, limo, city }) {
    const c = this.current;

    if (sky) {
      sky.material.uniforms.uTop.value.copy(c.top);
      sky.material.uniforms.uHorizon.value.copy(c.horizon);
      sky.material.uniforms.uGlow.value.copy(c.glow);
      sky.material.uniforms.uStarFade.value = c.starFade;
      sky.material.uniforms.uSunDir.value.copy(this.sunDirection).negate();
      sky.material.uniforms.uDaylight.value = this.daylight;
    }

    if (scene?.fog) scene.fog.color.copy(c.fog);
    if (scene) scene.background = null;      // the dome is the sky

    if (key) {
      // The light points from the sun toward the origin.
      const d = this.sunDirection;
      key.position.set(-d.x * 120, Math.max(-d.y * 120, 18), -d.z * 120);
      key.color.copy(c.key);
      key.intensity = c.keyIntensity;
    }

    if (ambient) {
      ambient.color.copy(c.ambientSky);
      ambient.groundColor.copy(c.ambientGround);
      ambient.intensity = c.ambientIntensity;
    }

    if (renderer) renderer.toneMappingExposure = c.exposure;

    // Office lights switch off in daylight.
    if (facadeMaterials) {
      for (const m of facadeMaterials) m.emissiveIntensity = c.windows;
    }

    // Street lighting is the city's business.
    if (city) city.setDaylight(this.daylight);

    // And the car turns its headlights on when it gets dark.
    if (limo) limo.setLamps({ ...limo.lampState, headlights: this.isNight });
  }
}
