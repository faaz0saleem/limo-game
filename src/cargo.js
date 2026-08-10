import { CONFIG, CATEGORY } from './config.js';
import { getCargoType } from './cargoTypes.js';
import { clamp, lerp, angleDiff } from './util.js';

const { Bodies, Body, Composite, Constraint } = window.Matter;

const ATTACHED_FILTER = { category: CATEGORY.CARGO_ATTACHED, mask: 0 };
const LOOSE_FILTER = {
  category: CATEGORY.CARGO_LOOSE,
  mask: CATEGORY.WALL | CATEGORY.PROP | CATEGORY.TRAFFIC | CATEGORY.CARGO_LOOSE,
};

/**
 * One piece of cargo strapped to a limo segment.
 *
 * While attached it is a real Matter body held by a real (soft) Constraint.
 * Cornering load transfer is injected as extra apparent inertia, so the strap
 * stretches. When the stretch passes `breakDistance` the constraint is removed
 * for real — the cargo becomes a free body that tumbles down the street.
 */
export class CargoItem {
  constructor(world, limo, typeId, segIndex) {
    this.world = world;
    this.limo = limo;
    this.def = getCargoType(typeId);
    this.segIndex = clamp(segIndex, 0, limo.segmentCount - 1);
    this.attached = true;
    this.tilt = 0;
    this.peakTilt = 0;
    this.leanX = 0;
    this.leanY = 0;
    this.warned = false;
    this.dropAge = 0;
    this.anchorLocal = { x: 0, y: 0 };

    const seg = limo.segments[this.segIndex];
    const pos = seg.body.position;
    const d = this.def;

    this.body = Bodies.rectangle(pos.x, pos.y, d.w, d.h, {
      angle: seg.body.angle,
      density: d.density * CONFIG.cargo.densityScale,
      frictionAir: CONFIG.cargo.frictionAir,
      friction: 0.25,
      restitution: 0.32,
      chamfer: { radius: Math.min(d.w, d.h) * 0.18 },
      label: 'cargo',
      collisionFilter: { ...ATTACHED_FILTER },
    });
    this.body.plugin = { cargo: this };

    this.constraint = Constraint.create({
      bodyA: seg.body,
      pointA: { ...this.anchorLocal },
      bodyB: this.body,
      pointB: { x: 0, y: 0 },
      length: 0,
      stiffness: CONFIG.cargo.stiffness,
      damping: CONFIG.cargo.damping,
      label: 'cargo-strap',
    });

    Composite.add(world, [this.body, this.constraint]);
  }

  get hostSegment() {
    return this.limo.segments[this.segIndex];
  }

  anchorWorld() {
    const seg = this.hostSegment;
    const a = seg.body.angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return {
      x: seg.body.position.x + this.anchorLocal.x * c - this.anchorLocal.y * s,
      y: seg.body.position.y + this.anchorLocal.x * s + this.anchorLocal.y * c,
    };
  }

  update(dt, events) {
    const cfg = CONFIG.cargo;
    if (!this.attached) {
      this.dropAge += dt;
      this.tilt = 0;
      return;
    }

    const seg = this.hostSegment;
    const body = this.body;
    const segAngle = seg.body.angle;
    const cs = Math.cos(segAngle);
    const sn = Math.sin(segAngle);

    // Load transfer: fake extra inertia so hard cornering visibly drags the
    // load outward instead of it riding glued to the roof. Worked in the
    // segment's own frame so cornering and acceleration can be weighted apart.
    const aF = (seg.accel.x * cs + seg.accel.y * sn) * cfg.longitudinalWeight;
    const aR = -seg.accel.x * sn + seg.accel.y * cs;
    this._aF = lerp(this._aF || 0, aF, cfg.accelSmoothing);
    this._aR = lerp(this._aR || 0, aR, cfg.accelSmoothing);

    const mag = Math.hypot(this._aF, this._aR);
    const scale = mag > cfg.maxAccelInput ? cfg.maxAccelInput / mag : 1;
    const extra = cfg.inertiaBoost * this.def.topHeavy * scale;
    const ax = this._aF * cs - this._aR * sn;
    const ay = this._aF * sn + this._aR * cs;

    Body.setVelocity(body, {
      x: body.velocity.x - ax * extra,
      y: body.velocity.y - ay * extra,
    });

    // Cobbles rattle the load loose.
    if (seg.bumping) {
      const j = seg.bumping * 0.55 * this.def.topHeavy;
      Body.setVelocity(body, {
        x: body.velocity.x + (Math.random() - 0.5) * j,
        y: body.velocity.y + (Math.random() - 0.5) * j,
      });
    }
    // Landing from a ramp slams it down hard.
    if (seg.air > 0) {
      Body.setAngularVelocity(body, body.angularVelocity + (Math.random() - 0.5) * 0.02);
    }

    const anchor = this.anchorWorld();
    const dx = body.position.x - anchor.x;
    const dy = body.position.y - anchor.y;
    const stretch = Math.hypot(dx, dy);

    const a = seg.body.angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.leanX = (dx * c + dy * s) / cfg.breakDistance;
    this.leanY = (-dx * s + dy * c) / cfg.breakDistance;

    this.tilt = clamp(stretch / cfg.breakDistance, 0, 1.5);
    if (this.tilt > this.peakTilt) this.peakTilt = this.tilt;

    if (this.tilt > cfg.warnRatio && !this.warned) {
      this.warned = true;
      events.onCargoWarn && events.onCargoWarn(this);
    } else if (this.tilt < cfg.warnRatio * 0.7) {
      this.warned = false;
    }

    if (this.tilt >= 1) this.detach(events, 'tilt');
  }

  /** Snap the strap. The cargo becomes a genuine loose body. */
  detach(events, reason = 'tilt') {
    if (!this.attached) return;
    this.attached = false;
    this.dropAge = 0;
    this.dropReason = reason;

    Composite.remove(this.world, this.constraint);
    this.constraint = null;

    const body = this.body;
    body.collisionFilter.category = LOOSE_FILTER.category;
    body.collisionFilter.mask = LOOSE_FILTER.mask;
    Body.set(body, 'frictionAir', CONFIG.cargo.looseAirFriction);
    Body.set(body, 'friction', CONFIG.cargo.looseFriction);

    const seg = this.hostSegment;
    const fling = CONFIG.cargo.flingBoost;
    const outward = Math.hypot(this.leanX, this.leanY) || 1;
    Body.setVelocity(body, {
      x: body.velocity.x * fling + (this.leanX / outward) * 1.4,
      y: body.velocity.y * fling + (this.leanY / outward) * 1.4,
    });
    Body.setAngularVelocity(body, seg.body.angularVelocity * 2.2 + (Math.random() - 0.5) * 0.25);

    events.onCargoDrop && events.onCargoDrop(this);
  }

  /** Rewarded-ad rescue: strap it back on where it belongs. */
  reattach() {
    if (this.attached) return;
    const seg = this.hostSegment;
    const anchor = this.anchorWorld();
    Body.setPosition(this.body, anchor);
    Body.setAngle(this.body, seg.body.angle);
    Body.setVelocity(this.body, { ...seg.body.velocity });
    Body.setAngularVelocity(this.body, 0);
    this.body.collisionFilter.category = ATTACHED_FILTER.category;
    this.body.collisionFilter.mask = ATTACHED_FILTER.mask;
    Body.set(this.body, 'frictionAir', CONFIG.cargo.frictionAir);
    this.constraint = Constraint.create({
      bodyA: seg.body,
      pointA: { ...this.anchorLocal },
      bodyB: this.body,
      pointB: { x: 0, y: 0 },
      length: 0,
      stiffness: CONFIG.cargo.stiffness,
      damping: CONFIG.cargo.damping,
      label: 'cargo-strap',
    });
    Composite.add(this.world, this.constraint);
    this.attached = true;
    this.tilt = 0;
    this.warned = false;
  }

  /** Put an attached item back on its anchor without breaking the strap. */
  snapToAnchor() {
    if (!this.attached) return;
    const seg = this.hostSegment;
    Body.setPosition(this.body, this.anchorWorld());
    Body.setAngle(this.body, seg.body.angle);
    Body.setVelocity(this.body, { ...seg.body.velocity });
    Body.setAngularVelocity(this.body, 0);
    this._aF = 0;
    this._aR = 0;
    this.tilt = 0;
    this.leanX = 0;
    this.leanY = 0;
  }

  /** Where and how to draw it this frame. */
  renderState() {
    if (!this.attached) {
      return {
        x: this.body.position.x,
        y: this.body.position.y,
        angle: this.body.angle,
        leanX: 0,
        leanY: 0,
        tilt: 0,
        alpha: 1,
      };
    }
    const anchor = this.anchorWorld();
    const k = CONFIG.cargo.visualLean;
    const seg = this.hostSegment;
    return {
      x: anchor.x + (this.body.position.x - anchor.x) * k,
      y: anchor.y + (this.body.position.y - anchor.y) * k,
      angle: seg.body.angle + angleDiff(this.body.angle, seg.body.angle) * 0.6,
      leanX: this.leanX,
      leanY: this.leanY,
      tilt: this.tilt,
      alpha: 1,
    };
  }

  destroy() {
    if (this.constraint) Composite.remove(this.world, this.constraint);
    Composite.remove(this.world, this.body);
  }
}

/** Manages the full load for a run. */
export class CargoRig {
  constructor(world, limo, typeIds) {
    this.world = world;
    this.limo = limo;
    this.items = [];
    const n = typeIds.length;
    const segs = limo.segmentCount;
    typeIds.forEach((id, i) => {
      // Spread the load down the length of the limo.
      const segIndex = n === 1 ? 0 : Math.round((i * (segs - 1)) / Math.max(1, n - 1));
      this.items.push(new CargoItem(world, limo, id, segIndex));
    });
  }

  get total() {
    return this.items.length;
  }

  get intact() {
    return this.items.reduce((acc, it) => acc + (it.attached ? 1 : 0), 0);
  }

  get lost() {
    return this.total - this.intact;
  }

  /** Worst current tilt across the load — drives the balance meter. */
  get worstTilt() {
    let worst = 0;
    for (const it of this.items) if (it.attached && it.tilt > worst) worst = it.tilt;
    return worst;
  }

  get integrity() {
    return this.total === 0 ? 1 : this.intact / this.total;
  }

  update(dt, events) {
    for (const it of this.items) it.update(dt, events);
  }

  snapToAnchors() {
    for (const it of this.items) it.snapToAnchor();
  }

  restoreAll() {
    let restored = 0;
    for (const it of this.items) {
      if (!it.attached) {
        it.reattach();
        restored += 1;
      }
    }
    return restored;
  }

  destroy() {
    for (const it of this.items) it.destroy();
    this.items = [];
  }
}
