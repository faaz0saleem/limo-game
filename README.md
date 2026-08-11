# MIDNIGHT LIMO

A 3D night-city drift game in the browser. You drive eight and a half metres of
stretch limousine through a neon grid, pick up fares, and get paid extra for
arriving sideways.

Built on [three.js](https://threejs.org). **No build step and no external
assets** — every texture, model and sound in the game is generated
procedurally at load time, and three.js itself is vendored into the repo. The
only network request is the optional Poki SDK (see below); block it and the
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

## Publishing to Poki

`src/poki.js` wraps the Poki SDK, which `index.html` loads from Poki's CDN.
Everything degrades gracefully: local dev, offline, or an ad blocker leaves
`window.PokiSDK` undefined and the bridge falls through to a stub, so nothing
in the game ever depends on an ad having played.

Wired up:

- `gameLoadingStart` / `gameLoadingProgress` / `gameLoadingFinished` around the
  procedural build.
- `gameplayStart` / `gameplayStop` bracketing play, including pause, tab-hide
  and ad breaks.
- `commercialBreak` **only between fares**, and never on the first two — the
  simulation freezes without showing the pause menu, and the audio mutes for
  the duration, as Poki requires.
- `happyTime` on a big payday or a huge drift.

To upload, zip the repo root (`index.html`, `styles.css`, `src/`,
`vendor/three/`). `node_modules/` is gitignored and not needed. Nothing is
compiled, so what's in the repo is what ships.

### Portal-specific behaviour

- **High-DPI.** The HUD canvases declare their display size in CSS and size
  their backing store separately, so they stay 320/220 CSS px at any device
  pixel ratio.
- **Blocked storage.** Third-party storage is often unavailable in a portal
  iframe, so every `localStorage` access — reads included — is wrapped.
- **Mobile.** Phones and tablets (coarse pointer, or a screen under 600px)
  default to the low preset and get an on-screen thumb pad. Touch-capable
  laptops don't.
- **Audio.** The context is created inside the start-button gesture and
  resumed explicitly, which Safari and in-app browsers need.
- **Quality changes reload the page.** The city, traffic fleet, light pool,
  shadow maps and particle pools are all built from the preset, so switching it
  has to rebuild the world; a reload is the honest way to do that and takes
  about a second.

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
  ui/hud.js           canvas speedometer, minimap, fare card
  audio/engine.js     synthesised engine, tyres, wind, impacts
  poki.js             Poki SDK bridge, with a stub when the SDK is absent
vendor/three/         three.js r169 + the addons used (MIT)
```

`spec.js` exists so the physics model can be imported and unit-tested in Node
without a renderer, a DOM, or a GPU.

## Licence

Game code: do what you like with it. Vendored three.js is MIT, see
`vendor/three/LICENSE`.
