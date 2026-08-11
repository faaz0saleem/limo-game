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

const SDK_URLS = {
  crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
  poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
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
    this._sinceAd = 0;
    this._memory = new Map();
  }

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    const override = new URLSearchParams(location.search).get('portal');
    const wanted = (override || window.GAME_PORTAL || 'none').toLowerCase();

    if (!SDK_URLS[wanted]) {
      console.info('[portal] running standalone (no portal SDK)');
      return this;
    }

    const loaded = await loadScript(SDK_URLS[wanted]);
    if (!loaded) {
      console.info(`[portal] ${wanted} SDK failed to load — continuing standalone`);
      return this;
    }

    try {
      if (wanted === 'crazygames' && window.CrazyGames?.SDK) {
        await window.CrazyGames.SDK.init();
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
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.loadingStop();
      else this.sdk.gameLoadingFinished();
    });
  }

  /* -------------------------------------------------------------- gameplay */

  gameplayStart() {
    if (this._gameplayActive) return;
    this._gameplayActive = true;
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.gameplayStart();
      else this.sdk.gameplayStart();
    });
  }

  gameplayStop() {
    if (!this._gameplayActive) return;
    this._gameplayActive = false;
    this._try(() => {
      if (this.name === 'crazygames') this.sdk.game.gameplayStop();
      else this.sdk.gameplayStop();
    });
  }

  happyTime(intensity = 1) {
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
      if (this.name === 'crazygames') {
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
   * Paced by completed fares, and never in the player's opening minutes —
   * both portals penalise games that interrupt too early or too often.
   */
  shouldShowInterstitial() {
    this._sinceAd += 1;
    if (this._sinceAd >= 3) {
      this._sinceAd = 0;
      return true;
    }
    return false;
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
