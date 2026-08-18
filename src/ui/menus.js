import { formatMoney } from '../util.js';
import { CARS, statBars, adsToUnlock } from '../game/garage.js';
import { limoProfile } from '../render/textures.js';
import { PAINT_JOBS } from '../vehicle/spec.js';

/* Every screen outside the HUD: loading, title, how-to, settings, pause and
 * the end-of-shift summary. Owns the DOM so main.js only deals in callbacks. */

const TIPS = [
  'Hold the handbrake through a corner — the multiplier climbs the longer you stay sideways.',
  'The painted ring in the central plaza is there for donuts. Use it.',
  'Boost recharges whenever you are off it. Save it for the long avenues.',
  'You have to slow down to pick a passenger up. Arriving at 200 km/h just drives past them.',
  'Crashing cancels the drift you were building. Land it before you bank it.',
  'Press C to change camera. The hood view is the fastest-feeling one.',
  'Delivering with time to spare pays a bonus on top of the fare.',
  'Traffic brakes for you, but it still hurts. Weave, do not bulldoze.',
  'The arrows on the road follow the streets, not the crow. Trust them.',
  'Everything you bank goes to the garage fund. A better limo grips harder.',
  'The city runs on a real clock — twenty minutes of daylight, then twenty of night.',
  'Braking as you turn in rotates the car. Trail the brake into a corner.',
];

const PANELS = ['panel-loading', 'panel-start', 'panel-howto', 'panel-settings',
  'panel-pause', 'panel-summary', 'panel-garage', 'panel-offer'];

export class Menus {
  constructor(handlers = {}) {
    this.h = handlers;
    this.overlay = document.getElementById('overlay');
    this.el = {};
    for (const id of PANELS) this.el[id] = document.getElementById(id);

    this.bar = document.getElementById('loadbar-fill');
    this.loadText = document.getElementById('loadtext');
    this.loadPct = document.getElementById('loadpct');
    this.loadTip = document.getElementById('load-tip');

    this._tipIndex = Math.floor(Math.random() * TIPS.length);
    this.loadTip.textContent = TIPS[this._tipIndex];
    this._tipTimer = setInterval(() => {
      this._tipIndex = (this._tipIndex + 1) % TIPS.length;
      this.loadTip.textContent = TIPS[this._tipIndex];
    }, 4200);

    this._bind();
    this._bindRotateHint();
  }

  _bind() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    on('btn-start', () => this.h.onStart?.());
    on('btn-again', () => this.h.onRestart?.());
    on('btn-resume', () => this.h.onResume?.());
    on('btn-end-shift', () => this.h.onEndShift?.());
    on('btn-settings', () => this.show('panel-settings'));
    on('btn-pause-settings', () => this.show('panel-settings', 'panel-pause'));
    on('btn-pause-garage', () => this.showGarage('panel-pause'));
    on('btn-howto', () => this.show('panel-howto'));
    on('btn-garage', () => this.showGarage());
    on('btn-summary-garage', () => this.showGarage('panel-summary'));
    on('btn-pause', () => this.h.onPause?.());
    on('btn-offer-watch', () => this._watchAd(this._offerCar));
    on('btn-offer-no', () => this.show(this._offerReturn ?? 'panel-start'));
    on('btn-fullscreen', () => this.toggleFullscreen());
    on('btn-reset', () => {
      this.h.onResetRecords?.();
      this._flash('btn-reset', 'records cleared');
    });

    // "BACK" buttons remember where they came from.
    for (const b of document.querySelectorAll('[data-back]')) {
      b.addEventListener('click', () => this.show(this._returnTo || b.dataset.back));
    }

    // Settings segmented controls.
    this._segment('seg-quality', 'q', (v) => this.h.onQuality?.(v));
    this._segment('seg-sound', 'v', (v) => this.h.onSound?.(v === 'on'));
    this._segment('seg-music', 'v', (v) => this.h.onMusic?.(v === 'on'));

    const vol = document.getElementById('rng-volume');
    vol?.addEventListener('input', () => this.h.onVolume?.(vol.value / 100));
  }

  _segment(groupId, attr, fn) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      for (const b of group.querySelectorAll('.seg-btn')) b.classList.remove('is-on');
      btn.classList.add('is-on');
      fn(btn.dataset[attr]);
    });
  }

  _flash(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 1400);
  }

  /** Portrait phones get a nudge; landscape is a much better play area. */
  _bindRotateHint() {
    const hint = document.getElementById('rotate-hint');
    if (!hint) return;
    const check = () => {
      const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
      const portrait = window.innerHeight > window.innerWidth;
      hint.classList.toggle('hidden', !(coarse && portrait));
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
  }

  /* ---------------------------------------------------------------- panels */

  show(id, returnTo = null) {
    this._returnTo = returnTo;
    this.activePanel = id;
    // Coming back to the title after a shift must show the updated records.
    if (id === 'panel-start' && this.h.getRecords) this._paintRecords(this.h.getRecords());
    this.overlay.classList.remove('hidden');
    for (const p of PANELS) this.el[p]?.classList.toggle('hidden', p !== id);
  }

  hide() {
    this.overlay.classList.add('hidden');
  }

  /** Which panel is actually on screen — nothing, if the overlay is hidden. */
  get shownPanel() {
    return this.visible ? this.activePanel : null;
  }

  get visible() {
    return !this.overlay.classList.contains('hidden');
  }

  /* --------------------------------------------------------------- loading */

  setProgress(pct, text) {
    this.bar.style.width = `${pct}%`;
    this.loadPct.textContent = `${Math.round(pct)}%`;
    if (text) this.loadText.textContent = text;
  }

  doneLoading() {
    clearInterval(this._tipTimer);
  }

  /* ----------------------------------------------------------------- title */

  showTitle(records) {
    this._paintRecords(records);
    this.show('panel-start');
  }

  _paintRecords(records) {
    document.getElementById('rec-cash').textContent = formatMoney(records.bestCash);
    document.getElementById('rec-drift').textContent =
      Math.round(records.bestDrift).toLocaleString('en-US');
    document.getElementById('rec-fares').textContent = records.bestFares;
    const w = document.getElementById('rec-wallet');
    if (w) w.textContent = formatMoney(records.wallet);
  }

  syncSettings(s, resolvedQuality) {
    const pick = (groupId, value) => {
      const group = document.getElementById(groupId);
      if (!group) return;
      for (const b of group.querySelectorAll('.seg-btn')) {
        const v = b.dataset.q ?? b.dataset.v;
        b.classList.toggle('is-on', v === value);
      }
    };
    pick('seg-quality', s.quality ?? resolvedQuality);
    pick('seg-sound', s.sound ? 'on' : 'off');
    pick('seg-music', s.music ? 'on' : 'off');
    const vol = document.getElementById('rng-volume');
    if (vol) vol.value = Math.round((s.volume ?? 0.8) * 100);
  }

  /* ----------------------------------------------------------------- pause */

  showPause(stats) {
    const bits = [
      `<span>${formatMoney(stats.cash)} earned</span>`,
      `<span>·</span><span><b>${stats.fares}</b> fares</span>`,
      `<span>·</span><span>best drift <b>${Math.round(stats.bestDrift).toLocaleString('en-US')}</b></span>`,
    ];
    if (stats.hits) bits.push(`<span>·</span><span class="warn"><b>${stats.hits}</b> hit</span>`);
    document.getElementById('pause-stats').innerHTML = bits.join('');
    this.show('panel-pause');
  }

  /* --------------------------------------------------------------- summary */

  showSummary(shift, records) {
    document.getElementById('sum-cash').textContent = formatMoney(shift.cash);

    const cells = [
      ['FARES DELIVERED', shift.fares, records.fares],
      ['BEST DRIFT', Math.round(shift.bestDrift).toLocaleString('en-US'), records.drift],
      ['DISTANCE', `${(shift.distance / 1000).toFixed(2)} km`, false],
      ['TOP SPEED', `${Math.round(shift.topSpeed)} km/h`, records.speed],
      ['PEOPLE HIT', shift.hits ?? 0, false],
    ];
    document.getElementById('sum-grid').innerHTML = cells.map(([k, v, rec]) =>
      `<div class="sum-cell${rec ? ' is-record' : ''}">
         <span class="sum-k">${k}</span><span class="sum-v">${v}</span>
       </div>`).join('');

    this.show('panel-summary');
  }

  /* ---------------------------------------------------------------- garage */

  showGarage(returnTo = 'panel-start') {
    this.renderGarage();
    this.show('panel-garage', returnTo);
  }

  renderGarage() {
    const save = this.h.getRecords?.();
    if (!save) return;
    document.getElementById('garage-wallet').textContent = formatMoney(save.wallet);

    document.getElementById('garage-list').innerHTML = CARS.map((car) => {
      const owned = save.owned.includes(car.id);
      const equipped = save.car === car.id;
      const afford = save.wallet >= car.price;

      const bars = statBars(car).map(([k, v]) => `
        <div class="bar-row"><span class="bar-k">${k}</span>
          <span class="bar"><i style="width:${(v * 100).toFixed(0)}%"></i></span></div>`).join('');

      // A locked car offers both routes: pay for it, or watch for it. The ad
      // button only appears when the platform can actually serve one.
      const needed = adsToUnlock(car);
      const watched = save.adProgress?.[car.id] ?? 0;
      const adButton = !owned && needed > 0 && this.h.canWatchAd?.()
        ? `<button class="btn-ghost car-btn is-ad" data-ad="${car.id}">
             ▶ WATCH AD<span class="ad-count">${watched}/${needed}</span>
           </button>`
        : '';

      const action = equipped
        ? '<span class="car-tag">IN USE</span>'
        : owned
          ? `<button class="btn-ghost car-btn" data-equip="${car.id}">DRIVE THIS</button>`
          : `<button class="btn-ghost car-btn${afford ? '' : ' is-locked'}"
               data-buy="${car.id}" ${afford ? '' : 'disabled'}>
               ${afford ? 'BUY ' + formatMoney(car.price) : formatMoney(car.price)}
             </button>${adButton}`;

      return `<div class="car-card${equipped ? ' is-equipped' : ''}">
          <img class="car-shot" alt="${car.name}" src="${this._portrait(car.paint)}">
          <div class="car-body">
            <div class="car-name">${car.name}</div>
            <div class="car-blurb">${car.blurb}</div>
            ${bars}
          </div>
          <div class="car-action">${action}</div>
        </div>`;
    }).join('');

    for (const b of document.querySelectorAll('#garage-list [data-buy]')) {
      b.addEventListener('click', () => { this.h.onBuy?.(b.dataset.buy); this.renderGarage(); });
    }
    for (const b of document.querySelectorAll('#garage-list [data-equip]')) {
      b.addEventListener('click', () => { this.h.onEquip?.(b.dataset.equip); this.renderGarage(); });
    }
    for (const b of document.querySelectorAll('#garage-list [data-ad]')) {
      b.addEventListener('click', () => {
        b.disabled = true;               // one view per click, not per impatience
        this._watchAd(b.dataset.ad, 'panel-garage');
      });
    }
  }

  /* ----------------------------------------------------------- ad unlocks */

  /**
   * The cheapest car the player has not got yet — the one worth offering.
   * @returns {object|null}
   */
  nextLockedCar() {
    const save = this.h.getRecords?.();
    if (!save) return null;
    return CARS.filter((c) => !save.owned.includes(c.id) && adsToUnlock(c) > 0)
      .sort((a, b) => a.price - b.price)[0] ?? null;
  }

  /**
   * The "watch an ad for a car" popup.
   *
   * @param {object} car
   * @param {string} returnTo panel to fall back to when they decline or finish
   * @returns {boolean} whether it was shown — it is skipped when there is
   *   nothing left to unlock or no ad to serve
   */
  showOffer(car = this.nextLockedCar(), returnTo = 'panel-start') {
    if (!car || !this.h.canWatchAd?.()) return false;
    const save = this.h.getRecords?.();
    const needed = adsToUnlock(car);
    const watched = save?.adProgress?.[car.id] ?? 0;

    this._offerCar = car.id;
    this._offerReturn = returnTo;
    document.getElementById('offer-shot').src = this._portrait(car.paint);
    document.getElementById('offer-shot').alt = car.name;
    document.getElementById('offer-name').textContent = car.name;
    document.getElementById('offer-blurb').textContent = car.blurb;
    document.getElementById('offer-progress').textContent = needed === 1
      ? 'ONE AD UNLOCKS IT'
      : `${watched} / ${needed} ADS WATCHED`;
    this.show('panel-offer', returnTo);
    return true;
  }

  /**
   * Play the ad and report back.
   *
   * The button is disabled for the duration: the ad opens in its own frame, so
   * without this the player can hammer it and queue several unlocks off one
   * view.
   */
  async _watchAd(carId, returnTo = this._offerReturn ?? 'panel-start') {
    const car = CARS.find((c) => c.id === carId);
    if (!car) return;
    const btn = document.getElementById('btn-offer-watch');
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'LOADING AD…'; }

    const result = await this.h.onWatchAd?.(car.id);

    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (!result) {                       // no reward earned — nothing changes
      this.show(returnTo);
      return;
    }
    if (result.unlocked) {
      // Land them in the garage looking at the car they just won.
      this.showGarage(returnTo === 'panel-garage' ? 'panel-start' : returnTo);
      this._flash('garage-wallet', `${car.name.toUpperCase()} UNLOCKED`);
      return;
    }
    // Still short — show them how far along they are rather than dropping them
    // back to the menu with no feedback.
    this.showOffer(car, returnTo);
  }

  /** Side-on portrait of the car, drawn on a canvas in its own paint. */
  _portrait(paintName) {
    const job = PAINT_JOBS[paintName] ?? PAINT_JOBS.midnight;
    return limoProfile(job.paint, job.accent);
  }

  /* ------------------------------------------------------------ fullscreen */

  toggleFullscreen() {
    const el = document.documentElement;
    try {
      if (!document.fullscreenElement) {
        (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
      } else {
        (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
      }
    } catch { /* some embeds disallow it; not worth surfacing */ }
  }
}
