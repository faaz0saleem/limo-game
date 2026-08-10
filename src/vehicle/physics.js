import * as THREE from 'three';
import { clamp, damp, lerp, sign, wrapAngle } from '../util.js';
import { LIMO } from './spec.js';

/**
 * Arcade drift physics on a two-axle tyre model.
 *
 * Each axle gets its own slip angle and a saturating lateral force curve
 * (a cheap stand-in for Pacejka). That's what makes the car behave like a
 * car: break the rears loose and the front still bites, so countersteering
 * catches the slide instead of doing nothing. Forces are per-unit-mass, so
 * the numbers below read directly as m/s².
 */

const CFG = {
  // Longitudinal
  enginePower: 16.5,        // m/s² at zero speed
  boostPower: 26.0,
  topSpeed: 54,             // m/s (~194 km/h)
  boostTopSpeed: 68,
  reversePower: 7.5,
  reverseTopSpeed: 14,
  brakePower: 24.0,
  engineBraking: 2.4,
  rollingDrag: 0.42,
  airDrag: 0.0015,

  // Steering
  maxSteer: 0.62,           // rad at a standstill
  highSpeedSteer: 0.17,     // rad at top speed
  steerRate: 4.6,           // how fast the wheel turns
  steerReturn: 7.5,
  counterSteerAssist: 0.55, // nudges the wheel into the slide

  // Grip (peak lateral acceleration per axle)
  gripFront: 15.5,
  gripRear: 16.4,
  handbrakeGrip: 3.4,
  throttleSlipLoss: 4.6,    // rear grip lost under full power
  stiffness: 7.0,           // slope of the tyre curve before saturation

  // Chassis
  yawInertia: 3.15,         // the limo is long: lazy in, lazy out
  yawDamping: 2.4,
  mass: 1,
};

export class Vehicle {
  constructor(startPos = new THREE.Vector3(), startHeading = 0) {
    this.position = startPos.clone();
    this.heading = startHeading;          // yaw, radians, 0 = +Z
    this.velocity = new THREE.Vector3();  // world space, y unused
    this.yawRate = 0;
    this.steer = 0;                       // current road-wheel angle

    this.speed = 0;                       // signed, along the body's forward
    this.slipAngle = 0;                   // radians between heading and travel
    this.isDrifting = false;
    this.rearSlipRatio = 0;               // 0..1, how loose the back end is
    this.wheelSlip = 0;                   // 0..1, drives smoke + screech
    this.gear = 1;
    this.rpm = 0.15;
    this.boostCharge = 1;
    this.airborne = false;

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._lastImpact = 0;
    this.impact = 0;                      // 0..1, decays after a collision
  }

  get forward() {
    return this._forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  get right() {
    return this._right.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }

  /** Absolute speed in km/h, for the dial. */
  get kmh() {
    return Math.abs(this.speed) * 3.6;
  }

  get speed01() {
    return clamp(Math.abs(this.speed) / CFG.boostTopSpeed, 0, 1);
  }

  reset(pos, heading) {
    this.position.copy(pos);
    this.heading = heading;
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.steer = 0;
    this.speed = 0;
    this.slipAngle = 0;
    this.isDrifting = false;
    this.impact = 0;
  }

  /**
   * @param {object} input  { throttle, brake, steer, handbrake, boost }
   * @param {number} dt     seconds
   */
  update(input, dt) {
    const fwd = this.forward.clone();
    const right = this.right.clone();

    // --- velocity in the body frame -------------------------------------
    let vLong = this.velocity.dot(fwd);
    let vLat = this.velocity.dot(right);
    const speedAbs = Math.hypot(vLong, vLat);

    // --- steering --------------------------------------------------------
    const speedFactor = clamp(speedAbs / CFG.topSpeed, 0, 1);
    const maxSteer = lerp(CFG.maxSteer, CFG.highSpeedSteer, Math.pow(speedFactor, 0.65));

    let steerTarget = input.steer * maxSteer;

    // Countersteer assist: when the rear is out, bias the wheel into the
    // slide so the car is catchable on a keyboard.
    if (speedAbs > 6) {
      const slide = Math.atan2(vLat, Math.abs(vLong));
      steerTarget += clamp(-slide, -maxSteer, maxSteer) * CFG.counterSteerAssist
        * clamp(Math.abs(slide) / 0.5, 0, 1);
      steerTarget = clamp(steerTarget, -maxSteer * 1.25, maxSteer * 1.25);
    }

    const rate = Math.abs(input.steer) > 0.01 ? CFG.steerRate : CFG.steerReturn;
    this.steer = damp(this.steer, steerTarget, rate, dt);

    // --- drive / brake ---------------------------------------------------
    const boosting = input.boost && this.boostCharge > 0.02 && input.throttle > 0.1;
    const topSpeed = boosting ? CFG.boostTopSpeed : CFG.topSpeed;
    const power = boosting ? CFG.boostPower : CFG.enginePower;

    this.boostCharge = clamp(
      this.boostCharge + (boosting ? -dt * 0.34 : dt * 0.13),
      0, 1,
    );

    let drive = 0;
    if (input.throttle > 0.01) {
      // Power tapers off as the car approaches its terminal speed.
      const headroom = clamp(1 - vLong / topSpeed, 0, 1);
      drive = power * input.throttle * headroom;
    }

    let braking = false;
    if (input.brake > 0.01) {
      if (vLong > 0.6) {
        drive -= CFG.brakePower * input.brake;   // brakes
        braking = true;
      } else {
        // Rolling backwards out of a corner.
        const headroom = clamp(1 + vLong / CFG.reverseTopSpeed, 0, 1);
        drive -= CFG.reversePower * input.brake * headroom;
      }
    }

    // Coasting losses.
    drive -= sign(vLong) * CFG.rollingDrag;
    drive -= vLong * Math.abs(vLong) * CFG.airDrag;
    if (input.throttle < 0.01 && input.brake < 0.01) {
      drive -= sign(vLong) * CFG.engineBraking * clamp(Math.abs(vLong) / 12, 0, 1);
    }

    // --- axle slip angles ------------------------------------------------
    const a = LIMO.frontAxle;          // +2.8
    const b = -LIMO.rearAxle;          // +2.8
    const vRef = Math.max(Math.abs(vLong), 2.2);   // keeps slip sane at low speed

    const slipFront = Math.atan2(vLat + this.yawRate * a, vRef) - this.steer * sign(vLong || 1);
    const slipRear = Math.atan2(vLat - this.yawRate * b, vRef);

    // Rear grip collapses under the handbrake or full throttle: that's the
    // whole drift mechanic in two lines.
    let gripRear = CFG.gripRear;
    if (input.handbrake) gripRear = CFG.handbrakeGrip;
    else if (input.throttle > 0.5) {
      gripRear -= CFG.throttleSlipLoss * input.throttle * clamp(1 - speedFactor * 0.6, 0.25, 1);
    }
    if (boosting) gripRear -= 1.8;

    const tyreForce = (slip, grip) =>
      -grip * Math.sin(1.9 * Math.atan(CFG.stiffness * slip));

    const fyFront = tyreForce(slipFront, CFG.gripFront);
    const fyRear = tyreForce(slipRear, gripRear);

    // --- integrate -------------------------------------------------------
    const aLong = drive + (vLat * this.yawRate);
    const aLat = (fyFront * Math.cos(this.steer) + fyRear) / CFG.mass - (vLong * this.yawRate);

    vLong += aLong * dt;
    vLat += aLat * dt;

    const yawTorque = a * fyFront * Math.cos(this.steer) - b * fyRear;
    const yawAcc = yawTorque / CFG.yawInertia - this.yawRate * CFG.yawDamping;
    this.yawRate += yawAcc * dt;

    // Stop the model buzzing when the car is essentially stationary.
    if (Math.abs(vLong) < 0.12 && Math.abs(vLat) < 0.12 && Math.abs(drive) < 0.5) {
      vLong = 0;
      vLat = 0;
      this.yawRate *= 0.82;
    }
    this.yawRate = clamp(this.yawRate, -2.6, 2.6);

    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    // Rebuild world velocity from the (updated) body frame.
    const nf = this.forward.clone();
    const nr = this.right.clone();
    this.velocity.copy(nf.multiplyScalar(vLong).add(nr.multiplyScalar(vLat)));
    this.position.addScaledVector(this.velocity, dt);

    // --- telemetry for the rest of the game ------------------------------
    this.speed = vLong;
    this.slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.8));
    this.rearSlipRatio = clamp(Math.abs(slipRear) / 0.62, 0, 1);
    this.wheelSlip = clamp(
      Math.max(
        this.rearSlipRatio,
        input.handbrake && speedAbs > 3 ? 1 : 0,
        // wheelspin from a standing start
        input.throttle > 0.8 && Math.abs(vLong) < 9 ? 0.65 : 0,
      ),
      0, 1,
    );
    this.isDrifting = Math.abs(this.slipAngle) > 0.18 && speedAbs > 7.5;
    this.braking = braking;
    this.reversing = vLong < -0.4;
    this.boosting = boosting;

    // Gear + rpm are cosmetic: they drive the dial and the engine note.
    const ratios = [0, 12, 22, 32, 42, 54, 68];
    let g = 1;
    while (g < ratios.length - 1 && Math.abs(vLong) > ratios[g]) g++;
    this.gear = this.reversing ? 0 : g;
    const lo = ratios[g - 1] ?? 0;
    const hi = ratios[g] ?? CFG.topSpeed;
    const inGear = clamp((Math.abs(vLong) - lo) / Math.max(hi - lo, 1), 0, 1);
    const idle = 0.13 + input.throttle * 0.16;
    this.rpm = damp(this.rpm, Math.max(idle, 0.22 + inGear * 0.78 + this.wheelSlip * 0.15), 7, dt);

    this.impact = Math.max(0, this.impact - dt * 2.6);
  }

  /** Called by the collision system when the body hits geometry. */
  applyImpact(normal, restitution = 0.32) {
    const vn = this.velocity.dot(normal);
    if (vn >= 0) return 0;
    const strength = clamp(-vn / 26, 0, 1);
    this.velocity.addScaledVector(normal, -vn * (1 + restitution));
    // Scrub speed and spin the car a little — hitting a wall should hurt.
    this.velocity.multiplyScalar(lerp(1, 0.72, strength));
    this.yawRate += (Math.random() - 0.5) * strength * 1.4;
    this.impact = Math.max(this.impact, strength);
    return strength;
  }
}

export const PHYSICS_CONFIG = CFG;
