import { clamp, lerp } from './util.js';

/**
 * Fully procedural WebAudio kit — no audio files, so the repo stays asset-free
 * and the game loads instantly on Poki.
 *
 * Public surface is a set of named "sound triggers" the game code calls:
 *   Sound.play('crash' | 'cargoDrop' | 'checkpoint' | 'boost' | 'cash' | ...)
 *   Sound.setEngine(speed01, boosting)
 *   Sound.setScreech(intensity01)
 */
class SoundKit {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.muted = false;
    this.adMuted = false;
    this.started = false;
    this.hornId = 'stock';
    this._engine = null;
    this._screech = null;
    this._noiseBuffer = null;
  }

  /** Must be triggered from a user gesture on most browsers. */
  start() {
    if (this.started) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      this.enabled = false;
      return;
    }
    try {
      this.ctx = new Ctor();
    } catch (err) {
      this.enabled = false;
      return;
    }
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this._targetVolume();
    this.master.connect(this.ctx.destination);

    // Gentle limiter so stacked explosions don't clip.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 8;
    this.comp.connect(this.master);

    this._buildNoise();
    this._buildEngine();
    this._buildScreech();
    this.resume();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _targetVolume() {
    return this.muted || this.adMuted ? 0 : 0.85;
  }

  _applyVolume() {
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this._targetVolume(), t, 0.05);
  }

  setMuted(muted) {
    this.muted = muted;
    this._applyVolume();
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Poki requires silence while an ad is on screen. */
  setAdMuted(muted) {
    this.adMuted = muted;
    this._applyVolume();
  }

  _buildNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buf;
  }

  _noiseSource(loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = loop;
    return src;
  }

  _buildEngine() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.comp);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;
    filter.connect(gain);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 60;

    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = 30;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;

    osc.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    osc.start();
    sub.start();

    this._engine = { osc, sub, gain, filter, level: 0 };
  }

  _buildScreech() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.comp);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 6;
    bp.connect(gain);

    const src = this._noiseSource(true);
    src.connect(bp);
    src.start();

    this._screech = { src, bp, gain };
  }

  /** speed01: 0..1 of top speed. */
  setEngine(speed01, boosting, running = true) {
    if (!this.started || !this._engine) return;
    const e = this._engine;
    const t = this.ctx.currentTime;
    const s = clamp(speed01, 0, 1);
    const base = 52 + s * 165 + (boosting ? 45 : 0);
    e.osc.frequency.setTargetAtTime(base, t, 0.07);
    e.sub.frequency.setTargetAtTime(base * 0.5, t, 0.07);
    e.filter.frequency.setTargetAtTime(500 + s * 2300 + (boosting ? 900 : 0), t, 0.08);
    const vol = running ? lerp(0.045, 0.115, s) + (boosting ? 0.05 : 0) : 0;
    e.gain.gain.setTargetAtTime(vol, t, 0.09);
  }

  setScreech(intensity01) {
    if (!this.started || !this._screech) return;
    const t = this.ctx.currentTime;
    const i = clamp(intensity01, 0, 1);
    this._screech.gain.gain.setTargetAtTime(i * 0.12, t, 0.05);
    this._screech.bp.frequency.setTargetAtTime(1500 + i * 1900, t, 0.08);
  }

  silence() {
    this.setEngine(0, false, false);
    this.setScreech(0);
  }

  _tone({ freq = 440, type = 'sine', dur = 0.2, gain = 0.2, slideTo = null, delay = 0 }) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.comp);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  _burst({ dur = 0.3, gain = 0.3, freq = 800, type = 'lowpass', q = 1, delay = 0 }) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = this._noiseSource(false);
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.25), t + dur);
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.comp);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  setHorn(id) {
    this.hornId = id || 'stock';
  }

  _horn() {
    const id = this.hornId;
    if (id === 'airhorn') {
      this._tone({ freq: 220, type: 'square', dur: 0.55, gain: 0.16 });
      this._tone({ freq: 277, type: 'square', dur: 0.55, gain: 0.13 });
      this._tone({ freq: 110, type: 'sawtooth', dur: 0.6, gain: 0.1 });
    } else if (id === 'trumpet') {
      const notes = [392, 523, 659, 784];
      notes.forEach((f, i) => this._tone({ freq: f, type: 'sawtooth', dur: 0.16, gain: 0.14, delay: i * 0.11 }));
    } else if (id === 'duck') {
      this._tone({ freq: 700, type: 'square', dur: 0.13, gain: 0.15, slideTo: 380 });
      this._tone({ freq: 660, type: 'square', dur: 0.13, gain: 0.12, slideTo: 340, delay: 0.17 });
    } else if (id === 'clown') {
      [523, 587, 659, 523].forEach((f, i) =>
        this._tone({ freq: f, type: 'triangle', dur: 0.14, gain: 0.16, delay: i * 0.1 })
      );
    } else if (id === 'moo') {
      this._tone({ freq: 160, type: 'sawtooth', dur: 0.7, gain: 0.16, slideTo: 95 });
    } else {
      this._tone({ freq: 330, type: 'square', dur: 0.3, gain: 0.13 });
      this._tone({ freq: 247, type: 'square', dur: 0.3, gain: 0.1 });
    }
  }

  play(name, intensity = 1) {
    if (!this.started || !this.enabled) return;
    const i = clamp(intensity, 0, 1);
    switch (name) {
      case 'crash':
        this._burst({ dur: 0.35, gain: 0.16 + i * 0.22, freq: 1400, q: 0.7 });
        this._tone({ freq: 90, type: 'square', dur: 0.22, gain: 0.14 * i, slideTo: 42 });
        break;
      case 'bump':
        this._burst({ dur: 0.12, gain: 0.06 + i * 0.08, freq: 500 });
        break;
      case 'cargoDrop':
        this._tone({ freq: 320, type: 'triangle', dur: 0.4, gain: 0.2, slideTo: 70 });
        this._burst({ dur: 0.5, gain: 0.2, freq: 900, delay: 0.03 });
        break;
      case 'cargoWobble':
        this._tone({ freq: 180 + i * 120, type: 'sine', dur: 0.18, gain: 0.05 + i * 0.05 });
        break;
      case 'checkpoint':
        this._tone({ freq: 660, type: 'triangle', dur: 0.15, gain: 0.14 });
        this._tone({ freq: 990, type: 'triangle', dur: 0.2, gain: 0.12, delay: 0.09 });
        break;
      case 'boost':
        this._burst({ dur: 0.45, gain: 0.16, freq: 2600, type: 'bandpass', q: 2 });
        this._tone({ freq: 180, type: 'sawtooth', dur: 0.35, gain: 0.1, slideTo: 620 });
        break;
      case 'ramp':
        this._tone({ freq: 300, type: 'sine', dur: 0.35, gain: 0.14, slideTo: 900 });
        break;
      case 'land':
        this._burst({ dur: 0.25, gain: 0.22, freq: 700 });
        this._tone({ freq: 70, type: 'square', dur: 0.18, gain: 0.16, slideTo: 40 });
        break;
      case 'oil':
        this._burst({ dur: 0.5, gain: 0.09, freq: 600, type: 'bandpass', q: 1.5 });
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, k) =>
          this._tone({ freq: f, type: 'triangle', dur: 0.28, gain: 0.16, delay: k * 0.12 })
        );
        break;
      case 'fail':
        this._tone({ freq: 300, type: 'sawtooth', dur: 0.7, gain: 0.15, slideTo: 90 });
        break;
      case 'cash':
        [880, 1320].forEach((f, k) => this._tone({ freq: f, type: 'square', dur: 0.12, gain: 0.1, delay: k * 0.07 }));
        break;
      case 'ui':
        this._tone({ freq: 520, type: 'square', dur: 0.06, gain: 0.07 });
        break;
      case 'buy':
        [660, 880, 1100].forEach((f, k) => this._tone({ freq: f, type: 'triangle', dur: 0.15, gain: 0.12, delay: k * 0.08 }));
        break;
      case 'deny':
        this._tone({ freq: 180, type: 'square', dur: 0.18, gain: 0.1 });
        break;
      case 'horn':
        this._horn();
        break;
      default:
        break;
    }
  }
}

export const Sound = new SoundKit();
