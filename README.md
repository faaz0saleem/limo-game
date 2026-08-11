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

Drifting banks style points: the multiplier climbs the longer you hold a slide,
and points convert to cash when the drift ends cleanly. Crash and you lose the
drift you were building. The central plaza has a painted ring in it, which is
there for exactly one reason.

---

## Publishing to a portal (CrazyGames / Poki)

`src/portal.js` is a single abstraction over both portals. **Exactly one SDK is
loaded at runtime** — shipping two ad SDKs in one build fails review on both —
chosen by one line in `index.html`:

```html
<script>window.GAME_PORTAL = 'crazygames';</script>   <!-- or 'poki', or 'none' -->
```

Append `?portal=none` to the URL to force the standalone path while testing.

Wired up for both portals:

| | CrazyGames | Poki |
| --- | --- | --- |
| loading | `game.loadingStart/Stop` | `gameLoadingStart/Progress/Finished` |
| gameplay | `game.gameplayStart/Stop` | `gameplayStart/Stop` |
| reward moment | `game.happytime()` | `happyTime()` |
| interstitial | `ad.requestAd('midgame')` | `commercialBreak()` |
| storage | `SDK.data` | `localStorage` |

Ads only ever run **between fares**, never mid-drive, and not until the third
one — the simulation freezes without showing the pause menu and the audio mutes
for the duration, which both portals require. If the SDK is missing, blocked by
an ad blocker, or its CDN hangs (8s timeout), everything falls through to a
stub and the game plays normally. Nothing depends on an ad having played.

### Uploading

Zip the repo root — `index.html`, `styles.css`, `src/`, `vendor/three/`. That's
about 2.3 MB. There is no build step, so what's in the repo is what ships, and
`node_modules/` is gitignored and not needed.

### Portal-specific behaviour

- **High-DPI.** The HUD canvases declare their display size in CSS and size
  their backing store separately, so they stay correct at any device pixel
  ratio.
- **Blocked storage.** Portal iframes routinely partition third-party storage,
  so saves go through `portal.getItem/setItem`, which tries the portal's own
  store, then `localStorage`, then memory.
- **Mobile.** Phones and tablets default to the low preset, get an on-screen
  thumb pad, a tightened HUD (both a narrow-width *and* a short-height media
  query, since an 860x360 handset matches neither alone), safe-area insets for
  notches, and a rotate prompt in portrait.
- **Audio.** The context is created inside the start-button gesture and resumed
  explicitly, which Safari and in-app browsers need.
- **Quality changes reload the page**, because the city, traffic fleet, light
  pool, shadow maps and particle pools are all built from the preset.

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

The handbrake and full throttle both collapse rear grip — that's the whole drift
mechanic. Yaw inertia is set high, because a limousine should feel lazy going in
and lazy coming back.

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
