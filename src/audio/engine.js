import { clamp, lerp } from '../util.js';

/**
 * All sound is synthesised — the repo ships no audio files.
 *
 * Engine: three detuned sawtooth oscillators through a resonant low-pass,
 * their frequency driven by rpm. Tyres: filtered white noise. Wind: a second
 * noise bed opened up by speed. Impacts: a short noise burst with a pitch
 * envelope.
 */
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.volume = 0.8;
  }

  /** Master volume, kept separate from mute so the two compose cleanly. */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v ?? 0.8));
    if (this.ready) {
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : 0.5 * this.volume, this.ctx.currentTime, 0.1,
      );
    }
  }

  /** Must be called from a user gesture — browsers block audio otherwise. */
  start() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    this.ctx = ctx;
    // Safari and some in-app browsers hand back a suspended context even when
    // it was created inside a user gesture.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // Gentle limiter so bloomy engine harmonics don't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    comp.connect(this.master);
    this.bus = comp;

    /* ------------------------------------------------------------ engine */
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 5.5;

    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.bus);

    this.oscs = [];
    // A big V8 idles around 30 Hz of firing frequency; the harmonics above
    // it are what you actually hear.
    for (const [mult, detune, gain, type] of [
      [1.0, 0, 0.5, 'sawtooth'],
      [2.0, 7, 0.32, 'sawtooth'],
      [0.5, -5, 0.42, 'square'],
      [3.01, 12, 0.14, 'sawtooth'],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engineGain);
      o.start();
      this.oscs.push({ osc: o, mult });
    }

    /* ------------------------------------------------- noise beds (tyres) */
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;

    const mkNoise = (type, freq, Q, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = Q;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(f);
      f.connect(g);
      g.connect(this.bus);
      src.start();
      return { src, filter: f, gain: g };
    };

    this.screech = mkNoise('bandpass', 1750, 7.5, 0);
    this.wind = mkNoise('lowpass', 520, 0.9, 0);
    this.rumble = mkNoise('lowpass', 150, 1.2, 0);

    this.ready = true;

    // Fade the master in so the engine doesn't thump on start.
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5 * this.volume, ctx.currentTime, 0.35);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ready) {
      this.master.gain.setTargetAtTime(
        m ? 0 : 0.5 * this.volume, this.ctx.currentTime, 0.08,
      );
    }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  suspend() {
    if (this.ready && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ready && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** Short noise burst with a falling pitch — collisions and curb strikes. */
  impact(strength) {
    if (!this.ready || this.muted || strength < 0.05) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(600 + strength * 900, now);
    f.frequency.exponentialRampToValueAtTime(90, now + 0.28);

    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(strength, 0, 1) * 0.75, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.34);

    src.connect(f);
    f.connect(g);
    g.connect(this.bus);
    src.start(now);
    src.stop(now + 0.36);
  }

  /** Rising two-tone chime for a completed fare. */
  chime(up = true) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = up ? [660, 880, 1320] : [440, 330];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t = now + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.42);
      o.connect(g);
      g.connect(this.bus);
      o.start(t);
      o.stop(t + 0.45);
    });
  }

  /**
   * @param {object} s  { rpm, speed01, wheelSlip, throttle, boosting, drifting }
   */
  update(s, dt) {
    if (!this.ready || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const smooth = 0.05;

    // --- engine pitch: idle ~34 Hz fundamental, redline ~190 Hz.
    const base = lerp(34, 190, clamp(s.rpm, 0, 1));
    for (const { osc, mult } of this.oscs) {
      osc.frequency.setTargetAtTime(base * mult, now, smooth);
    }

    // Opening the filter with throttle is what makes it sound like load
    // rather than a synth pad.
    const cutoff = lerp(420, 3400, clamp(s.rpm * 0.65 + s.throttle * 0.5, 0, 1));
    this.engineFilter.frequency.setTargetAtTime(cutoff, now, smooth);
    this.engineFilter.Q.setTargetAtTime(s.boosting ? 9 : 5.5, now, smooth);

    const engineVol = lerp(0.12, 0.34, clamp(s.rpm, 0, 1)) * (s.boosting ? 1.35 : 1);
    this.engineGain.gain.setTargetAtTime(engineVol, now, smooth);

    // --- tyres.
    const slip = clamp(s.wheelSlip, 0, 1);
    const screechVol = slip > 0.25 ? (slip - 0.25) * 0.5 * clamp(s.speed01 * 2.4, 0, 1) : 0;
    this.screech.gain.gain.setTargetAtTime(screechVol, now, 0.06);
    this.screech.filter.frequency.setTargetAtTime(1450 + slip * 1400, now, 0.08);

    // --- road roar + wind.
    this.rumble.gain.gain.setTargetAtTime(clamp(s.speed01, 0, 1) * 0.16, now, 0.12);
    this.wind.gain.gain.setTargetAtTime(Math.pow(clamp(s.speed01, 0, 1), 1.7) * 0.2, now, 0.12);
    this.wind.filter.frequency.setTargetAtTime(380 + s.speed01 * 1500, now, 0.12);
  }
}
