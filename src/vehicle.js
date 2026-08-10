import { CONFIG, CATEGORY } from './config.js';
import { clamp, lerp, angleDiff } from './util.js';

const { Bodies, Body, Composite, Constraint } = window.Matter;

/**
 * The stretch limo: a front cab plus N trailing segments joined by zero-length
 * revolute constraints.
 *
 * Driving model is velocity-space (arcade), applied on top of Matter's rigid
 * body solve:
 *   1. decompose each segment's velocity into forward / lateral
 *   2. the cab gets engine thrust + a steering angular velocity target
 *   3. every segment loses lateral velocity according to a grip curve that
 *      saturates past `slipLimit` — past that point the tires let go and the
 *      segment slides, which is what produces the snaking drift
 *   4. trailing segments get progressively less grip, so the tail whips
 */
export class Limo {
  constructor(world, { segments = 1, position, angle = 0 } = {}) {
    this.world = world;
    this.segmentCount = Math.max(1, segments);
    this.group = Body.nextGroup(true);
    this.segments = [];
    this.joints = [];
    this.destroyed = false;

    // Live telemetry read by the HUD, camera, audio and particle systems.
    this.speed = 0;
    this.speed01 = 0;
    this.driftAngle = 0;
    this.maxDriftAngle = 0;
    this.driftScore = 0;
    this.slip = 0;
    this.boost = CONFIG.limo.boostCapacity;
    this.boosting = false;
    this.airTime = 0;
    this.wallHitCooldown = 0;
    this.trackIndex = 0;
    this.distance = 0;

    const L = CONFIG.limo;
    const pitch = L.segLength + L.segGap;
    const fwd = { x: Math.cos(angle), y: Math.sin(angle) };

    for (let i = 0; i < this.segmentCount; i++) {
      const x = position.x - fwd.x * pitch * i;
      const y = position.y - fwd.y * pitch * i;
      const body = Bodies.rectangle(x, y, L.segLength, L.segWidth, {
        angle,
        density: L.density,
        friction: 0.05,
        frictionAir: 0,
        restitution: 0.16,
        label: i === 0 ? 'limo-cab' : 'limo-seg',
        chamfer: { radius: 8 },
        collisionFilter: {
          group: this.group, // segments never collide with each other
          category: CATEGORY.LIMO,
          mask: CATEGORY.WALL | CATEGORY.TRAFFIC | CATEGORY.PROP,
        },
      });
      body.plugin = body.plugin || {};
      body.plugin.limoIndex = i;
      body.plugin.limo = this;

      this.segments.push({
        body,
        index: i,
        isCab: i === 0,
        prevVel: { x: 0, y: 0 },
        accel: { x: 0, y: 0 },
        lateral: 0,
        forward: 0,
        air: 0,
        surfaceGrip: 1,
        smokeCharge: 0,
      });
    }

    for (let i = 0; i < this.segments.length - 1; i++) {
      const a = this.segments[i].body;
      const b = this.segments[i + 1].body;
      const joint = Constraint.create({
        bodyA: a,
        pointA: { x: -(L.segLength / 2 + L.segGap / 2), y: 0 },
        bodyB: b,
        pointB: { x: L.segLength / 2 + L.segGap / 2, y: 0 },
        length: 0,
        stiffness: L.jointStiffness,
        damping: L.jointDamping,
        label: 'limo-joint',
      });
      this.joints.push(joint);
    }

    Composite.add(world, [...this.segments.map((s) => s.body), ...this.joints]);
  }

  get cab() {
    return this.segments[0].body;
  }

  get tail() {
    return this.segments[this.segments.length - 1].body;
  }

  get position() {
    return this.cab.position;
  }

  get totalLength() {
    return this.segmentCount * (CONFIG.limo.segLength + CONFIG.limo.segGap);
  }

  /** Local anchor point on top of a segment where cargo straps down. */
  cargoAnchor(index) {
    return this.segments[clamp(index, 0, this.segmentCount - 1)];
  }

  /** World position of a wheel, used for smoke and skid marks. */
  wheelPoint(seg, axle, side) {
    const L = CONFIG.limo;
    const lx = axle * L.segLength * 0.33;
    const ly = side * L.segWidth * 0.46;
    const c = Math.cos(seg.body.angle);
    const s = Math.sin(seg.body.angle);
    return {
      x: seg.body.position.x + lx * c - ly * s,
      y: seg.body.position.y + lx * s + ly * c,
    };
  }

  launch(power) {
    for (const seg of this.segments) seg.pendingAir = Math.max(seg.pendingAir || 0, power);
  }

  /**
   * One fixed physics step. `dt` is always CONFIG.physics.fixedDt seconds.
   */
  update(dt, input, track, events) {
    if (this.destroyed) return;
    const L = CONFIG.limo;
    const steer = input.steer;

    // --- Boost meter ------------------------------------------------
    const wantsBoost = input.boostHeld && this.boost > 0.001;
    if (wantsBoost) {
      if (!this.boosting && this.boost >= L.boostMinToFire) {
        this.boosting = true;
        events.onBoostStart && events.onBoostStart();
      }
      if (this.boosting) {
        this.boost = Math.max(0, this.boost - dt);
        if (this.boost <= 0) this.boosting = false;
      }
    } else {
      this.boosting = false;
    }
    if (!this.boosting) {
      this.boost = Math.min(CONFIG.limo.boostCapacity, this.boost + L.boostRefill * dt);
    }

    const cabSeg = this.segments[0];
    const cab = cabSeg.body;

    for (const seg of this.segments) {
      const body = seg.body;
      const v = body.velocity;

      // Surface under this segment.
      const surf = track ? track.surfaceAt(body.position.x, body.position.y) : { grip: 1, bump: 0 };
      seg.surfaceGrip = surf.grip;

      // Ramp launch propagates down the limo segment by segment.
      if (seg.pendingAir) {
        seg.air = Math.max(seg.air, 0.42 + seg.pendingAir * 0.22);
        seg.pendingAir = 0;
      }
      const wasAir = seg.air > 0;
      if (seg.air > 0) {
        seg.air = Math.max(0, seg.air - dt);
        if (wasAir && seg.air === 0) events.onLand && events.onLand(seg);
      }
      const airborne = seg.air > 0;

      const cosA = Math.cos(body.angle);
      const sinA = Math.sin(body.angle);
      // forward = local +x, right = local +y
      let vf = v.x * cosA + v.y * sinA;
      let vr = -v.x * sinA + v.y * cosA;

      // --- Engine (auto-throttle: this is a two-button game) ----------
      // Every segment is driven along its own heading. Thrusting only the cab
      // would make the limo slower the longer it gets, because the cab has to
      // drag the whole chain through the joints.
      if (!airborne) {
        const top = this.boosting ? L.boostMaxSpeed : L.maxSpeed;
        const accel =
          (this.boosting ? L.boostAccel : L.engineAccel) * (seg.isCab ? 1 : L.trailerDrive);
        if (vf < top) {
          vf = Math.min(top, vf + accel);
        } else {
          vf = lerp(vf, top, 0.06);
        }
        if (input.handbrake) vf *= 1 - L.brakeResistance;
      }

      // --- Grip curve ------------------------------------------------
      let grip = seg.isCab ? L.cabGrip : L.trailerGrip - seg.index * L.tailGripFalloff;
      grip = Math.max(0.06, grip);
      const slipMag = Math.abs(vr);
      if (slipMag > L.slipLimit) {
        grip *= Math.pow(L.slipLimit / slipMag, L.gripFalloff);
      }
      grip *= seg.surfaceGrip;
      if (input.handbrake) grip *= L.handbrakeGrip;
      if (airborne) grip *= 0.12;

      const preSlip = vr;
      vr *= 1 - clamp(grip, 0, 0.98);
      vf *= 1 - L.rollingResistance;

      seg.lateral = preSlip;
      seg.forward = vf;

      Body.setVelocity(body, {
        x: vf * cosA - vr * sinA,
        y: vf * sinA + vr * cosA,
      });

      // --- Steering / angular behaviour ------------------------------
      if (seg.isCab) {
        const speed = Math.hypot(v.x, v.y);
        const authority = clamp(speed / L.steerFullSpeed, 0, 1);
        const reverse = vf < -0.2 ? -1 : 1;
        const target = steer * L.maxSteerRate * (0.28 + 0.72 * authority) * reverse * (airborne ? 0.25 : 1);
        Body.setAngularVelocity(body, lerp(body.angularVelocity, target, L.steerResponse));
      } else {
        Body.setAngularVelocity(body, body.angularVelocity * L.angularDamping);
      }

      // --- Road bumps ------------------------------------------------
      if (surf.bump > 0 && !airborne) {
        const jolt = surf.bump * L.bumpImpulse * (0.4 + this.speed01) * 60 * dt;
        Body.setVelocity(body, {
          x: body.velocity.x + (Math.random() - 0.5) * jolt * 40,
          y: body.velocity.y + (Math.random() - 0.5) * jolt * 40,
        });
        seg.bumping = surf.bump;
      } else {
        seg.bumping = 0;
      }

      // Total acceleration across this whole step (engine + grip + collisions).
      // The cargo balance model reads this to work out load transfer.
      seg.accel.x = body.velocity.x - seg.prevVel.x;
      seg.accel.y = body.velocity.y - seg.prevVel.y;
      seg.prevVel.x = body.velocity.x;
      seg.prevVel.y = body.velocity.y;
    }

    this._limitJoints();

    // Front wheels visually follow the steering input.
    this.steerVisual = lerp(this.steerVisual || 0, steer * 0.45, 0.25);

    // --- Telemetry ---------------------------------------------------
    const v = cab.velocity;
    this.speed = Math.hypot(v.x, v.y);
    this.speed01 = clamp(this.speed / L.boostMaxSpeed, 0, 1);
    this.airTime = Math.max(...this.segments.map((s) => s.air));

    if (this.speed > 2.2) {
      const heading = Math.atan2(v.y, v.x);
      this.driftAngle = Math.abs(angleDiff(heading, cab.angle));
      if (this.driftAngle > Math.PI / 2) this.driftAngle = Math.PI - this.driftAngle;
    } else {
      this.driftAngle = 0;
    }
    if (this.driftAngle > this.maxDriftAngle) this.maxDriftAngle = this.driftAngle;

    this.slip = 0;
    for (const seg of this.segments) this.slip = Math.max(this.slip, Math.abs(seg.lateral));

    if (this.driftAngle > 0.16 && this.speed > 3.4) {
      this.driftScore += this.driftAngle * this.speed * CONFIG.score.driftRate * dt;
    }

    if (this.wallHitCooldown > 0) this.wallHitCooldown -= dt;
  }

  /** Soft jackknife limiter so the limo can fold hard but never invert. */
  _limitJoints() {
    const L = CONFIG.limo;
    for (let i = 0; i < this.segments.length - 1; i++) {
      const a = this.segments[i].body;
      const b = this.segments[i + 1].body;
      const d = angleDiff(b.angle, a.angle);
      const over = Math.abs(d) - L.maxJointAngle;
      if (over > 0) {
        const push = Math.sign(d) * over * L.jointLimitStrength;
        Body.setAngularVelocity(b, b.angularVelocity - push);
        Body.setAngularVelocity(a, a.angularVelocity + push * 0.45);
      }
    }
  }

  /** Emit tire smoke for every sliding wheel. */
  emitSmoke(particles, dt) {
    const L = CONFIG.limo;
    for (const seg of this.segments) {
      const slip = Math.abs(seg.lateral);
      const sliding = slip > L.driftSmokeSlip && !(seg.air > 0);
      const lowGrip = seg.surfaceGrip < 0.5 && this.speed > 2;
      if (!sliding && !lowGrip) continue;
      const strength = clamp((slip - L.driftSmokeSlip) / 3.2, lowGrip ? 0.25 : 0.05, 1);
      seg.smokeCharge += strength * dt * 62;
      while (seg.smokeCharge >= 1) {
        seg.smokeCharge -= 1;
        for (const side of [-1, 1]) {
          const p = this.wheelPoint(seg, -1, side);
          particles.smoke(p.x, p.y, {
            vx: seg.body.velocity.x * 0.12 + (Math.random() - 0.5) * 0.6,
            vy: seg.body.velocity.y * 0.12 + (Math.random() - 0.5) * 0.6,
            size: 9 + strength * 16,
            life: 0.55 + strength * 0.7,
            tint: seg.surfaceGrip < 0.5 ? 'oil' : 'smoke',
          });
        }
      }
    }
  }

  /** Re-place the whole limo at a track sample (used after a spin-out). */
  respawnAt(track, index) {
    const L = CONFIG.limo;
    const s = track.sample(index);
    const pitch = L.segLength + L.segGap;
    const fwd = { x: Math.cos(s.a), y: Math.sin(s.a) };
    for (let i = 0; i < this.segments.length; i++) {
      const body = this.segments[i].body;
      Body.setPosition(body, {
        x: s.x - fwd.x * pitch * i,
        y: s.y - fwd.y * pitch * i,
      });
      Body.setAngle(body, s.a);
      Body.setVelocity(body, { x: fwd.x * 2, y: fwd.y * 2 });
      Body.setAngularVelocity(body, 0);
      this.segments[i].prevVel = { x: 0, y: 0 };
      this.segments[i].air = 0;
    }
  }

  destroy() {
    if (this.destroyed) return;
    Composite.remove(this.world, this.joints);
    Composite.remove(this.world, this.segments.map((s) => s.body));
    this.destroyed = true;
  }
}
