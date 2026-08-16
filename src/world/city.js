import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {
  asphaltMaps, concreteMaps, facadeMaps, laneMarkingTexture, neonSignTexture,
} from '../render/textures.js';
import { rngKit, clamp } from '../util.js';

/* Grid city. Blocks sit between road centre-lines; the car is fenced onto the
 * roads by one AABB per block, which keeps collision to a handful of tests.
 *
 *   roadLine(i) = (i - GRID/2) * PITCH        i ∈ [0, GRID]
 *   blockCentre(i) = roadLine(i) + PITCH/2    i ∈ [0, GRID-1]
 */

export const GRID = 7;
export const PITCH = 94;
export const ROAD_W = 32;
export const BLOCK = PITCH - ROAD_W;      // 62
export const HALF_CITY = (GRID / 2) * PITCH + ROAD_W / 2;   // 345

const FACADE_VARIANTS = 4;
const NEON_VARIANTS = 4;
const TILE_W = 9;
const TILE_H = 18;

export const roadLine = (i) => (i - GRID / 2) * PITCH;
export const blockCentre = (i) => roadLine(i) + PITCH / 2;

/** Snap a coordinate to the nearest street centre-line. */
export const nearestRoadLine = (v) =>
  (Math.round(v / PITCH + GRID / 2) - GRID / 2) * PITCH;

/** Plane with UVs scaled so the facade texture keeps a constant window size. */
function facadePlane(w, h, tileW = TILE_W, tileH = TILE_H) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (w / tileW), uv.getY(i) * (h / tileH));
  }
  uv.needsUpdate = true;
  return g;
}

function transformed(geo, { pos, rotY = 0, rotX = 0 }) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, 'YXZ'));
  m.compose(pos, q, new THREE.Vector3(1, 1, 1));
  return geo.applyMatrix4(m);
}

function mergeInto(scene, list, material, { cast = true, receive = true, order } = {}) {
  if (!list.length) return null;
  const merged = BufferGeometryUtils.mergeGeometries(list, false);
  if (!merged) return null;
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  if (order !== undefined) mesh.renderOrder = order;
  scene.add(mesh);
  list.length = 0;
  return mesh;
}

export class City {
  constructor(scene, { envMap, settings }) {
    this.scene = scene;
    this.settings = settings;
    this.colliders = [];         // { minX, maxX, minZ, maxZ, tall }
    this.lampPositions = [];
    this.spawnPoints = [];       // road-legal points for fares and traffic
    this.intersections = [];
    this.blinkers = [];
    this.group = new THREE.Group();
    scene.add(this.group);

    this.rng = rngKit(24601);

    this._buildGround(envMap);
    this._buildBlocks(envMap);
    this._buildStreetFurniture(envMap);
    this._buildStreetLife(envMap);
    this._buildBoundary();
    this._buildLightPool();
    this._buildSpawnPoints();
  }

  /* ------------------------------------------------------------- ground */

  _buildGround(envMap) {
    const maps = asphaltMaps();
    maps.map.repeat.set(80, 80);
    maps.roughnessMap.repeat.set(80, 80);
    maps.normalMap.repeat.set(160, 160);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_CITY * 2 + 90, HALF_CITY * 2 + 90),
      new THREE.MeshStandardMaterial({
        map: maps.map,
        roughnessMap: maps.roughnessMap,
        normalMap: maps.normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
        metalness: 0.14,
        roughness: 1,
        envMap,
        envMapIntensity: 1.35,
      }),
    );
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    this.group.add(road);
    this.ground = road;

    // Lane markings down the centre of every street, both axes.
    const lane = laneMarkingTexture();
    const laneMat = new THREE.MeshBasicMaterial({
      map: lane, transparent: true, depthWrite: false, opacity: 0.5,
    });
    const strips = [];
    const len = HALF_CITY * 2;
    for (let i = 0; i <= GRID; i++) {
      const c = roadLine(i);
      const g1 = new THREE.PlaneGeometry(3.0, len);
      const uv1 = g1.attributes.uv;
      for (let k = 0; k < uv1.count; k++) uv1.setY(k, uv1.getY(k) * (len / 26));
      strips.push(transformed(g1, { pos: new THREE.Vector3(c, 0.015, 0), rotX: -Math.PI / 2 }));

      const g2 = new THREE.PlaneGeometry(3.0, len);
      const uv2 = g2.attributes.uv;
      for (let k = 0; k < uv2.count; k++) uv2.setY(k, uv2.getY(k) * (len / 26));
      strips.push(transformed(g2, {
        pos: new THREE.Vector3(0, 0.015, c), rotX: -Math.PI / 2, rotY: Math.PI / 2,
      }));
    }
    mergeInto(this.group, strips, laneMat, { cast: false, receive: false, order: 1 });

    /* Solid white edge lines and zebra crossings. Real roads are covered in
     * paint; a bare strip of asphalt with one dashed line reads as a runway. */
    const paint = new THREE.MeshBasicMaterial({
      color: 0xf2efe0, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const marks = [];
    const edge = ROAD_W / 2 - 1.6;

    for (let i = 0; i <= GRID; i++) {
      const c = roadLine(i);
      for (const off of [-edge, edge]) {
        marks.push(transformed(new THREE.PlaneGeometry(0.5, len), {
          pos: new THREE.Vector3(c + off, 0.016, 0), rotX: -Math.PI / 2,
        }));
        marks.push(transformed(new THREE.PlaneGeometry(0.5, len), {
          pos: new THREE.Vector3(0, 0.016, c + off), rotX: -Math.PI / 2, rotY: Math.PI / 2,
        }));
      }
    }

    // Zebra bands on all four approaches to every junction.
    const stripeW = 1.5, stripeGap = 2.9, bandLen = 4.4;
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const jx = roadLine(i), jz = roadLine(j);
        for (const [ax, az] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const bx = jx + ax * (ROAD_W / 2 - bandLen / 2 - 0.6);
          const bz = jz + az * (ROAD_W / 2 - bandLen / 2 - 0.6);
          for (let k = -2; k <= 2; k++) {
            const sx = bx + (ax !== 0 ? 0 : k * stripeGap);
            const sz = bz + (az !== 0 ? 0 : k * stripeGap);
            const w = ax !== 0 ? bandLen : stripeW;
            const d = ax !== 0 ? stripeW : bandLen;
            if (Math.abs(sx) > HALF_CITY || Math.abs(sz) > HALF_CITY) continue;
            marks.push(transformed(new THREE.PlaneGeometry(w, d), {
              pos: new THREE.Vector3(sx, 0.017, sz), rotX: -Math.PI / 2,
            }));
          }
        }
      }
    }
    mergeInto(this.group, marks, paint, { cast: false, receive: false, order: 1 });
  }

  /* -------------------------------------------------------------- blocks */

  _buildBlocks(envMap) {
    const rng = this.rng;
    const concrete = concreteMaps();

    const sidewalkMat = new THREE.MeshStandardMaterial({
      map: concrete.map, normalMap: concrete.normalMap,
      metalness: 0.05, roughness: 0.82, envMap, envMapIntensity: 0.7,
    });
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d26, metalness: 0.2, roughness: 0.75, envMap, envMapIntensity: 0.5,
    });

    const facadeMats = [];
    this.facadeMaterials = facadeMats;   // the day/night cycle dims these
    const facadeGeos = [];
    for (let v = 0; v < FACADE_VARIANTS; v++) {
      const m = facadeMaps(v);
      facadeMats.push(new THREE.MeshStandardMaterial({
        map: m.map,
        emissiveMap: m.emissiveMap,
        emissive: 0xffffff,
        emissiveIntensity: 1.35,
        metalness: 0.28,
        roughness: 0.58,
        envMap,
        envMapIntensity: 0.85,
      }));
      facadeGeos.push([]);
    }

    const neonMats = [];
    const neonGeos = [];
    for (let v = 0; v < NEON_VARIANTS; v++) {
      neonMats.push(new THREE.MeshBasicMaterial({
        map: neonSignTexture(v), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      neonGeos.push([]);
    }

    const sidewalks = [];
    const roofs = [];
    const props = [];
    const beaconPositions = [];

    const midI = (GRID - 1) / 2;

    for (let ix = 0; ix < GRID; ix++) {
      for (let iz = 0; iz < GRID; iz++) {
        const cx = blockCentre(ix);
        const cz = blockCentre(iz);
        const isPlaza = ix === midI && iz === midI;
        const isPark = (ix === 1 && iz === GRID - 2) || (ix === GRID - 2 && iz === 1);

        if (isPlaza) {
          this._buildPlaza(cx, cz, sidewalks, props, envMap);
          continue;
        }

        // Raised sidewalk = the block's collision footprint.
        sidewalks.push(transformed(
          new THREE.BoxGeometry(BLOCK, 0.26, BLOCK),
          { pos: new THREE.Vector3(cx, 0.13, cz) },
        ));
        /*
         * Deliberately NO block-wide collider any more. Fencing off the whole
         * lot kept the car on the tarmac; now the pavement is drivable and
         * only the buildings themselves stop you (see _pushBuilding).
         */

        if (isPark) {
          this._buildPark(cx, cz, props);
          continue;
        }

        // How close to the middle of the map? Towers get taller downtown.
        const centrality = 1 - clamp(
          (Math.abs(ix - midI) + Math.abs(iz - midI)) / (GRID - 1), 0, 1,
        );

        const towers = rng.int(2, 4);
        const placed = [];
        for (let t = 0; t < towers; t++) {
          const w = rng.range(15, 26);
          const d = rng.range(15, 26);
          // Keep towers inside the lot with a sidewalk margin.
          const span = BLOCK / 2 - 5;
          const x = cx + rng.range(-span + w / 2, span - w / 2);
          const z = cz + rng.range(-span + d / 2, span - d / 2);

          if (placed.some((p) =>
            Math.abs(p.x - x) < (p.w + w) / 2 - 1 && Math.abs(p.z - z) < (p.d + d) / 2 - 1)) {
            continue;
          }
          placed.push({ x, z, w, d });

          const h = rng.range(16, 40) + centrality * rng.range(20, 95);
          const v = rng.int(0, FACADE_VARIANTS - 1);
          this._pushBuilding(facadeGeos[v], roofs, props, x, z, w, d, h);

          if (h > 70) beaconPositions.push(new THREE.Vector3(x, h + 1.2, z));

          // Neon sign on a street-facing wall.
          if (rng.chance(0.42)) {
            const nv = rng.int(0, NEON_VARIANTS - 1);
            const faceX = x > cx;
            const faceZ = z > cz;
            const sw = rng.range(4, 7);
            const sh = sw * 2;
            const sy = rng.range(8, Math.max(10, h - 8));
            if (rng.chance(0.5)) {
              neonGeos[nv].push(transformed(new THREE.PlaneGeometry(sw, sh), {
                pos: new THREE.Vector3(x + (faceX ? w / 2 + 0.3 : -w / 2 - 0.3), sy, z),
                rotY: faceX ? Math.PI / 2 : -Math.PI / 2,
              }));
            } else {
              neonGeos[nv].push(transformed(new THREE.PlaneGeometry(sw, sh), {
                pos: new THREE.Vector3(x, sy, z + (faceZ ? d / 2 + 0.3 : -d / 2 - 0.3)),
                rotY: faceZ ? 0 : Math.PI,
              }));
            }
          }
        }
      }
    }

    mergeInto(this.group, sidewalks, sidewalkMat);
    mergeInto(this.group, roofs, roofMat);
    mergeInto(this.group, props, new THREE.MeshStandardMaterial({
      color: 0x22262f, metalness: 0.35, roughness: 0.7, envMap, envMapIntensity: 0.6,
    }));
    for (let v = 0; v < FACADE_VARIANTS; v++) {
      mergeInto(this.group, facadeGeos[v], facadeMats[v]);
    }
    for (let v = 0; v < NEON_VARIANTS; v++) {
      mergeInto(this.group, neonGeos[v], neonMats[v], { cast: false, receive: false });
    }

    this._buildBeacons(beaconPositions);
  }

  /** Four walls + a roof cap + a little rooftop clutter. */
  _pushBuilding(facadeList, roofs, props, x, z, w, d, h) {
    const y = h / 2;
    const half = { x: w / 2, z: d / 2 };

    facadeList.push(transformed(facadePlane(w, h), { pos: new THREE.Vector3(x, y, z + half.z) }));
    facadeList.push(transformed(facadePlane(w, h), { pos: new THREE.Vector3(x, y, z - half.z), rotY: Math.PI }));
    facadeList.push(transformed(facadePlane(d, h), { pos: new THREE.Vector3(x + half.x, y, z), rotY: Math.PI / 2 }));
    facadeList.push(transformed(facadePlane(d, h), { pos: new THREE.Vector3(x - half.x, y, z), rotY: -Math.PI / 2 }));

    roofs.push(transformed(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4), {
      pos: new THREE.Vector3(x, h + 0.25, z),
    }));

    // Each tower is its own obstacle, so there is room to drive between them.
    this.colliders.push({
      minX: x - w / 2, maxX: x + w / 2,
      minZ: z - d / 2, maxZ: z + d / 2, tall: true,
    });

    const rng = this.rng;
    const clutter = rng.int(1, 3);
    for (let i = 0; i < clutter; i++) {
      const cw = rng.range(1.6, 4.2), cd = rng.range(1.6, 4.2), ch = rng.range(1.2, 3.4);
      props.push(transformed(new THREE.BoxGeometry(cw, ch, cd), {
        pos: new THREE.Vector3(
          x + rng.range(-w / 2 + cw, w / 2 - cw),
          h + 0.5 + ch / 2,
          z + rng.range(-d / 2 + cd, d / 2 - cd),
        ),
      }));
    }
    if (h > 55 && rng.chance(0.6)) {
      props.push(transformed(new THREE.CylinderGeometry(0.18, 0.28, rng.range(6, 16), 6), {
        pos: new THREE.Vector3(x, h + 8, z),
      }));
    }
  }

  /** Open block in the middle of the map: somewhere to practise donuts. */
  _buildPlaza(cx, cz, sidewalks, props, envMap) {
    // A ring of planters instead of a solid lot, so the plaza stays drivable.
    const R = BLOCK / 2 - 2;
    const count = 16;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const x = cx + Math.cos(a) * R;
      const z = cz + Math.sin(a) * R;
      props.push(transformed(new THREE.CylinderGeometry(1.4, 1.6, 1.1, 10), {
        pos: new THREE.Vector3(x, 0.55, z),
      }));
      this.colliders.push({ minX: x - 1.5, maxX: x + 1.5, minZ: z - 1.5, maxZ: z + 1.5, tall: false });
    }

    // Central fountain.
    sidewalks.push(transformed(new THREE.CylinderGeometry(7, 7.6, 0.7, 28), {
      pos: new THREE.Vector3(cx, 0.35, cz),
    }));
    props.push(transformed(new THREE.CylinderGeometry(1.1, 1.6, 4.2, 12), {
      pos: new THREE.Vector3(cx, 2.4, cz),
    }));
    this.colliders.push({ minX: cx - 7.6, maxX: cx + 7.6, minZ: cz - 7.6, maxZ: cz + 7.6, tall: false });

    // Painted donut ring, purely to invite the player to use it.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(14, 15.2, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffcb5c, transparent: true, opacity: 0.22, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, 0.03, cz);
    ring.renderOrder = 1;
    this.group.add(ring);
    this.plaza = new THREE.Vector3(cx, 0, cz);
  }

  _buildPark(cx, cz, props) {
    const rng = this.rng;
    this.colliders.push({
      minX: cx - BLOCK / 2 + 6, maxX: cx + BLOCK / 2 - 6,
      minZ: cz - BLOCK / 2 + 6, maxZ: cz + BLOCK / 2 - 6, tall: false,
    });
    for (let i = 0; i < 26; i++) {
      const x = cx + rng.range(-BLOCK / 2 + 4, BLOCK / 2 - 4);
      const z = cz + rng.range(-BLOCK / 2 + 4, BLOCK / 2 - 4);
      const h = rng.range(4, 9);
      props.push(transformed(new THREE.CylinderGeometry(0.22, 0.32, h, 6), {
        pos: new THREE.Vector3(x, h / 2 + 0.26, z),
      }));
      props.push(transformed(new THREE.ConeGeometry(rng.range(1.6, 2.6), h * 0.9, 7), {
        pos: new THREE.Vector3(x, h + 0.26, z),
      }));
    }
  }

  /** Blinking aviation lights on the tallest towers. */
  _buildBeacons(positions) {
    if (!positions.length) return;
    const geo = new THREE.SphereGeometry(0.6, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
    const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
    const m = new THREE.Matrix4();
    positions.forEach((p, i) => mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.beaconMat = mat;
  }

  /* ---------------------------------------------------- street furniture */

  _buildStreetFurniture(envMap) {
    const poles = [];
    const heads = [];
    const rng = this.rng;

    const metal = new THREE.MeshStandardMaterial({
      color: 0x15181f, metalness: 0.75, roughness: 0.45, envMap, envMapIntensity: 0.8,
    });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });

    // A lamp on each corner of every block, arm reaching over the road.
    for (let ix = 0; ix <= GRID; ix++) {
      for (let iz = 0; iz <= GRID; iz++) {
        const x = roadLine(ix);
        const z = roadLine(iz);
        if (Math.abs(x) > HALF_CITY || Math.abs(z) > HALF_CITY) continue;

        for (const [ox, oz] of [[-1, -1], [1, 1]]) {
          const px = x + ox * (ROAD_W / 2 + 1.6);
          const pz = z + oz * (ROAD_W / 2 + 1.6);
          if (Math.abs(px) > HALF_CITY - 2 || Math.abs(pz) > HALF_CITY - 2) continue;

          poles.push(transformed(new THREE.CylinderGeometry(0.16, 0.22, 8.4, 8), {
            pos: new THREE.Vector3(px, 4.2, pz),
          }));
          poles.push(transformed(new THREE.BoxGeometry(2.6, 0.16, 0.16), {
            pos: new THREE.Vector3(px - ox * 1.3, 8.3, pz),
          }));
          const hx = px - ox * 2.5;
          heads.push(transformed(new THREE.BoxGeometry(1.1, 0.22, 0.5), {
            pos: new THREE.Vector3(hx, 8.16, pz),
          }));
          this.lampPositions.push(new THREE.Vector3(hx, 8.0, pz));
        }

        this.intersections.push(new THREE.Vector3(x, 0, z));

        // Traffic light mast at busier junctions.
        if (rng.chance(0.35)) {
          const px = x + (ROAD_W / 2 + 1.2);
          const pz = z - (ROAD_W / 2 + 1.2);
          poles.push(transformed(new THREE.CylinderGeometry(0.14, 0.18, 6.2, 8), {
            pos: new THREE.Vector3(px, 3.1, pz),
          }));
          poles.push(transformed(new THREE.BoxGeometry(0.35, 1.1, 0.35), {
            pos: new THREE.Vector3(px, 6.2, pz),
          }));
          heads.push(transformed(new THREE.SphereGeometry(0.14, 6, 5), {
            pos: new THREE.Vector3(px, 6.5, pz + 0.2),
          }));
        }
      }
    }

    mergeInto(this.group, poles, metal);
    this.lampHeadMat = lampMat;
    mergeInto(this.group, heads, lampMat, { cast: false });
  }

  /**
   * The stuff that makes a street feel inhabited: shopfronts with awnings and
   * lit signs at the base of every block, hot-dog carts on the corners, plus
   * benches and bins along the pavement.
   *
   * All of it sits on the raised sidewalk, which is already the block's
   * collider — so it is scenery the player can see but never drive into.
   */
  _buildStreetLife(envMap) {
    const rng = this.rng;
    const dark = [];
    const canvasProps = [];      // fabric awnings + cart canopies
    const signGeos = [];         // emissive shop signage
    const midI = (GRID - 1) / 2;

    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1c2029, metalness: 0.5, roughness: 0.62, envMap, envMapIntensity: 0.7,
    });
    const fabricMat = new THREE.MeshStandardMaterial({
      color: 0xb4442f, metalness: 0.0, roughness: 0.85, envMap, envMapIntensity: 0.4,
    });
    this.signMat = new THREE.MeshBasicMaterial({ color: 0xffcf94 });

    for (let ix = 0; ix < GRID; ix++) {
      for (let iz = 0; iz < GRID; iz++) {
        if (ix === midI && iz === midI) continue;          // the plaza
        const cx = blockCentre(ix), cz = blockCentre(iz);
        const half = BLOCK / 2;

        /*
         * Shopfronts, set back at the building line so the pavement in front
         * of them stays clear to drive and walk on. Only some edges get one,
         * and only some bays within an edge — a shop on every bay of every
         * block was what made the streets look stamped out.
         */
        for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          if (!rng.chance(0.6)) continue;
          const inset = 5.5;
          const units = rng.int(2, 3);
          for (let u = 0; u < units; u++) {
            if (!rng.chance(0.75)) continue;
            const t = (u + 0.5) / units - 0.5;
            const along = t * (BLOCK - 20);
            const ex = cx + nx * (half - inset) + (nx === 0 ? along : 0);
            const ez = cz + nz * (half - inset) + (nz === 0 ? along : 0);
            const rotY = Math.atan2(nx, nz);

            // Awning over the door.
            canvasProps.push(transformed(new THREE.BoxGeometry(5.4, 0.22, 2.0), {
              pos: new THREE.Vector3(ex + nx * 1.0, 3.15, ez + nz * 1.0), rotY,
            }));
            // Lit fascia sign above it.
            signGeos.push(transformed(new THREE.BoxGeometry(4.6, 0.85, 0.22), {
              pos: new THREE.Vector3(ex + nx * 0.35, 4.15, ez + nz * 0.35), rotY,
            }));
            // Window frame / doorway.
            dark.push(transformed(new THREE.BoxGeometry(5.0, 2.9, 0.3), {
              pos: new THREE.Vector3(ex + nx * 0.2, 1.75, ez + nz * 0.2), rotY,
            }));

            // A bench or a bin on the pavement in front — sparingly.
            if (rng.chance(0.25)) {
              const bx = ex + nx * 3.2, bz = ez + nz * 3.2;
              dark.push(transformed(new THREE.BoxGeometry(2.0, 0.16, 0.6), {
                pos: new THREE.Vector3(bx, 0.85, bz), rotY,
              }));
              for (const s2 of [-0.8, 0.8]) {
                dark.push(transformed(new THREE.BoxGeometry(0.16, 0.72, 0.5), {
                  pos: new THREE.Vector3(bx + Math.cos(rotY) * s2, 0.5, bz - Math.sin(rotY) * s2), rotY,
                }));
              }
            } else if (rng.chance(0.3)) {
              dark.push(transformed(new THREE.CylinderGeometry(0.42, 0.36, 1.1, 10), {
                pos: new THREE.Vector3(ex + nx * 3.4, 0.81, ez + nz * 3.4),
              }));
            }
          }
        }

        // --- a hot-dog cart on one corner of the block
        if (rng.chance(0.3)) {
          const sx = rng.chance(0.5) ? 1 : -1;
          const sz = rng.chance(0.5) ? 1 : -1;
          const px = cx + sx * (half - 3.0);
          const pz = cz + sz * (half - 3.0);
          this.colliders.push({
            minX: px - 1.6, maxX: px + 1.6, minZ: pz - 1.1, maxZ: pz + 1.1, tall: false,
          });

          dark.push(transformed(new THREE.BoxGeometry(2.6, 1.1, 1.5), {
            pos: new THREE.Vector3(px, 0.95, pz),
          }));
          canvasProps.push(transformed(new THREE.BoxGeometry(3.2, 0.16, 2.1), {
            pos: new THREE.Vector3(px, 2.5, pz),
          }));
          for (const [ox, oz] of [[-1.4, -0.9], [1.4, -0.9], [-1.4, 0.9], [1.4, 0.9]]) {
            dark.push(transformed(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 6), {
              pos: new THREE.Vector3(px + ox, 1.75, pz + oz),
            }));
          }
          signGeos.push(transformed(new THREE.BoxGeometry(1.9, 0.5, 0.14), {
            pos: new THREE.Vector3(px, 2.95, pz),
          }));
          for (const ox of [-0.95, 0.95]) {
            dark.push(transformed(new THREE.CylinderGeometry(0.3, 0.3, 0.14, 10).rotateZ(Math.PI / 2), {
              pos: new THREE.Vector3(px + ox, 0.3, pz),
            }));
          }
        }
      }
    }

    mergeInto(this.group, dark, darkMat);
    mergeInto(this.group, canvasProps, fabricMat);
    mergeInto(this.group, signGeos, this.signMat, { cast: false });
  }

  _buildBoundary() {
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x0d1017, metalness: 0.3, roughness: 0.8,
    });
    const geos = [];
    const t = 6, h = 9;
    const L = HALF_CITY * 2 + t * 2;
    // The fourth entry is the inward normal. A thin wall that wraps the map
    // must always eject toward the city, never out through its far face.
    for (const [x, z, w, d, nx, nz] of [
      [0, HALF_CITY + t / 2, L, t, 0, -1],
      [0, -HALF_CITY - t / 2, L, t, 0, 1],
      [HALF_CITY + t / 2, 0, t, L, -1, 0],
      [-HALF_CITY - t / 2, 0, t, L, 1, 0],
    ]) {
      geos.push(transformed(new THREE.BoxGeometry(w, h, d), { pos: new THREE.Vector3(x, h / 2, z) }));
      this.colliders.push({
        minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2,
        tall: true, nx, nz,
      });
    }
    mergeInto(this.group, geos, wallMat);
  }

  /**
   * A handful of real point lights recycled between the nearest lamp posts.
   * Dozens of static lights would tank the frame rate; six that follow the
   * player look identical from inside the car.
   */
  _buildLightPool() {
    const n = this.settings.lightsPerBlock * 3;
    this.lightPool = [];
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffcf94, 0, 46, 2);
      l.visible = false;
      this.group.add(l);
      this.lightPool.push(l);
    }
  }

  _buildSpawnPoints() {
    // Mid-block points on every street, both directions — used for fares.
    for (let i = 0; i <= GRID; i++) {
      const c = roadLine(i);
      for (let j = 0; j < GRID; j++) {
        const m = blockCentre(j);
        this.spawnPoints.push(new THREE.Vector3(c, 0, m));
        this.spawnPoints.push(new THREE.Vector3(m, 0, c));
      }
    }
  }

  /* -------------------------------------------------------------- runtime */

  /** 0 = midnight, 1 = noon. Street lighting switches off in daylight. */
  setDaylight(d) {
    this._daylight = d;
    if (this.lampHeadMat) {
      // The emissive lamp housings should stop glowing too, or they read as
      // little white squares stuck to the poles in broad daylight.
      this.lampHeadMat.color.setScalar(1 - d * 0.92);
    }
    // Shop signs stay readable by day but stop glowing.
    if (this.signMat) this.signMat.color.setRGB(1 - d * 0.45, 0.81 - d * 0.35, 0.58 - d * 0.25);
  }

  update(dt, playerPos, elapsed) {
    // Re-seat the light pool on whichever lamps are closest to the car.
    if (this.lightPool.length) {
      const near = [];
      for (const p of this.lampPositions) {
        const d = p.distanceToSquared(playerPos);
        if (d < 90 * 90) near.push({ p, d });
      }
      near.sort((a, b) => a.d - b.d);
      for (let i = 0; i < this.lightPool.length; i++) {
        const l = this.lightPool[i];
        if (i < near.length) {
          l.position.copy(near[i].p);
          l.visible = true;
          l.intensity = 500 * (1 - (this._daylight ?? 0));
        } else {
          l.visible = false;
        }
      }
    }

    if (this.beaconMat) {
      this.beaconMat.color.setScalar(Math.sin(elapsed * 2.4) > 0.4 ? 1 : 0.06);
    }
  }

  /**
   * Circle-vs-AABB sweep. Returns the surface normal and penetration depth of
   * the deepest overlap, or null.
   */
  probe(x, z, radius) {
    let best = null;
    for (const c of this.colliders) {
      if (x + radius < c.minX || x - radius > c.maxX ||
          z + radius < c.minZ || z - radius > c.maxZ) continue;

      const cx = clamp(x, c.minX, c.maxX);
      const cz = clamp(z, c.minZ, c.maxZ);
      let nx = x - cx, nz = z - cz;
      let dist = Math.hypot(nx, nz);

      if (dist > 1e-4) {
        if (dist >= radius) continue;
        nx /= dist; nz /= dist;
      } else if (c.nx !== undefined) {
        // Fixed-normal collider (the boundary wall): always eject inward.
        nx = c.nx; nz = c.nz;
        dist = -(nx !== 0 ? (nx > 0 ? c.maxX - x : x - c.minX)
                          : (nz > 0 ? c.maxZ - z : z - c.minZ));
      } else {
        // Centre is inside the box: push out along the shallowest face.
        const dl = x - c.minX, dr = c.maxX - x;
        const db = z - c.minZ, df = c.maxZ - z;
        const m = Math.min(dl, dr, db, df);
        nx = m === dl ? -1 : m === dr ? 1 : 0;
        nz = m === db ? -1 : m === df ? 1 : 0;
        dist = -m;
      }

      const depth = radius - dist;
      if (!best || depth > best.depth) best = { nx, nz, depth };
    }
    return best;
  }

  /** Nearest legal road position to `v` — used when recovering the car. */
  snapToRoad(v) {
    let best = this.spawnPoints[0];
    let bd = Infinity;
    for (const p of this.spawnPoints) {
      const d = p.distanceToSquared(v);
      if (d < bd) { bd = d; best = p; }
    }
    return best.clone();
  }

  /**
   * Heading that points down the street at `v`, choosing whichever of the two
   * directions is closest to `currentHeading` so recovering doesn't spin the
   * car around.
   */
  alignedHeading(v, currentHeading = 0) {
    const dx = Math.abs(v.x - nearestRoadLine(v.x));
    const dz = Math.abs(v.z - nearestRoadLine(v.z));
    // Sitting on a north–south centre-line means the street runs along Z.
    const base = dx < dz ? 0 : Math.PI / 2;
    const alt = base + Math.PI;
    const diff = (a) => Math.abs(((a - currentHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    return diff(base) <= diff(alt) ? base : alt;
  }

  randomSpawn(rand, awayFrom = null, minDist = 90) {
    for (let i = 0; i < 40; i++) {
      const p = this.spawnPoints[Math.floor(rand() * this.spawnPoints.length)];
      if (!awayFrom || p.distanceTo(awayFrom) > minDist) return p.clone();
    }
    return this.spawnPoints[0].clone();
  }
}
