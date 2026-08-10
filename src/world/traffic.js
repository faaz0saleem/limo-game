import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GRID, PITCH, ROAD_W, HALF_CITY, roadLine, nearestRoadLine } from './city.js';
import { clamp, damp, rngKit, wrapAngle } from '../util.js';

/* Ambient traffic. Cars drive one lane on the grid, yield to the player's
 * bumper, and turn at random junctions. Not a full simulation — just enough
 * motion and moving light to make the streets feel inhabited.
 *
 * Every car is drawn from four InstancedMeshes (body, glass, wheels, lamps),
 * so the whole fleet costs four draw calls no matter how many cars there are.
 */

const LANE_OFFSET = ROAD_W / 4;      // 5m right of the centre line
const BODY_COLOURS = [
  0x9aa4b8, 0x2c3550, 0x6d1f2a, 0x1c4a3c, 0xb8ac8e,
  0x30343d, 0x7a5d2e, 0x274766, 0xa8a29a,
];

const DIRS = [
  { x: 1, z: 0, yaw: Math.PI / 2 },
  { x: -1, z: 0, yaw: -Math.PI / 2 },
  { x: 0, z: 1, yaw: 0 },
  { x: 0, z: -1, yaw: Math.PI },
];

/**
 * Lane centre for a car travelling in `dir`. Traffic keeps right, so the
 * lane sits one quarter-road-width to the right of the centre-line:
 * right = (dir.z, -dir.x).
 */
function laneFor(dir, line) {
  return dir.x !== 0
    ? { fixed: line - dir.x * LANE_OFFSET, axis: 'z' }   // travelling along X
    : { fixed: line + dir.z * LANE_OFFSET, axis: 'x' };  // travelling along Z
}

const WHEEL_OFFSETS = [[-0.85, 1.4], [0.85, 1.4], [-0.85, -1.4], [0.85, -1.4]];
const LAMP_OFFSETS = [
  [-0.62, 0.72, 2.22, 'head'], [0.62, 0.72, 2.22, 'head'],
  [-0.66, 0.78, -2.22, 'tail'], [0.66, 0.78, -2.22, 'tail'],
];

export class Traffic {
  constructor(scene, { count = 26, envMap, rng = rngKit(918) } = {}) {
    this.scene = scene;
    this.rng = rng;
    this.cars = [];
    this.count = count;

    // --- shared geometry -------------------------------------------------
    const body = new RoundedBoxGeometry(1.9, 1.0, 4.4, 3, 0.22).translate(0, 0.62, 0);
    const glass = new RoundedBoxGeometry(1.75, 0.62, 2.3, 3, 0.2).translate(0, 1.28, -0.2);

    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12).rotateZ(Math.PI / 2);
    const wheels = BufferGeometryUtils.mergeGeometries(
      WHEEL_OFFSETS.map(([x, z]) => wheel.clone().translate(x, 0.34, z)),
    );

    const lampGeo = new THREE.BoxGeometry(0.26, 0.14, 0.08);
    const heads = BufferGeometryUtils.mergeGeometries(
      LAMP_OFFSETS.filter((l) => l[3] === 'head')
        .map(([x, y, z]) => lampGeo.clone().translate(x, y, z)),
    );
    const tails = BufferGeometryUtils.mergeGeometries(
      LAMP_OFFSETS.filter((l) => l[3] === 'tail')
        .map(([x, y, z]) => lampGeo.clone().translate(x, y, z)),
    );

    // --- shared materials ------------------------------------------------
    const paintMat = new THREE.MeshPhysicalMaterial({
      metalness: 0.55, roughness: 0.34, clearcoat: 0.8,
      envMap, envMapIntensity: 1.1,
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a0e18, metalness: 0.2, roughness: 0.08,
      transparent: true, opacity: 0.7, envMap, envMapIntensity: 2,
    });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.9 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xfff0d0, emissiveIntensity: 5,
    });
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x330000, emissive: 0xff1a2e, emissiveIntensity: 3,
    });

    const mk = (geo, mat, castShadow = false) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = castShadow;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };

    this.bodyMesh = mk(body, paintMat, true);
    this.glassMesh = mk(glass, glassMat);
    this.wheelMesh = mk(wheels, wheelMat);
    this.headMesh = mk(heads, headMat);
    this.tailMesh = mk(tails, tailMat);
    this.meshes = [this.bodyMesh, this.glassMesh, this.wheelMesh, this.headMesh, this.tailMesh];

    // Per-instance paint colour (only the body needs it).
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      col.setHex(BODY_COLOURS[Math.floor(rng.rand() * BODY_COLOURS.length)]);
      this.bodyMesh.setColorAt(i, col);
    }
    this.bodyMesh.instanceColor.needsUpdate = true;

    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._scale = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < count; i++) {
      const car = {
        index: i,
        dir: DIRS[Math.floor(rng.rand() * DIRS.length)],
        speed: 0,
        cruise: 0,
        yaw: 0,
        pos: new THREE.Vector3(),
        radius: 2.4,
        turnedRecently: false,
      };
      this._respawn(car, null, true);
      this.cars.push(car);
    }
    this._writeMatrices();
  }

  /** Drop a car onto a random lane, ideally out of the player's sight. */
  _respawn(car, playerPos, initial = false) {
    const rng = this.rng;
    for (let attempt = 0; attempt < 24; attempt++) {
      const dir = DIRS[Math.floor(rng.rand() * DIRS.length)];
      const line = roadLine(Math.floor(rng.rand() * (GRID + 1)));
      const along = rng.range(-HALF_CITY + 14, HALF_CITY - 14);

      const lane = laneFor(dir, line);
      const px = lane.axis === 'x' ? lane.fixed : along;
      const pz = lane.axis === 'z' ? lane.fixed : along;

      if (!initial && playerPos) {
        const d = Math.hypot(px - playerPos.x, pz - playerPos.z);
        if (d < 70 || d > 240) continue;
      }

      car.dir = dir;
      car.pos.set(px, 0, pz);
      car.yaw = dir.yaw;
      car.cruise = rng.range(9, 16);
      car.speed = car.cruise;
      car.turnedRecently = false;
      return;
    }
  }

  /** Turn onto a crossing street when we reach a junction. */
  _maybeTurn(car) {
    const rng = this.rng;
    if (rng.rand() > 0.4) return;

    const options = DIRS.filter((d) =>
      !(d.x === -car.dir.x && d.z === -car.dir.z) && d !== car.dir);
    const next = options[Math.floor(rng.rand() * options.length)];
    if (!next) return;

    // Snap onto the new lane centre before committing to the turn.
    const lane = laneFor(next, nearestRoadLine(next.x !== 0 ? car.pos.z : car.pos.x));
    car.pos[lane.axis] = lane.fixed;
    car.dir = next;
  }

  _writeMatrices() {
    const m = this._matrix;
    const q = this._quat;
    for (const car of this.cars) {
      q.setFromAxisAngle(this._up, car.yaw);
      m.compose(car.pos, q, this._scale);
      for (const mesh of this.meshes) mesh.setMatrixAt(car.index, m);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, player) {
    const playerPos = player.position;

    for (const car of this.cars) {
      if (car.pos.distanceTo(playerPos) > 300) {
        this._respawn(car, playerPos);
        continue;
      }

      // Yield to the player's bumper: brake if they're close and ahead.
      const tx = playerPos.x - car.pos.x;
      const tz = playerPos.z - car.pos.z;
      const ahead = tx * car.dir.x + tz * car.dir.z;
      const lateral = Math.abs(tx * car.dir.z - tz * car.dir.x);
      const blocked = ahead > 0 && ahead < 16 && lateral < 4.2;
      car.speed = damp(car.speed, blocked ? 0 : car.cruise, blocked ? 4.5 : 1.6, dt);

      car.pos.x += car.dir.x * car.speed * dt;
      car.pos.z += car.dir.z * car.speed * dt;

      // A junction is where both coordinates sit on a street centre-line.
      const atJunction =
        Math.abs(car.pos.x - nearestRoadLine(car.pos.x)) < 4 &&
        Math.abs(car.pos.z - nearestRoadLine(car.pos.z)) < 4;
      if (atJunction) {
        if (!car.turnedRecently) {
          this._maybeTurn(car);
          car.turnedRecently = true;
        }
      } else {
        car.turnedRecently = false;
      }

      if (Math.abs(car.pos.x) > HALF_CITY - 8 || Math.abs(car.pos.z) > HALF_CITY - 8) {
        this._respawn(car, playerPos);
        continue;
      }

      car.yaw += wrapAngle(car.dir.yaw - car.yaw) * clamp(dt * 6, 0, 1);
    }

    this._writeMatrices();
  }

  /**
   * Circle test against every traffic car. Returns the contact normal and
   * depth of the first overlap, plus the car itself.
   */
  probe(x, z, radius) {
    for (const car of this.cars) {
      const dx = x - car.pos.x;
      const dz = z - car.pos.z;
      const dist = Math.hypot(dx, dz);
      const min = radius + car.radius;
      if (dist >= min || dist < 1e-4) continue;
      return { nx: dx / dist, nz: dz / dist, depth: min - dist, car };
    }
    return null;
  }

  /** Knock a car aside when the limo ploughs into it. */
  shove(car, nx, nz, strength) {
    car.pos.x -= nx * strength * 1.4;
    car.pos.z -= nz * strength * 1.4;
    car.speed = Math.max(0, car.speed - strength * 8);
  }
}
