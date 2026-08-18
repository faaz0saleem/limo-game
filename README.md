# MIDNIGHT LIMO

A 3D night-city drift game in the browser. You drive eight and a half metres of
stretch limousine through a neon grid, pick up fares, and get paid extra for
arriving sideways.

Built on [three.js](https://threejs.org). **No build step and no external
assets** — every texture, model and sound in the game is generated procedurally
at load time, and three.js itself is vendored into the repo. The only network
request the game makes is the Playgama Bridge script, and the game runs fine
without it.

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
a rear end that steps out on command; the Pearl Phantom is quick everywhere. You
can buy them with fares or unlock them by watching ads, whichever you'd rather.

The city runs a **day/night cycle**: twenty minutes of daylight, twenty of
night, with dawn and dusk in between. Office windows switch off in the morning,
street lights and headlights come on at dusk, and the sky, fog, key light and
exposure all move together.

---

## Publishing

No build step — zip `index.html`, `styles.css`, `src/` and `vendor/three/` with
**index.html at the root of the archive**, and upload. The whole thing is about
2.3 MB and runs from any static host.

### Saves

Progress is stored **through the Bridge**, not in `localStorage` — portals
require it, and it is the only way a player keeps their garage across devices or
inside an embed that partitions storage. `src/storage.js` runs two layers:

- **The Bridge is the record of truth.** Writes are coalesced onto a short timer
  and flushed on `pagehide` / `visibilitychange`, since a shift can end seconds
  before the tab closes and `beforeunload` does not fire on mobile.
- **`localStorage` is a mirror.** The platform store is asynchronous and may not
  exist at all, so the mirror lets the game boot with real data instead of
  defaults while the platform read is in flight, and it is the whole store on a
  plain static host. Memory backs both, because a blocked `localStorage` throws
  on read rather than returning null.

The title screen shows the local mirror immediately and repaints if the platform
copy differs — making someone wait on a network read to see a menu is the wrong
trade. If they press START first, `hydrate` leaves the running shift alone
rather than moving the wallet underneath them; the local copy is written up on
the next save regardless. A player who has an old local save and no platform one
has it pushed up on first boot, which is their only migration path.

The graphics preset is deliberately **not** synced: a phone must not inherit the
`ultra` its owner picked on a desktop, and the game reads it at boot, before the
Bridge could have answered.

### Playgama Bridge

`src/playgama.js` wraps the [Playgama
Bridge](https://github.com/Playgama/bridge), which is one SDK across the portals
it supports. It sends `game_ready` when the title screen appears,
`gameplay_started` / `gameplay_stopped` around play, shows a banner, takes an
interstitial at the two moments that are actually breaks (every third fare
delivered, and when a shift restarts), and backs the save store described above.

**Rewarded ads unlock cars.** Every locked car in the garage carries a `WATCH
AD` button alongside its price, and leaving the end-of-shift summary pops up an
offer for the cheapest one you do not own yet. The count rises with the car —
two for the Champagne Royale, three for the Bordeaux Slider, four for the Pearl
Phantom — since a flat count would make the flagship, at six times the price,
exactly as easy to get. A skipped or failed ad credits nothing.

Both affordances are **always visible**, including on a static host where no ad
can be served. Hiding them behind `rewardedAvailable` made the feature invisible
during development, and a player who never sees the option cannot want it; the
honest version shows the button and answers a tap it cannot fulfil with *no ads
available right now*. `onWatchAd` reports `credited`, `skipped` or `unavailable`
separately for exactly this reason — "we have nothing to show you" is not the
player's doing and must not read like a failure.

The popup is offered once per shift and declining returns to the summary —
without that flag, pressing *drive again* would re-offer forever. A rewarded
view also resets the interstitial cooldown: the player just chose to watch an
advert, and following it with one they did not choose is the fastest way to
make them stop choosing.

The adapter assumes the SDK will misbehave, because on a portal you cannot debug
it will:

- **Every call is feature-detected and wrapped.** A missing or renamed member
  downgrades the feature rather than throwing inside the game loop. Ad states
  are compared as plain strings, not against imported constants.
- **Resuming is guaranteed; pausing is best-effort.** The one unrecoverable bug
  is holding the game for an advert whose *closed* signal never comes, so the
  resume path listens for events, polls the state as a backup, and finally runs
  a watchdog that releases the game regardless. Adverts that throw, never open,
  or never close are all covered.
- **Adverts hold the game through `adHold`, not `paused`.** They cannot share a
  flag: `paused` opens the pause menu, which must not appear under an advert,
  and the player must not be able to un-pause out from under one. Audio is muted
  for the duration — portals forbid game sound under a video ad.
- **Initialisation never delays the game, and lifecycle calls are queued rather
  than dropped.** Initialisation is kicked off in parallel with building the
  city and races a timeout so a slow SDK cannot hold the loading screen — which
  means the game can reach its title screen and call `game_ready` *before* the
  Bridge has answered. Discarding that call leaves the portal's own spinner up
  forever and the game looks broken to a reviewer, so `game_ready`, the play
  state and the banner are all replayed once the Bridge comes up. The adapter
  also waits for `window.bridge` to appear rather than deciding once, at the
  earliest possible moment, that there is no SDK.
- **One advert is guaranteed early.** Forty seconds into the first shift,
  regardless of fares. Portals verify an integration by playing the game and
  watching an advert all the way through; tying every break to fares means a
  reviewer who just drives around never sees one, and an integration nobody can
  see cannot be signed off.

Off a supported portal the Bridge falls back to its own mock platform, and if
the script does not load at all the adapter stays switched off. Both cases are
tested and neither produces a console error.

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

### Kerbs

The pavement is a bump, not a wall and not a ramp. `City.probeKerb` returns a
signed distance to the block edge, and the response depends on how hard you hit
it: below the mount speed the car is pushed back out and its inward velocity is
cancelled — a slide along the kerb, never a bounce, because a bounce with a
push-out turns into a ratchet that machine-guns the car down the street. Above
it the car climbs, and a short latch stops the push-out from immediately
fighting the climb. Once up, the body rides a few centimetres higher.

## Crowds

The pavements are walked by articulated figures rather than sliding blobs:
head with a face, hair or a hat, a torso with a waist, two-segment arms with
hands, legs and shoes, posed by a walk cycle.

The trick that makes a crowd this detailed affordable is **one `InstancedMesh`
per body part** rather than per person. Paired limbs share a mesh — person *i*
owns instances *2i* and *2i+1* — so the whole crowd is eight draw calls at any
population, and every limb still poses independently because each instance
carries its own matrix. Nobody is skinned and there is no skeleton: each part's
matrix is composed from the body's orientation and one joint angle, chained
through the parent's quaternion. Deriving a child joint analytically from sines
and cosines instead is what once left everyone's arms floating beside them.

One phase angle per person drives the gait: legs swing in antiphase, knees bend
backwards only, arms counter-swing, and the hips rise twice per stride — that
last detail is most of what separates a walk from a slide. Stride rate follows
speed, so nobody moonwalks. Heads turn to watch a car go past.

Drive at someone and they run; hit them and they go down and stay down. The
fall is worth a note: once the body has pitched face-down its limbs' pitch axes
lie along the ground and their splay axes point through it, so the pose has to
migrate from pitch into splay on the way down, or the arms end up waving at the
sky and the legs sink through the tarmac.

Faces are a single 128×64 canvas *multiplied* by each person's instance colour,
so one shared map gives brows, eyes and a mouth on every skin tone in the
palette without a second material. Vertical placement is by sphere latitude
rather than by eye — uv.y is not proportional to height — and the hair has to
clear the crown while stopping above the brow: too short and it reads as a
headband, too long and it buries the face in a helmet.

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
    navigation.js     street-following route arrows
  world/
    city.js           block grid, buildings, street furniture, kerbs, collision
    traffic.js        instanced ambient traffic
    pedestrians.js    articulated pavement crowd
    daynight.js       the day/night cycle
  vehicle/
    spec.js           dimensions and paint jobs (no three.js import)
    limo.js           the limousine model
    physics.js        two-axle drift model
  game/
    chaseCamera.js    travel-direction chase camera with boom collision
    input.js          keyboard / gamepad / touch
    gameplay.js       fares, timers, payouts, drift scoring
    save.js           records + settings
    garage.js         the cars the garage sells
  ui/
    hud.js            canvas speedometer, minimap, fare card
    menus.js          loading, title, settings, pause, summary screens
  audio/
    engine.js         synthesised engine, tyres, wind, impacts
    music.js          synthesised synthwave bed
  playgama.js         Playgama Bridge adapter, safe when the SDK is absent
  storage.js          platform saves, mirrored to localStorage and memory
vendor/three/         three.js r169 + the addons used (MIT)
```

`spec.js` exists so the physics model can be imported and unit-tested in Node
without a renderer, a DOM, or a GPU.

## Licence

Game code: do what you like with it. Vendored three.js is MIT, see
`vendor/three/LICENSE`.
