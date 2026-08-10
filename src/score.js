import { CONFIG } from './config.js';
import { clamp } from './util.js';

/**
 * Delivery scoring: time left + cargo integrity + how sideways you got.
 */
export function computeScore({
  delivered,
  timeRemaining,
  timeLimit,
  cargoIntact,
  cargoTotal,
  maxDriftAngle,
  driftScore,
  level,
  payMultiplier,
  wallHits,
}) {
  const integrity = cargoTotal ? cargoIntact / cargoTotal : 1;
  const clean = delivered && cargoIntact === cargoTotal;

  const lines = [];
  let total = 0;

  const add = (label, value, detail = '') => {
    const v = Math.round(value);
    if (v === 0 && !detail) return;
    lines.push({ label, value: v, detail });
    total += v;
  };

  if (delivered) add('Delivery', CONFIG.score.deliveryBase, '');
  add(
    'Time left',
    Math.max(0, timeRemaining) * CONFIG.score.perSecondRemaining,
    `${Math.max(0, timeRemaining).toFixed(1)}s`
  );
  add(
    'Cargo intact',
    cargoIntact * CONFIG.score.cargoIntact,
    `${cargoIntact}/${cargoTotal}`
  );
  add('Drift style', driftScore, '');
  add(
    'Max drift angle',
    clamp(maxDriftAngle / (Math.PI / 2), 0, 1) * CONFIG.score.maxDriftBonus,
    `${Math.round((maxDriftAngle * 180) / Math.PI)}°`
  );
  if (clean) add('Spotless delivery', CONFIG.score.cleanDeliveryBonus, '');
  if (delivered && wallHits === 0) add('No paint traded', 400, '');

  const mult = delivered ? payMultiplier : payMultiplier * 0.25;
  const scaled = Math.round(total * mult);
  const cash = Math.max(0, Math.round((scaled / CONFIG.score.cashDivisor) * (clean ? 1.25 : 1)));

  return {
    lines,
    subtotal: total,
    multiplier: mult,
    total: scaled,
    cash,
    integrity,
    clean,
    stars: delivered ? (clean ? 3 : integrity >= 0.6 ? 2 : 1) : 0,
  };
}
