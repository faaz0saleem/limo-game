# Limo Drift: Maximum Cargo

A top-down, physics-driven driving game. You are a valet with a very bad job:
deliver increasingly absurd, unbalanced cargo across a chaotic procedural city
in an **infinitely stretchy limousine**. Every level you finish bolts another
segment onto the limo and another ridiculous item onto its roof.

- **Level 1** — a standard limo carrying a wedding cake.
- **Level 3** — an extra-long limo carrying a cake, a sleeping giraffe and a full swimming pool.
- **Level 7** — a super-limo carrying an entire bouncy castle and a stack of giant speakers.
- **Level 10** — "Maximum Cargo": ten segments, ten items, no sympathy.

Drift too hard and the straps snap and your cargo goes bouncing down the street.
Drive too slow and the client calls.

```
npm start          # serves the game at http://localhost:8080
```

No build step, no bundler, no external asset downloads — open `index.html`
through any static server and it runs.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Steer / drift | `←` `→` or `A` `D` | on-screen arrows |
| Turbo | `Space` | TURBO button |
| Handbrake (kills grip, swings the tail) | `Shift` / `S` / `↓` | ✋ button |
| Horn | `H` | — |
| Restart level | `R` | — |
| Pause | `Esc` / `P` | — |
| Mute | `M` | 🔊 in the menu |

The throttle is automatic. It is a two-button game: steer, and pick your moments
to boost.

## How it works

### Whip-physics trailer system

The limo is a chain of rectangular Matter.js bodies: a cab plus *N* trailer
segments, joined by **zero-length revolute constraints** anchored at each
segment's nose and tail (`src/vehicle.js`). Segments share a negative collision
group so they never collide with each other, and a soft angular limiter stops
the chain inverting on itself while still allowing a proper jackknife.

Driving is solved in velocity space on top of Matter's rigid-body pass. Each
step, per segment:

1. velocity is decomposed into forward / lateral components in the segment's own frame;
2. thrust is applied along that segment's heading (every segment is driven — thrusting
   only the cab would make the limo slower the longer it gets, because the cab
   would have to drag the whole chain through the joints);
3. lateral velocity is scrubbed off by a **grip curve** that saturates:

   ```
   grip = base
   if |v_lateral| > slipLimit:
       grip *= (slipLimit / |v_lateral|) ^ gripFalloff
   ```

   Past the slip limit the tires let go, grip collapses and the segment slides.
   That saturation is the whole drift model — it is why hard corners break away
   and why the tail steps out before the cab does.
4. trailing segments get progressively **less** grip the further back they are
   (`tailGripFalloff`), so the back of the limo whips wider than the front.

Oil slicks multiply grip down to near zero, the handbrake multiplies it down on
demand, and airborne segments have almost none at all.

### Cargo balance meter

Each item of cargo is a real Matter body held to its host segment by a real,
soft `Matter.Constraint` (`src/cargo.js`). Cornering load transfer is injected
as extra *apparent* inertia — the cargo's velocity is pushed against its host
segment's measured acceleration, scaled by a per-item `topHeavy` factor. A grand
piano barely moves; a full swimming pool and a champagne pyramid slosh alarmingly.

The strap's **stretch is the tilt meter**. Past `breakDistance` the constraint is
genuinely removed from the world: collision filters flip from "attached"
(collides with nothing) to "loose", friction is applied, and the item is flung
with the limo's velocity plus the direction it was already leaning. It then
tumbles down the street as an ordinary rigid body.

Because the load transfer is a velocity effect and the cargo bodies are light,
cargo never robs the limo of acceleration — it only threatens to leave.

### Procedural city tracks

`src/track.js` walks a centerline out of weighted pieces — straights, sweepers,
curves, hairpins, chicanes, narrow alleys and wide intersections — with
difficulty shifting the weights toward the nastier ones as levels climb. Each
candidate piece is tested against a spatial hash of everything already placed and
rejected if the road would run on top of itself, so layouts stay untangled.

From the centerline it derives:

- **kerb walls** — the edge polylines are simplified first, so long straights
  become a couple of big static bodies instead of hundreds of little ones;
- **hazards** — oil slicks, launch ramps, cobbled bump strips and turbo pads;
- **props** — cones, barrels, bins and hydrants that scatter on contact;
- **traffic** — civilian cars that follow the centerline in lanes, some oncoming,
  which spin out and honk when you clip them (`src/traffic.js`), and which only
  simulate near the player;
- **decor** — city blocks with lit windows either side of the road.

Ramps launch the limo one segment at a time, so a jump ripples down the length of
the car and slams the cargo on landing.

### Scoring

`src/score.js`: delivery base + time remaining + per-item cargo integrity + drift
style (accumulated from drift angle × speed) + a max-drift-angle bonus, with
bonuses for a spotless delivery and for trading no paint. Score is multiplied by
the level's pay rate; cash for the garage is derived from it.

### Visual polish

Tire smoke and skid marks from every sliding wheel, oil-black smoke on slicks,
trauma-based screen shake on impacts and cargo losses, confetti on checkpoints
and deliveries, boost flames, headlight cones, animated cargo (sloshing pool
water, a flag-waving bouncy castle, pulsing speaker cones, a blinking sleeping
giraffe), and a camera that automatically zooms out as the limo grows so a
ten-segment super-limo always fits on screen.

### Poki SDK integration

`src/poki.js` wraps the SDK and falls back to a stub when it is absent (local
dev, offline, ad blockers), so the game always runs:

- `gameLoadingStart` / `gameLoadingProgress` / `gameLoadingFinished` around boot
- `gameplayStart` / `gameplayStop` bracketing every playable moment, including
  pauses and result screens
- `commercialBreak` between attempts (never during gameplay), skipping the first
  couple so the first-time experience is clean
- `rewardedBreak` for the two reward hooks: **rescue the run** (cargo
  re-strapped, +15s, resume where you crashed) and **double the delivery cash**
- `happyTime` on a successful delivery
- audio is muted for the duration of any break, as Poki requires

High scores, per-level bests, cash and garage unlocks persist through
`localStorage` with an in-memory fallback when storage is blocked
(`src/save.js`).

## Project layout

```
index.html          markup, screens, Poki + Matter script tags
styles.css          menu / HUD / garage styling
vendor/             matter.min.js (v0.20.0, MIT)
src/
  main.js           bootstrap
  game.js           state machine, fixed-timestep loop, collisions, results
  config.js         every tuning constant in one table
  vehicle.js        the limo: segments, joints, grip curve, drift telemetry
  cargo.js          breakable cargo straps + balance meter
  cargoTypes.js     the cargo catalogue and how each item is drawn
  track.js          procedural city generator
  traffic.js        civilian car AI
  render.js         all drawing (world + HUD)
  camera.js         chase camera, auto zoom, screen shake
  particles.js      pooled particles and skid marks
  levels.js         level curve, cargo manifests, time limits
  score.js          delivery scoring
  customize.js      garage catalogue (underglow, horns, driver hats)
  input.js          keyboard + touch
  audio.js          fully procedural WebAudio kit (no audio files)
  poki.js           Poki SDK wrapper with offline stub
  save.js           persistence
scripts/
  check.mjs         parses every module
  smoke-test.mjs    headless playthrough assertions
  autoplay.mjs      bot plays every level; checks they are completable
  probe.mjs         physics feel readouts (speed, drift, tilt, jackknife)
```

## Development

```
npm start                   # static server on :8080
npm run check               # parse every module
npm test                    # headless Chromium smoke test
node scripts/autoplay.mjs   # bot-plays levels 1-10 and reports balance
node scripts/probe.mjs 7    # physics telemetry for a given level
```

`window.__limo` (the game) and `window.__CONFIG` (the tuning table) are exposed
on the page, so values can be tweaked live from the browser console.

## Licence

MIT. Bundles [Matter.js](https://brm.io/matter-js/) v0.20.0, also MIT — see
`vendor/matter-LICENSE.txt`.
