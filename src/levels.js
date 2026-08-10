import { CONFIG } from './config.js';
import { Rng, clamp } from './util.js';

/**
 * Level curve: every level bolts another segment onto the limo and another
 * ridiculous item onto the roof. Levels 1-10 are hand-tuned; beyond that the
 * game keeps generating "overtime" contracts with random loads.
 */
const HAND_TUNED = [
  { name: 'The Wedding Run', segments: 1, cargo: ['cake'] },
  { name: 'Duck Duty', segments: 2, cargo: ['cake', 'ducks'] },
  { name: 'Zoo Transfer', segments: 3, cargo: ['cake', 'giraffe', 'pool'] },
  { name: 'Pool Party Express', segments: 4, cargo: ['pool', 'giraffe', 'champagne', 'hotTub'] },
  { name: 'Recital Rush', segments: 5, cargo: ['piano', 'chandelier', 'cake', 'iceSwan', 'ducks'] },
  {
    name: 'Aquarium Emergency',
    segments: 6,
    cargo: ['fishTank', 'pool', 'statue', 'champagne', 'cactus', 'portaloo'],
  },
  {
    name: 'Super-Limo Debut',
    segments: 7,
    cargo: ['bouncy', 'speakers', 'giraffe', 'hotTub', 'chandelier', 'cake', 'ducks'],
  },
  {
    name: 'The Gala Gauntlet',
    segments: 8,
    cargo: ['bouncy', 'speakers', 'iceSwan', 'champagne', 'statue', 'piano', 'fishTank', 'cake'],
  },
  {
    name: 'Satellite Delivery',
    segments: 9,
    cargo: ['satellite', 'bouncy', 'speakers', 'pool', 'giraffe', 'hotTub', 'chandelier', 'cactus', 'ducks'],
  },
  {
    name: 'Maximum Cargo',
    segments: 10,
    cargo: [
      'satellite', 'bouncy', 'speakers', 'pool', 'giraffe',
      'hotTub', 'piano', 'fishTank', 'champagne', 'cake',
    ],
  },
];

const OVERTIME_POOL = [
  'cake', 'ducks', 'giraffe', 'pool', 'piano', 'chandelier', 'iceSwan', 'hotTub',
  'portaloo', 'champagne', 'fishTank', 'statue', 'cactus', 'satellite', 'bouncy', 'speakers',
];

export const MAX_SEGMENTS = 10;

export function getLevel(n) {
  const level = Math.max(1, Math.floor(n));
  const seed = 1337 + level * 7919;
  let name;
  let segments;
  let cargo;

  if (level <= HAND_TUNED.length) {
    const def = HAND_TUNED[level - 1];
    name = def.name;
    segments = def.segments;
    cargo = def.cargo.slice();
  } else {
    const rng = new Rng(seed);
    const over = level - HAND_TUNED.length;
    name = `Overtime Shift ${over}`;
    segments = MAX_SEGMENTS;
    cargo = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) cargo.push(rng.pick(OVERTIME_POOL));
  }

  const trackLength = CONFIG.track.baseLength + CONFIG.track.lengthPerLevel * (level - 1);
  // Assume the player averages ~65% of top speed through the city.
  const cruise = CONFIG.limo.maxSpeed * 0.65 * 60;
  const timeLimit = Math.round((trackLength / cruise) * 1.9 + 10);

  return {
    level,
    name,
    segments,
    cargo,
    seed,
    timeLimit,
    difficulty: clamp((level - 1) / 9, 0, 1),
    payMultiplier: 1 + (level - 1) * 0.15,
  };
}

export function levelCount() {
  return HAND_TUNED.length;
}
