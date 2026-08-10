/**
 * Central tuning table for Limo Drift: Maximum Cargo.
 * Everything gameplay-feel related lives here so it can be tweaked in one place.
 */

export const CATEGORY = {
  WALL: 0x0001,
  LIMO: 0x0002,
  CARGO_ATTACHED: 0x0004,
  CARGO_LOOSE: 0x0008,
  TRAFFIC: 0x0010,
  PROP: 0x0020,
};

export const CONFIG = {
  physics: {
    fixedDt: 1000 / 60,
    maxSubSteps: 5,
  },

  limo: {
    // A segment is one "car length" of the stretch limo.
    segLength: 66,
    segWidth: 28,
    segGap: 7,
    density: 0.0016,
    // Forward drive. Speeds/accelerations are in world units per 1/60s step.
    engineAccel: 0.185,
    boostAccel: 0.34,
    trailerDrive: 0.8, // trailing segments are driven too, slightly softer
    maxSpeed: 9.4,
    boostMaxSpeed: 13.2,
    rollingResistance: 0.011,
    brakeResistance: 0.055,
    // Steering
    maxSteerRate: 0.032,
    steerResponse: 0.3,
    steerFullSpeed: 4.0,
    steerInputRamp: 7.0,
    // Grip / drift model. `grip` is the fraction of lateral velocity scrubbed
    // off per step. Past `slipLimit` the tires saturate, grip collapses and the
    // segment slides — that is the drift.
    cabGrip: 0.62,
    trailerGrip: 0.5,
    tailGripFalloff: 0.028, // grip loss per segment index (whippier tail)
    slipLimit: 1.5,
    gripFalloff: 1.3,
    handbrakeGrip: 0.13,
    angularDamping: 0.94,
    // Joint between segments
    jointStiffness: 0.92,
    jointDamping: 0.12,
    maxJointAngle: 0.95, // radians before the soft jackknife limiter kicks in
    jointLimitStrength: 0.32,
    // Boost
    boostCapacity: 1.65,
    boostRefill: 0.28,
    boostMinToFire: 0.28,
    // Feel
    driftSmokeSlip: 1.35,
    bumpImpulse: 0.00055,
  },

  cargo: {
    // Attached cargo hangs off a soft, breakable constraint. Cornering drags it
    // sideways and the strap's stretch IS the tilt meter.
    stiffness: 0.05,
    damping: 0.06,
    // Cargo is deliberately light so it never robs the limo of acceleration;
    // its *apparent* inertia comes from `inertiaBoost` instead, which is a pure
    // velocity effect and so costs the limo nothing.
    densityScale: 0.16,
    frictionAir: 0.02,
    inertiaBoost: 5.5, // amplifies apparent load transfer (per-item topHeavy scales this)
    // Cargo is meant to be threatened by *cornering*, not by flooring the
    // throttle, so longitudinal load transfer counts for much less.
    longitudinalWeight: 0.32,
    // Smoothing + a ceiling on the acceleration fed into the model. Without
    // these, one-step spikes (the launch, a wall impact) would exceed anything
    // cornering can produce and instantly strip the roof.
    accelSmoothing: 0.35,
    maxAccelInput: 0.34,
    breakDistance: 26, // world units of strap stretch before it snaps
    warnRatio: 0.55,
    visualLean: 1.6, // render exaggeration of the physical lean
    looseFriction: 0.2,
    looseAirFriction: 0.05,
    flingBoost: 1.25,
    impactShake: 0.6,
  },

  track: {
    step: 50, // distance between centerline samples
    baseLength: 4200,
    lengthPerLevel: 780,
    // The road has to swallow a limo that can grow past 700 units long, so it
    // is wide by racing-game standards. Alleys are where it gets scary.
    roadWidth: 400,
    alleyWidth: 240,
    plazaWidth: 620,
    wallThickness: 26,
    checkpointEvery: 26, // samples
    checkpointBonus: 6.5, // seconds
  },

  camera: {
    baseZoom: 1.0,
    minZoom: 0.42,
    lookAhead: 15,
    follow: 0.115,
    zoomLerp: 0.045,
    shakeDecay: 1.9,
    maxShake: 34,
  },

  score: {
    deliveryBase: 1000,
    perSecondRemaining: 45,
    cargoIntact: 650,
    driftRate: 2.4, // points per (rad * speed * second)
    maxDriftBonus: 900,
    cleanDeliveryBonus: 750,
    cashDivisor: 22,
  },
};

export const COLORS = {
  asphalt: '#2c2f38',
  asphaltAlt: '#31343d',
  lane: '#f2d675',
  curb: '#5a6072',
  ground: '#171922',
  building: ['#242836', '#2a2f40', '#1e2230', '#2f3548', '#262b3a'],
  limoBody: '#12141c',
  limoTrim: '#e8c66a',
  glass: '#4fd2e8',
  danger: '#ff5a5a',
  good: '#5affa0',
  warn: '#ffc24d',
};
