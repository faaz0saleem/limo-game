import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { glowSprite, blobShadowTexture } from '../render/textures.js';
import { clamp } from '../util.js';
import { LIMO, PAINT_JOBS } from './spec.js';

export { LIMO, PAINT_JOBS };

/* The limo is modelled from primitives at load time. Forward is +Z.
 *
 * Hierarchy:
 *   root        — world position + heading
 *     chassis   — body roll / pitch / squat (wheels stay planted)
 *     wheels[]  — steer group per wheel, spinning mesh inside
 */

function makeMaterials(job) {
  const paint = new THREE.MeshPhysicalMaterial({
    color: job.paint,
    metalness: 0.62,
    roughness: 0.26,
    clearcoat: 1,
    clearcoatRoughness: 0.045,
    envMapIntensity: 1.5,
  });

  const chrome = new THREE.MeshPhysicalMaterial({
    color: 0xf2f5ff,
    metalness: 1,
    roughness: 0.055,
    envMapIntensity: 2.4,
  });

  const darkTrim = new THREE.MeshStandardMaterial({
    color: 0x14161d, metalness: 0.5, roughness: 0.55,
  });

  // Limo tint: dark, glossy, and reflective enough to catch the skyline.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x05070d,
    metalness: 0.25,
    roughness: 0.04,
    transparent: true,
    opacity: 0.62,
    envMapIntensity: 3.0,
    clearcoat: 1,
    side: THREE.DoubleSide,
  });

  const tyre = new THREE.MeshStandardMaterial({
    color: 0x090a0d, metalness: 0.0, roughness: 0.92,
  });

  const headLamp = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 3, roughness: 0.15,
  });

  const tailLamp = new THREE.MeshStandardMaterial({
    color: 0x2a0206, emissive: 0xff1030, emissiveIntensity: 2.2, roughness: 0.3,
  });

  const reverseLamp = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xdfe8ff, emissiveIntensity: 0.4, roughness: 0.2,
  });

  return { paint, chrome, darkTrim, glass, tyre, headLamp, tailLamp, reverseLamp, accent: job.accent };
}

function box(w, h, d, r, mat, x = 0, y = 0, z = 0) {
  // More segments on the big panels: the rounded edge is most of what makes
  // the car read as coachwork rather than a crate.
  const seg = r > 0.12 ? 5 : r > 0 ? 3 : 1;
  const geo = r > 0
    ? new RoundedBoxGeometry(w, h, d, seg, r)
    : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function buildWheel(M) {
  const g = new THREE.Group();
  const R = LIMO.wheelRadius;

  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, 0.36, 28, 1),
    M.tyre,
  );
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  g.add(tyre);

  // Sidewall shoulder so the tyre isn't a bare cylinder in profile.
  const shoulder = new THREE.Mesh(
    new THREE.TorusGeometry(R - 0.05, 0.07, 8, 26),
    M.tyre,
  );
  shoulder.rotation.y = Math.PI / 2;
  g.add(shoulder);

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.68, R * 0.68, 0.38, 24, 1),
    M.chrome,
  );
  rim.rotation.z = Math.PI / 2;
  g.add(rim);

  // Six spokes per face. Each sits in a holder rotated about the wheel axis
  // (X), so the whole set spins with the tyre.
  const spokeGeo = new THREE.BoxGeometry(0.16, R * 1.24, 0.055);
  for (let i = 0; i < 6; i++) {
    const holder = new THREE.Group();
    holder.rotation.x = (i / 6) * Math.PI;
    for (const side of [-1, 1]) {
      const bar = new THREE.Mesh(spokeGeo, M.chrome);
      bar.position.x = side * 0.19;
      holder.add(bar);
    }
    g.add(holder);
  }

  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), M.chrome);
  cap.position.x = 0.2;
  g.add(cap);
  const cap2 = cap.clone();
  cap2.position.x = -0.2;
  g.add(cap2);

  return g;
}

export function createLimo(jobName = 'midnight') {
  const job = PAINT_JOBS[jobName] ?? PAINT_JOBS.midnight;
  const M = makeMaterials(job);

  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const W = LIMO.width;

  /* ------------------------------------------------------------- body shell */
  chassis.add(box(W, 0.86, LIMO.length, 0.34, M.paint, 0, 0.76, 0));

  // Bonnet, cabin and boot as separate stacked volumes.
  chassis.add(box(W - 0.10, 0.38, 2.55, 0.19, M.paint, 0, 1.22, 3.45));
  const cabin = box(W - 0.14, 0.72, 5.70, 0.30, M.paint, 0, 1.44, -0.40);
  chassis.add(cabin);
  chassis.add(box(W - 0.10, 0.34, 1.75, 0.18, M.paint, 0, 1.20, -3.95));

  // Roof panel, very slightly inset — catches a crisp specular line.
  chassis.add(box(W - 0.36, 0.08, 5.20, 0.04, M.paint, 0, 1.80, -0.40));

  /* ------------------------------------------------------------------ glass */
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.30, 1.05), M.glass);
  windshield.position.set(0, 1.52, 2.42);
  windshield.rotation.x = -Math.PI * 0.16;
  chassis.add(windshield);

  const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.32, 0.86), M.glass);
  rearGlass.position.set(0, 1.52, -3.20);
  rearGlass.rotation.x = Math.PI * 0.18;
  chassis.add(rearGlass);

  for (const side of [-1, 1]) {
    const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(5.1, 0.62), M.glass);
    sideGlass.position.set(side * (W / 2 - 0.06), 1.50, -0.40);
    sideGlass.rotation.y = side * Math.PI / 2;
    chassis.add(sideGlass);
  }

  /* ------------------------------------------------------------ chrome trim */
  // Full-length waist line — the detail that says "limousine".
  for (const side of [-1, 1]) {
    chassis.add(box(0.05, 0.07, LIMO.length - 0.6, 0.02, M.chrome, side * (W / 2 - 0.01), 1.08, 0));
    chassis.add(box(0.07, 0.18, LIMO.length - 1.2, 0.03, M.chrome, side * (W / 2 - 0.02), 0.44, 0));
  }

  // Bumpers.
  chassis.add(box(W + 0.04, 0.30, 0.34, 0.10, M.chrome, 0, 0.60, LIMO.length / 2 - 0.06));
  chassis.add(box(W + 0.04, 0.30, 0.34, 0.10, M.chrome, 0, 0.60, -LIMO.length / 2 + 0.06));

  // Grille: a chrome frame filled with vertical slats.
  const grille = box(1.30, 0.42, 0.10, 0.03, M.chrome, 0, 0.96, LIMO.length / 2 - 0.02);
  chassis.add(grille);
  for (let i = -5; i <= 5; i++) {
    chassis.add(box(0.045, 0.36, 0.06, 0, M.darkTrim, i * 0.11, 0.96, LIMO.length / 2 + 0.02));
  }

  // Hood ornament.
  const ornament = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 10), M.chrome);
  ornament.position.set(0, 1.48, 4.42);
  chassis.add(ornament);

  /* ----------------------------------------------------------------- lights */
  const headLights = [];
  const glow = glowSprite();

  for (const side of [-1, 1]) {
    for (const inner of [0, 1]) {
      const x = side * (0.58 + inner * 0.30);
      const lamp = box(0.26, 0.18, 0.10, 0.04, M.headLamp, x, 0.99, LIMO.length / 2 + 0.02);
      chassis.add(lamp);
      headLights.push(lamp);

      // A forward-facing quad, not a sprite: a billboard would swing around
      // and glare through the bodywork when the camera is behind the car.
      const flare = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 0.8),
        new THREE.MeshBasicMaterial({
          map: glow, color: 0x8f7a55, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      flare.position.set(x, 0.99, LIMO.length / 2 + 0.06);
      chassis.add(flare);
    }
  }

  // Soft beam cones. Cheap stand-in for volumetric light: a cone that fades
  // out along its length and at its silhouette.
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0xffeccc) }, uOpacity: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vNormal = normalize( normalMatrix * normal );
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vView = normalize( -mv.xyz );
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        // Fade along the cone and soften where it faces the camera edge-on.
        float along = pow( vUv.y, 2.0 );
        float rim = pow( 1.0 - abs( dot( normalize( vNormal ), normalize( vView ) ) ), 1.6 );
        gl_FragColor = vec4( uColor, along * rim * 0.035 * uOpacity );
      }
    `,
  });

  const beamCones = [];
  for (const side of [-1, 1]) {
    const len = 17;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.3, len, 20, 1, true), beamMat);
    cone.rotation.x = -Math.PI / 2;         // apex at the lamp, mouth downrange
    cone.position.set(side * 0.72, 0.94, LIMO.length / 2 + len / 2 - 1.2);
    cone.renderOrder = 4;
    chassis.add(cone);
    beamCones.push(cone);
  }

  // Two real spotlights carry the beam onto the road.
  const beams = [];
  for (const side of [-1, 1]) {
    const spot = new THREE.SpotLight(0xfff1d4, 1800, 85, 0.52, 0.42, 1.7);
    spot.position.set(side * 0.7, 1.0, LIMO.length / 2 - 0.1);
    spot.target.position.set(side * 0.9, -1.4, LIMO.length / 2 + 22);
    chassis.add(spot);
    chassis.add(spot.target);
    beams.push(spot);
  }

  const tailBar = box(W - 0.34, 0.14, 0.08, 0.03, M.tailLamp, 0, 1.02, -LIMO.length / 2 - 0.02);
  chassis.add(tailBar);
  const tailGlowMat = new THREE.MeshBasicMaterial({
    map: glow, color: 0xff1030, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6,
  });
  // Rear-facing quad, for the same reason as the headlight flares.
  const tailGlow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.95), tailGlowMat);
  tailGlow.rotation.y = Math.PI;
  tailGlow.position.set(0, 1.02, -LIMO.length / 2 - 0.09);
  chassis.add(tailGlow);

  const reverseLamps = [];
  for (const side of [-1, 1]) {
    const r = box(0.22, 0.10, 0.06, 0.02, M.reverseLamp, side * 0.5, 0.82, -LIMO.length / 2 - 0.02);
    chassis.add(r);
    reverseLamps.push(r);
  }

  /* ------------------------------------------------------------- appendages */
  for (const side of [-1, 1]) {
    const stalk = box(0.16, 0.05, 0.05, 0.02, M.darkTrim, side * (W / 2 + 0.05), 1.36, 2.05);
    chassis.add(stalk);
    const mirror = box(0.08, 0.14, 0.20, 0.04, M.paint, side * (W / 2 + 0.16), 1.36, 2.05);
    chassis.add(mirror);

    // Door seams + handles.
    for (const z of [1.15, -0.35, -1.85]) {
      chassis.add(box(0.03, 0.05, 0.24, 0.01, M.chrome, side * (W / 2 - 0.005), 1.10, z));
    }

    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.26, 12), M.chrome);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(side * 0.62, 0.44, -LIMO.length / 2 - 0.08);
    chassis.add(pipe);
  }

  // Wheel arches: dark inner shell plus a chrome lip.
  for (const z of [LIMO.frontAxle, LIMO.rearAxle]) {
    for (const side of [-1, 1]) {
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(LIMO.wheelRadius + 0.12, 0.07, 8, 18, Math.PI),
        M.chrome,
      );
      arch.rotation.y = Math.PI / 2;
      arch.position.set(side * (W / 2 - 0.02), 0.60, z);
      chassis.add(arch);
    }
  }

  /* ----------------------------------------------------------------- wheels */
  const wheels = [];
  for (const [z, isFront] of [[LIMO.frontAxle, true], [LIMO.rearAxle, false]]) {
    for (const side of [-1, 1]) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(side * LIMO.trackWidth / 2, LIMO.wheelRadius, z);
      const spin = buildWheel(M);
      steerPivot.add(spin);
      root.add(steerPivot);
      wheels.push({ pivot: steerPivot, spin, isFront, side, z });
    }
  }

  /* ----------------------------------------------------- contact shadow blob */
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(LIMO.length * 1.15, LIMO.width * 2.3),
    new THREE.MeshBasicMaterial({
      map: blobShadowTexture(), transparent: true, opacity: 0.75,
      depthWrite: false, color: 0x000000,
    }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.rotation.z = Math.PI / 2;
  blob.position.y = 0.02;
  blob.renderOrder = 2;
  root.add(blob);

  // Underglow: a wash of accent colour on the tarmac beneath the car.
  const underGlow = new THREE.PointLight(job.accent, 9, 10, 2);
  underGlow.position.set(0, 0.35, 0);
  root.add(underGlow);

  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  blob.castShadow = false;

  return {
    root,
    chassis,
    wheels,
    materials: M,
    job,
    beams,

    /** Front wheels turn; all four spin at road speed. */
    updateWheels(steerAngle, forwardSpeed, dt) {
      const spinDelta = (forwardSpeed / LIMO.wheelRadius) * dt;
      for (const w of wheels) {
        if (w.isFront) w.pivot.rotation.y = steerAngle;
        w.spin.rotation.x -= spinDelta;
      }
    },

    /** Brake lights and reverse lamps react to the driver's inputs. */
    setLamps({ braking, reversing, headlights = true }) {
      M.tailLamp.emissiveIntensity = braking ? 9 : 2.2;
      tailGlowMat.opacity = braking ? 1 : 0.45;
      M.reverseLamp.emissiveIntensity = reversing ? 5 : 0.4;
      M.headLamp.emissiveIntensity = headlights ? 3 : 0.2;
      for (const b of beams) b.intensity = headlights ? 1800 : 0;
      beamMat.uniforms.uOpacity.value = headlights ? 1 : 0;
    },

    /** Weight transfer: the long body leans, dives and squats. */
    setAttitude(rollRad, pitchRad) {
      chassis.rotation.z = clamp(rollRad, -0.13, 0.13);
      chassis.rotation.x = clamp(pitchRad, -0.09, 0.09);
    },

    setEnvironment(envMap) {
      for (const m of [M.paint, M.chrome, M.glass, M.darkTrim]) m.envMap = envMap;
    },
  };
}
