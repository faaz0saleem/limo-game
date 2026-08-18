import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GRID, BLOCK, blockCentre } from './city.js';
import { clamp, damp, rngKit, wrapAngle } from '../util.js';

/**
 * Pavement crowds — articulated figures with a procedural walk.
 *
 * Roughly the fidelity of a PS2-era open-world pedestrian: a head, hair, torso,
 * two-segment arms and legs, and shoes, all animated by a walk cycle rather
 * than sliding about as a single blob.
 *
 * The trick that makes a crowd this detailed affordable is one InstancedMesh
 * per *body part* rather than per person. Paired limbs share a mesh with two
 * instances each, so ~13 body parts across any number of people cost 8 draw
 * calls total, and every limb can still be posed independently because each
 * instance carries its own matrix.
 *
 * Nobody is skinned and there is no skeleton hierarchy: each part's world
 * matrix is composed directly from the body's orientation and one joint angle.
 * At the distance you see them that is indistinguishable from a rig, and it
 * costs a few hundred matrix composes a frame instead of a skinning pass.
 */

const STATE = { WALK: 0, FLEE: 1, DOWN: 2 };

const SHIRTS = [
  0xc9524a, 0x35618f, 0x3f7a58, 0xc7a94e, 0x7a4c8f, 0xd07a3c,
  0x486b7a, 0xa8425f, 0x555c68, 0xbfb59e, 0x2f3d52, 0x8f6f4e,
];
const TROUSERS = [0x2b3242, 0x3f3a33, 0x1f2530, 0x59524a, 0x35405c, 0x4a4038];
const SKINS = [0xf1c9a5, 0xdcab7d, 0xb98255, 0x8d5f3c, 0x5f3d24, 0xefd3b3];
const HAIRS = [0x1a1512, 0x3a2418, 0x6b4a2a, 0x9c8256, 0x2b2b2b, 0x120f0d];
/* Roughly a fifth of the crowd wears something on their head instead. The cap
 * is the same geometry as the hair, scaled proud of the skull — a hat is a
 * haircut with a brighter palette as far as this rig is concerned. */
const HATS = [0x9d2f28, 0x1d2b45, 0x2a2a2a, 0xd8d2c4, 0x2f5340, 0x7a5230];
const SHOES = [0x2a2724, 0x3d2f24, 0x1a1a1e, 0xa8a29a];

/**
 * One shared face map for the whole crowd.
 *
 * It is drawn in greys on white and *multiplied* by each person's per-instance
 * skin colour, so a single 128x64 canvas gives brows, eyes and a mouth on every
 * skin tone in the palette without a second material. Anything white passes the
 * skin tone through untouched; anything dark stays dark.
 *
 * Sphere UVs put u=0.25 dead centre of the face (three.js starts phi on -X) and
 * v=0.5 on the equator, so the features go just above the midline.
 */
function faceMap() {
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, W, H);

  /* Vertically, uv.y maps to latitude, not to height — the features are spaced
   * in canvas rows chosen against the actual sphere: row 48 lands at 66% of the
   * head's height, row 64 at 47%, row 80 at 27%. Placing them by eye instead is
   * how the whole face ended up crammed into the top of the skull. */
  const cx = W * 0.25;          // centre of the face
  const eyeY = 64, eyeDX = 13;

  // Brow ridge. Drawn hard rather than soft: tone mapping and the distance both
  // eat contrast, and a face that is subtle up close is a blank oval in play.
  x.fillStyle = '#4a3628';
  x.fillRect(cx - 22, eyeY - 10, 17, 4.5);
  x.fillRect(cx + 5, eyeY - 10, 17, 4.5);

  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    x.fillStyle = '#efe6da';                    // eye white, tinted by skin
    x.beginPath();
    x.ellipse(ex, eyeY, 7, 4.6, 0, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#2b2118';                    // iris and pupil as one dot
    x.beginPath();
    x.ellipse(ex, eyeY + 0.4, 3.5, 3.7, 0, 0, Math.PI * 2);
    x.fill();
  }

  // Nose: shading rather than geometry — a shadow down one side and a tip.
  x.fillStyle = 'rgba(112,80,60,0.42)';
  x.fillRect(cx - 3.4, eyeY + 3, 3, 8);
  x.fillStyle = 'rgba(96,66,50,0.30)';
  x.beginPath();
  x.ellipse(cx, eyeY + 11, 4.4, 2.4, 0, 0, Math.PI * 2);
  x.fill();

  // Mouth.
  x.strokeStyle = 'rgba(112,58,52,0.85)';
  x.lineWidth = 3.4;
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(cx - 8, eyeY + 16);
  x.quadraticCurveTo(cx, eyeY + 19, cx + 8, eyeY + 16);
  x.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* Proportions, in metres, for a 1.75m adult. */
const B = {
  hip: 0.92,          // waist joint height
  shoulder: 1.44,     // must sit just under the top of the chest box
  shoulderX: 0.215,   // wider than the chest, so the figure has shoulders
  hipX: 0.10,
  neck: 1.50,
};

export class Pedestrians {
  constructor(scene, { count = 90, envMap, rng = rngKit(4242) } = {}) {
    this.rng = rng;
    this.count = count;
    this.people = [];
    this.hits = 0;
    this.nearMisses = 0;

    /* ---------------------------------------------------------- geometry
     * Every limb is built with its origin at the joint it rotates about and
     * extending downward, so a single quaternion per part is enough to pose it.
     */
    const limb = (w, h, d, taper = 1) => {
      const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
      if (taper !== 1) {
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          if (pos.getY(i) < 0) {
            pos.setX(i, pos.getX(i) * taper);
            pos.setZ(i, pos.getZ(i) * taper);
          }
        }
      }
      g.translate(0, -h / 2, 0);
      return g;
    };

    /* The torso is a chest over a hip block with a step between them. A single
     * slab reads as a cardboard box from any angle; the waist is what makes the
     * silhouette look like a person. Merged, so it is still one draw call. */
    const chest = limb(0.40, 0.28, 0.235, 0.80);
    chest.translate(0, 0.56, 0);                  // spans 0.28 → 0.56
    const hips = limb(0.315, 0.30, 0.20, 1.08);   // widens downward into the hips
    hips.translate(0, 0.30, 0);                   // spans 0.00 → 0.30
    const torsoGeo = BufferGeometryUtils.mergeGeometries([chest, hips], false);

    /* Head and neck are one part. The neck used to be missing entirely, which
     * left a floating head above a 2cm gap — the sort of thing you only notice
     * once you put the camera on the pavement. It overlaps down into the chest
     * so no gap can open up at any body scale. */
    const skull = new THREE.SphereGeometry(0.110, 16, 12);
    skull.scale(0.90, 1.10, 0.96);
    skull.translate(0, 0.110, 0);
    const neck = new THREE.CylinderGeometry(0.050, 0.060, 0.09, 8, 1, true);
    neck.translate(0, -0.015, 0);                 // spans -0.06 → 0.03
    // Park the neck's UVs on a blank part of the face map so it does not get a
    // second set of eyes wrapped round it.
    const nuv = neck.attributes.uv;
    for (let i = 0; i < nuv.count; i++) nuv.setXY(i, 0.75, 0.5);
    const headGeo = BufferGeometryUtils.mergeGeometries([skull, neck], false);

    /* Hair has to *cap* the skull — clearing the crown, and stopping above the
     * brow. Too short and the crown pokes through and it reads as a headband;
     * too long, as 0.60π was, and it comes down past the eyes and buries the
     * whole face in a helmet. 0.35π puts the hairline at about 72% of the
     * head's height, which is where a hairline goes. */
    const hairGeo = new THREE.SphereGeometry(0.115, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.35);
    hairGeo.scale(0.96, 1.14, 1.00);
    hairGeo.translate(0, 0.109, 0);

    const upperArmGeo = limb(0.100, 0.30, 0.110, 0.9);

    /* Forearm and hand are one part. Without the hand the arm just stops at the
     * wrist, which is very visible from the pavement — a fist is four triangles
     * of silhouette that costs nothing, since it rides the forearm's matrix. */
    const forearm = limb(0.088, 0.25, 0.098, 0.92);
    const hand = new THREE.BoxGeometry(0.080, 0.095, 0.090);
    hand.translate(0, -0.297, 0.004);
    const lowerArmGeo = BufferGeometryUtils.mergeGeometries([forearm, hand], false);

    const upperLegGeo = limb(0.155, 0.40, 0.165, 0.86);
    const lowerLegGeo = limb(0.125, 0.40, 0.135, 0.85);
    const shoeGeo = new THREE.BoxGeometry(0.135, 0.10, 0.285);
    shoeGeo.translate(0, -0.07, 0.05);       // sole lands on the pavement

    const mat = (extra) => new THREE.MeshStandardMaterial({
      roughness: 0.78, metalness: 0.0, envMap, envMapIntensity: 0.35, ...extra,
    });

    const mk = (geo, n, extra) => {
      const m = new THREE.InstancedMesh(geo, mat(extra), n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };

    // Paired limbs share one mesh: person i owns instances 2i and 2i+1.
    this.parts = {
      torso: mk(torsoGeo, count),
      head: mk(headGeo, count, { map: faceMap() }),
      hair: mk(hairGeo, count),
      upperArm: mk(upperArmGeo, count * 2),
      lowerArm: mk(lowerArmGeo, count * 2),
      upperLeg: mk(upperLegGeo, count * 2),
      lowerLeg: mk(lowerLegGeo, count * 2),
      shoe: mk(shoeGeo, count * 2),
    };
    this.meshes = Object.values(this.parts);

    /* ------------------------------------------------------------ colours */
    const col = new THREE.Color();
    const setPair = (mesh, i, hex) => {
      col.setHex(hex);
      mesh.setColorAt(i * 2, col);
      mesh.setColorAt(i * 2 + 1, col);
    };

    // Sleeves get a shade of the shirt rather than the shirt itself: with the
    // arm embedded in the torso, identical colours weld them into one lump and
    // the figure loses its shoulders.
    const pick = (arr) => arr[Math.floor(rng.rand() * arr.length)];
    this._headwear = [];

    for (let i = 0; i < count; i++) {
      const shirt = pick(SHIRTS);
      const trouser = pick(TROUSERS);
      const skin = pick(SKINS);
      const hatted = rng.rand() < 0.2;
      this._headwear.push(hatted);

      col.setHex(shirt); this.parts.torso.setColorAt(i, col);
      col.setHex(skin); this.parts.head.setColorAt(i, col);
      col.setHex(hatted ? pick(HATS) : pick(HAIRS)); this.parts.hair.setColorAt(i, col);
      col.setHex(shirt).multiplyScalar(0.62);
      this.parts.upperArm.setColorAt(i * 2, col);
      this.parts.upperArm.setColorAt(i * 2 + 1, col);
      setPair(this.parts.lowerArm, i, skin);
      setPair(this.parts.upperLeg, i, trouser);
      col.setHex(trouser).multiplyScalar(0.9);
      this.parts.lowerLeg.setColorAt(i * 2, col);
      this.parts.lowerLeg.setColorAt(i * 2 + 1, col);
      setPair(this.parts.shoe, i, pick(SHOES));
    }
    for (const m of this.meshes) m.instanceColor.needsUpdate = true;

    /* ------------------------------------------------------------ scratch */
    this._m = new THREE.Matrix4();
    this._bodyQ = new THREE.Quaternion();
    this._limbQ = new THREE.Quaternion();
    this._outQ = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._off = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    this._scale = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._j0 = new THREE.Vector3();
    this._j1 = new THREE.Vector3();
    this._j2 = new THREE.Vector3();
    // These must match the limb geometry, since the chain walks these lengths.
    this._armLen = 0.30;
    this._thighLen = 0.40;
    this._calfLen = 0.40;

    for (let i = 0; i < count; i++) {
      const p = {
        index: i,
        pos: new THREE.Vector3(),
        yaw: 0,
        speed: 0,
        state: STATE.WALK,
        phase: rng.rand() * Math.PI * 2,
        height: rng.range(0.92, 1.08),
        build: rng.range(0.9, 1.12),
        fall: 0,
        fallDir: 0,
        downFor: 0,
        scared: 0,
        headYaw: 0,
        // Cropped through to a full head of volume, and a hat sits proud of the
        // skull rather than following it. The vertical scale is never allowed
        // below 1: the hair is sized to just clear the crown, so shrinking it
        // pops the top of the head back through.
        hair: this._headwear[i]
          ? new THREE.Vector3(1.08, rng.range(1.0, 1.06), 1.08)
          : new THREE.Vector3(1, rng.range(1.0, 1.14), 1),
      };
      this._respawn(p, null, true);
      this.people.push(p);
    }
    this._write();
  }

  _respawn(p, playerPos, initial = false) {
    const rng = this.rng;
    for (let attempt = 0; attempt < 20; attempt++) {
      const cx = blockCentre(Math.floor(rng.rand() * GRID));
      const cz = blockCentre(Math.floor(rng.rand() * GRID));
      const ring = BLOCK / 2 - rng.range(1.6, 4.2);
      const side = Math.floor(rng.rand() * 4);
      const along = rng.range(-ring, ring);

      const x = side === 0 ? cx + ring : side === 1 ? cx - ring : cx + along;
      const z = side === 2 ? cz + ring : side === 3 ? cz - ring : cz + along;

      if (!initial && playerPos) {
        const d = Math.hypot(x - playerPos.x, z - playerPos.z);
        if (d < 60 || d > 200) continue;
      }

      p.pos.set(x, 0, z);
      p.yaw = (side < 2 ? 0 : Math.PI / 2) + (rng.rand() < 0.5 ? 0 : Math.PI);
      p.speed = rng.range(1.05, 1.75);
      p.state = STATE.WALK;
      p.fall = 0;
      p.downFor = 0;
      p.scared = 0;
      p.headYaw = 0;
      return;
    }
  }

  /**
   * Place one part.
   *
   * `local` is the joint position in body space — relative to the waist, before
   * the body's own rotation — and `q` is the part's local rotation. The world
   * transform is the body rotation applied to both.
   */
  _place(mesh, idx, local, q, scale, p, hipY) {
    this._off.copy(local).applyQuaternion(this._bodyQ);
    this._pos.set(p.pos.x + this._off.x, hipY + this._off.y, p.pos.z + this._off.z);
    this._outQ.copy(this._bodyQ).multiply(q);
    this._m.compose(this._pos, this._outQ, scale);
    mesh.setMatrixAt(idx, this._m);
  }

  /**
   * Where a limb ends: rotate its down-vector by the limb's own rotation and
   * add it to the joint it hangs from.
   *
   * Chaining through the parent's quaternion is the whole point. Deriving the
   * child joint analytically from sines and cosines is exactly how the arms
   * ended up detached at the hip — the sign conventions of an Euler triple are
   * very easy to get backwards, and a quaternion cannot disagree with itself.
   */
  _endOf(joint, q, length, out) {
    return out.set(0, -length, 0).applyQuaternion(q).add(joint);
  }

  /**
   * Pose everyone.
   *
   * One phase angle per person drives the whole gait: legs swing in antiphase,
   * knees only ever bend backwards, arms counter-swing against the legs, and
   * the hips rise twice per stride. That last detail is most of what separates
   * a walk from a slide.
   */
  _write() {
    const P = this.parts;
    const A = this._armLen, T = this._thighLen, C = this._calfLen;

    for (const p of this.people) {
      const i = p.index;
      const h = p.height;
      const running = p.state === STATE.FLEE;

      const amp = p.state === STATE.DOWN ? 0 : running ? 0.95 : 0.52;
      const swing = Math.sin(p.phase) * amp;
      const counter = -swing;
      const kneeL = Math.max(0, -Math.cos(p.phase)) * (running ? 1.15 : 0.55);
      const kneeR = Math.max(0, Math.cos(p.phase)) * (running ? 1.15 : 0.55);
      const bob = Math.abs(Math.sin(p.phase)) * (running ? 0.055 : 0.03);

      const fall = p.fall;
      const lean = running ? 0.20 : 0.04;
      // Stopping the pitch short of flat leaves the body slightly on its side,
      // which reads as a person on the ground; dead flat reads as a rug.
      const pitch = lean + fall * (1.40 - lean);
      const drop = fall * (B.hip * h - 0.22);   // hips down to lying height

      this._e.set(pitch, p.yaw, p.fallDir * fall * 0.45, 'YXZ');
      this._bodyQ.setFromEuler(this._e);

      const hipY = B.hip * h + bob - drop;
      const bodyScale = this._scale.set(p.build, h, p.build);
      const neckY = (B.neck - B.hip) * h;
      const shoulderY = (B.shoulder - B.hip) * h;

      // torso, head, hair
      this._e.set(0, 0, 0, 'XYZ');
      this._q1.setFromEuler(this._e);
      this._place(P.torso, i, this._j0.set(0, 0, 0), this._q1, bodyScale, p, hipY);

      // The head counter-rotates against the body lean and turns toward
      // whatever startled them. Almost free, and it is the single cheapest
      // thing that stops a crowd looking like furniture.
      this._e.set(-pitch * 0.3, p.headYaw, 0, 'XYZ');
      this._q1.setFromEuler(this._e);
      this._j0.set(0, neckY, 0.015);
      this._place(P.head, i, this._j0, this._q1, this._one, p, hipY);
      this._place(P.hair, i, this._j0, this._q1, p.hair, p, hipY);

      /* arms: shoulder -> elbow -> hand
       *
       * Once the body is pitched face-down, the arm's own pitch axis points
       * along the ground and its splay axis points *through* it — so on the way
       * down the pose has to move out of pitch and into splay, or the arms end
       * up waving at the sky. */
      for (const [k, side, sw] of [[0, -1, counter], [1, 1, swing]]) {
        const splay = side * (0.06 + fall * 0.5);
        const upper = -sw * 0.62 * (1 - fall);
        const bend = 0.17 + Math.max(0, sw) * 0.45 + fall * 0.22;

        this._j0.set(side * B.shoulderX * p.build, shoulderY, 0);
        this._e.set(upper, 0, splay, 'XYZ');
        this._q1.setFromEuler(this._e);
        this._place(P.upperArm, i * 2 + k, this._j0, this._q1, this._one, p, hipY);

        this._endOf(this._j0, this._q1, A, this._j1);
        this._e.set(upper + bend, 0, splay, 'XYZ');
        this._q2.setFromEuler(this._e);
        this._place(P.lowerArm, i * 2 + k, this._j1, this._q2, this._one, p, hipY);
      }

      // legs: hip -> knee -> ankle
      for (const [k, side, sw, knee] of [
        [0, -1, swing, kneeL], [1, 1, counter, kneeR],
      ]) {
        // Same story as the arms: a downward hip swing points into the tarmac
        // once the body is flat, so it has to ease upward as the fall lands.
        const hipSwing = sw * 0.5 * (1 - fall) + fall * 0.12;
        const splay = side * fall * 0.32;

        this._j0.set(side * B.hipX * p.build, 0, 0);
        this._e.set(hipSwing, 0, splay, 'XYZ');
        this._q1.setFromEuler(this._e);
        this._place(P.upperLeg, i * 2 + k, this._j0, this._q1, this._one, p, hipY);

        this._endOf(this._j0, this._q1, T * h, this._j1);
        this._e.set(hipSwing + knee, 0, splay, 'XYZ');
        this._q2.setFromEuler(this._e);
        this._place(P.lowerLeg, i * 2 + k, this._j1, this._q2, this._one, p, hipY);

        this._endOf(this._j1, this._q2, C * h, this._j2);
        this._e.set((hipSwing + knee) * 0.35, 0, 0, 'XYZ');
        this._q1.setFromEuler(this._e);
        this._place(P.shoe, i * 2 + k, this._j2, this._q1, this._one, p, hipY);
      }
    }

    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  /**
   * @returns {number} how many people were struck this frame
   */
  update(dt, vehicle) {
    const car = vehicle.position;
    const speed = Math.abs(vehicle.speed);
    let struck = 0;

    for (const p of this.people) {
      const dx = p.pos.x - car.x;
      const dz = p.pos.z - car.z;
      const dist = Math.hypot(dx, dz);

      if (p.state === STATE.DOWN) {
        // Go over in about half a second, then lie still.
        p.fall = damp(p.fall, 1, 5.5, dt);
        p.downFor += dt;
        if (p.downFor > 14) this._respawn(p, car);
        continue;
      }

      if (dist < 2.1 && speed > 1.5) {
        p.state = STATE.DOWN;
        p.fall = 0.04;
        p.downFor = 0;
        p.fallDir = Math.random() < 0.5 ? -1 : 1;
        const push = clamp(speed * 0.06, 0.4, 2.2);
        p.pos.x += (dx / (dist || 1)) * push;
        p.pos.z += (dz / (dist || 1)) * push;
        struck++;
        this.hits++;
        continue;
      }

      const threat = speed > 6 && dist < 16;
      if (threat) {
        if (p.scared < 0.2) this.nearMisses++;
        p.scared = 1;
        p.state = STATE.FLEE;
      } else if (p.scared > 0) {
        p.scared = Math.max(0, p.scared - dt * 0.5);
        if (p.scared === 0) p.state = STATE.WALK;
      }

      // Glance at the car while it is close, then drift back to looking ahead.
      // Clamped so nobody's head spins round backwards.
      const wantLook = dist < 30
        ? clamp(wrapAngle(Math.atan2(-dx, -dz) - p.yaw), -1.15, 1.15)
        : 0;
      p.headYaw = damp(p.headYaw, wantLook, 4.5, dt);

      const v = p.state === STATE.FLEE ? 4.6 : p.speed;
      if (p.state === STATE.FLEE) {
        const away = Math.atan2(dx, dz);
        p.yaw += wrapAngle(away - p.yaw) * clamp(dt * 7, 0, 1);
      }
      p.pos.x += Math.sin(p.yaw) * v * dt;
      p.pos.z += Math.cos(p.yaw) * v * dt;

      // Stride rate follows speed, so nobody moonwalks.
      p.phase = (p.phase + (v / (0.78 * p.height)) * dt * Math.PI) % (Math.PI * 2);

      if (dist > 240) this._respawn(p, car);
    }

    this._write();
    return struck;
  }

  reset() {
    this.hits = 0;
    this.nearMisses = 0;
    for (const p of this.people) this._respawn(p, null, true);
    this._write();
  }
}
