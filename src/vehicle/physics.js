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
  gripFront: 16.5,
  gripRear: 17.0,
  handbrakeGrip: 4.2,
  handbrakeRamp: 9.0,       // how fast the rear lets go / hooks back up
  throttleSlipLoss: 4.2,    // rear grip lost under full power
  stiffness: 6.2,           // slope of the tyre curve before it saturates
  peakSharpness: 1.75,      // <2 keeps grip past the peak: slides stay held
  weightTransfer: 0.30,     // brake loads the front, throttle loads the rear

  // Chassis
  yawInertia: 3.15,         // the limo is long: lazy in, lazy out
  yawDamping: 2.4,
  driftDamping: 2.2,        // extra yaw damping deep in a slide (anti-spin)
  mass: 1,
};

/**
 * Per-car handling, scaled onto CFG. The shop sells these.
 * 1.0 everywhere is the starting limo.
 */
export const DEFAULT_HANDLING = {
  grip: 1, power: 1, brake: 1, drift: 1, mass: 1,
};

export class Vehicle {
  constructor(startPos = new THREE.Vector3(), startHeading = 0, handling = DEFAULT_HANDLING) {
    this.handling = { ...DEFAULT_HANDLING, ...handling };
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
    this._left = new THREE.Vector3();
    this._handbrake = 0;              // smoothed, so the rear doesn't snap
    this._lastImpact = 0;
    this.impact = 0;                      // 0..1, decays after a collision
  }

  get forward() {
    return this._forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /**
   * The car's LEFT-hand direction.
   *
   * Facing +Z with +Y up in a right-handed frame, the driver's right is -X,
   * so this vector — (+X at heading 0) — is the left side. The whole model is
   * built in this ISO-style frame where positive lateral velocity, positive
   * yaw and positive steer all mean "left"; `update()` negates the player's
   * steering input once, on the way in. Calling this `right` is what made the
   * controls come out mirrored.
   */
  get left() {
    return this._left.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
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
    const left = this.left.clone();

    // --- velocity in the body frame -------------------------------------
    let vLong = this.velocity.dot(fwd);
    let vLat = this.velocity.dot(left);
    const speedAbs = Math.hypot(vLong, vLat);

    // --- steering --------------------------------------------------------
    // Input is +1 for "right" because that is what a player expects; the model
    // below is left-positive, so flip it exactly once, here.
    const steerCmd = -input.steer;

    const speedFactor = clamp(speedAbs / CFG.topSpeed, 0, 1);
    const maxSteer = lerp(CFG.maxSteer, CFG.highSpeedSteer, Math.pow(speedFactor, 0.65));

    let steerTarget = steerCmd * maxSteer;

    // Countersteer assist: when the rear is out, bias the wheel into the
    // slide so the car is catchable on a keyboard.
    if (speedAbs > 6) {
      const slide = Math.atan2(vLat, Math.abs(vLong));
      steerTarget += clamp(-slide, -maxSteer, maxSteer) * CFG.counterSteerAssist
        * clamp(Math.abs(slide) / 0.5, 0, 1);
      steerTarget = clamp(steerTarget, -maxSteer * 1.25, maxSteer * 1.25);
    }

    const rate = Math.abs(steerCmd) > 0.01 ? CFG.steerRate : CFG.steerReturn;
    this.steer = damp(this.steer, steerTarget, rate, dt);

    // --- drive / brake ---------------------------------------------------
    const H = this.handling;
    const boosting = input.boost && this.boostCharge > 0.02 && input.throttle > 0.1;
    const topSpeed = (boosting ? CFG.boostTopSpeed : CFG.topSpeed) * lerp(1, H.power, 0.5);
    const power = (boosting ? CFG.boostPower : CFG.enginePower) * H.power;

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
        drive -= CFG.brakePower * H.brake * input.brake;   // brakes
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

    // Weight transfer. Braking pitches weight onto the nose (more front grip,
    // less rear — this is what makes trail-braking rotate the car); throttle
    // does the opposite. It's the difference between a car that turns and a
    // car that understeers everywhere.
    const load = clamp(input.brake - input.throttle, -1, 1) * CFG.weightTransfer;
    const gripScale = H.grip;

    // The handbrake ramps rather than switching, so the rear breaks away over
    // a few frames and hooks back up smoothly instead of snapping.
    this._handbrake = damp(this._handbrake, input.handbrake ? 1 : 0, CFG.handbrakeRamp, dt);

    let gripFront = CFG.gripFront * gripScale * (1 + load);
    let gripRear = CFG.gripRear * gripScale * (1 - load);

    if (input.throttle > 0.5) {
      gripRear -= CFG.throttleSlipLoss * input.throttle
        * clamp(1 - speedFactor * 0.6, 0.25, 1) * gripScale;
    }
    if (boosting) gripRear -= 1.8;
    // Blend toward handbrake grip; H.drift makes a drift-spec car looser.
    gripRear = lerp(gripRear, CFG.handbrakeGrip / H.drift, this._handbrake);
    gripRear = Math.max(gripRear, 1.2);

    /*
     * Saturating tyre curve. `peakSharpness` below 2 means the force does not
     * collapse once the tyre is past its peak — it eases off. That plateau is
     * what makes a big slide holdable instead of an instant spin.
     */
    const tyreForce = (slip, grip) =>
      -grip * Math.sin(CFG.peakSharpness * Math.atan(CFG.stiffness * slip));

    const fyFront = tyreForce(slipFront, gripFront);
    const fyRear = tyreForce(slipRear, gripRear);

    // --- integrate -------------------------------------------------------
    const aLong = drive + (vLat * this.yawRate);
    const aLat = (fyFront * Math.cos(this.steer) + fyRear) / CFG.mass - (vLong * this.yawRate);

    vLong += aLong * dt;
    vLat += aLat * dt;

    const yawTorque = a * fyFront * Math.cos(this.steer) - b * fyRear;
    // Extra damping once the car is properly sideways. Without it the model is
    // technically correct and completely unplayable: every slide becomes a
    // spin. With it, a big angle is something you can sit in and hold.
    const sideways = clamp((Math.abs(Math.atan2(vLat, Math.max(Math.abs(vLong), 1))) - 0.25) / 0.6, 0, 1);
    const damping = CFG.yawDamping + sideways * CFG.driftDamping;
    const yawAcc = yawTorque / (CFG.yawInertia * H.mass) - this.yawRate * damping;
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
    const nl = this.left.clone();
    this.velocity.copy(nf.multiplyScalar(vLong).add(nl.multiplyScalar(vLat)));
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
