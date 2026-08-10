import { CONFIG, CATEGORY, COLORS } from './config.js';
import { Rng, clamp, lerp, TAU, dist2 } from './util.js';

const { Bodies, Composite } = window.Matter;

/**
 * Procedural city track generator.
 *
 * Produces a continuous centerline made of straights, sweepers, hairpins,
 * chicanes, narrow alleys and wide intersections; then derives:
 *   - collidable kerb walls (merged into long bodies where the road is straight)
 *   - hazard zones (oil slicks, ramps, cobble/bump strips, boost pads)
 *   - knock-over props (cones, barrels, bins)
 *   - civilian traffic spawn points
 *   - purely decorative city blocks either side of the road
 */

const PIECE = {
  STRAIGHT: 'straight',
  SWEEPER: 'sweeper',
  CURVE: 'curve',
  HAIRPIN: 'hairpin',
  CHICANE: 'chicane',
  ALLEY: 'alley',
  PLAZA: 'plaza',
};

export class Track {
  constructor(samples, opts) {
    this.samples = samples;
    this.step = CONFIG.track.step;
    this.walls = [];
    this.zones = [];
    this.props = [];
    this.buildings = [];
    this.checkpoints = [];
    this.trafficSpawns = [];
    this.length = (samples.length - 1) * this.step;
    this.level = opts.level;
    this.seed = opts.seed;

    const first = samples[0];
    this.startPos = { x: first.x, y: first.y };
    this.startAngle = first.a;
    const last = samples[samples.length - 1];
    this.finish = { x: last.x, y: last.y, a: last.a, index: samples.length - 1 };

    this._bounds = null;
  }

  sample(i) {
    return this.samples[clamp(i | 0, 0, this.samples.length - 1)];
  }

  /**
   * Nearest centerline index. `hint` keeps the search local so this stays O(1)
   * during play; pass -1 for a full scan (respawns, first frame).
   */
  nearestIndex(x, y, hint = -1) {
    let lo = 0;
    let hi = this.samples.length - 1;
    if (hint >= 0) {
      lo = Math.max(0, hint - 24);
      hi = Math.min(this.samples.length - 1, hint + 40);
    }
    let best = lo;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const s = this.samples[i];
      const d = dist2(x, y, s.x, s.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // Local search can get stranded if the limo is flung off course.
    if (hint >= 0 && bestD > 900 * 900) return this.nearestIndex(x, y, -1);
    return best;
  }

  progressAt(index) {
    return clamp(index / (this.samples.length - 1), 0, 1);
  }

  /** Signed distance from the centerline: positive = right of travel. */
  lateralOffset(x, y, index) {
    const s = this.sample(index);
    const nx = -Math.sin(s.a);
    const ny = Math.cos(s.a);
    return (x - s.x) * nx + (y - s.y) * ny;
  }

  bounds() {
    if (this._bounds) return this._bounds;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of this.samples) {
      minX = Math.min(minX, s.x - s.w);
      minY = Math.min(minY, s.y - s.w);
      maxX = Math.max(maxX, s.x + s.w);
      maxY = Math.max(maxY, s.y + s.w);
    }
    this._bounds = { minX, minY, maxX, maxY };
    return this._bounds;
  }

  /** Surface grip multiplier at a world point (oil slicks are slippery). */
  surfaceAt(x, y) {
    let grip = 1;
    let bump = 0;
    for (const z of this.zones) {
      if (z.type !== 'oil' && z.type !== 'bump') continue;
      const dx = x - z.x;
      const dy = y - z.y;
      if (dx * dx + dy * dy > z.r * z.r) continue;
      if (z.type === 'oil') grip = Math.min(grip, z.grip);
      else bump = Math.max(bump, z.strength);
    }
    return { grip, bump };
  }

  destroy(world) {
    Composite.remove(world, this.walls);
    for (const p of this.props) Composite.remove(world, p.body);
    this.walls = [];
    this.props = [];
  }
}

/* ------------------------------------------------------------------ */
/* Centerline construction                                             */
/* ------------------------------------------------------------------ */

function buildCenterline(rng, targetLength, difficulty, widths) {
  const step = CONFIG.track.step;
  const samples = [];
  const cellSize = 110;
  const grid = new Map();

  let x = 0;
  let y = 0;
  let a = 0;
  let width = widths.road;

  const key = (cx, cy) => cx + ',' + cy;

  const indexSample = (s, i) => {
    const cx = Math.floor(s.x / cellSize);
    const cy = Math.floor(s.y / cellSize);
    const k = key(cx, cy);
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(i);
  };

  // Rejects a candidate that would run the road on top of an earlier section.
  const overlaps = (px, py, pw) => {
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    const reach = Math.ceil((pw + 60) / cellSize) + 1;
    const ignoreAfter = samples.length - 16;
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const arr = grid.get(key(gx, gy));
        if (!arr) continue;
        for (const idx of arr) {
          if (idx >= ignoreAfter) continue;
          const s = samples[idx];
          // Half of each road plus a real gap, so parallel streets never end up
          // sharing a kerb (which is where blocked corridors came from).
          const minSep = (s.w + pw) * 0.5 + 90;
          if (dist2(px, py, s.x, s.y) < minSep * minSep) return true;
        }
      }
    }
    return false;
  };

  const push = (s) => {
    indexSample(s, samples.length);
    samples.push(s);
  };

  push({ x, y, a, w: width, type: PIECE.STRAIGHT, index: 0 });

  // Generate a candidate run of samples for a piece without committing it.
  function planPiece(piece) {
    const out = [];
    let px = x;
    let py = y;
    let pa = a;
    let pw = width;

    const advance = (turnPerStep, targetW, count) => {
      for (let i = 0; i < count; i++) {
        pa += turnPerStep;
        pw = lerp(pw, targetW, 0.28);
        px += Math.cos(pa) * step;
        py += Math.sin(pa) * step;
        out.push({ x: px, y: py, a: pa, w: pw, type: piece.type });
      }
    };

    switch (piece.type) {
      case PIECE.STRAIGHT:
        advance(0, widths.road, piece.count);
        break;
      case PIECE.SWEEPER:
      case PIECE.CURVE:
      case PIECE.HAIRPIN: {
        const turn = (step / piece.radius) * piece.dir;
        const count = Math.max(2, Math.round(Math.abs(piece.angle) / (step / piece.radius)));
        advance(turn, piece.width, count);
        break;
      }
      case PIECE.CHICANE: {
        const turn = (step / piece.radius) * piece.dir;
        const count = Math.max(2, Math.round(Math.abs(piece.angle) / (step / piece.radius)));
        advance(turn, piece.width, count);
        advance(-turn, piece.width, count);
        break;
      }
      case PIECE.ALLEY:
        advance(piece.drift, widths.alley, piece.count);
        break;
      case PIECE.PLAZA:
        advance(0, widths.plaza, piece.count);
        break;
      default:
        advance(0, widths.road, 4);
    }
    return out;
  }

  function commit(planned, piece) {
    for (const s of planned) {
      s.index = samples.length;
      s.piece = piece.type;
      push(s);
    }
    const last = planned[planned.length - 1];
    x = last.x;
    y = last.y;
    a = last.a;
    width = last.w;
  }

  const d = clamp(difficulty, 0, 1);
  let traveled = 0;
  let lastType = PIECE.STRAIGHT;
  let sinceHairpin = 0;

  // Opening straight so the player gets a moment before the first corner.
  commit(planPiece({ type: PIECE.STRAIGHT, count: 7 }), { type: PIECE.STRAIGHT });
  traveled += 7 * step;

  while (traveled < targetLength) {
    const table = [
      { w: lastType === PIECE.STRAIGHT ? 0.7 : 2.6, type: PIECE.STRAIGHT },
      { w: 2.2, type: PIECE.SWEEPER },
      { w: 1.6 + d * 1.4, type: PIECE.CURVE },
      { w: sinceHairpin > 3 ? 0.5 + d * 1.7 : 0, type: PIECE.HAIRPIN },
      { w: 0.7 + d * 1.5, type: PIECE.CHICANE },
      { w: 0.4 + d * 1.5, type: PIECE.ALLEY },
      { w: 0.55, type: PIECE.PLAZA },
    ].filter((e) => e.w > 0);

    let placed = false;
    for (let attempt = 0; attempt < 16 && !placed; attempt++) {
      // Later attempts fall back to short straights, which are the easiest
      // shape to fit into whatever space is left.
      const choice = attempt < 10 ? rng.weighted(table) : { type: PIECE.STRAIGHT };
      const dir = rng.bool() ? 1 : -1;
      let piece;
      switch (choice.type) {
        case PIECE.STRAIGHT:
          piece = { type: PIECE.STRAIGHT, count: attempt < 10 ? rng.int(4, 11) : rng.int(2, 4) };
          break;
        case PIECE.SWEEPER:
          piece = {
            type: PIECE.SWEEPER,
            dir,
            radius: rng.range(430, 780),
            angle: rng.range(0.6, 1.7),
            width: widths.road,
          };
          break;
        case PIECE.CURVE:
          piece = {
            type: PIECE.CURVE,
            dir,
            radius: rng.range(270, 410),
            angle: rng.range(1.0, 1.9),
            width: widths.road * rng.range(0.88, 1.0),
          };
          break;
        case PIECE.HAIRPIN:
          piece = {
            type: PIECE.HAIRPIN,
            dir,
            radius: rng.range(225, 275),
            angle: rng.range(2.5, 3.05),
            width: widths.road * 1.1,
          };
          break;
        case PIECE.CHICANE:
          piece = {
            type: PIECE.CHICANE,
            dir,
            radius: rng.range(290, 400),
            angle: rng.range(0.7, 1.15),
            width: widths.road * 0.95,
          };
          break;
        case PIECE.ALLEY:
          piece = { type: PIECE.ALLEY, count: rng.int(5, 10), drift: rng.range(-0.03, 0.03) };
          break;
        default:
          piece = { type: PIECE.PLAZA, count: rng.int(3, 5) };
      }

      const planned = planPiece(piece);
      let bad = false;
      for (const s of planned) {
        if (overlaps(s.x, s.y, s.w)) {
          bad = true;
          break;
        }
      }
      if (bad) continue;

      commit(planned, piece);
      traveled += planned.length * step;
      lastType = piece.type;
      sinceHairpin = piece.type === PIECE.HAIRPIN ? 0 : sinceHairpin + 1;
      placed = true;
    }

    // Boxed in on every attempt: stop here rather than committing a piece that
    // would run through an earlier street. The contract just ends up shorter.
    if (!placed) break;
  }

  // Run-out so the finish line isn't mid-corner. Trimmed if it would collide.
  const runOut = planPiece({ type: PIECE.STRAIGHT, count: 6 });
  const clearRunOut = [];
  for (const s of runOut) {
    if (overlaps(s.x, s.y, s.w)) break;
    clearRunOut.push(s);
  }
  if (clearRunOut.length) commit(clearRunOut, { type: PIECE.STRAIGHT });

  return samples;
}

/* ------------------------------------------------------------------ */
/* Walls                                                               */
/* ------------------------------------------------------------------ */

function edgePoint(s, side) {
  const nx = -Math.sin(s.a);
  const ny = Math.cos(s.a);
  const half = s.w * 0.5;
  return { x: s.x + nx * half * side, y: s.y + ny * half * side };
}

/**
 * Collapse a polyline into as few straight runs as its shape allows.
 *
 * The test is perpendicular deviation from the candidate chord — every point
 * being skipped has to lie within `tol` of it. An earlier version compared the
 * *bearing from the anchor* instead, which let a road that curved away and
 * looped back merge 20+ points into one chord straight across the corridor.
 * `maxRun` caps how much any single chord can ever swallow.
 */
function simplify(points, tol = 5, maxRun = 12) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  let anchor = 0;
  for (let i = 2; i < points.length; i++) {
    const a = points[anchor];
    const b = points[i];
    let ok = i - anchor <= maxRun;
    if (ok) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      for (let k = anchor + 1; k < i; k++) {
        const p = points[k];
        if (Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len > tol) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      out.push(points[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** True when segments p1p2 and p3p4 properly cross. */
function segmentsCross(p1, p2, p3, p4) {
  const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
  if (Math.abs(d) < 1e-9) return false;
  const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
  const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
  return ua > 0.002 && ua < 0.998 && ub > 0.002 && ub < 0.998;
}

function computeEdges(track) {
  const left = track.samples.map((s) => edgePoint(s, -1));
  const right = track.samples.map((s) => edgePoint(s, 1));
  return {
    leftRaw: left,
    rightRaw: right,
    leftLine: simplify(left),
    rightLine: simplify(right),
  };
}

/**
 * A generated layout is only usable if no kerb ever crosses the driving line.
 * Cheap brute force (a few hundred × a few hundred segments) and it is the
 * guarantee that no seed can ever ship a road blocked by its own wall.
 */
function corridorIsClear(track, edges) {
  const centre = track.samples;
  for (const line of [edges.leftLine, edges.rightLine]) {
    for (let w = 0; w < line.length - 1; w++) {
      const a = line[w];
      const b = line[w + 1];
      for (let i = 0; i < centre.length - 1; i++) {
        if (segmentsCross(a, b, centre[i], centre[i + 1])) return false;
      }
    }
  }
  return true;
}

function buildWalls(track, world, edges) {
  const thickness = CONFIG.track.wallThickness;
  const bodies = [];
  const filter = {
    category: CATEGORY.WALL,
    mask: CATEGORY.LIMO | CATEGORY.CARGO_LOOSE | CATEGORY.TRAFFIC | CATEGORY.PROP,
  };

  for (const line of [edges.leftLine, edges.rightLine]) {
    for (let i = 0; i < line.length - 1; i++) {
      const p0 = line[i];
      const p1 = line[i + 1];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      bodies.push(
        Bodies.rectangle((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, len + thickness, thickness, {
          isStatic: true,
          angle: Math.atan2(dy, dx),
          friction: 0.35,
          restitution: 0.28,
          label: 'wall',
          collisionFilter: { ...filter },
        })
      );
    }
  }

  track.leftEdge = edges.leftRaw;
  track.rightEdge = edges.rightRaw;

  // Cap the far end so a mistimed finish doesn't launch into the void.
  const f = track.finish;
  bodies.push(
    Bodies.rectangle(
      f.x + Math.cos(f.a) * 120,
      f.y + Math.sin(f.a) * 120,
      thickness,
      track.sample(track.finish.index).w * 1.6,
      { isStatic: true, angle: f.a, label: 'wall', collisionFilter: { ...filter } }
    )
  );

  track.walls = bodies;
  Composite.add(world, bodies);
}

/* ------------------------------------------------------------------ */
/* Hazards, props, decoration                                          */
/* ------------------------------------------------------------------ */

function makeProp(kind, x, y, rng) {
  const spec = {
    cone: { r: 11, density: 0.0004, color: '#ff7a3d', restitution: 0.3 },
    barrel: { r: 19, density: 0.0011, color: '#e0483c', restitution: 0.45 },
    bin: { r: 22, density: 0.0009, color: '#3f8f5e', restitution: 0.3 },
    hydrant: { r: 13, density: 0.002, color: '#d94a4a', restitution: 0.2 },
  }[kind];
  const body = Bodies.circle(x, y, spec.r, {
    density: spec.density,
    frictionAir: 0.06,
    friction: 0.25,
    restitution: spec.restitution,
    label: 'prop',
    angle: rng.range(0, TAU),
    collisionFilter: {
      category: CATEGORY.PROP,
      mask: CATEGORY.WALL | CATEGORY.LIMO | CATEGORY.TRAFFIC | CATEGORY.PROP | CATEGORY.CARGO_LOOSE,
    },
  });
  return { kind, body, color: spec.color, r: spec.r };
}

function decorate(track, world, rng, difficulty) {
  const n = track.samples.length;
  const d = clamp(difficulty, 0, 1);

  // --- Checkpoints -------------------------------------------------
  for (let i = CONFIG.track.checkpointEvery; i < n - 8; i += CONFIG.track.checkpointEvery) {
    const s = track.sample(i);
    track.checkpoints.push({ index: i, x: s.x, y: s.y, a: s.a, w: s.w, taken: false });
  }

  // --- Hazard zones ------------------------------------------------
  let i = 12;
  while (i < n - 10) {
    const s = track.sample(i);
    const straightish = s.piece === PIECE.STRAIGHT || s.piece === PIECE.SWEEPER || s.piece === PIECE.PLAZA;
    const roll = rng.next();

    if (straightish && roll < 0.14 + d * 0.1) {
      // Launch ramp across the road.
      track.zones.push({
        type: 'ramp',
        x: s.x,
        y: s.y,
        a: s.a,
        w: s.w * 0.7,
        len: 62,
        r: Math.max(s.w * 0.36, 60),
        power: 0.9 + d * 0.5,
        index: i,
      });
      i += 6;
    } else if (roll < 0.3 + d * 0.12) {
      // Oil slick, offset to one side so there's a clean line through.
      const off = rng.range(-0.28, 0.28) * s.w;
      const nx = -Math.sin(s.a);
      const ny = Math.cos(s.a);
      track.zones.push({
        type: 'oil',
        x: s.x + nx * off,
        y: s.y + ny * off,
        r: rng.range(46, 78),
        grip: 0.22,
        index: i,
      });
      i += 4;
    } else if (roll < 0.4) {
      // Cobbles: shakes the limo and unsettles top-heavy cargo.
      track.zones.push({
        type: 'bump',
        x: s.x,
        y: s.y,
        r: Math.max(s.w * 0.38, 80),
        strength: rng.range(0.5, 1),
        a: s.a,
        index: i,
      });
      i += 5;
    } else if (straightish && roll < 0.47) {
      track.zones.push({
        type: 'boost',
        x: s.x,
        y: s.y,
        a: s.a,
        r: 52,
        power: 1,
        index: i,
      });
      i += 6;
    } else {
      i += rng.int(2, 5);
    }
  }

  // --- Knock-over props --------------------------------------------
  const propCount = Math.round(n * (0.35 + d * 0.35));
  for (let k = 0; k < propCount; k++) {
    const idx = rng.int(10, n - 8);
    const s = track.sample(idx);
    const nx = -Math.sin(s.a);
    const ny = Math.cos(s.a);
    const off = rng.range(0.18, 0.42) * s.w * (rng.bool() ? 1 : -1);
    const kind = rng.weighted([
      { w: 4, type: 'cone' },
      { w: 2, type: 'barrel' },
      { w: 1.4, type: 'bin' },
      { w: 1, type: 'hydrant' },
    ]).type;
    const prop = makeProp(kind, s.x + nx * off, s.y + ny * off, rng);
    track.props.push(prop);
  }
  Composite.add(world, track.props.map((p) => p.body));

  // --- Civilian traffic spawn plan ---------------------------------
  const trafficCount = Math.round(6 + d * 16 + n * 0.035);
  for (let k = 0; k < trafficCount; k++) {
    const idx = rng.int(14, n - 12);
    const lane = rng.bool(0.55) ? 1 : -1;
    track.trafficSpawns.push({
      index: idx,
      lane: lane * rng.range(0.14, 0.3),
      speed: rng.range(2.6, 5.4),
      oncoming: lane < 0 && rng.bool(0.45),
      kind: rng.pick(['sedan', 'taxi', 'van', 'bus', 'sports']),
    });
  }

  // --- Decorative city blocks --------------------------------------
  for (let idx = 4; idx < n - 4; idx += rng.int(3, 6)) {
    const s = track.sample(idx);
    const nx = -Math.sin(s.a);
    const ny = Math.cos(s.a);
    for (const side of [-1, 1]) {
      if (rng.bool(0.25)) continue;
      const off = s.w * 0.5 + rng.range(55, 190);
      const w = rng.range(70, 190);
      const h = rng.range(70, 210);
      track.buildings.push({
        x: s.x + nx * off * side,
        y: s.y + ny * off * side,
        w,
        h,
        a: s.a + rng.range(-0.15, 0.15),
        color: rng.pick(COLORS.building),
        rows: Math.max(2, Math.round(h / 34)),
        cols: Math.max(2, Math.round(w / 30)),
        lit: rng.next(),
        seed: rng.int(0, 9999),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export function generateTrack(world, { level = 1, seed = null, attempts = 14 } = {}) {
  const baseSeed = seed == null ? Math.floor(Math.random() * 1e9) : seed;
  const difficulty = clamp((level - 1) / 9, 0, 1);
  const targetLength = CONFIG.track.baseLength + CONFIG.track.lengthPerLevel * (level - 1);
  const minSamples = Math.max(24, Math.round((targetLength * 0.82) / CONFIG.track.step));

  // The city widens as the limo lengthens; alleys widen at half the rate so
  // they stay the pinch point they are meant to be.
  const grow = CONFIG.track.widthPerLevel * (level - 1);
  const widths = {
    road: CONFIG.track.roadWidth + grow,
    alley: CONFIG.track.alleyWidth + grow * 0.5,
    plaza: CONFIG.track.plazaWidth + grow,
  };

  let best = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const trySeed = (baseSeed + attempt * 7919) >>> 0;
    const rng = new Rng(trySeed);
    const samples = buildCenterline(rng, targetLength, difficulty, widths);
    const track = new Track(samples, { level, seed: trySeed });
    const edges = computeEdges(track);

    // Reject any layout whose own kerbs cross the driving line, and any that
    // boxed itself in so early the contract would be trivially short.
    const clear = corridorIsClear(track, edges);
    const longEnough = samples.length >= minSamples;
    if (clear && longEnough) {
      track.rng = rng;
      buildWalls(track, world, edges);
      decorate(track, world, rng, difficulty);
      track.attempts = attempt + 1;
      return track;
    }
    if (clear && (!best || samples.length > best.samples.length)) {
      best = { track, edges, rng, samples };
    }
  }

  // Nothing hit the length target: take the longest layout that was still
  // provably clear. A short contract is fine; a blocked one is not.
  const fallback = best || (() => {
    const rng = new Rng(baseSeed);
    const samples = buildCenterline(rng, targetLength * 0.5, difficulty * 0.5, widths);
    const track = new Track(samples, { level, seed: baseSeed });
    return { track, edges: computeEdges(track), rng, samples };
  })();

  buildWalls(fallback.track, world, fallback.edges);
  decorate(fallback.track, world, fallback.rng, difficulty);
  fallback.track.attempts = attempts;
  return fallback.track;
}
