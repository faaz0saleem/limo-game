# MIDNIGHT LIMO

A 3D night-city drift game in the browser. You drive eight and a half metres of
stretch limousine through a neon grid, pick up fares, and get paid extra for
arriving sideways.

Built on [three.js](https://threejs.org). **No build step and no external
assets** — every texture, model and sound in the game is generated
procedurally at load time, and three.js itself is vendored into the repo. The
only network request is the portal SDK (CrazyGames or Poki); block it and the
game still plays.

---

## Running it

ES modules need to be served over HTTP (`file://` will be blocked by CORS), so
point any static server at the repo root:

```bash
npx http-server -p 8080 -c-1     # or: python3 -m http.server 8080
```

Then open <http://localhost:8080>. There is nothing to install or compile.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | throttle, steer, brake (hold brake at a standstill to reverse) |
| `Space` | handbrake — kicks the rear out |
| `Shift` | boost (recharges when you're off it) |
| `C` | cycle camera: chase → close → hood → cinematic |
| `R` | recover — puts you back on the nearest street, pointed down it |
| `P` | change the paint (midnight, champagne, bordeaux, pearl) |
| `M` | mute |
| `Esc` | pause |

Gamepads work (left stick steers, triggers drive, A/B handbrake, X boost), and
on touch devices an on-screen pad appears automatically.

## How to play

Follow the cyan beacon to your passenger and **slow to under 50 km/h** to stop
for them. The beacon turns gold and a meter starts running — deliver them
before it expires. Payment scales with the passenger's tip rate and how much
time you had left.

Chevrons painted on the tarmac route you street by street — not a straight line
through the buildings — and a floating arrow over the roof points at the next
turn. An arrow pins itself to the screen edge whenever the target is out of
frame.

Drifting banks style points: the multiplier climbs the longer you hold a slide,
and points convert to cash when the drift ends cleanly. Crash and you lose the
drift you were building. The central plaza has a painted ring in it, which is
there for exactly one reason.

Everything you earn banks into a **garage fund** that survives between shifts.
Four cars, each a different handling brief — the Bordeaux Slider trades grip for
a rear end that steps out on command; the Pearl Phantom is quick everywhere.

The city runs a **day/night cycle**: twenty minutes of daylight, twenty of
night, with dawn and dusk in between. Office windows switch off in the morning,
street lights and headlights come on at dusk, and the sky, fog, key light and
exposure all move together.

---

## Publishing to a portal

`src/portal.js` is one abstraction over **GameMonetize, CrazyGames and Poki**.
Only one ad SDK is ever active — shipping two fails review on all of them —
selected by one line in `index.html`:

```html
<script>
  window.GAME_PORTAL = 'gamemonetize';           // or 'crazygames' / 'poki' / 'none'
  window.GAME_ID     = 'x3p3ubo7dt5lf17cabk76rz3yfvqx257';
</script>
```

Append `?portal=none` to the URL to force the standalone path while testing.

### GameMonetize (current build)

Its SDK is loaded by `index.html` rather than by `portal.js`, because
`window.SDK_OPTIONS` has to exist *before* the script runs. Every event is
forwarded to the adapter:

| Event | What the game does |
| --- | --- |
| `SDK_READY` | adapter adopts `window.sdk` |
| `SDK_GAME_PAUSE` | freezes the simulation and **mutes** — mandatory, audio under a video ad is forbidden |
| `SDK_GAME_START` | resumes and unmutes |

Breaks are triggered with `sdk.showBanner()` and resolve on the next
`SDK_GAME_START`, with a 45s fallback for when no ad fills.

### Ad pacing differs per portal, deliberately

`AD_POLICY` in `src/portal.js` holds one row per portal, because the rules
genuinely differ — GameMonetize expects a pre-roll and frequent breaks, while
CrazyGames and Poki reject builds that do that.

| | pre-roll | earliest break | min gap | on pickup |
| --- | --- | --- | --- | --- |
| gamemonetize | yes | immediate | 45s | yes |
| crazygames | no | 30s into driving | 3 min | no |
| poki | no | 30s into driving | 3 min | no |

Breaks never interrupt driving: they fire on a pre-roll, on picking a passenger
up, or on dropping one off. If the SDK is missing, blocked or its CDN hangs,
everything falls through to a stub and the game plays normally — nothing in the
game depends on an ad having played.

### Uploading

```bash
npm run zip        # writes midnight-limo.zip, ~0.5 MB
```

`index.html` ends up at the **root of the archive**, which is what the portals
require — zipping the containing folder instead is the usual reason an upload
is rejected.

### If GameMonetize will not activate the game

Their verifier only lists a game once it has watched a complete ad inside their
iframe. Things that stop that happening, all of which this build now handles:

- **The SDK arriving late.** It is fetched from their CDN and can take well
  over ten seconds. The adapter claims the portal immediately, attaches
  whenever the SDK turns up, and replays any break requested in the meantime —
  it never gives up and disables ads.
- **`SDK_OPTIONS` defined after the loader.** It has to exist before the script
  runs, which is why it lives in `index.html` and not in `portal.js`.
- **Two SDK blocks.** Only one can exist: a second overwrites the first's
  `onEvent`, and the loader no-ops on the duplicate script id.
- **Ads not muting.** `SDK_GAME_PAUSE` freezes the simulation and mutes;
  `SDK_GAME_START` resumes. Audio under a video ad is forbidden.
- **`sdk.showBanner !== 'undefined'`.** That check, straight from their docs,
  compares a function to a string and is always true. Use `typeof`.

Open the console while testing: the adapter logs `SDK attached` and
`sdk.showBanner()` so you can see exactly where a break did or did not fire.

## Game shell

Everything a portal expects a finished game to have:

- **Loading screen** with a real progress bar, percentage and rotating tips.
- **Title screen** showing lifetime records (best shift, best drift, most fares).
- **How to play** panel.
- **Settings**: graphics preset, sound on/off, music on/off, volume slider, and
  a reset-records option. Persisted.
- **Pause**, from `Esc` or an on-screen button, with live shift stats.
- **End of shift** summary — take-home pay, fares, best drift, distance and top
  speed, with a star on anything that beat a personal best — then *drive again*
  without a reload.
- **Fullscreen** toggle.
- **Music**: a synthesised synthwave bed scheduled on the WebAudio clock, whose
  filter opens up as you drive faster. Zero bytes of audio data.

## Graphics

The look comes from a few deliberate choices rather than from asset quality:

- **Real environment lighting.** A night sky is drawn to an equirectangular
  canvas — gradient, stars, moon, and coloured glow domes along the horizon —
  then run through `PMREMGenerator`. That gives the paint and chrome an actual
  environment to reflect, which is what stops the car reading as coloured
  plastic.
- **Clearcoat paint.** The body is `MeshPhysicalMaterial` with a full clearcoat
  layer over metallic base paint, so highlights sit *on* the lacquer.
- **Wet asphalt.** The road's roughness map matters more than its colour: broad
  low-roughness patches read as standing water and mirror the skyline, while
  coarse grain keeps the dry areas from looking like vinyl.
- **Emissive-mapped facades.** Building windows are lit through an emissive map
  so only the lit panes bloom, instead of the whole wall glowing.
- **One combined post pass.** Radial speed blur, chromatic aberration, vignette
  and film grain share a single fullscreen read, sitting between bloom and tone
  mapping. ACES filmic tone mapping and SMAA finish the frame.

## Driving model

`src/vehicle/physics.js` is a two-axle tyre model, not a "turn the car when you
press left" arcade hack. Each axle computes its own slip angle and runs it
through a saturating lateral-force curve (a cheap stand-in for Pacejka). That
one detail is what makes the car behave like a car: break the rears loose and
the fronts still bite, so **countersteering actually catches the slide**.

Three things make the drift feel deliberate rather than random:

- **Weight transfer.** Braking loads the front axle and unloads the rear, so
  trailing the brake into a corner rotates the car; throttle does the reverse.
- **A tyre curve that plateaus.** The peak-sharpness term is below 2, so grip
  eases off past the limit instead of collapsing — a big slide is something you
  can sit in and hold.
- **Extra yaw damping once sideways.** Without it the model is technically
  correct and completely unplayable, because every slide becomes a spin.

The handbrake ramps rather than switching, so the rear breaks away over a few
frames and hooks back up smoothly. Per-car `handling` multipliers (grip, power,
brake, drift, mass) scale the whole model — that's what the garage sells.

### A note on sign conventions

The model is left-positive throughout: positive lateral velocity, positive yaw
and positive steer all mean "left", ISO style. Facing +Z with +Y up in a
right-handed frame, the driver's right is −X, so `Vehicle.left` is the +X
vector. Naming that vector `right` is exactly what once made the controls come
out mirrored; the player's steering input is flipped once, on the way in.

Physics runs on a fixed 120 Hz timestep independent of the render rate.

## Performance

Everything static is merged into as few draw calls as possible: the city is one
mesh per facade variant, and the entire traffic fleet is five `InstancedMesh`es
regardless of how many cars are on the road. Skid marks are a pre-allocated ring
buffer that never grows — the oldest quad is overwritten — and particles are a
fixed pool. Street lights are a handful of real point lights recycled onto
whichever lamp posts are nearest the player.

Three quality presets (low / high / ultra) change resolution scale, shadows,
bloom, draw distance and pool sizes. Your choice is remembered.

## Layout

```
index.html            importmap, HUD markup, menus
styles.css            HUD and menu styling
src/
  main.js             boot, game loop, collision resolution, effect emission
  util.js             maths helpers, seeded RNG
  render/
    renderer.js       WebGL renderer, post-processing chain, quality presets
    post.js           combined cinematic shader + sky dome
    environment.js    procedural night sky → PMREM environment map
    textures.js       every texture in the game, drawn on a canvas
    effects.js        skid marks, particle field, objective beacon
  world/
    city.js           block grid, buildings, street furniture, collision
    traffic.js        instanced ambient traffic
  vehicle/
    spec.js           dimensions and paint jobs (no three.js import)
    limo.js           the limousine model
    physics.js        two-axle drift model
  game/
    chaseCamera.js    travel-direction chase camera with boom collision
    input.js          keyboard / gamepad / touch
    gameplay.js       fares, timers, payouts, drift scoring
    save.js           records + settings, stored via the portal
  ui/
    hud.js            canvas speedometer, minimap, fare card
    menus.js          loading, title, settings, pause, summary screens
  audio/
    engine.js         synthesised engine, tyres, wind, impacts
    music.js          synthesised synthwave bed
  portal.js           CrazyGames / Poki adapter, with a standalone stub
vendor/three/         three.js r169 + the addons used (MIT)
```

`spec.js` exists so the physics model can be imported and unit-tested in Node
without a renderer, a DOM, or a GPU.

## Licence

Game code: do what you like with it. Vendored three.js is MIT, see
`vendor/three/LICENSE`.
