/**
 * Poki SDK bridge.
 *
 * The SDK is loaded from Poki's CDN by index.html. When it isn't there — local
 * development, offline, or an ad blocker — every call falls through to a stub
 * so the game still runs normally. Nothing in the game may depend on an ad
 * having played.
 *
 * Covers Poki's integration checklist:
 *   - init, with loadingStart / loadingProgress / loadingFinished around setup
 *   - gameplayStart / gameplayStop bracketing every playable moment
 *   - commercialBreak only at natural pauses, never mid-drive
 *   - happyTime on a big payday
 *   - the game mutes itself while a break is playing
 *
 * The structure here follows the bridge written on the sibling branch
 * (claude/limo-drift-game-dx164q) so both games behave the same way for the
 * portal; this version drops the rewarded-ad path, which this game has no
 * use for.
 */

class PokiBridge {
  constructor() {
    this.sdk = null;
    this.available = false;
    this.adPlaying = false;
    this._gameplayActive = false;
    this._muteHandlers = [];
    this._faresSinceAd = 0;
  }

  async init() {
    const sdk = typeof window !== 'undefined' ? window.PokiSDK : null;

    if (!sdk || typeof sdk.init !== 'function') {
      console.info('[poki] SDK not present — running with a local stub');
      return this;
    }

    this.sdk = sdk;
    this.available = true;
    try {
      await sdk.init();
    } catch (err) {
      // Poki's own guidance: if init fails, let the player play anyway.
      console.info('[poki] init failed, continuing without ads', err);
    }
    if (typeof sdk.setDebug === 'function' && this._isLocal()) sdk.setDebug(true);
    return this;
  }

  _isLocal() {
    if (typeof location === 'undefined') return true;
    return ['localhost', '127.0.0.1', ''].includes(location.hostname);
  }

  _call(name, ...args) {
    if (!this.available || typeof this.sdk?.[name] !== 'function') return null;
    try {
      return this.sdk[name](...args);
    } catch (err) {
      console.warn(`[poki] ${name} threw`, err);
      return null;
    }
  }

  loadingStart() { this._call('gameLoadingStart'); }
  loadingFinished() { this._call('gameLoadingFinished'); }

  loadingProgress(fraction01) {
    this._call('gameLoadingProgress', {
      percentageDone: Math.round(Math.max(0, Math.min(1, fraction01)) * 100),
    });
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

  /** Interstitial. Always resolves — instantly when there's no SDK. */
  async commercialBreak() {
    const wasPlaying = this._gameplayActive;
    this.gameplayStop();
    this.adPlaying = true;
    this._emitMute(true);
    try {
      const p = this._call('commercialBreak', () => this._emitMute(true));
      if (p && typeof p.then === 'function') await p;
    } catch (err) {
      console.warn('[poki] commercialBreak failed', err);
    } finally {
      this.adPlaying = false;
      this._emitMute(false);
    }
    return wasPlaying;
  }

  /** Poki requires the game to silence itself for the duration of a break. */
  onMuteChange(fn) {
    this._muteHandlers.push(fn);
  }

  _emitMute(muted) {
    for (const fn of this._muteHandlers) {
      try { fn(muted); } catch { /* a broken handler must not break the ad */ }
    }
  }

  /**
   * Interstitials are paced by completed fares, and never on the first one —
   * a player's opening minute should be uninterrupted.
   */
  shouldShowInterstitial() {
    this._faresSinceAd += 1;
    if (this._faresSinceAd >= 3) {
      this._faresSinceAd = 0;
      return true;
    }
    return false;
  }
}

export const Poki = new PokiBridge();
