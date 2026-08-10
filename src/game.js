import { CONFIG } from './config.js';
import { clamp, formatCash } from './util.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { Poki } from './poki.js';
import { Save } from './save.js';
import { generateTrack } from './track.js';
import { Limo } from './vehicle.js';
import { CargoRig } from './cargo.js';
import { Traffic } from './traffic.js';
import { Particles } from './particles.js';
import { Camera } from './camera.js';
import { Renderer } from './render.js';
import { getLevel, levelCount } from './levels.js';
import { computeScore } from './score.js';
import { SLOTS } from './customize.js';
import { getCargoType } from './cargoTypes.js';

const { Engine, Composite, Events } = window.Matter;

const STATE = {
  BOOT: 'boot',
  MENU: 'menu',
  GARAGE: 'garage',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PAUSED: 'paused',
  RESULT: 'result',
};

const STEP = 1 / 60;

export class Game {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('#game');
    this.renderer = new Renderer(this.canvas);
    this.camera = new Camera();
    this.particles = new Particles();
    this.input = new Input(window);

    this.state = STATE.BOOT;
    this.time = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.flash = 0;
    this.toast = { text: '', life: 0, color: '#ffd35a' };
    this.rescueUsed = false;
    this.doubledCash = false;

    this.engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 6;
    this.engine.constraintIterations = 4;
    this.world = this.engine.world;

    this.track = null;
    this.limo = null;
    this.rig = null;
    this.traffic = null;
    this.levelDef = null;

    this.ui = this._collectUi();
    this._bindUi();
    this._bindPhysicsEvents();

    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('blur', () => {
      if (this.state === STATE.PLAYING) this.pause();
    });
    this._onResize();

    Poki.onMuteChange((muted) => Sound.setAdMuted(muted));
    Sound.setMuted(Save.get('muted'));
    Sound.setHorn(Save.data.equipped.horn);
  }

  /* ---------------------------------------------------------------- */
  /* UI plumbing                                                       */
  /* ---------------------------------------------------------------- */

  _collectUi() {
    const q = (sel) => this.root.querySelector(sel);
    return {
      screens: {
        loading: q('#screen-loading'),
        menu: q('#screen-menu'),
        garage: q('#screen-garage'),
        result: q('#screen-result'),
        pause: q('#screen-pause'),
        countdown: q('#screen-countdown'),
      },
      loadingBar: q('#loading-bar'),
      playBtn: q('#btn-play'),
      playLabel: q('#btn-play-label'),
      garageBtn: q('#btn-garage'),
      levelGrid: q('#level-grid'),
      cashMenu: q('#cash-menu'),
      bestMenu: q('#best-menu'),
      muteBtn: q('#btn-mute'),
      garageBack: q('#btn-garage-back'),
      garageCash: q('#cash-garage'),
      garageSlots: q('#garage-slots'),
      resultTitle: q('#result-title'),
      resultSub: q('#result-sub'),
      resultStars: q('#result-stars'),
      resultLines: q('#result-lines'),
      resultTotal: q('#result-total'),
      resultCash: q('#result-cash'),
      btnPrimary: q('#btn-result-primary'),
      btnReward: q('#btn-result-reward'),
      btnMenu: q('#btn-result-menu'),
      btnRetry: q('#btn-result-retry'),
      pauseResume: q('#btn-resume'),
      pauseRestart: q('#btn-pause-restart'),
      pauseMenu: q('#btn-pause-menu'),
      countdownText: q('#countdown-text'),
      cargoManifest: q('#cargo-manifest'),
      touch: q('#touch-controls'),
      adOverlay: q('#ad-overlay'),
    };
  }

  _bindUi() {
    const u = this.ui;
    const click = (el, fn) => {
      if (!el) return;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        Sound.start();
        Sound.play('ui');
        fn(e);
      });
    };

    click(u.playBtn, () => this.startLevel(Save.get('levelUnlocked')));
    click(u.garageBtn, () => this.showGarage());
    click(u.garageBack, () => this.showMenu());
    click(u.muteBtn, () => {
      const muted = Sound.toggleMute();
      Save.set('muted', muted);
      this._refreshMute();
    });
    click(u.pauseResume, () => this.resume());
    click(u.pauseRestart, () => this.startLevel(this.levelDef.level));
    click(u.pauseMenu, () => this.showMenu());
    click(u.btnMenu, () => this.showMenu());
    click(u.btnRetry, () => this.startLevel(this.levelDef.level));
    click(u.btnPrimary, () => this._resultPrimary());
    click(u.btnReward, () => this._resultReward());

    this.input.bindTouch(this.root.querySelector('#touch-left'), 'left');
    this.input.bindTouch(this.root.querySelector('#touch-right'), 'right');
    this.input.bindTouch(this.root.querySelector('#touch-boost'), 'boost');
    this.input.bindTouch(this.root.querySelector('#touch-brake'), 'handbrake');

    // Any first interaction unlocks WebAudio.
    const unlock = () => Sound.start();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  _showScreen(name) {
    for (const [key, el] of Object.entries(this.ui.screens)) {
      if (!el) continue;
      el.classList.toggle('active', key === name);
    }
    this.root.classList.toggle('in-game', name === null || name === 'countdown');
  }

  _refreshMute() {
    if (this.ui.muteBtn) this.ui.muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
  }

  _onResize() {
    this.renderer.resize();
    this.camera.resize(this.renderer.width, this.renderer.height);
    const touch = this.ui.touch;
    if (touch) {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      touch.style.display = coarse ? 'flex' : 'none';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async boot() {
    Poki.loadingStart();
    this._showScreen('loading');
    // The build has no external assets — this is a short, honest warm-up that
    // also gives the Poki SDK time to settle before the menu appears.
    for (let i = 0; i <= 10; i++) {
      Poki.loadingProgress(i / 10);
      if (this.ui.loadingBar) this.ui.loadingBar.style.width = `${i * 10}%`;
      await new Promise((r) => setTimeout(r, 40));
    }
    Poki.loadingFinished();
    this._refreshMute();
    this.showMenu();
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  showMenu() {
    Poki.gameplayStop();
    this.state = STATE.MENU;
    this._teardownRun();
    this._showScreen('menu');
    const next = Save.get('levelUnlocked');
    if (this.ui.playLabel) {
      this.ui.playLabel.textContent =
        next > 1 ? `CONTINUE · LEVEL ${next}` : 'START YOUR SHIFT';
    }
    if (this.ui.cashMenu) this.ui.cashMenu.textContent = formatCash(Save.get('cash'));
    if (this.ui.bestMenu) {
      this.ui.bestMenu.textContent = Save.get('highScore').toLocaleString('en-US');
    }
    this._buildLevelGrid();
  }

  _buildLevelGrid() {
    const grid = this.ui.levelGrid;
    if (!grid) return;
    grid.innerHTML = '';
    const unlocked = Save.get('levelUnlocked');
    const max = Math.max(levelCount(), unlocked);
    for (let i = 1; i <= max; i++) {
      const def = getLevel(i);
      const btn = document.createElement('button');
      btn.className = 'level-chip';
      const open = i <= unlocked;
      btn.disabled = !open;
      const best = Save.get('levelScores')[i];
      btn.innerHTML = `<span class="lv">${i}</span><span class="nm">${
        open ? def.name : 'Locked'
      }</span>${best ? `<span class="bs">${best.toLocaleString('en-US')}</span>` : ''}`;
      if (open) {
        btn.addEventListener('click', () => {
          Sound.start();
          Sound.play('ui');
          this.startLevel(i);
        });
      }
      grid.appendChild(btn);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Garage                                                            */
  /* ---------------------------------------------------------------- */

  showGarage() {
    this.state = STATE.GARAGE;
    this._showScreen('garage');
    this._renderGarage();
  }

  _renderGarage() {
    const host = this.ui.garageSlots;
    if (!host) return;
    if (this.ui.garageCash) this.ui.garageCash.textContent = formatCash(Save.get('cash'));
    host.innerHTML = '';
    for (const slot of SLOTS) {
      const section = document.createElement('div');
      section.className = 'shop-slot';
      section.innerHTML = `<h3>${slot.name}</h3>`;
      const row = document.createElement('div');
      row.className = 'shop-row';
      for (const item of Object.values(slot.items)) {
        const owned = Save.owns(slot.id, item.id) || item.price === 0;
        const equipped = Save.data.equipped[slot.id] === item.id;
        const card = document.createElement('button');
        card.className = `shop-card${equipped ? ' equipped' : ''}${owned ? ' owned' : ''}`;
        const swatch =
          slot.id === 'underglow' && item.color
            ? `<span class="swatch" style="background:${
                item.color === 'rainbow'
                  ? 'linear-gradient(90deg,#ff5e8a,#ffd93d,#5affa0,#4fd2e8,#c78bff)'
                  : item.color
              }"></span>`
            : '';
        card.innerHTML = `${swatch}<span class="nm">${item.name}</span><span class="pr">${
          equipped ? 'EQUIPPED' : owned ? 'Equip' : formatCash(item.price)
        }</span>`;
        card.addEventListener('click', () => {
          Sound.start();
          if (owned) {
            Save.equip(slot.id, item.id);
            if (slot.id === 'horn') {
              Sound.setHorn(item.id);
              Sound.play('horn');
            } else {
              Sound.play('ui');
            }
          } else if (Save.spendCash(item.price)) {
            Save.unlock(slot.id, item.id);
            Save.equip(slot.id, item.id);
            if (slot.id === 'horn') Sound.setHorn(item.id);
            Sound.play('buy');
          } else {
            Sound.play('deny');
            card.classList.add('shake');
            setTimeout(() => card.classList.remove('shake'), 400);
            return;
          }
          this._renderGarage();
        });
        row.appendChild(card);
      }
      section.appendChild(row);
      host.appendChild(section);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Run lifecycle                                                     */
  /* ---------------------------------------------------------------- */

  _teardownRun() {
    if (this.rig) this.rig.destroy();
    if (this.traffic) this.traffic.destroy();
    if (this.limo) this.limo.destroy();
    if (this.track) this.track.destroy(this.world);
    Composite.clear(this.world, false, true);
    this.rig = null;
    this.traffic = null;
    this.limo = null;
    this.track = null;
    this.particles.clear();
  }

  startLevel(levelNumber) {
    this._teardownRun();
    const def = getLevel(levelNumber);
    this.levelDef = def;
    this.rescueUsed = false;
    this.doubledCash = false;

    this.track = generateTrack(this.world, { level: def.level, seed: def.seed });
    this.limo = new Limo(this.world, {
      segments: def.segments,
      position: { ...this.track.startPos },
      angle: this.track.startAngle,
    });
    this.rig = new CargoRig(this.world, this.limo, def.cargo);
    this.traffic = new Traffic(this.world, this.track, def.seed);

    this.timeLeft = def.timeLimit;
    this.score = 0;
    this.wallHits = 0;
    this.playerIndex = 0;
    this.finished = false;
    this.stuckTimer = 0;
    this.stuckCount = 0;
    this.stuckEscapeFrom = 0;
    this.flash = 0;
    this.toast.life = 0;
    this.input.releaseAll();
    this.input.clearPresses();

    this.camera.zoomBias = 1;
    this.camera.snapTo(this.track.startPos.x, this.track.startPos.y);
    this.camera.zoom = this.camera.fitZoom(this.limo.totalLength);

    this._renderManifest();
    this._startCountdown();
  }

  _renderManifest() {
    const host = this.ui.cargoManifest;
    if (!host) return;
    host.innerHTML = this.levelDef.cargo
      .map((id) => `<li>${getCargoType(id).name}</li>`)
      .join('');
  }

  _startCountdown() {
    this.state = STATE.COUNTDOWN;
    this.countdown = 3.2;
    this._showScreen('countdown');
  }

  _beginPlay() {
    this.state = STATE.PLAYING;
    this._showScreen(null);
    Poki.gameplayStart();
    Sound.start();
  }

  pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    Poki.gameplayStop();
    Sound.silence();
    this.input.releaseAll();
    this._showScreen('pause');
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = STATE.PLAYING;
    this._showScreen(null);
    Poki.gameplayStart();
  }

  /* ---------------------------------------------------------------- */
  /* Physics events                                                    */
  /* ---------------------------------------------------------------- */

  _bindPhysicsEvents() {
    Events.on(this.engine, 'collisionStart', (evt) => {
      for (const pair of evt.pairs) this._handleCollision(pair);
    });
  }

  _handleCollision(pair) {
    if (this.state !== STATE.PLAYING) return;
    const a = pair.bodyA;
    const b = pair.bodyB;
    const labels = [a.label, b.label];
    const has = (l) => labels.includes(l);
    const isLimo = has('limo-cab') || has('limo-seg');

    const relative = Math.hypot(
      (a.velocity.x - b.velocity.x) || 0,
      (a.velocity.y - b.velocity.y) || 0
    );
    const point = pair.collision && pair.collision.supports && pair.collision.supports[0];
    const px = point ? point.x : (a.position.x + b.position.x) / 2;
    const py = point ? point.y : (a.position.y + b.position.y) / 2;

    if (isLimo && has('wall')) {
      const strength = clamp(relative / 9, 0, 1);
      if (strength > 0.12 && this.limo.wallHitCooldown <= 0) {
        this.limo.wallHitCooldown = 0.25;
        this.wallHits += 1;
        this.camera.addTrauma(0.16 + strength * 0.4);
        Sound.play('crash', strength);
        this.particles.burst(px, py, 6 + (strength * 12) | 0, {
          speed: 2 + strength * 4,
          tint: 'spark',
          size: 3,
          life: 0.4,
        });
      }
    } else if (isLimo && has('traffic')) {
      const other = a.label === 'traffic' ? a : b;
      const strength = clamp(relative / 8, 0, 1);
      this.camera.addTrauma(0.2 + strength * 0.35);
      Sound.play('crash', strength * 0.8);
      if (other.plugin && other.plugin.traffic) {
        if (other.plugin.traffic.hit(relative)) Sound.play('horn');
      }
      this.particles.burst(px, py, 10, { speed: 3, tint: 'spark', size: 3.5, life: 0.45 });
    } else if (isLimo && has('prop')) {
      Sound.play('bump', 0.5);
      this.particles.burst(px, py, 5, { speed: 2.4, tint: 'dust', size: 4, life: 0.5, additive: false });
      this.camera.addTrauma(0.05);
    } else if (has('cargo')) {
      const cargoBody = a.label === 'cargo' ? a : b;
      const item = cargoBody.plugin && cargoBody.plugin.cargo;
      if (item && !item.attached && item.dropAge < 3 && relative > 2) {
        Sound.play('bump', 0.6);
        this.particles.burst(px, py, 6, { speed: 2, tint: 'dust', size: 4, life: 0.5 });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  _events() {
    if (this._eventBundle) return this._eventBundle;
    this._eventBundle = {
      onCargoDrop: (item) => this._onCargoDrop(item),
      onCargoWarn: () => Sound.play('cargoWobble', 0.7),
      onBoostStart: () => {
        Sound.play('boost');
        this.camera.addTrauma(0.12);
      },
      onLand: (seg) => {
        Sound.play('land', 0.6);
        this.camera.addTrauma(0.22);
        const p = seg.body.position;
        this.particles.burst(p.x, p.y, 10, {
          speed: 2.4,
          tint: 'dust',
          size: 7,
          life: 0.5,
          additive: false,
        });
      },
    };
    return this._eventBundle;
  }

  _onCargoDrop(item) {
    Sound.play('cargoDrop');
    this.camera.addTrauma(CONFIG.cargo.impactShake);
    this.flash = 1;
    const p = item.body.position;
    this.particles.burst(p.x, p.y, 22, {
      speed: 4,
      tint: 'dust',
      size: 8,
      life: 0.8,
      additive: false,
    });
    this.particles.confetti(p.x, p.y, 14);
    this._say(`${item.def.name.toUpperCase()} LOST!`, '#ff6b6b');
    if (this.rig.intact === 0) this._finish(false, 'cargo');
  }

  _say(text, color = '#ffd35a') {
    this.toast.text = text;
    this.toast.color = color;
    this.toast.life = 1.6;
  }

  _fixedUpdate(dt) {
    this.input.update(dt);

    if (this.input.consume('mute')) {
      Save.set('muted', Sound.toggleMute());
      this._refreshMute();
    }
    if (this.input.consume('horn')) Sound.play('horn');

    if (this.state === STATE.COUNTDOWN) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.2);
      if (this.ui.countdownText) {
        this.ui.countdownText.textContent = n > 0 ? String(n) : 'GO!';
      }
      if (this.countdown <= 0) this._beginPlay();
      // Let physics settle so the limo is straight when the flag drops.
      Engine.update(this.engine, 1000 / 60);
      this.camera.update(dt, this._cameraTarget());
      return;
    }

    if (this.state !== STATE.PLAYING) {
      this.camera.update(dt, this._cameraTarget());
      return;
    }

    if (this.input.consume('pause')) {
      this.pause();
      return;
    }
    if (this.input.consume('restart')) {
      this.startLevel(this.levelDef.level);
      return;
    }

    const events = this._events();
    this.limo.update(dt, this.input, this.track, events);
    this.rig.update(dt, events);
    this.playerIndex = this.track.nearestIndex(
      this.limo.cab.position.x,
      this.limo.cab.position.y,
      this.playerIndex
    );
    this.traffic.update(dt, this.playerIndex);

    Engine.update(this.engine, 1000 / 60);

    this.limo.emitSmoke(this.particles, dt);
    this._skidMarks(dt);
    this._checkZones(dt);
    this._checkProgress();
    this._checkStuck(dt);

    this.timeLeft -= dt;
    this.score =
      this.limo.driftScore +
      this.rig.intact * 40 +
      this.track.progressAt(this.playerIndex) * 900 * this.levelDef.payMultiplier;

    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this._finish(false, 'time');
    }
  }

  _skidMarks(dt) {
    this._skidTimer = (this._skidTimer || 0) + dt;
    if (this._skidTimer < 0.024) return;
    this._skidTimer = 0;
    for (const seg of this.limo.segments) {
      const slip = Math.abs(seg.lateral);
      if (slip < CONFIG.limo.driftSmokeSlip * 0.8 || seg.air > 0) continue;
      for (const side of [-1, 1]) {
        const p = this.limo.wheelPoint(seg, -1, side);
        this.particles.skid(p.x, p.y, seg.body.angle, clamp(slip / 4, 0.25, 1));
      }
    }
  }

  _checkZones(dt) {
    const cab = this.limo.cab;
    for (const z of this.track.zones) {
      if (z.type === 'ramp') {
        for (const seg of this.limo.segments) {
          const d = Math.hypot(seg.body.position.x - z.x, seg.body.position.y - z.y);
          if (d < z.r && seg.air <= 0 && (seg.rampCooldown || 0) <= 0) {
            seg.pendingAir = z.power;
            seg.rampCooldown = 0.9;
            if (seg.isCab) {
              Sound.play('ramp');
              this.camera.addTrauma(0.14);
            }
          }
        }
      } else if (z.type === 'boost') {
        const d = Math.hypot(cab.position.x - z.x, cab.position.y - z.y);
        if (d < z.r && (z.cooldown || 0) <= 0) {
          z.cooldown = 1.2;
          this.limo.boost = Math.min(
            CONFIG.limo.boostCapacity,
            this.limo.boost + 0.65 * z.power
          );
          Sound.play('boost');
          this.particles.burst(cab.position.x, cab.position.y, 12, {
            speed: 3,
            tint: 'spark',
            size: 4,
            life: 0.4,
          });
          this._say('+TURBO', '#4fd2e8');
        }
      }
      if (z.cooldown > 0) z.cooldown -= dt;
    }
    for (const seg of this.limo.segments) {
      if (seg.rampCooldown > 0) seg.rampCooldown -= dt;
    }
  }

  /**
   * There is no reverse gear, so a limo wedged across an alley would otherwise
   * be a dead run. After a moment at a standstill we straighten it back out
   * along the road — cargo included, so the realign itself never costs an item.
   */
  _checkStuck(dt) {
    const moving = this.limo.speed > 1.1 || this.limo.airTime > 0;
    if (moving) {
      this.stuckTimer = 0;
      // Only real forward progress clears the escalation.
      if (this.playerIndex > (this.stuckEscapeFrom || 0) + 3) this.stuckCount = 0;
      return;
    }
    this.stuckTimer = (this.stuckTimer || 0) + dt;
    if (this.stuckTimer < 1.6) return;

    this.stuckTimer = 0;
    this.stuckCount = (this.stuckCount || 0) + 1;
    this.stuckEscapeFrom = this.playerIndex;
    // Each repeat drops us further down the road, so a limo wedged across a
    // tight alley always gets past it instead of re-wedging in the same spot.
    this.placeLimoAt(this.playerIndex + Math.min(6, this.stuckCount));
    this.camera.addTrauma(0.18);
    this._say('REALIGNED', '#4fd2e8');
    Sound.play('bump', 0.5);
  }

  /**
   * Move the whole rig to a point on the route. Cargo is snapped along with it
   * — moving the limo out from under an attached load would stretch every strap
   * across the teleport distance and shear the roof clean off.
   */
  placeLimoAt(index) {
    const target = clamp(index, 0, this.track.finish.index - 1);
    this.limo.respawnAt(this.track, target);
    this.rig.snapToAnchors();
    this.playerIndex = this.track.nearestIndex(
      this.limo.cab.position.x,
      this.limo.cab.position.y,
      -1
    );
  }

  _checkProgress() {
    for (const cp of this.track.checkpoints) {
      if (cp.taken || this.playerIndex < cp.index) continue;
      cp.taken = true;
      this.timeLeft += CONFIG.track.checkpointBonus;
      Sound.play('checkpoint');
      this._say(`+${CONFIG.track.checkpointBonus.toFixed(1)}s CHECKPOINT`, '#5affa0');
      this.particles.confetti(cp.x, cp.y, 16);
    }
    if (!this.finished && this.playerIndex >= this.track.finish.index - 1) {
      this._finish(true, 'delivered');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Results                                                           */
  /* ---------------------------------------------------------------- */

  _finish(delivered, reason) {
    if (this.finished) return;
    this.finished = true;
    this.state = STATE.RESULT;
    this.finishReason = reason;
    Poki.gameplayStop();
    Sound.silence();
    this.input.releaseAll();

    const def = this.levelDef;
    const result = computeScore({
      delivered,
      timeRemaining: this.timeLeft,
      timeLimit: def.timeLimit,
      cargoIntact: this.rig.intact,
      cargoTotal: this.rig.total,
      maxDriftAngle: this.limo.maxDriftAngle,
      driftScore: this.limo.driftScore,
      level: def.level,
      payMultiplier: def.payMultiplier,
      wallHits: this.wallHits,
    });
    this.result = result;
    this.result.delivered = delivered;

    Save.addCash(result.cash);
    Save.recordRun({
      level: def.level,
      score: result.total,
      driftAngle: this.limo.maxDriftAngle,
      segments: def.segments,
      delivered,
    });

    if (delivered) {
      Sound.play('win');
      Poki.happyTime(clamp(result.stars / 3, 0.3, 1));
      const p = this.limo.cab.position;
      this.particles.confetti(p.x, p.y, 60);
      this.camera.addTrauma(0.2);
    } else {
      Sound.play('fail');
    }

    this._renderResult();
    this._showScreen('result');
  }

  _renderResult() {
    const u = this.ui;
    const r = this.result;
    const def = this.levelDef;
    const delivered = r.delivered;

    if (u.resultTitle) {
      u.resultTitle.textContent = delivered ? 'DELIVERED!' : 'SHIFT FAILED';
      u.resultTitle.className = delivered ? 'win' : 'lose';
    }
    if (u.resultSub) {
      u.resultSub.textContent = delivered
        ? r.clean
          ? 'Not a scratch. The client is delighted.'
          : `${this.rig.intact}/${this.rig.total} items survived.`
        : this.finishReason === 'time'
        ? 'Out of time. The client is calling.'
        : 'Every last item is on the pavement.';
    }
    if (u.resultStars) {
      u.resultStars.innerHTML = [0, 1, 2]
        .map((i) => `<span class="${i < r.stars ? 'on' : ''}">★</span>`)
        .join('');
    }
    if (u.resultLines) {
      u.resultLines.innerHTML = r.lines
        .map(
          (l) =>
            `<li><span>${l.label}${
              l.detail ? ` <em>${l.detail}</em>` : ''
            }</span><b>${l.value.toLocaleString('en-US')}</b></li>`
        )
        .join('');
    }
    if (u.resultTotal) u.resultTotal.textContent = r.total.toLocaleString('en-US');
    if (u.resultCash) u.resultCash.textContent = formatCash(r.cash);

    const canRescue = !delivered && !this.rescueUsed;
    if (u.btnPrimary) {
      u.btnPrimary.textContent = delivered ? `NEXT · LEVEL ${def.level + 1}` : 'RETRY';
    }
    if (u.btnRetry) u.btnRetry.style.display = delivered ? 'inline-flex' : 'none';
    if (u.btnReward) {
      u.btnReward.style.display = delivered || canRescue ? 'inline-flex' : 'none';
      u.btnReward.textContent = delivered
        ? this.doubledCash
          ? 'CASH DOUBLED ✓'
          : '▶ WATCH AD · DOUBLE CASH'
        : '▶ WATCH AD · RESCUE THE RUN';
      u.btnReward.disabled = delivered && this.doubledCash;
    }
  }

  async _resultPrimary() {
    const delivered = this.result.delivered;
    const next = delivered ? this.levelDef.level + 1 : this.levelDef.level;
    if (Poki.shouldShowInterstitial()) {
      this._setAdOverlay(true);
      await Poki.commercialBreak();
      this._setAdOverlay(false);
    }
    this.startLevel(next);
  }

  async _resultReward() {
    const delivered = this.result.delivered;
    if (delivered && this.doubledCash) return;
    this._setAdOverlay(true);
    const earned = await Poki.rewardedBreak();
    this._setAdOverlay(false);
    if (!earned) {
      this._say('Ad unavailable — no reward', '#ff6b6b');
      return;
    }
    if (delivered) {
      this.doubledCash = true;
      Save.addCash(this.result.cash);
      this.result.cash *= 2;
      Sound.play('cash');
      this._renderResult();
    } else {
      this._rescueRun();
    }
  }

  _setAdOverlay(on) {
    if (this.ui.adOverlay) this.ui.adOverlay.classList.toggle('active', on);
  }

  /** Rewarded-ad continue: cargo re-strapped, extra time, back on the road. */
  _rescueRun() {
    this.rescueUsed = true;
    this.timeLeft = Math.max(this.timeLeft, 0) + 15;
    this.finished = false;
    this.stuckTimer = 0;
    this.stuckCount = 0;
    // Straighten the limo out first, then re-strap everything onto it.
    this.placeLimoAt(this.playerIndex - 1);
    const restored = this.rig.restoreAll();
    this.camera.addTrauma(0.2);
    this._say(`${restored} ITEMS RE-STRAPPED · +15s`, '#5affa0');
    Sound.play('checkpoint');
    this.state = STATE.COUNTDOWN;
    this.countdown = 2.2;
    this._showScreen('countdown');
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  _cameraTarget() {
    if (!this.limo) return null;
    const cab = this.limo.cab;
    return {
      x: cab.position.x,
      y: cab.position.y,
      vx: cab.velocity.x,
      vy: cab.velocity.y,
      speed: this.limo.speed,
      length: this.limo.totalLength,
    };
  }

  _frame(ts) {
    const raw = (ts - this.lastFrame) / 1000;
    this.lastFrame = ts;
    const dt = clamp(raw, 0, 0.1);
    this.time += dt;

    if (this.state === STATE.PLAYING || this.state === STATE.COUNTDOWN) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= STEP && steps < CONFIG.physics.maxSubSteps) {
        this._fixedUpdate(STEP);
        this.accumulator -= STEP;
        steps += 1;
        if (this.state !== STATE.PLAYING && this.state !== STATE.COUNTDOWN) break;
      }
      if (this.accumulator > STEP * CONFIG.physics.maxSubSteps) this.accumulator = 0;
    } else {
      this.accumulator = 0;
    }

    this.particles.update(dt);
    this.flash = Math.max(0, this.flash - dt * 2.4);
    if (this.toast.life > 0) this.toast.life -= dt;
    if (this.limo) this.camera.update(dt, this._cameraTarget());

    if (this.state === STATE.PLAYING && this.limo) {
      Sound.setEngine(this.limo.speed01, this.limo.boosting);
      Sound.setScreech(clamp((this.limo.slip - 1.2) / 3.2, 0, 1));
    }

    this._draw();
    requestAnimationFrame((t) => this._frame(t));
  }

  _draw() {
    const r = this.renderer;
    r.clear();
    if (!this.track || !this.limo) return;

    const bounds = this.camera.viewBounds(260);
    r.beginWorld(this.camera);
    r.drawGround(bounds);
    r.drawBuildings(this.track, bounds, this.time);
    r.drawRoad(this.track, bounds);
    this.particles.drawSkids(r.ctx);
    r.drawZones(this.track, bounds, this.time);
    r.drawProps(this.track, bounds, this.time);
    r.drawTraffic(this.traffic, bounds);
    r.drawLimo(this.limo, {
      time: this.time,
      underglow: Save.data.equipped.underglow,
      hat: Save.data.equipped.hat,
      boosting: this.limo.boosting,
    });
    r.drawCargo(this.rig, this.time);
    this.particles.draw(r.ctx);
    r.endWorld();

    if (
      this.state === STATE.PLAYING ||
      this.state === STATE.COUNTDOWN ||
      this.state === STATE.PAUSED
    ) {
      r.beginScreen();
      r.drawHud({
        limo: this.limo,
        rig: this.rig,
        track: this.track,
        time: this.time,
        timeLeft: this.timeLeft,
        timeLimit: this.levelDef.timeLimit,
        score: this.score,
        level: this.levelDef.level,
        levelName: this.levelDef.name,
        progress: this.track.progressAt(this.playerIndex),
        flash: this.flash,
        toast: this.toast,
      });
      r.endScreen();
    }
  }
}

export { STATE };
