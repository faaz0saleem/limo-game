/**
 * Playgama Bridge adapter.
 *
 * The Bridge is loaded from Playgama's CDN as a plain script in index.html and
 * publishes a global `bridge`. On a supported portal it forwards to that
 * portal's own SDK; everywhere else — including a plain static host, which is
 * how this game is developed and tested — it falls back to a mock platform that
 * returns safe defaults. Nothing here should ever be load-bearing.
 *
 * Two rules drive the whole design:
 *
 * 1. **Never let an advert strand the game.** The one unrecoverable failure is
 *    pausing for an advert whose "closed" signal never arrives, because the
 *    player is then stuck staring at a frozen car with no way out. So the
 *    resume path does not trust a single source: it listens for state-change
 *    events, polls the state as a backup, and finally has a watchdog that
 *    resumes regardless. Pausing is best-effort; resuming is guaranteed.
 *
 * 2. **Never trust the shape of the API.** Every call is feature-detected and
 *    wrapped, and the ad states are compared as plain strings rather than
 *    against imported constants, so a missing or renamed member downgrades the
 *    feature instead of throwing inside the game loop.
 */

/* Ad lifecycle states, as the Bridge reports them. Anything not in OPEN or
 * PENDING is treated as "over", which is the safe direction to be wrong in. */
const PENDING = new Set(['loading']);
const OPEN = new Set(['opened']);

const INIT_TIMEOUT = 6000;      // ms before boot stops waiting on the Bridge
const OPEN_TIMEOUT = 5000;      // ms before an ad that never opened is given up
const SHOW_TIMEOUT = 240000;    // ms before an ad that never closed is given up

export class Playgama {
  /**
   * @param {object} hooks
   * @param {() => void} hooks.onAdOpen   pause and mute — adverts must not play
   *                                      over game audio
   * @param {() => void} hooks.onAdClose  resume
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.ready = false;
    this.platform = 'none';
    this.adOpen = false;
    this._pending = null;       // { kind, resolve, opened, since }
    this._poll = 0;
    this._lastBreak = -Infinity;
  }

  get _bridge() {
    return typeof window !== 'undefined' ? window.bridge : null;
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Resolves once the Bridge is up, or once we have waited long enough that
   * holding the loading screen for it is worse than going without.
   *
   * It keeps listening after the timeout: a late `initialize` still switches
   * the adapter on, it just does not get to delay the title screen. Giving up
   * permanently on a timer is how the previous portal integration ended up
   * silently disabled on exactly the slow connections that needed it.
   */
  async initialize() {
    const bridge = this._bridge;
    if (!bridge?.initialize) return false;

    const started = bridge.initialize()
      .then(() => { this._onReady(); return true; })
      .catch((err) => { console.warn('[playgama] initialize failed', err); return false; });

    const timeout = new Promise((r) => setTimeout(() => r(false), INIT_TIMEOUT));
    return Promise.race([started, timeout]);
  }

  _onReady() {
    const bridge = this._bridge;
    this.ready = true;
    this.platform = this._try(() => bridge.platform.id) ?? 'unknown';

    // Subscribe if the event API is there; the poll in _tick() is the backup,
    // so a missing or differently-named event only costs latency.
    for (const name of ['interstitial_state_changed', 'rewarded_state_changed']) {
      this._try(() => bridge.advertisement.on(name, (state) => this._onAdState(state)));
    }
    this._try(() => bridge.advertisement.setMinimumDelayBetweenInterstitial(60));
  }

  /** Tell the platform the game is playable — this is what stops its spinner. */
  gameReady() {
    this._message('game_ready');
  }

  gameplayStarted() {
    this._message('gameplay_started');
  }

  gameplayStopped() {
    this._message('gameplay_stopped');
  }

  _message(name) {
    if (!this.ready) return;
    this._try(() => this._bridge.platform.sendMessage(name));
  }

  /* ---------------------------------------------------------------- banner */

  showBanner() {
    if (!this.ready) return;
    this._try(() => this._bridge.advertisement.showBanner({ position: 'bottom' }));
  }

  hideBanner() {
    if (!this.ready) return;
    this._try(() => this._bridge.advertisement.hideBanner());
  }

  /* ------------------------------------------------------------- ad breaks */

  /**
   * Show an interstitial, if one is due.
   *
   * @param {number} minGap seconds since the last break before another is
   *   allowed. The platform enforces its own floor as well; this is only so the
   *   game does not *ask* more often than it should.
   * @returns {Promise<void>} resolves when the game may run again — which is
   *   immediately if no ad was shown.
   */
  interstitial(minGap = 60) {
    const now = performance.now() / 1000;
    if (!this.ready || this._pending || now - this._lastBreak < minGap) {
      return Promise.resolve();
    }
    this._lastBreak = now;
    return this._run('interstitial', () => this._bridge.advertisement.showInterstitial());
  }

  /**
   * @returns {Promise<boolean>} whether the player actually earned the reward.
   */
  rewarded() {
    if (!this.ready || this._pending) return Promise.resolve(false);
    return this._run('rewarded', () => this._bridge.advertisement.showRewarded())
      .then(() => this._rewardEarned === true);
  }

  _run(kind, show) {
    this._rewardEarned = false;
    return new Promise((resolve) => {
      this._pending = { kind, resolve, opened: false, since: performance.now() };
      if (!this._try(show)) {
        this._finish();
        return;
      }
      // Poll as well as listen. The Bridge's mock platform, and some portals,
      // resolve the call without ever emitting a state change.
      clearInterval(this._poll);
      this._poll = setInterval(() => this._tick(), 250);
    });
  }

  _tick() {
    const p = this._pending;
    if (!p) { clearInterval(this._poll); return; }

    const key = p.kind === 'rewarded' ? 'rewardedState' : 'interstitialState';
    const state = this._try(() => this._bridge.advertisement[key]);
    if (typeof state === 'string') this._onAdState(state);
    if (!this._pending) return;

    // Watchdogs. An ad that never opened was never going to; an ad that opened
    // and never closed has taken longer than any real advert, and leaving the
    // player frozen is worse than dropping an impression.
    const waited = performance.now() - p.since;
    if ((!p.opened && waited > OPEN_TIMEOUT) || waited > SHOW_TIMEOUT) {
      if (p.opened) console.warn('[playgama] advert never closed — resuming');
      this._finish();
    }
  }

  _onAdState(state) {
    const p = this._pending;
    if (!p || typeof state !== 'string') return;
    const s = state.toLowerCase();

    if (s === 'rewarded') this._rewardEarned = true;

    if (OPEN.has(s)) {
      if (!p.opened) {
        p.opened = true;
        p.since = performance.now();
        this.adOpen = true;
        this._try(() => this.hooks.onAdOpen?.());
      }
      return;
    }
    if (PENDING.has(s)) return;
    this._finish();               // closed, failed, empty, or anything unknown
  }

  _finish() {
    const p = this._pending;
    if (!p) return;
    this._pending = null;
    clearInterval(this._poll);
    this._poll = 0;
    if (this.adOpen) {
      this.adOpen = false;
      this._try(() => this.hooks.onAdClose?.());
    }
    p.resolve();
  }

  /** Run a Bridge call, swallowing anything it throws. */
  _try(fn) {
    try {
      const v = fn();
      return v === undefined ? true : v;
    } catch (err) {
      console.warn('[playgama] call failed', err);
      return null;
    }
  }
}
