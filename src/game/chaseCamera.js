import * as THREE from 'three';
import { clamp, damp, lerp } from '../util.js';
import { LIMO } from '../vehicle/spec.js';
import { HALF_CITY } from '../world/city.js';

export const CAMERA_MODES = ['chase', 'close', 'hood', 'cinematic'];

const RIGS = {
  chase: { dist: 13.5, height: 5.2, look: 6.0, fov: 62, stiff: 7.5 },
  close: { dist: 9.5, height: 3.6, look: 7.5, fov: 66, stiff: 10.5 },
  hood: { dist: -1.2, height: 1.85, look: 14, fov: 72, stiff: 26 },
  cinematic: { dist: 17, height: 3.0, look: 4.0, fov: 48, stiff: 3.2 },
};

/**
 * Chase camera that follows the direction the car is *travelling*, not the
 * direction it's pointing. During a drift the nose swings across the frame
 * while the camera holds the line — which is the entire reason drifting looks
 * good in a game.
 */
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.modeIndex = 0;

    this.pos = new THREE.Vector3(0, 8, -20);
    this.lookAt = new THREE.Vector3();
    this.trackDir = new THREE.Vector3(0, 0, 1);
    this.roll = 0;
    this.shake = 0;
    this.lookBack = false;

    this._desired = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  cycleMode() {
    this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
    this.mode = CAMERA_MODES[this.modeIndex];
    return this.mode;
  }

  addShake(amount) {
    this.shake = clamp(this.shake + amount, 0, 1.4);
  }

  /**
   * March backwards along the boom and return the furthest distance that is
   * still inside the city and clear of geometry.
   */
  _clearBoom(origin, dir, maxDist, city) {
    const limit = HALF_CITY - 3;
    const steps = 7;
    let safe = 6.5;   // never inside the 8.6m body
    for (let i = 1; i <= steps; i++) {
      const d = (maxDist * i) / steps;
      const x = origin.x - dir.x * d;
      const z = origin.z - dir.z * d;
      if (Math.abs(x) > limit || Math.abs(z) > limit) break;
      if (city && city.probe(x, z, 1.7)) break;
      safe = d;
    }
    return safe;
  }

  reset(vehicle) {
    const fwd = vehicle.forward;
    this.trackDir.copy(fwd);
    this.pos.copy(vehicle.position).addScaledVector(fwd, -13.5).setY(5.2);
    this.camera.position.copy(this.pos);
  }

  update(dt, vehicle, city) {
    const rig = RIGS[this.mode];
    const speed01 = vehicle.speed01;

    const heading = vehicle.forward.clone();
    const velDir = this._tmp.copy(vehicle.velocity);
    velDir.y = 0;

    // Blend between where the car points and where it's actually going.
    // At low speed heading wins (so the camera doesn't spin during donuts);
    // at speed the travel direction wins (so drifts read side-on).
    let target;
    if (velDir.lengthSq() > 4 && vehicle.speed > 1) {
      velDir.normalize();
      const blend = clamp(Math.abs(vehicle.speed) / 16, 0, 1) * 0.75;
      target = heading.clone().lerp(velDir, blend).normalize();
    } else {
      target = heading;
    }

    if (this.lookBack) target.negate();

    // Cinematic mode swings slowly around the car instead of trailing it.
    if (this.mode === 'cinematic') {
      const a = performance.now() * 0.00013;
      target.set(Math.sin(a), 0, Math.cos(a));
    }

    const followRate = this.mode === 'cinematic' ? 1.1 : lerp(3.2, 8.5, speed01);
    this.trackDir.x = damp(this.trackDir.x, target.x, followRate, dt);
    this.trackDir.z = damp(this.trackDir.z, target.z, followRate, dt);
    this.trackDir.y = 0;
    if (this.trackDir.lengthSq() < 1e-6) this.trackDir.copy(heading);
    this.trackDir.normalize();

    // Pull back and drop lower as speed rises: cheap, effective speed cue.
    const dist = rig.dist * (1 + speed01 * 0.26);
    const height = rig.height * (1 - speed01 * 0.14);

    if (this.mode === 'hood') {
      // Rigidly mounted: no spring, or the view judders.
      this._desired.copy(vehicle.position)
        .addScaledVector(heading, LIMO.length * 0.5 - 1.6)
        .setY(rig.height);
      this.pos.copy(this._desired);
    } else {
      // Pull the boom in until the camera has a clear line back to the car,
      // rather than sliding it along a wall — sliding can shove the camera
      // straight through a thin collider and leave it looking at the back
      // face.
      const clear = this._clearBoom(vehicle.position, this.trackDir, dist, city);

      this._desired.copy(vehicle.position)
        .addScaledVector(this.trackDir, -clear)
        .setY(vehicle.position.y + height + (1 - clear / dist) * 4.5);

      const stiff = rig.stiff * (this.mode === 'cinematic' ? 1 : lerp(0.75, 1.35, speed01));
      this.pos.x = damp(this.pos.x, this._desired.x, stiff, dt);
      this.pos.y = damp(this.pos.y, this._desired.y, stiff * 0.85, dt);
      this.pos.z = damp(this.pos.z, this._desired.z, stiff, dt);
    }

    // Look ahead of the car along its travel line.
    const lookDir = this.mode === 'hood' ? heading : this.trackDir;
    this._desired.copy(vehicle.position)
      .addScaledVector(lookDir, this.lookBack ? -rig.look : rig.look)
      .setY(vehicle.position.y + 1.4);
    this.lookAt.lerp(this._desired, 1 - Math.exp(-12 * dt));

    // Impact + engine shake.
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const jitter = this.shake * 0.5 + speed01 * 0.035;
    const t = performance.now() * 0.001;
    const sx = Math.sin(t * 37.1) * jitter;
    const sy = Math.sin(t * 29.7) * jitter;

    this.camera.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookAt);

    // Bank into the slide.
    const targetRoll = clamp(-vehicle.slipAngle * 0.32 - vehicle.yawRate * 0.06, -0.16, 0.16);
    this.roll = damp(this.roll, this.mode === 'hood' ? targetRoll * 0.4 : targetRoll, 5, dt);
    this.camera.rotateZ(this.roll + this.shake * 0.05);

    // FOV kick.
    const fov = rig.fov + speed01 * 15 + (vehicle.boosting ? 7 : 0) + this.shake * 4;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, fov, 6, dt);
      this.camera.updateProjectionMatrix();
    }
  }
}
