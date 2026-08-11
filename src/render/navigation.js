import * as THREE from 'three';
import { nearestRoadLine, ROAD_W } from '../world/city.js';
import { clamp, damp } from '../util.js';

/**
 * Turn-by-turn guidance.
 *
 * A straight line to the objective is useless in a grid city — it points
 * through buildings. Instead this routes along the streets: down whichever
 * street you're on, round one corner, then down the target's street. Chevrons
 * are painted on the tarmac along that route, and a big arrow floats over the
 * car pointing at the next leg.
 */

const CHEVRONS = 44;
const SPACING = 13;

/** Is `v` sitting on a north–south street (so travel runs along Z)? */
function onNorthSouth(x, z) {
  const dx = Math.abs(x - nearestRoadLine(x));
  const dz = Math.abs(z - nearestRoadLine(z));
  return dx < dz;
}

/**
 * Waypoints from `from` to `to` that stay on the road grid: at most one
 * corner, placed so both legs run down a street centre-line.
 */
export function routeAlongStreets(from, to) {
  const fromNS = onNorthSouth(from.x, from.z);
  const toNS = onNorthSouth(to.x, to.z);

  const fx = nearestRoadLine(from.x);
  const fz = nearestRoadLine(from.z);
  const tx = nearestRoadLine(to.x);
  const tz = nearestRoadLine(to.z);

  // Already on the same street: straight shot.
  if (fromNS && toNS && Math.abs(fx - tx) < 1) return [from, to];
  if (!fromNS && !toNS && Math.abs(fz - tz) < 1) return [from, to];

  // Otherwise turn once, at the junction the two streets share.
  const corner = fromNS
    ? new THREE.Vector3(fx, 0, toNS ? fz : tz)
    : new THREE.Vector3(toNS ? tx : fx, 0, fz);

  return [from, corner, to];
}

export class Navigator {
  constructor(scene) {
    this.route = [];
    this.group = new THREE.Group();
    scene.add(this.group);

    /* ---- tarmac chevrons, one InstancedMesh for the lot ---- */
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.6);
    shape.lineTo(1.5, -0.4);
    shape.lineTo(0.62, -0.4);
    shape.lineTo(0, 0.85);
    shape.lineTo(-0.62, -0.4);
    shape.lineTo(-1.5, -0.4);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);            // lie flat on the road

    this.chevMat = new THREE.MeshBasicMaterial({
      color: 0xffcb5c,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.chevrons = new THREE.InstancedMesh(geo, this.chevMat, CHEVRONS);
    this.chevrons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chevrons.frustumCulled = false;
    this.chevrons.renderOrder = 3;
    this.group.add(this.chevrons);

    /* ---- floating arrow above the car ---- */
    const arrowGeo = new THREE.ConeGeometry(0.85, 2.2, 4);
    arrowGeo.rotateX(Math.PI / 2);        // point along +Z
    this.arrowMat = new THREE.MeshBasicMaterial({
      color: 0xffcb5c, transparent: true, opacity: 0.9, depthWrite: false,
    });
    this.arrow = new THREE.Mesh(arrowGeo, this.arrowMat);
    this.arrow.frustumCulled = false;
    this.arrow.renderOrder = 4;
    this.group.add(this.arrow);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._arrowYaw = 0;
    this.t = 0;
  }

  setColor(hex) {
    this.chevMat.color.setHex(hex);
    this.arrowMat.color.setHex(hex);
  }

  /** Walk the route laying chevrons every SPACING metres. */
  update(dt, carPos, target, carHeading) {
    this.t += dt;
    if (!target) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const route = routeAlongStreets(carPos, target);
    this.route = route;

    // --- chevrons -------------------------------------------------------
    let placed = 0;
    let carry = (this.t * 5) % SPACING;     // scrolls them toward the target

    for (let leg = 0; leg < route.length - 1 && placed < CHEVRONS; leg++) {
      const a = route[leg];
      const b = route[leg + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const ux = dx / len, uz = dz / len;
      const yaw = Math.atan2(ux, uz);

      // Sit the chevrons on the driving side rather than the centre-line.
      const ox = -uz * ROAD_W * 0.18;
      const oz = ux * ROAD_W * 0.18;

      for (let d = carry; d < len && placed < CHEVRONS; d += SPACING) {
        const x = a.x + ux * d + ox;
        const z = a.z + uz * d + oz;

        // Fade in the distance, and skip any that would sit under the car.
        const toCar = Math.hypot(x - carPos.x, z - carPos.z);
        const s = toCar < 7 ? 0 : clamp(1 - (placed / CHEVRONS) * 0.75, 0.2, 1);

        this._pos.set(x, 0.05, z);
        this._q.setFromAxisAngle(this._up, yaw);
        this._scale.setScalar(s);
        this._m.compose(this._pos, this._q, this._scale);
        this.chevrons.setMatrixAt(placed++, this._m);
      }
      carry = 0;
    }

    // Park the unused instances at zero scale.
    this._scale.setScalar(0);
    this._m.compose(this._pos.set(0, -50, 0), this._q.identity(), this._scale);
    for (let i = placed; i < CHEVRONS; i++) this.chevrons.setMatrixAt(i, this._m);
    this.chevrons.instanceMatrix.needsUpdate = true;

    // --- floating arrow over the car ------------------------------------
    const next = route[1] ?? target;
    const targetYaw = Math.atan2(next.x - carPos.x, next.z - carPos.z);
    // Shortest-path angle blend so it never spins the long way round.
    let delta = targetYaw - this._arrowYaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this._arrowYaw = damp(this._arrowYaw, this._arrowYaw + delta, 7, dt);

    this.arrow.position.set(
      carPos.x, 5.4 + Math.sin(this.t * 2.4) * 0.28, carPos.z,
    );
    this.arrow.rotation.y = this._arrowYaw;
    this.arrowMat.opacity = 0.55 + Math.sin(this.t * 3) * 0.18;
  }

  /** Distance along the route, which is what the player actually has to drive. */
  routeDistance() {
    let d = 0;
    for (let i = 0; i < this.route.length - 1; i++) {
      d += Math.hypot(
        this.route[i + 1].x - this.route[i].x,
        this.route[i + 1].z - this.route[i].z,
      );
    }
    return d;
  }
}
