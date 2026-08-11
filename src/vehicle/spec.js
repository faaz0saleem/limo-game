/* Vehicle dimensions and paint options.
 *
 * Kept free of any three.js import so the physics model can be loaded (and
 * unit-tested) without a renderer, a DOM, or a GPU. */

export const LIMO = {
  length: 9.6,
  width: 2.30,
  wheelBase: 6.4,
  trackWidth: 1.98,
  wheelRadius: 0.50,
  frontAxle: 3.2,
  rearAxle: -3.2,
};

export const PAINT_JOBS = {
  midnight: { paint: 0x0b0d14, accent: 0xffcb5c, name: 'Midnight Black' },
  champagne: { paint: 0xc9a86a, accent: 0xfff0c0, name: 'Champagne Gold' },
  bordeaux: { paint: 0x4a0d1c, accent: 0xff7fa5, name: 'Bordeaux' },
  pearl: { paint: 0xe8e6ea, accent: 0x8fd4ff, name: 'Pearl White' },
};
