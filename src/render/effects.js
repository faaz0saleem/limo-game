import * as THREE from 'three';
import { smokeSprite, glowSprite } from './textures.js';
import { clamp, lerp } from '../util.js';

/**
 * Skid marks written into one pre-allocated ring buffer.
 *
 * Every frame each sliding wheel extends a ribbon by one quad. Nothing is
 * allocated after construction — the oldest quad is simply overwritten, so
 * the marks fade out of existence as you lap the city and the geometry never
 * grows.
 */
export class SkidMarks {
  constructor(scene, maxQuads = 2200) {
    this.max = maxQuads;
    this.head = 0;
    this.count = 0;

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxQuads * 6 * 3);
    this.alphas = new Float32Array(maxQuads * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { uColor: { value: new THREE.Color(0x05050a) } },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if ( vAlpha <= 0.001 ) discard;
          gl_FragColor = vec4( uColor, vAlpha * 0.72 );
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    // Per-wheel "last position" so we can emit connected quads.
    this.trails = new Map();
  }

  /** Emit one segment for a wheel. `key` identifies the wheel. */
  stamp(key, x, z, dirX, dirZ, width, alpha) {
    const prev = this.trails.get(key);
    const now = { x, z };

    if (prev && (prev.x - x) ** 2 + (prev.z - z) ** 2 > 0.0025) {
      // Perpendicular to travel, in the ground plane.
      const px = -dirZ * width * 0.5;
      const pz = dirX * width * 0.5;
      this._quad(
        prev.x + prev.px, prev.z + prev.pz,
        prev.x - prev.px, prev.z - prev.pz,
        x + px, z + pz,
        x - px, z - pz,
        prev.alpha, alpha,
      );
      now.px = px; now.pz = pz; now.alpha = alpha;
      this.trails.set(key, now);
    } else if (!prev) {
      now.px = -dirZ * width * 0.5;
      now.pz = dirX * width * 0.5;
      now.alpha = alpha;
      this.trails.set(key, now);
    }
  }

  /** Stop extending a wheel's ribbon (it lifted off / regained grip). */
  lift(key) {
    this.trails.delete(key);
  }

  _quad(ax, az, bx, bz, cx, cz, dx, dz, a0, a1) {
    const i = this.head * 18;
    const p = this.positions;
    const y = 0.022;

    // two triangles: a,b,c and b,d,c
    const set = (o, x, z) => { p[o] = x; p[o + 1] = y; p[o + 2] = z; };
    set(i + 0, ax, az); set(i + 3, bx, bz); set(i + 6, cx, cz);
    set(i + 9, bx, bz); set(i + 12, dx, dz); set(i + 15, cx, cz);

    const j = this.head * 6;
    const al = this.alphas;
    al[j] = a0; al[j + 1] = a0; al[j + 2] = a1;
    al[j + 3] = a0; al[j + 4] = a1; al[j + 5] = a1;

    this.head = (this.head + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count * 6);
  }

  clear() {
    this.alphas.fill(0);
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.head = 0;
    this.count = 0;
    this.trails.clear();
  }
}

/**
 * Pooled billboard particles for tyre smoke, exhaust and impact sparks.
 * One draw call for the lot, using THREE.Points with per-particle size.
 */
export class ParticleField {
  constructor(scene, max = 520) {
    this.max = max;
    this.cursor = 0;

    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.drag = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uMap: { value: smokeSprite() },
        uScale: { value: window.innerHeight * 0.5 },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute vec3 aColor;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_PointSize = aSize * uScale / max( -mv.z, 0.001 );
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if ( vAlpha <= 0.002 ) discard;
          vec4 t = texture2D( uMap, gl_PointCoord );
          gl_FragColor = vec4( vColor, t.a * vAlpha );
        }
      `,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    this._resize = () => { this.material.uniforms.uScale.value = window.innerHeight * 0.5; };
    window.addEventListener('resize', this._resize);
  }

  spawn({ x, y, z, vx = 0, vy = 0, vz = 0, life = 1, size = 1, grow = 1,
          color = [0.7, 0.72, 0.78], alpha = 0.5, drag = 1.4 }) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;

    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.color[i * 3] = color[0]; this.color[i * 3 + 1] = color[1]; this.color[i * 3 + 2] = color[2];
    this.alpha[i] = alpha;
    this.drag[i] = drag;
  }

  update(dt) {
    const { pos, vel, life, maxLife, size, grow, alpha, drag } = this;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) {
        if (alpha[i] !== 0) alpha[i] = 0;
        continue;
      }
      life[i] -= dt;
      const t = clamp(life[i] / maxLife[i], 0, 1);

      const d = Math.exp(-drag[i] * dt);
      vel[i * 3] *= d;
      vel[i * 3 + 1] *= d;
      vel[i * 3 + 2] *= d;

      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;

      size[i] += grow[i] * dt;
      // Fade in fast, out slow — reads as a puff rather than a pop.
      alpha[i] = Math.min(t * 2.2, (1 - t) * 6, 1) * 0.62;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
  }
}

/** The rotating pillar of light marking a pickup or drop-off. */
export class Beacon {
  constructor(scene, color = 0xffcb5c) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const col = new THREE.Color(color);

    // Tapered column.
    const colGeo = new THREE.CylinderGeometry(2.6, 3.4, 26, 24, 1, true);
    this.columnMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: col }, uTime: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uTime, uOpacity;
        varying vec2 vUv;
        void main() {
          float fade = pow( 1.0 - vUv.y, 2.2 );
          float bands = 0.65 + 0.35 * sin( vUv.y * 22.0 - uTime * 5.0 );
          float edge = smoothstep( 0.0, 0.12, vUv.x ) * smoothstep( 1.0, 0.88, vUv.x );
          gl_FragColor = vec4( uColor, fade * bands * 0.5 * uOpacity );
        }
      `,
    });
    this.group.add(new THREE.Mesh(colGeo, this.columnMat));

    // Ground ring.
    this.ringMat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(3.0, 3.8, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.group.add(this.ring);

    // Bobbing marker so it's readable from a distance.
    const glowMat = new THREE.SpriteMaterial({
      map: glowSprite(), color: col, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.spark = new THREE.Sprite(glowMat);
    this.spark.scale.setScalar(7);
    this.spark.position.y = 4;
    this.group.add(this.spark);

    this.light = new THREE.PointLight(col, 520, 34, 2);
    this.light.position.y = 3;
    this.group.add(this.light);

    this.t = 0;
  }

  setColor(hex) {
    const c = new THREE.Color(hex);
    this.columnMat.uniforms.uColor.value.copy(c);
    this.ringMat.color.copy(c);
    this.spark.material.color.copy(c);
    this.light.color.copy(c);
  }

  place(v) {
    this.group.position.set(v.x, 0, v.z);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  update(dt, playerPos) {
    if (!this.group.visible) return;
    this.t += dt;
    this.columnMat.uniforms.uTime.value = this.t;
    this.ring.rotation.z += dt * 0.8;
    this.ring.scale.setScalar(1 + Math.sin(this.t * 2.2) * 0.06);
    this.spark.position.y = 4 + Math.sin(this.t * 2) * 0.6;
    this.light.intensity = 420 + Math.sin(this.t * 4) * 160;

    // Fade the column out when the player is right on top of it so it
    // doesn't wash out the whole screen.
    const d = this.group.position.distanceTo(playerPos);
    this.columnMat.uniforms.uOpacity.value = clamp((d - 4) / 12, 0, 1);
  }
}

/** Bright, short-lived sparks thrown off a collision. */
export function burstSparks(particles, x, y, z, nx, nz, strength) {
  const n = Math.floor(6 + strength * 22);
  for (let i = 0; i < n; i++) {
    const spread = 1.6;
    particles.spawn({
      x, y, z,
      vx: nx * (3 + Math.random() * 12) + (Math.random() - 0.5) * spread * 6,
      vy: 1 + Math.random() * 7,
      vz: nz * (3 + Math.random() * 12) + (Math.random() - 0.5) * spread * 6,
      life: 0.28 + Math.random() * 0.42,
      size: 0.12 + Math.random() * 0.2,
      grow: -0.06,
      color: [1, lerp(0.55, 0.85, Math.random()), 0.25],
      drag: 2.4,
    });
  }
}
