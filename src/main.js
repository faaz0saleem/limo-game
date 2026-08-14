import * as THREE from 'three';
import { Stage, QUALITY } from './render/renderer.js';
import { buildNightEnvironment, buildFog } from './render/environment.js';
import { makeSkyDome } from './render/post.js';
import { SkidMarks, ParticleField, burstSparks } from './render/effects.js';
import { City, HALF_CITY } from './world/city.js';
import { Traffic } from './world/traffic.js';
import { Pedestrians } from './world/pedestrians.js';
import { createLimo, LIMO, PAINT_JOBS } from './vehicle/limo.js';
import { Vehicle } from './vehicle/physics.js';
import { ChaseCamera } from './game/chaseCamera.js';
import { Input } from './game/input.js';
import { Gameplay } from './game/gameplay.js';
import { HUD } from './ui/hud.js';
import { EngineAudio } from './audio/engine.js';
import { portal } from './portal.js';
import { save } from './game/save.js';
import { Music } from './audio/music.js';
import { Menus } from './ui/menus.js';
import { Navigator } from './render/navigation.js';
import { DayNight } from './world/daynight.js';
import { carById } from './game/garage.js';
import { clamp, damp, lerp } from './util.js';

/* ---------------------------------------------------------------- boot */

let menus;                      // created in boot(), before anything else
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function progress(pct, text) {
  menus.setProgress(pct, text);
  portal.loadingProgress(pct / 100);
}

/* --------------------------------------------------------------- game */

class Game {
  constructor(stage) {
    this.stage = stage;
    this.scene = stage.scene;
    this.paused = false;
    this.running = false;
    this.elapsed = 0;
    this.smokeAcc = 0;
    this.exhaustAcc = 0;
    this.music = new Music();
    this._adMuted = false;
  }

  async build() {
    const { scene } = this;

    progress(14, 'painting the sky');
    await nextFrame();
    const { envMap, background } = buildNightEnvironment(this.stage.renderer);
    this.envMap = envMap;
    scene.environment = envMap;
    scene.background = background;
    scene.backgroundIntensity = 0.55;
    buildFog(scene, { near: 70, far: this.stage.settings.drawDistance, color: 0x0b1020 });
    this.sky = makeSkyDome(2400);
    scene.add(this.sky);
    // Twenty minutes of daylight, then twenty of night.
    this.dayNight = new DayNight({ cycleMinutes: 40, startAt: 0.02 });

    progress(28, 'pouring concrete');
    await nextFrame();
    this._buildLights();

    progress(42, 'raising towers');
    await nextFrame();
    this.city = new City(scene, { envMap, settings: this.stage.settings });
    this.facadeMaterials = this.city.facadeMaterials ?? [];

    progress(62, 'wiring the neon');
    await nextFrame();
    this.traffic = new Traffic(scene, {
      count: this.stage.quality === 'low' ? 14 : this.stage.quality === 'ultra' ? 38 : 26,
      envMap,
    });

    this.pedestrians = new Pedestrians(scene, {
      count: this.stage.quality === 'low' ? 45 : this.stage.quality === 'ultra' ? 130 : 90,
      envMap,
    });

    progress(74, 'polishing the chrome');
    await nextFrame();
    this.car = carById(save.load().car);
    this.limo = createLimo(this.car.paint);
    this.limo.setEnvironment(envMap);
    scene.add(this.limo.root);

    // Start on the street just south of the central plaza, pointed down it.
    const start = this.city.snapToRoad(new THREE.Vector3(0, 0, -60));
    this.vehicle = new Vehicle(start, this.city.alignedHeading(start, Math.PI / 2),
      this.car.handling);

    progress(85, 'laying rubber');
    await nextFrame();
    const q = this.stage.settings;
    this.skids = new SkidMarks(scene, q.skidSegments);
    this.particles = new ParticleField(scene, q.particles);

    this.nav = new Navigator(scene);
    this.chase = new ChaseCamera(this.stage.camera);
    this.chase.reset(this.vehicle);

    progress(94, 'hiring a driver');
    await nextFrame();
    this.hud = new HUD();
    this.input = new Input();
    this.audio = new EngineAudio();
    this.play = new Gameplay(scene, this.city, this.hud, {
      onEvent: (type, data) => {
        if (type === 'fare-paid') {
          this.audio.chime(true);
          if (data?.payout > 700) portal.happyTime(0.8);
          // Show banner ad when dropping off a passenger
          this.showBannerAd();
          // Only ever break between fares — never while the player is driving.
          if (portal.shouldShowInterstitial()) this._adBreak();
        } else if (type === 'picked-up') {
          this.audio.chime(true);
          // Show banner ad when picking up a new passenger
          this.showBannerAd();
        } else if (type === 'fare-lost') this.audio.chime(false);
        else if (type === 'drift-banked') {
          this.audio.chime(true);
          if (data?.total > 3000) portal.happyTime(0.6);
        }
      },
    });

    this._bindKeys();
    this._startPos = start.clone();
    this._startHeading = this.vehicle.heading;
    progress(100, 'ready');
  }

  _buildLights() {
    const scene = this.scene;

    // Moon key light. Its shadow camera is small and rides with the car —
    // a city-wide shadow map would be all texel and no detail.
    const moon = new THREE.DirectionalLight(0xa8c0ff, 1.7);
    moon.position.set(60, 90, -40);
    moon.castShadow = this.stage.settings.shadows;
    const s = this.stage.settings.shadowSize;
    moon.shadow.mapSize.set(s, s);
    moon.shadow.camera.near = 1;
    moon.shadow.camera.far = 320;
    const extent = 62;
    Object.assign(moon.shadow.camera, {
      left: -extent, right: extent, top: extent, bottom: -extent,
    });
    moon.shadow.bias = -0.0007;
    moon.shadow.normalBias = 0.035;
    moon.shadow.camera.updateProjectionMatrix();
    scene.add(moon);
    scene.add(moon.target);
    this.moon = moon;

    // Sky/ground bounce, so shadowed faces aren't black.
    this.ambient = new THREE.HemisphereLight(0x3a4a80, 0x1a1018, 1.1);
    scene.add(this.ambient);

    // A warm fill from the street below, faked with a second directional.
    const bounce = new THREE.DirectionalLight(0xff9a5c, 0.45);
    bounce.position.set(-40, -20, 30);
    scene.add(bounce);
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        this.togglePause();
      } else if (e.code === 'KeyC' && this.running && !this.paused) {
        const mode = this.chase.cycleMode();
        this.hud.toast(`CAMERA — ${mode}`);
      } else if (e.code === 'KeyR' && this.running && !this.paused) {
        this.recover();
      } else if (e.code === 'KeyM') {
        this.hud.toast(this.audio.toggleMute() ? 'SOUND OFF' : 'SOUND ON');
      } else if (e.code === 'KeyP' && this.running) {
        this.cyclePaint();
      }
    });

    window.addEventListener('resize', () => this.hud?.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running && !this.paused) this.togglePause();
    });
  }

  /**
   * Swap the driven car. The handling numbers can be applied live, but the
   * paint has to go on the existing materials — rebuilding the model mid-frame
   * would drop the wheels and lights the rest of the code holds references to.
   */
  equipCar(id) {
    this.car = carById(id);
    this.vehicle.handling = { ...this.vehicle.handling, ...this.car.handling };
    const job = PAINT_JOBS[this.car.paint] ?? PAINT_JOBS.midnight;
    this.limo.materials.paint.color.set(job.paint);
    this.hud?.toast?.(`${this.car.name} ready`);
  }

  cyclePaint() {
    const names = Object.keys(PAINT_JOBS);
    this._paintIndex = ((this._paintIndex ?? 0) + 1) % names.length;
    const job = PAINT_JOBS[names[this._paintIndex]];
    this.limo.materials.paint.color.set(job.paint);
    this.hud.toast(job.name);
  }

  recover() {
    const p = this.city.snapToRoad(this.vehicle.position);
    this.vehicle.reset(p, this.city.alignedHeading(p, this.vehicle.heading));
    this.chase.reset(this.vehicle);
    this.skids.trails.clear();
    this.play.breakDrift();
    this.hud.toast('RECOVERED');
  }

  /** The title button both starts the first shift and begins a new one. */
  startOrRestart() {
    if (this._shiftEnded) this.restart();
    else this.begin();
  }

  begin() {
    const first = !this.running;
    this._shiftEnded = false;
    this.running = true;
    this.paused = false;
    menus.hide();
    this.hud.show();

    // Audio must be created inside the click that got us here.
    this.audio.start();
    if (this.audio.ready) {
      this.music.attach(this.audio.ctx, this.audio.bus);
      this.music.start();
    }
    this.applyAudioSettings();

    portal.gameplayStart();
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    // Show banner ad when starting the game
    this.showBannerAd();
    if (first) this._loop();
  }

  /** Push the saved sound/music/volume settings into the audio engines. */
  applyAudioSettings() {
    const s = save.settings;
    this.audio.setMuted(this._adMuted || !s.sound);
    this.audio.setVolume?.(s.volume);
    this.music.setEnabled(!this._adMuted && s.music);
    this.music.setVolume(s.volume);
  }

  /** Portals require silence for the duration of a break. */
  setAdMuted(muted) {
    this._adMuted = muted;
    this.applyAudioSettings();
  }

  /** Explicit pause state, so menus and the Esc key can't get out of sync. */
  setPaused(paused) {
    if (!this.running || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.audio.suspend();
      portal.gameplayStop();
      menus.showPause({
        cash: this.play.cash,
        fares: this.play.fares,
        bestDrift: this.play.bestDrift,
        hits: this.pedestrians.hits,
      });
    } else {
      // Show banner ad when unpausing the game
      this.showBannerAd();
      menus.hide();
      this.audio.resume();
      portal.gameplayStart();
      this.clock.getDelta();          // discard the paused interval
    }
  }

  /** Bank the shift, show the summary, and stand the car back at the start. */
  endShift() {
    if (!this.running) return;
    this.paused = true;
    this.audio.suspend();
    portal.gameplayStop();
    // Show banner ad when shift ends
    this.showBannerAd();

    const shift = {
      cash: this.play.cash,
      fares: this.play.fares,
      bestDrift: this.play.bestDrift,
      distance: this.play.stats.distance,
      topSpeed: this.play.stats.topSpeed,
      hits: this.pedestrians.hits,
    };
    const records = save.recordShift(shift);
    this._shiftEnded = true;
    this.hud.hide();
    menus.showSummary(shift, records);
  }

  /** Fresh shift without reloading: reset the car, the score and the marks. */
  restart() {
    this.vehicle.reset(this._startPos, this._startHeading);
    this.chase.reset(this.vehicle);
    this.skids.clear();
    this.particles.clear();
    this.pedestrians.reset();
    this.play.reset(this.vehicle.position);
    this.nav.update(0, this.vehicle.position, this.play.objective, this.vehicle.heading);
    this._roll = 0;
    this._pitch = 0;
    this.elapsed = 0;
    this.begin();
  }

  togglePause() {
    // Esc must not dismiss the summary — that screen owns its own exit.
    if (!this.running || menus.el['panel-summary']?.classList.contains('hidden') === false) return;
    this.setPaused(!this.paused);
  }

  /**
   * Freeze the simulation for an interstitial without showing the pause menu,
   * then hand control straight back. `_adPaused` is separate from `paused` so
   * a break can't be dismissed with Esc and can't leave the menu on screen.
   */
  async _adBreak() {
    if (this._adPaused) return;
    this._adPaused = true;
    this.audio.suspend();
    try {
      await portal.commercialBreak();
    } finally {
      this._adPaused = false;
      if (!this.paused) {
        this.audio.resume();
        portal.gameplayStart();
      }
      this.clock.getDelta();        // don't integrate the ad's duration
    }
  }

  /** Show a GameMonetize banner ad at an appropriate time during gameplay. */
  showBannerAd() {
    if (typeof sdk !== 'undefined' && sdk.showBanner !== 'undefined') {
      try {
        sdk.showBanner();
      } catch (err) {
        console.warn('[GameMonetize] showBanner error:', err);
      }
    }
  }

  /* --------------------------------------------------------- simulation */

  /** Three body-aligned circles approximate the limo for collision. */
  _resolveCollisions() {
    const v = this.vehicle;
    const fwd = v.forward.clone();
    const radius = 1.46;
    let worst = 0;
    let normal = null;
    let contact = null;

    for (const offset of [3.7, 0, -3.7]) {
      const x = v.position.x + fwd.x * offset;
      const z = v.position.z + fwd.z * offset;

      const hit = this.city.probe(x, z, radius);
      if (hit) {
        v.position.x += hit.nx * hit.depth;
        v.position.z += hit.nz * hit.depth;
        const n = new THREE.Vector3(hit.nx, 0, hit.nz);
        const s = v.applyImpact(n, 0.34);
        if (s > worst) { worst = s; normal = n; contact = { x, z }; }
      }

      const car = this.traffic.probe(x, z, radius + 0.3);
      if (car) {
        v.position.x += car.nx * car.depth * 0.7;
        v.position.z += car.nz * car.depth * 0.7;
        const n = new THREE.Vector3(car.nx, 0, car.nz);
        const s = v.applyImpact(n, 0.18);
        this.traffic.shove(car.car, car.nx, car.nz, car.depth + s * 2);
        if (s > worst) { worst = s; normal = n; contact = { x, z }; }
      }
    }

    // Hard stop at the city limits.
    const lim = HALF_CITY - 4;
    for (const axis of ['x', 'z']) {
      if (Math.abs(v.position[axis]) > lim) {
        v.position[axis] = Math.sign(v.position[axis]) * lim;
        const n = new THREE.Vector3();
        n[axis] = -Math.sign(v.position[axis]);
        const s = v.applyImpact(n, 0.3);
        if (s > worst) { worst = s; normal = n; contact = { x: v.position.x, z: v.position.z }; }
      }
    }

    if (worst > 0.04 && contact) {
      this.chase.addShake(worst * 0.9);
      this.audio.impact(worst);
      if (worst > 0.12) {
        burstSparks(this.particles, contact.x, 0.7, contact.z, normal.x, normal.z, worst);
        this.play.breakDrift();
      }
    }
  }

  _emitEffects(dt) {
    const v = this.vehicle;
    const fwd = v.forward.clone();
    const left = v.left.clone();
    const speed = Math.abs(v.speed);
    const slip = v.wheelSlip;

    const travel = v.velocity.clone();
    const tLen = travel.length();
    const dirX = tLen > 0.2 ? travel.x / tLen : fwd.x;
    const dirZ = tLen > 0.2 ? travel.z / tLen : fwd.z;

    const smoking = slip > 0.26 && speed > 4;

    for (const side of [-1, 1]) {
      const key = `r${side}`;
      const wx = v.position.x + fwd.x * LIMO.rearAxle + left.x * side * (LIMO.trackWidth / 2);
      const wz = v.position.z + fwd.z * LIMO.rearAxle + left.z * side * (LIMO.trackWidth / 2);

      if (smoking) {
        this.skids.stamp(key, wx, wz, dirX, dirZ, 0.42, clamp((slip - 0.2) * 1.5, 0.15, 1));
      } else {
        this.skids.lift(key);
      }
    }

    // Tyre smoke, rate-limited so the pool lasts.
    if (smoking) {
      this.smokeAcc += dt * (18 + slip * 46);
      while (this.smokeAcc >= 1) {
        this.smokeAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const wx = v.position.x + fwd.x * LIMO.rearAxle + left.x * side * (LIMO.trackWidth / 2);
        const wz = v.position.z + fwd.z * LIMO.rearAxle + left.z * side * (LIMO.trackWidth / 2);
        const shade = lerp(0.62, 0.82, Math.random());
        this.particles.spawn({
          x: wx + (Math.random() - 0.5) * 0.4,
          y: 0.22 + Math.random() * 0.25,
          z: wz + (Math.random() - 0.5) * 0.4,
          vx: -dirX * speed * 0.16 + (Math.random() - 0.5) * 2.4,
          vy: 0.9 + Math.random() * 1.7,
          vz: -dirZ * speed * 0.16 + (Math.random() - 0.5) * 2.4,
          life: 1.0 + Math.random() * 1.3,
          size: 0.7 + Math.random() * 0.7,
          grow: 2.4,
          color: [shade, shade, shade * 1.05],
          drag: 1.1,
        });
      }
    }

    // Exhaust: a puff on throttle, more when boosting.
    this.exhaustAcc += dt * (v.boosting ? 40 : 7 + this.input.throttle * 10);
    while (this.exhaustAcc >= 1) {
      this.exhaustAcc -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      const ex = v.position.x + fwd.x * (-LIMO.length / 2) + left.x * side * 0.62;
      const ez = v.position.z + fwd.z * (-LIMO.length / 2) + left.z * side * 0.62;
      const hot = v.boosting;
      this.particles.spawn({
        x: ex, y: 0.45, z: ez,
        vx: -fwd.x * (2 + Math.random() * 3) + (Math.random() - 0.5),
        vy: 0.5 + Math.random(),
        vz: -fwd.z * (2 + Math.random() * 3) + (Math.random() - 0.5),
        life: hot ? 0.5 : 0.85,
        size: hot ? 0.5 : 0.3,
        grow: hot ? 2.2 : 1.1,
        color: hot ? [1, 0.55, 0.25] : [0.42, 0.44, 0.5],
        alpha: 0.3,
        drag: 1.9,
      });
    }
  }

  _syncCar(dt) {
    const v = this.vehicle;
    this.limo.root.position.set(v.position.x, 0, v.position.z);
    this.limo.root.rotation.y = v.heading;
    this.limo.updateWheels(v.steer, v.speed, dt);

    // Weight transfer: roll into the corner, dive under braking, squat on power.
    const lateralG = clamp(-v.yawRate * v.speed * 0.02, -1, 1);
    const longG = clamp((this.input.throttle - this.input.brake * 1.4) * 0.55, -1, 1);
    this._roll = damp(this._roll ?? 0, lateralG * 0.09, 6, dt);
    this._pitch = damp(this._pitch ?? 0, -longG * 0.045, 5, dt);
    this.limo.setAttitude(this._roll, this._pitch);
  }

  _step(dt) {
    this.input.update(dt);

    const cmd = {
      throttle: this.input.throttle,
      brake: this.input.brake,
      steer: this.input.steer,
      handbrake: this.input.handbrake,
      boost: this.input.boost,
    };

    this.vehicle.update(cmd, dt);
    this._resolveCollisions();
  }

  _loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (this.paused || this._adPaused) return;

    const raw = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += raw;

    // Fixed-step physics keeps the tyre model stable on any refresh rate.
    this.accumulator += raw;
    const step = 1 / 120;
    let steps = 0;
    while (this.accumulator >= step && steps < 8) {
      this._step(step);
      this.accumulator -= step;
      steps++;
    }
    if (steps === 8) this.accumulator = 0;

    const v = this.vehicle;
    this._syncCar(raw);
    this._emitEffects(raw);

    // Time of day drives the sky, the fog, the key light, the office windows
    // and the car's headlights from a single number.
    this.dayNight.update(raw);
    this.dayNight.apply({
      scene: this.scene, sky: this.sky, key: this.moon, ambient: this.ambient,
      renderer: this.stage.renderer, facadeMaterials: this.facadeMaterials,
      city: this.city,
    });
    this.limo.setLamps({
      braking: v.braking, reversing: v.reversing,
      headlights: this.dayNight.isNight,
    });

    this.nav.update(raw, v.position, this.play.objective, v.heading);
    this.nav.setColor(this.play.state === 'seeking' ? 0x38e6ff : 0xffcb5c);

    const struck = this.pedestrians.update(raw, v);
    if (struck > 0) this.play.registerPedestrianHit(struck, v);

    this.traffic.update(raw, v, this.elapsed);
    this.city.update(raw, v.position, this.elapsed);
    this.particles.update(raw);
    this.play.update(raw, v);
    this.chase.update(raw, v, this.city);

    // Keep the shadow frustum centred on the car.
    this.moon.position.set(v.position.x + 60, 90, v.position.z - 40);
    this.moon.target.position.set(v.position.x, 0, v.position.z);
    this.moon.target.updateMatrixWorld();

    this.audio.update({
      rpm: v.rpm,
      speed01: v.speed01,
      wheelSlip: v.wheelSlip,
      throttle: this.input.throttle,
      boosting: v.boosting,
      drifting: v.isDrifting,
    }, raw);

    this.music.setIntensity(v.speed01);
    this.hud.update(raw, v, this.play.objective, this.traffic, {
      camera: this.stage.camera,
      clock: this.dayNight.clock,
      state: this.play.state,
      passenger: this.play.passenger?.name ?? '',
      routeDistance: this.nav.routeDistance(),
      hits: this.pedestrians.hits,
    });
    this.stage.update(raw, { speed01: v.speed01, damage: v.impact });
    this.stage.render();

    this.input.endFrame();
  };
}

/* --------------------------------------------------------------- start */

/**
 * Phones and tablets get the low preset unless the player says otherwise.
 *
 * Deliberately keyed off the pointer type and the physical screen, not the
 * window size — a 1366x768 laptop or a half-width browser window is still a
 * desktop GPU and should not be dropped to low.
 */
function defaultQuality() {
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
  const tinyScreen = Math.min(window.screen?.width ?? 9999,
                              window.screen?.height ?? 9999) < 600;
  return coarse || tinyScreen ? 'low' : 'high';
}

async function boot() {
  menus = new Menus();
  menus.setProgress(4, 'contacting the portal');

  // The portal has to come up first: it owns the storage the settings live in.
  await portal.init();
  portal.loadingStart();

  const settings = save.load().settings;
  const quality = QUALITY[settings.quality] ? settings.quality : defaultQuality();

  let stage;
  try {
    stage = new Stage(document.getElementById('scene'), quality);
  } catch (err) {
    console.error('WebGL init failed', err);
    menus.hide();
    document.getElementById('nowebgl').classList.remove('hidden');
    return;
  }

  const game = new Game(stage);
  window.__limo = game;              // handy for debugging from the console
  window.gameInstance = game;        // exposed for GameMonetize SDK

  /* ------------------------------------------------------- menu callbacks */
  menus.h = {
    onStart: () => game.startOrRestart(),
    onResume: () => game.setPaused(false),
    onPause: () => game.setPaused(true),
    onRestart: () => game.restart(),
    onEndShift: () => game.endShift(),

    onQuality: (q) => {
      if (q === stage.quality) return;
      save.setSetting('quality', q);
      // The city, traffic fleet, light pool, shadow maps and particle pools are
      // all built from the preset, so changing it has to rebuild the world.
      // Reloading is the honest way to do that, and the whole game is
      // procedural so it comes back in about a second.
      menus.show('panel-loading');
      menus.setProgress(0, 'rebuilding the city');
      location.reload();
    },
    onSound: (on) => {
      save.setSetting('sound', on);
      game.applyAudioSettings();
    },
    onMusic: (on) => {
      save.setSetting('music', on);
      game.applyAudioSettings();
    },
    onVolume: (v) => {
      save.setSetting('volume', v);
      game.applyAudioSettings();
    },
    getRecords: () => save.load(),
    onBuy: (id) => {
      // Show banner ad when opening purchase dialog
      game.showBannerAd();
      const car = carById(id);
      if (save.buy(car)) {
        game.equipCar(car.id);
        // Show another banner ad after successful purchase
        game.showBannerAd();
      }
    },
    onEquip: (id) => { if (save.equip(id)) game.equipCar(id); },
    onResetRecords: () => {
      save.reset();
      menus.syncSettings(save.settings, stage.quality);
      game.applyAudioSettings();
    },
  };

  try {
    await game.build();
  } catch (err) {
    console.error('Build failed', err);
    menus.setProgress(100, 'something broke — check the console');
    return;
  }

  // Park the camera on the skyline so the menu has the city behind it.
  stage.camera.position.set(30, 14, 46);
  stage.camera.lookAt(0, 6, 0);
  stage.render();

  // Both portals require the game to silence itself while a break plays.
  portal.onMuteChange((muted) => game.setAdMuted(muted));

  portal.loadingStop();
  menus.doneLoading();
  menus.syncSettings(save.settings, stage.quality);
  menus.showTitle(save.load());
}

boot();
