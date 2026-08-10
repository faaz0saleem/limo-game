/**
 * Poki SDK wrapper.
 *
 * The real SDK is loaded from Poki's CDN by index.html. When it is missing
 * (local dev, offline, blocked by an ad blocker) every call falls through to a
 * stub so the game still runs and rewarded ads "succeed" instantly in dev.
 *
 * Poki integration checklist covered here:
 *   - init + loadingStart / loadingFinished around asset setup
 *   - gameplayStart / gameplayStop bracketing every playable moment
 *   - commercialBreak between attempts (never during gameplay)
 *   - rewardedBreak for the "save my cargo" retry
 *   - happyTime on big wins
 */

const noop = () => {};

class PokiBridge {
  constructor() {
    this.sdk = null;
    this.available = false;
    this.ready = false;
    this.adPlaying = false;
    this._gameplayActive = false;
    this._muteHandlers = [];
    this.attemptsSinceAd = 0;
  }

  async init() {
    const sdk = typeof window !== 'undefined' ? window.PokiSDK : null;
    if (sdk && typeof sdk.init === 'function') {
      this.sdk = sdk;
      this.available = true;
      try {
        await sdk.init();
      } catch (err) {
        // Adblock or SDK failure: Poki's guidance is to keep playing.
        console.info('[poki] init failed, continuing without ads', err);
      }
      if (typeof sdk.setDebug === 'function' && this._isLocal()) sdk.setDebug(true);
    } else {
      console.info('[poki] SDK not present — running with local stub');
    }
    this.ready = true;
    return this;
  }

  _isLocal() {
    if (typeof location === 'undefined') return true;
    return ['localhost', '127.0.0.1', ''].includes(location.hostname);
  }

  _call(name, ...args) {
    if (!this.available || !this.sdk || typeof this.sdk[name] !== 'function') return null;
    try {
      return this.sdk[name](...args);
    } catch (err) {
      console.warn(`[poki] ${name} threw`, err);
      return null;
    }
  }

  loadingStart() {
    this._call('gameLoadingStart');
  }

  loadingFinished() {
    this._call('gameLoadingFinished');
  }

  loadingProgress(value) {
    this._call('gameLoadingProgress', { percentageDone: Math.round(value * 100) });
  }

  gameplayStart() {
    if (this._gameplayActive) return;
    this._gameplayActive = true;
    this._call('gameplayStart');
  }

  gameplayStop() {
    if (!this._gameplayActive) return;
    this._gameplayActive = false;
    this._call('gameplayStop');
  }

  happyTime(intensity = 1) {
    this._call('happyTime', Math.max(0, Math.min(1, intensity)));
  }

  /** Interstitial. Resolves once the break is over (immediately in the stub). */
  async commercialBreak() {
    this.gameplayStop();
    this.adPlaying = true;
    this._emitMute(true);
    try {
      const p = this._call('commercialBreak', () => this._emitMute(true));
      if (p && typeof p.then === 'function') await p;
    } finally {
      this.adPlaying = false;
      this._emitMute(false);
    }
  }

  /**
   * Rewarded video. Resolves true when the player earned the reward.
   * Without the SDK this resolves true so the flow stays testable offline.
   */
  async rewardedBreak() {
    this.gameplayStop();
    this.adPlaying = true;
    this._emitMute(true);
    let success = true;
    try {
      const p = this._call('rewardedBreak', () => this._emitMute(true));
      if (p && typeof p.then === 'function') {
        success = await p;
      } else if (this.available) {
        success = false;
      }
    } catch (err) {
      success = false;
    } finally {
      this.adPlaying = false;
      this._emitMute(false);
    }
    return !!success;
  }

  /** Poki requires the game to mute itself while an ad plays. */
  onMuteChange(fn) {
    this._muteHandlers.push(fn);
  }

  _emitMute(muted) {
    for (const fn of this._muteHandlers) {
      try {
        fn(muted);
      } catch (err) {
        noop();
      }
    }
  }

  /** Interstitials between attempts, skipping the very first one. */
  shouldShowInterstitial() {
    this.attemptsSinceAd += 1;
    if (this.attemptsSinceAd >= 3) {
      this.attemptsSinceAd = 0;
      return true;
    }
    return false;
  }
}

export const Poki = new PokiBridge();
