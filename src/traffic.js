import { CATEGORY } from './config.js';
import { clamp, lerp, angleDiff, Rng } from './util.js';

const { Bodies, Body, Composite } = window.Matter;

const KINDS = {
  sedan: { w: 58, h: 28, color: '#4f7fd4', roof: '#3b62a8', mass: 0.0018 },
  taxi: { w: 60, h: 29, color: '#f2c14e', roof: '#d9a72f', mass: 0.0018 },
  van: { w: 70, h: 32, color: '#e8e8ee', roof: '#c8c8d2', mass: 0.0024 },
  bus: { w: 108, h: 36, color: '#e2564a', roof: '#c0403a', mass: 0.0034 },
  sports: { w: 54, h: 26, color: '#5fd1a0', roof: '#3fae82', mass: 0.0015 },
};

class TrafficCar {
  constructor(world, track, spawn, rng) {
    this.track = track;
    this.spec = KINDS[spawn.kind] || KINDS.sedan;
    this.kind = spawn.kind;
    this.dir = spawn.oncoming ? -1 : 1;
    this.index = spawn.index;
    this.lane = spawn.lane;
    this.baseSpeed = spawn.speed * (this.dir < 0 ? 0.8 : 1);
    this.speed = this.baseSpeed;
    this.spun = 0;
    this.honkCooldown = rng.range(0, 4);
    this.blinker = rng.next() < 0.25;

    const s = track.sample(this.index);
    const nx = -Math.sin(s.a);
    const ny = Math.cos(s.a);
    const off = this.lane * s.w;
    this.body = Bodies.rectangle(s.x + nx * off, s.y + ny * off, this.spec.w, this.spec.h, {
      angle: s.a + (this.dir < 0 ? Math.PI : 0),
      density: this.spec.mass,
      frictionAir: 0.02,
      friction: 0.1,
      restitution: 0.25,
      chamfer: { radius: 6 },
      label: 'traffic',
      collisionFilter: {
        category: CATEGORY.TRAFFIC,
        mask:
          CATEGORY.WALL | CATEGORY.LIMO | CATEGORY.PROP | CATEGORY.TRAFFIC | CATEGORY.CARGO_LOOSE,
      },
    });
    this.body.plugin = { traffic: this };
    Composite.add(world, this.body);
  }

  /** Drive toward a point a little way ahead on the centerline. */
  update(dt, playerIndex) {
    const body = this.body;
    const track = this.track;

    // Only simulate cars near the player — keeps long tracks cheap.
    const near = Math.abs(this.index - playerIndex) < 46;
    this.active = near;
    if (!near) {
      Body.setVelocity(body, { x: 0, y: 0 });
      Body.setAngularVelocity(body, 0);
      return;
    }

    this.index = track.nearestIndex(body.position.x, body.position.y, this.index);

    if (this.spun > 0) {
      this.spun -= dt;
      // Coast and scrub speed while spinning out.
      Body.setVelocity(body, { x: body.velocity.x * 0.97, y: body.velocity.y * 0.97 });
      return;
    }

    const lookAhead = 3 * this.dir;
    const target = track.sample(this.index + lookAhead);
    const nx = -Math.sin(target.a);
    const ny = Math.cos(target.a);
    const off = this.lane * target.w;
    const tx = target.x + nx * off;
    const ty = target.y + ny * off;

    // Oncoming cars were spawned facing backwards along the track, and their
    // look-ahead sample is behind them, so the same maths steers both.
    const desired = Math.atan2(ty - body.position.y, tx - body.position.x);
    const turn = angleDiff(desired, body.angle);
    Body.setAngularVelocity(body, lerp(body.angularVelocity, clamp(turn * 0.12, -0.06, 0.06), 0.3));

    this.speed = lerp(this.speed, this.baseSpeed, 0.02);

    const c = Math.cos(body.angle);
    const s = Math.sin(body.angle);
    let vf = body.velocity.x * c + body.velocity.y * s;
    let vr = -body.velocity.x * s + body.velocity.y * c;
    vf = lerp(vf, this.speed, 0.06);
    vr *= 0.35; // civilians do not drift
    Body.setVelocity(body, { x: vf * c - vr * s, y: vf * s + vr * c });

    if (this.honkCooldown > 0) this.honkCooldown -= dt;
  }

  hit(strength) {
    this.spun = Math.max(this.spun, clamp(strength * 0.5, 0.4, 2.2));
    this.speed = 0;
    const canHonk = this.honkCooldown <= 0;
    this.honkCooldown = 3;
    return canHonk;
  }
}

export class Traffic {
  constructor(world, track, seed = 1) {
    this.world = world;
    this.track = track;
    this.cars = [];
    const rng = new Rng(seed ^ 0x9e37);
    for (const spawn of track.trafficSpawns) {
      this.cars.push(new TrafficCar(world, track, spawn, rng));
    }
  }

  update(dt, playerIndex) {
    for (const car of this.cars) car.update(dt, playerIndex);
  }

  destroy() {
    for (const car of this.cars) Composite.remove(this.world, car.body);
    this.cars = [];
  }
}

export { KINDS as TRAFFIC_KINDS };
