import * as THREE from 'three';
import { GRID, BLOCK, blockCentre } from './city.js';
import { clamp, damp, rngKit, wrapAngle } from '../util.js';

/**
 * Pavement crowds.
 *
 * People walk laps of the block perimeters. When the limo gets close and is
 * moving with intent they scatter — away from the car, and faster. Clip one
 * and they go down and stay down; it costs the driver a fine, because a
 * chauffeur who mows down pedestrians is not getting tipped.
 *
 * Two InstancedMeshes (bodies, heads) draw the whole crowd, so the cost is two
 * draw calls regardless of population.
 */

const STATE = { WALK: 0, FLEE: 1, DOWN: 2 };

const SHIRTS = [
  0xc85a4a, 0x3f6fa8, 0x4c8a5e, 0xb99a4c, 0x8a5aa8,
  0xcf7a3a, 0x486b7a, 0xa8425f, 0x5c6470, 0xd0b06a,
];
const SKINS = [0xf0c8a0, 0xd9a877, 0xb07c4f, 0x8a5a34, 0x5d3a20];

export class Pedestrians {
  constructor(scene, { count = 90, envMap, rng = rngKit(4242) } = {}) {
    this.rng = rng;
    this.people = [];
    this.hits = 0;                 // pedestrians struck this shift
    this.nearMisses = 0;

    // Body is a tapered box, head a small sphere. Deliberately simple: at the
    // distance you actually see them, silhouette and colour are all that read.
    const bodyGeo = new THREE.CapsuleGeometry(0.26, 0.86, 4, 8);
    bodyGeo.translate(0, 0.85, 0);
    const headGeo = new THREE.SphereGeometry(0.19, 10, 8);
    headGeo.translate(0, 1.62, 0);

    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.82, metalness: 0.0, envMap, envMapIntensity: 0.4,
    });
    const headMat = new THREE.MeshStandardMaterial({
      roughness: 0.7, metalness: 0.0, envMap, envMapIntensity: 0.4,
    });

    this.bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
    this.heads = new THREE.InstancedMesh(headGeo, headMat, count);
    for (const m of [this.bodies, this.heads]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      scene.add(m);
    }

    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      col.setHex(SHIRTS[Math.floor(rng.rand() * SHIRTS.length)]);
      this.bodies.setColorAt(i, col);
      col.setHex(SKINS[Math.floor(rng.rand() * SKINS.length)]);
      this.heads.setColorAt(i, col);
    }
    this.bodies.instanceColor.needsUpdate = true;
    this.heads.instanceColor.needsUpdate = true;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < count; i++) {
      const p = {
        index: i,
        pos: new THREE.Vector3(),
        yaw: 0,
        speed: 0,
        state: STATE.WALK,
        fall: 0,              // 0..1 how far over they are
        downFor: 0,
        bob: rng.rand() * 10,
        scared: 0,
      };
      this._respawn(p, null, true);
      this.people.push(p);
    }
    this._write();
  }

  /** Put someone on the pavement ring of a random block. */
  _respawn(p, playerPos, initial = false) {
    const rng = this.rng;
    for (let attempt = 0; attempt < 20; attempt++) {
      const cx = blockCentre(Math.floor(rng.rand() * GRID));
      const cz = blockCentre(Math.floor(rng.rand() * GRID));
      // The walkable ring: outside the buildings, inside the kerb.
      const ring = BLOCK / 2 - rng.range(1.6, 4.2);
      const side = Math.floor(rng.rand() * 4);
      const along = rng.range(-ring, ring);

      const x = side === 0 ? cx + ring : side === 1 ? cx - ring : cx + along;
      const z = side === 2 ? cz + ring : side === 3 ? cz - ring : cz + along;

      if (!initial && playerPos) {
        const d = Math.hypot(x - playerPos.x, z - playerPos.z);
        if (d < 60 || d > 200) continue;
      }

      p.pos.set(x, 0, z);
      // Walk along the edge they're standing on.
      p.yaw = (side < 2 ? 0 : Math.PI / 2) + (rng.rand() < 0.5 ? 0 : Math.PI);
      p.speed = rng.range(1.1, 1.8);
      p.state = STATE.WALK;
      p.fall = 0;
      p.downFor = 0;
      p.scared = 0;
      return;
    }
  }

  _write() {
    const m = this._m, q = this._q, e = this._e;
    for (const p of this.people) {
      // Falling tips them about the axis across their direction of travel.
      e.set(p.fall * Math.PI * 0.5, p.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(p.pos, q, this._s);
      this.bodies.setMatrixAt(p.index, m);
      this.heads.setMatrixAt(p.index, m);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {object} vehicle the player's car
   * @returns {number} how many people were struck this frame
   */
  update(dt, vehicle) {
    const car = vehicle.position;
    const speed = Math.abs(vehicle.speed);
    let struck = 0;

    for (const p of this.people) {
      const dx = p.pos.x - car.x;
      const dz = p.pos.z - car.z;
      const dist = Math.hypot(dx, dz);

      /* ---- already down: lie there, then quietly leave the scene ---- */
      if (p.state === STATE.DOWN) {
        p.fall = damp(p.fall, 1, 4.5, dt);
        p.downFor += dt;
        if (p.downFor > 14) this._respawn(p, car);
        continue;
      }

      /* ---- getting hit ---- */
      if (dist < 2.1 && speed > 1.5) {
        p.state = STATE.DOWN;
        p.fall = 0.05;
        p.downFor = 0;
        // Shove them along the car's travel so it reads as an impact.
        const push = clamp(speed * 0.06, 0.4, 2.2);
        p.pos.x += (dx / (dist || 1)) * push;
        p.pos.z += (dz / (dist || 1)) * push;
        struck++;
        this.hits++;
        continue;
      }

      /* ---- fear: a fast car nearby sends them running ---- */
      const threat = speed > 6 && dist < 16;
      if (threat) {
        if (p.scared < 0.2) this.nearMisses++;
        p.scared = 1;
        p.state = STATE.FLEE;
      } else if (p.scared > 0) {
        p.scared = Math.max(0, p.scared - dt * 0.5);
        if (p.scared === 0) p.state = STATE.WALK;
      }

      if (p.state === STATE.FLEE) {
        // Run directly away from the car.
        const away = Math.atan2(dx, dz);
        p.yaw += wrapAngle(away - p.yaw) * clamp(dt * 7, 0, 1);
        p.pos.x += Math.sin(p.yaw) * 4.6 * dt;
        p.pos.z += Math.cos(p.yaw) * 4.6 * dt;
      } else {
        p.pos.x += Math.sin(p.yaw) * p.speed * dt;
        p.pos.z += Math.cos(p.yaw) * p.speed * dt;
      }

      // Recycle anyone who has wandered too far from the action.
      if (dist > 240) this._respawn(p, car);
    }

    this._write();
    return struck;
  }

  reset() {
    this.hits = 0;
    this.nearMisses = 0;
    for (const p of this.people) this._respawn(p, null, true);
    this._write();
  }
}
