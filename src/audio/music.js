import { clamp } from '../util.js';

/**
 * Synthesised music bed — a slow synthwave loop built from oscillators, so it
 * ships as zero bytes of audio data.
 *
 * A bass pulse on eighths, a sparse arpeggio, and a wide pad chord that
 * changes every bar. Notes are scheduled a bar ahead on the WebAudio clock
 * rather than from a timer, so it stays in time regardless of frame rate.
 */

// A minor → F major → C major → G major, the entire genre in four chords.
const PROGRESSION = [
  { root: 55.00, chord: [220.00, 261.63, 329.63] },  // Am
  { root: 43.65, chord: [174.61, 220.00, 261.63] },  // F
  { root: 65.41, chord: [196.00, 261.63, 329.63] },  // C
  { root: 49.00, chord: [196.00, 246.94, 293.66] },  // G
];

const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

export class Music {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.started = false;
    this._bar = 0;
    this._nextBarTime = 0;
    this._timer = null;
    this._intensity = 0;      // 0..1, raised while driving fast
    this._volume = 0.8;
  }

  /** Share the engine's AudioContext so there's only one to unlock. */
  attach(ctx, destination) {
    if (!ctx || this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination ?? ctx.destination);

    // Gentle low-pass keeps the synth behind the engine rather than on top.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1800;
    this.filter.Q.value = 0.6;
    this.filter.connect(this.out);

    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = BEAT * 0.75;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.32;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.28;
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.filter);
  }

  start() {
    if (!this.ctx || this.started) return;
    this.started = true;
    this._nextBarTime = this.ctx.currentTime + 0.15;
    this._bar = 0;
    this._tick();
    this._timer = setInterval(() => this._tick(), 250);
    this.setEnabled(this.enabled);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.started = false;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    this.out.gain.setTargetAtTime(on ? 0.22 * this._volume : 0, this.ctx.currentTime, 0.4);
  }

  setVolume(v) {
    this._volume = clamp(v, 0, 1);
    if (this.ctx && this.enabled) {
      this.out.gain.setTargetAtTime(0.22 * this._volume, this.ctx.currentTime, 0.2);
    }
  }

  /** Opens the filter as the player drives faster — subtle but effective. */
  setIntensity(v) {
    this._intensity = clamp(v, 0, 1);
    if (!this.ctx) return;
    this.filter.frequency.setTargetAtTime(
      1200 + this._intensity * 3200, this.ctx.currentTime, 0.5,
    );
  }

  _voice(type, freq, t, dur, peak, dest) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    o.connect(g);
    g.connect(dest ?? this.filter);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Schedule any bar whose start time is within the next second. */
  _tick() {
    if (!this.ctx || this.ctx.state !== 'running') return;

    while (this._nextBarTime < this.ctx.currentTime + 1.0) {
      const t0 = this._nextBarTime;
      const step = PROGRESSION[this._bar % PROGRESSION.length];

      // Bass on every eighth note.
      for (let i = 0; i < 8; i++) {
        const t = t0 + i * (BEAT / 2);
        const oct = i % 4 === 3 ? 2 : 1;
        this._voice('sawtooth', step.root * oct, t, 0.26, 0.20);
      }

      // Pad: the chord held across the bar.
      for (const f of step.chord) {
        this._voice('triangle', f, t0, BAR * 0.95, 0.055);
        this._voice('triangle', f * 1.005, t0, BAR * 0.95, 0.04);  // detune
      }

      // Arpeggio, through the delay, only once the player is moving.
      if (this._intensity > 0.12) {
        for (let i = 0; i < 4; i++) {
          const t = t0 + BEAT * i + BEAT * 0.5;
          const f = step.chord[(i + this._bar) % step.chord.length] * 2;
          this._voice('square', f, t, 0.18, 0.035 * this._intensity, this.delay);
        }
      }

      this._nextBarTime += BAR;
      this._bar++;
    }
  }
}
