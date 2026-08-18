/**
 * The garage: cars you can buy with fare money.
 *
 * `handling` multiplies the base physics constants (see DEFAULT_HANDLING in
 * physics.js), so a car is described entirely by a handful of numbers:
 *
 *   grip   cornering force at both axles
 *   power  engine force and top speed
 *   brake  braking force
 *   drift  how loose the rear goes on the handbrake — higher slides more
 *   mass   yaw inertia; lower turns in faster, higher feels planted
 */

export const CARS = [
  {
    id: 'classic',
    name: 'Classic Stretch',
    blurb: 'The company car. Long, heavy, and honest about it.',
    price: 0,
    paint: 'midnight',
    handling: { grip: 1.00, power: 1.00, brake: 1.00, drift: 1.00, mass: 1.00 },
  },
  {
    id: 'champagne',
    name: 'Champagne Royale',
    blurb: 'Gold leaf and a bigger engine. Corners like it means it.',
    price: 6500,
    paint: 'champagne',
    handling: { grip: 1.14, power: 1.16, brake: 1.10, drift: 1.05, mass: 0.94 },
  },
  {
    id: 'bordeaux',
    name: 'Bordeaux Slider',
    blurb: 'Built for the sideways stuff. Loose rear, endless smoke.',
    price: 18000,
    paint: 'bordeaux',
    handling: { grip: 1.10, power: 1.24, brake: 1.12, drift: 1.55, mass: 0.86 },
  },
  {
    id: 'pearl',
    name: 'Pearl Phantom',
    blurb: 'The one the mayor asks for. Fast everywhere, forgiving.',
    price: 42000,
    paint: 'pearl',
    handling: { grip: 1.30, power: 1.34, brake: 1.26, drift: 1.20, mass: 0.82 },
  },
];

export const carById = (id) => CARS.find((c) => c.id === id) ?? CARS[0];

/**
 * How many rewarded ads unlock a car outright, for players who would rather
 * watch than grind.
 *
 * Scaled off the price so the cheap car is one ad and the flagship is a real
 * commitment — a flat count would make the Pearl Phantom, at six times the
 * price of the Champagne, exactly as easy to get.
 */
export function adsToUnlock(car) {
  if (car.price <= 0) return 0;
  return Math.min(5, 1 + Math.round(car.price / 12000));
}

/** 0..1 bars for the shop cards. */
export function statBars(car) {
  const h = car.handling;
  return [
    ['GRIP', (h.grip - 0.9) / 0.5],
    ['POWER', (h.power - 0.9) / 0.5],
    ['BRAKES', (h.brake - 0.9) / 0.45],
    ['DRIFT', (h.drift - 0.9) / 0.75],
  ].map(([k, v]) => [k, Math.max(0.08, Math.min(1, v))]);
}
