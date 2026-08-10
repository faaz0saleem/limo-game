import { CONFIG } from './config.js';
import { clamp, lerp } from './util.js';

/**
 * Chase camera.
 *
 * Zoom pulls out automatically as the limo gets longer (so a 9-segment
 * super-limo always fits on screen) and a little more with speed. Trauma-based
 * shake is used for crashes and cargo losses.
 */
export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.targetZoom = 1;
    this.trauma = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.viewW = 1280;
    this.viewH = 720;
    this.zoomBias = 1;
  }

  resize(w, h) {
    this.viewW = w;
    this.viewH = h;
  }

  snapTo(x, y) {
    this.x = x;
    this.y = y;
  }

  addTrauma(amount) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  /** Zoom that keeps a limo of `worldLength` comfortably framed. */
  fitZoom(worldLength) {
    const minSide = Math.min(this.viewW, this.viewH);
    const maxSide = Math.max(this.viewW, this.viewH);
    // Two constraints: the whole limo has to fit along the long axis, and
    // enough road has to be visible across the short axis to read a corner.
    const need = worldLength * 1.15 + 380;
    const byLength = maxSide / need;
    const byRoad = minSide / (CONFIG.track.roadWidth * 1.5);
    return clamp(Math.min(byLength, byRoad), CONFIG.camera.minZoom, CONFIG.camera.baseZoom);
  }

  update(dt, target) {
    const c = CONFIG.camera;
    if (target) {
      const lead = clamp(target.speed / 10, 0, 1);
      const tx = target.x + (target.vx || 0) * c.lookAhead * lead;
      const ty = target.y + (target.vy || 0) * c.lookAhead * lead;
      const k = 1 - Math.pow(1 - c.follow, dt * 60);
      this.x = lerp(this.x, tx, k);
      this.y = lerp(this.y, ty, k);

      const speedZoom = 1 - clamp(target.speed / 16, 0, 1) * 0.13;
      this.targetZoom = this.fitZoom(target.length || 200) * speedZoom * this.zoomBias;
    }

    const zk = 1 - Math.pow(1 - CONFIG.camera.zoomLerp, dt * 60);
    this.zoom = lerp(this.zoom, this.targetZoom, zk);

    this.trauma = Math.max(0, this.trauma - CONFIG.camera.shakeDecay * dt);
    const shake = this.trauma * this.trauma;
    const amp = shake * CONFIG.camera.maxShake;
    this.shakeX = (Math.random() * 2 - 1) * amp;
    this.shakeY = (Math.random() * 2 - 1) * amp;
  }

  /** Set up the canvas transform for world-space drawing. */
  apply(ctx) {
    ctx.translate(this.viewW / 2 + this.shakeX, this.viewH / 2 + this.shakeY);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  /** Visible world rect, padded, for culling. */
  viewBounds(pad = 200) {
    const hw = this.viewW / (2 * this.zoom) + pad;
    const hh = this.viewH / (2 * this.zoom) + pad;
    return { minX: this.x - hw, minY: this.y - hh, maxX: this.x + hw, maxY: this.y + hh };
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.x) * this.zoom + this.viewW / 2 + this.shakeX,
      y: (y - this.y) * this.zoom + this.viewH / 2 + this.shakeY,
    };
  }
}
