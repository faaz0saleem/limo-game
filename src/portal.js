/**
 * Game-portal abstraction.
 *
 * CrazyGames and Poki each want their own SDK, and shipping both in one build
 * fails QA on both. So exactly one SDK is loaded at runtime, chosen by
 * `window.GAME_PORTAL` in index.html (or a `?portal=` override for testing),
 * and the rest of the game only ever talks to the interface below.
 *
 *   portal.init()                     load + initialise the SDK
 *   portal.loadingStart/Progress/Stop bracket the procedural build
 *   portal.gameplayStart/Stop         bracket every playable moment
 *   portal.happyTime(0..1)            player did something great
 *   portal.commercialBreak()          interstitial; always resolves
 *   portal.getItem/setItem            storage that survives a portal iframe
 *   portal.onMuteChange(fn)           silence the game during a break
 *
 * With no SDK — local dev, itch.io, a plain web host, or an ad blocker —
 * everything falls through to a stub and the game plays normally. Nothing may
 * ever depend on an ad having played.
 */

/**
 * Ad pacing, per portal — because the rules genuinely differ.
 *
 * CrazyGames and Poki reject builds that advertise too aggressively: nothing
 * before the game is playable, nothing during gameplay, and at least three
 * minutes between interstitials. GameMonetize is built the other way round —
 * it expects a pre-roll and frequent breaks — so it gets the aggressive
 * settings and the others stay compliant.
 *
 *   preroll      show a break the moment a shift starts
 *   firstDelayMs earliest a break may fire, measured from gameplay start
 *   gapMs        minimum spacing between breaks
 *   onPickup     also break when a passenger gets in, not just on drop-off
 */
export const AD_POLICY = {
  gamemonetize: { preroll: true, firstDelayMs: 0, gapMs: 45000, onPickup: true },
  crazygames: { preroll: false, firstDelayMs: 30000, gapMs: 180000, onPickup: false },
  poki: { preroll: false, firstDelayMs: 30000, gapMs: 180000, onPickup: false },
  none: { preroll: false, firstDelayMs: 0, gapMs: 45000, onPickup: true },
};

/* Kept for anything still importing the old names. */
export const AD_COOLDOWN_MS = AD_POLICY.crazygames.gapMs;
export const FIRST_AD_DELAY_MS = AD_POLICY.crazygames.firstDelayMs;

const SDK_URLS = {
  crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
  poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
  // GameMonetize is loaded by index.html, because its SDK_OPTIONS block has to
  // exist before the script runs. Nothing to inject here.
  gamemonetize: null,
};

function loadScript(src, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const el = document.createElement('script');
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    el.src = src;
    el.async = false;
    el.onload = () => finish(true);
    el.onerror = () => finish(false);
    // A hung CDN must never stop the game from starting.
    setTimeout(() => finish(false), timeoutMs);
    document.head.appendChild(el);
  });
}

class Portal {
  constructor() {
    this.name = 'none';
    this.sdk = null;
    this.adPlaying = false;
    this._gameplayActive = false;
    this._muteHandlers = [];
    this._pauseHandlers = [];
    this._sinceAd = 0;
    this._lastAdAt = 0;
    this.gameId = typeof window !== 'undefined' ? window.GAME_ID ?? null : null;
    this._memory = new Map();
  }

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    this._bootAt = Date.now();
    const override = new URLSearchParams(location.search).get('portal');
    const wanted = (override || window.GAME_PORTAL || 'none').toLowerCase();

    if (!(wanted in SDK_URLS)) {
      console.info('[portal] running standalone (no portal SDK)');
      return this;
    }

    if (wanted === 'gamemonetize') {
      await this._initGameMonetize();
      return this;
    }

    const loaded = await loadScript(SDK_URLS[wanted]);
    if (!loaded) {
      console.info(`[portal] ${wanted} SDK failed to load — continuing standalone`);
      return this;
    }

    try {
      if (wanted === 'crazygames' && window.CrazyGames?.SDK) {
        // v3 reads the game ID from the page it is embedded on, but pass it
        // when the SDK accepts one so local/dev builds report correctly too.
        await (this.gameId && window.CrazyGames.SDK.init.length > 0
          ? window.CrazyGames.SDK.init({ gameId: this.gameId })
          : window.CrazyGames.SDK.init());
        this.sdk = window.CrazyGames.SDK;
        this.name = 'crazygames';
      } else if (wanted === 'poki' && window.PokiSDK) {
        await window.PokiSDK.init();
        this.sdk = window.PokiSDK;
        this.name = 'poki';
        if (this._isLocal() && typeof this.sdk.setDebug === 'function') this.sdk.setDebug(true);
      }
    } catch (err) {
      // Both portals say the same thing: if init fails, let them play.
      console.info(`[portal] ${wanted} init failed — continuing standalone`, err);
      this.sdk = null;
      this.name = 'none';
    }

    if (this.sdk) console.info(`[portal] ${this.name} ready`);
    return this;
  }

  get active() {
    return this.sdk !== null;
  }

  /** The pacing rules for whichever portal is live. */
  get policy() {
    return AD_POLICY[this.name] ?? AD_POLICY.none;
  }

  /**
   * GameMonetize's SDK is loaded by index.html so that `window.SDK_OPTIONS`
   * exists before the script runs. All we do here is adopt the global it
   * creates and route its lifecycle events.
   *
   * Its contract is event-driven rather than promise-based:
   *   SDK_READY        the SDK is usable
   *   SDK_GAME_PAUSE   an ad is about to play — pause and mute, mandatory
   *   SDK_GAME_START   the ad finished — resume and unmute
   */
  async _initGameMonetize() {
    /*
     * Never block boot on the SDK, and never give up on it.
     *
     * This used to poll for window.sdk for eight seconds and then permanently
     * disable ads. On a slow connection the SDK arrives later than that, so
     * the game would run with no advertising at all — and GameMonetize will
     * not list a game until its verifier has seen a complete ad play. Now the
     * portal claims the name immediately, attaches whenever the SDK turns up,
     * and replays any break that was requested in the meantime.
     */
    this.name = 'gamemonetize';

    window.__limoPortalEvent = (name) => {
      if (name === 'SDK_GAME_PAUSE') {
        this.adPlaying = true;
        this._emitMute(true);
        this._emitPause(true);
      } else if (name === 'SDK_GAME_START') {
        this.adPlaying = false;
        this._emitMute(false);
        this._emitPause(false);
        this._resolveBreak?.();
      } else if (name === 'SDK_READY') {
        this._sdkReady = true;
        this._attachSdk();
      }
    };

    // SDK_READY is the documented signal, but poll as a backstop in case the
    // global appears without the event firing.
    let waited = 0;
    const poll = setInterval(() => {
      waited += 500;
      this._attachSdk();
      if (this.sdk || waited > 120000) clearInterval(poll);
    }, 500);
    this._attachSdk();

    return this;
  }

  /** Adopt window.sdk once it exists, and flush a queued break. */
  _attachSdk() {
    if (this.sdk || typeof window.sdk === 'undefined' || !window.sdk) return;
    this.sdk = window.sdk;
    console.info('[portal] gamemonetize SDK attached', this.gameId ?? '');
    if (this._pendingBreak) {
      this._pendingBreak = false;
      this.commercialBreak();
    }
  }

  /** Fired alongside mute so the game can freeze for the duration of an ad. */
  onPauseChange(fn) {
    this._pauseHandlers.push(fn);
  }

  _emitPause(paused) {
    for (const fn of this._pauseHandlers) {
      try { fn(paused); } catch { /* a broken handler must not break the ad */ }
    }
  }

  _isLocal() {
    return ['localhost', '127.0.0.1', ''].includes(location.hostname);
  }

  /** Call a method on whichever SDK is live, swallowing portal-side errors. */
  _try(fn) {
    if (!this.sdk) return null;
    try {
      return fn();
    } catch (err) {
      console.warn('[portal] SDK call failed', err);
      return null;
    }
  }

  /* --------------------------------------------------------------- loading */

  loadingStart() {
    if (this.name === 'gamemonetize') return;   // no such API
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.loadingStart();
      else this.sdk.gameLoadingStart();
    });
  }

  loadingProgress(fraction01) {
    // Only Poki exposes a progress channel; CrazyGames just wants start/stop.
    if (this.name !== 'poki') return;
    this._try(() => this.sdk.gameLoadingProgress({
      percentageDone: Math.round(Math.max(0, Math.min(1, fraction01)) * 100),
    }));
  }

  loadingStop() {
    if (this.name === 'gamemonetize') return;
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.loadingStop();
      else this.sdk.gameLoadingFinished();
    });
  }

  /* -------------------------------------------------------------- gameplay */

  gameplayStart() {
    if (this._gameplayActive) return;
    this._gameplayActive = true;
    if (!this._firstPlayAt) this._firstPlayAt = Date.now();
    if (this.name === 'gamemonetize') return;
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.gameplayStart();
      else this.sdk.gameplayStart();
    });
  }

  gameplayStop() {
    if (!this._gameplayActive) return;
    this._gameplayActive = false;
    if (this.name === 'gamemonetize') return;
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.gameplayStop();
      else this.sdk.gameplayStop();
    });
  }

  happyTime(intensity = 1) {
    if (this.name === 'gamemonetize') return;
    const v = Math.max(0, Math.min(1, intensity));
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.happytime();
      else this.sdk.happyTime(v);
    });
  }

  /* ------------------------------------------------------------------- ads */

  /** Interstitial. Always resolves, even if the portal errors or has no fill. */
  async commercialBreak() {
    this.gameplayStop();
    this.adPlaying = true;
    this._emitMute(true);

    try {
      if (this.name === 'gamemonetize' && !this.sdk) {
        // Not ready yet — remember it and let the player carry on. _attachSdk
        // replays it the moment the SDK lands.
        this._pendingBreak = true;
        console.info('[portal] break queued until the SDK is ready');
      } else if (this.name === 'gamemonetize') {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; this._resolveBreak = null; resolve(); } };
          this._resolveBreak = done;          // SDK_GAME_START calls this
          try {
            if (typeof this.sdk.showBanner === 'function') {
              console.info('[portal] sdk.showBanner()');
              this.sdk.showBanner();
            } else done();
          } catch { done(); }
          // If no ad fills, SDK_GAME_START may never come.
          setTimeout(done, 45000);
        });
      } else if (this.name === 'crazygames') {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          try {
            this.sdk.ad.requestAd('midgame', {
              adStarted: () => this._emitMute(true),
              adFinished: done,
              adError: done,
            });
          } catch { done(); }
          // No-fill sometimes fires no callback at all.
          setTimeout(done, 45000);
        });
      } else if (this.name === 'poki') {
        const p = this._try(() => this.sdk.commercialBreak(() => this._emitMute(true)));
        if (p && typeof p.then === 'function') await p;
      }
    } catch (err) {
      console.warn('[portal] commercial break failed', err);
    } finally {
      this.adPlaying = false;
      this._emitMute(false);
    }
  }

  /**
   * Called on every completed fare. Shows an ad as often as the portal allows
   * — which is once per AD_COOLDOWN_MS, not once per fare. The cooldown is the
   * binding constraint, not the fare count.
   */
  shouldShowInterstitial() {
    // Deliberately not gated on `active`: with GameMonetize the SDK can attach
    // after the first break is due, and that break still needs to happen.
    if (this.name === 'none') return false;
    const pol = this.policy;
    const now = Date.now();

    if (!this._lastAdAt) {
      // Measured from gameplay start, never from page load.
      if (!this._firstPlayAt || now - this._firstPlayAt < pol.firstDelayMs) return false;
    } else if (now - this._lastAdAt < pol.gapMs) {
      return false;
    }

    this._lastAdAt = now;
    return true;
  }

  /** Mark a break as shown, for breaks triggered outside the fare loop. */
  noteAdShown() {
    this._lastAdAt = Date.now();
  }

  onMuteChange(fn) {
    this._muteHandlers.push(fn);
  }

  _emitMute(muted) {
    for (const fn of this._muteHandlers) {
      try { fn(muted); } catch { /* a broken handler must not break the ad */ }
    }
  }

  /* --------------------------------------------------------------- storage */

  /*
   * Portal iframes routinely partition or block third-party storage, so every
   * path here is guarded and ultimately falls back to memory. CrazyGames
   * provides its own store that works inside their frame.
   */

  getItem(key) {
    if (this.name === 'crazygames') {
      const v = this._try(() => this.sdk.data.getItem(key));
      if (v !== null && v !== undefined) return v;
    }
    try {
      const v = localStorage.getItem(key);
      if (v !== null) return v;
    } catch { /* blocked */ }
    return this._memory.get(key) ?? null;
  }

  setItem(key, value) {
    const v = String(value);
    this._memory.set(key, v);
    if (this.name === 'crazygames') {
      const ok = this._try(() => { this.sdk.data.setItem(key, v); return true; });
      if (ok) return;
    }
    try { localStorage.setItem(key, v); } catch { /* blocked; memory holds it */ }
  }
}

export const portal = new Portal();
