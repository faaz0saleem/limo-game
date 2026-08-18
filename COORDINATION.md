# Working on this repo alongside another agent

Two Claude sessions were pointed at this repository at the same time:

| Session | Branch | Scope |
| --- | --- | --- |
| "3D game with graphics" | `claude/3d-game-graphics-txupag` | this branch — the 3D game |
| "Limo Drift game concept" | `claude/limo-drift-game-dx164q` | concept / design work |

Direct session-to-session messaging isn't available in these environments
(`ListAgents` reports no reachable peers), so coordination happens here and in
[issue #1](https://github.com/faaz0saleem/limo-game/issues/1).

The repo contained only a placeholder `hi` file when this branch started, so
there was nothing to merge from and the whole game was written from scratch
here.

## If you're the other agent

Please build on top of this rather than in parallel — the rendering, physics,
city and camera are done and tested. The seams designed for extension:

**Gameplay events.** `Gameplay` takes an `onEvent(type, payload)` callback and
emits `picked-up`, `fare-paid`, `fare-lost`, `drift-banked`. Hook new rules
there instead of editing the fare loop.

```js
new Gameplay(scene, city, hud, { onEvent: (type, data) => { /* … */ } });
```

**Vehicle telemetry.** `Vehicle` exposes `position`, `heading`, `velocity`,
`speed` (signed, m/s), `kmh`, `speed01`, `slipAngle`, `wheelSlip`,
`isDrifting`, `gear`, `rpm`, `boostCharge`, `impact`. Read these; don't write
them mid-frame.

**World queries.** `City` exposes `spawnPoints`, `randomSpawn(rand, awayFrom,
minDist)`, `snapToRoad(v)`, `alignedHeading(v, currentHeading)` and
`probe(x, z, radius)` for collision. `Traffic` exposes `cars`, `probe()` and
`shove()`.

**HUD.** `HUD` has `setFare`, `setFareProgress`, `setStats`, `showDrift`,
`bankDrift`, `toast(text, 'good'|'bad')`. Add panels as new methods rather than
reaching into the DOM from gameplay code.

**Tuning.** Driving feel lives in one `CFG` object at the top of
`src/vehicle/physics.js`; graphics presets live in `QUALITY` in
`src/render/renderer.js`. Both are meant to be edited.

## Things that will bite you

These were all found and fixed the hard way — please don't reintroduce them:

- **Light intensities are physical.** three.js r155+ uses real falloff. A
  headlight needs intensity in the thousands, not single digits, or the road
  renders black.
- **The boundary wall needs a fixed inward normal.** Generic "push out of the
  nearest face" ejects the *camera* through the outer face of a thin wall and
  leaves you rendering from behind it. Boundary colliders carry `nx`/`nz`.
- **The chase camera shortens its boom** rather than sliding along walls, for
  the same reason. Minimum boom is 6.5m because the car is 8.6m long.
- **Billboards on the car glare through the bodywork.** Headlight and taillight
  glows are direction-facing quads, deliberately not sprites.
- **`ctx.font` can't take CSS custom properties** — `var(--font)` silently
  fails and the canvas keeps the previous font.
- Physics must not import `limo.js` (it needs a DOM). Dimensions live in
  `src/vehicle/spec.js`.
- **A kerb must push out without bouncing.** Push-out plus a reflected velocity
  is a ratchet: the car gets machine-gunned down the street. Cancel the inward
  component instead, and latch the push-out off while the car is climbing.
- **Limb joints chain through the parent's quaternion.** Computing a child joint
  from sines and cosines is how the pedestrians' arms ended up detached at the
  hip — an Euler triple's signs are very easy to get backwards, and a quaternion
  cannot disagree with itself.
- **A face texture's vertical placement is by sphere latitude, not by height.**
  `uv.y` is linear in the polar angle, so features spaced by eye bunch up near
  the crown. The rows in `faceMap()` were chosen against measured vertex
  positions; if the head geometry changes, re-measure.
- **Saves must go through the Bridge, not `localStorage`.** The portal requires
  it. `localStorage` is only a synchronous mirror so the game can boot with real
  data while the platform read is in flight — do not make it the source of
  truth again. `settings.quality` is the one deliberate exception, kept
  device-local so a phone cannot inherit a desktop's `ultra`.
- **Only a real reward credits an unlock.** `portal.rewarded()` resolves false
  for a skipped, failed or absent ad, and `onWatchAd` must return null on that
  path — otherwise closing the ad frame early buys the car.
- **Do not hide the rewarded affordances when no ad can be served.** They were
  gated on `portal.rewardedAvailable` at first, which made the whole feature
  invisible on a static host and through development. Show the button and
  answer an unfulfillable tap with "no ads available right now" — `onWatchAd`
  reports `unavailable` apart from `skipped` so the UI can say which.
- **Never drop a lifecycle call made before the SDK is up.** `initialize()`
  races a timeout so a slow SDK cannot hold the loading screen, so `gameReady()`
  routinely runs before the Bridge has answered. Queue and replay it — a
  `game_ready` that never arrives leaves the portal's spinner up forever, which
  is indistinguishable from a broken game and fails review.
- **A reviewer has to be able to see an advert.** Every break being tied to
  fares means someone who just drives around never gets one. Keep the
  guaranteed early break.
- **The Playgama adapter must never leave `adHold` set.** Resuming is guaranteed
  by three independent paths (event, poll, watchdog) because a game frozen
  behind an advert that never closed is unrecoverable for the player. Do not
  simplify that down to just the event.

## Testing

There's no test runner wired up, but the physics model is importable in plain
Node once `node_modules/three` is linked to `vendor/three` (gitignored):

```js
import { Vehicle } from './src/vehicle/physics.js';
```

Everything else was verified by driving the real page in headless Chromium via
Playwright — screenshots plus reading `window.__limo` (the live game object is
exposed there for exactly this).
