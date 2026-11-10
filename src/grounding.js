import * as THREE from 'three';
import { solveTwoBoneIK, makeIKOut } from './ik.js';
import { LEG } from './character.js';
import { RELEASE, MAX_FOLLOW_STEP, MAX_FOLLOW_SPEED } from './platforms.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// support-phase window of the gait cycle with smooth entry/exit ramps;
// the exit ends at the animation's toe-off (p=0.62) so the correction
// releases before the swing foot swings back out of reach
function supportWeight(p) {
  const up = THREE.MathUtils.smoothstep(p, 0.0, 0.06);
  const down = 1 - THREE.MathUtils.smoothstep(p, 0.52, 0.62);
  return up * down;
}

// plant-blend window over the stance: ramps in after heel strike, holds the
// foot locked mid-stance, ramps out for the toe-off heel raise
function plantWindow(p) {
  return THREE.MathUtils.smoothstep(p, 0.02, 0.12) * (1 - THREE.MathUtils.smoothstep(p, 0.42, 0.58));
}

function setWorldQuat(obj, q) {
  obj.parent.getWorldQuaternion(_q1).invert();
  obj.quaternion.copy(_q1.multiply(q));
  obj.updateMatrixWorld(true);
}

// orient a downward-hanging limb segment (local -Y along the bone) so it
// points from `from` to `to`, twisting around a stable forward reference
function orientLimb(joint, from, to, forward) {
  _v1.subVectors(to, from);
  if (_v1.lengthSq() < 1e-12) return;
  _v1.normalize();                       // bone direction
  const y = _v2.copy(_v1).negate();      // local +Y maps to -dir
  const z = _v3.copy(forward).addScaledVector(_v1, -forward.dot(_v1));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(_v1, -_v1.z);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  z.crossVectors(x, y);
  _m.makeBasis(x, y, z);
  _q2.setFromRotationMatrix(_m);
  setWorldQuat(joint, _q2);
}

// foot orientation aligned to the terrain: local +Y -> ground normal,
// local +Z -> heading projected on the ground plane
function groundQuat(normal, heading, out) {
  const z = _v3.copy(heading).addScaledVector(normal, -heading.dot(normal));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1);
  z.normalize();
  const x = _v2.crossVectors(normal, z);
  _m.makeBasis(x, normal, z);
  return out.setFromRotationMatrix(_m);
}

function footState() {
  return {
    target: new THREE.Vector3(),   // IK ankle target (world)
    animPos: new THREE.Vector3(),  // ankle world pos from the raw animation
    quat: new THREE.Quaternion(),  // desired foot world orientation
    point: new THREE.Vector3(),    // terrain sample point
    normal: new THREE.Vector3(0, 1, 0),
    gy: null,                      // smoothed ground target height (swing/transition)
    planted: false,                // contact latch: foot locked to its plant point
    plantX: 0, plantY: 0, plantZ: 0,
    reachFade: 1,                  // one-way plant release as the leg nears full reach
    hit: false, groundY: 0, clamped: false, w: 0,
    // anchor identity: a contact on a moving object is stored in the object's
    // local frame and re-expressed in world space every frame. null means the
    // contact is with the static terrain (plantX/Y/Z stay world-space).
    anchorObj: null,               // object generation id
    anchorLocal: new THREE.Vector3(),
    anchorFrame: 'world',          // 'world' (static ground) | 'object:<id>'
    releaseReason: RELEASE.NONE,
    // the last OBJECT-anchor failure. Unlike releaseReason this is not
    // touched by static-ground gait bookkeeping, so an object-gone / teleport
    // / edge explanation stays explainable across later frames until a new
    // object contact is formed.
    objectReleaseReason: RELEASE.NONE,
    surfaceVel: new THREE.Vector3(),
    relVel: new THREE.Vector3(),
    _prevSole: null,
    _prevPlant: null,
    _anchorPrevWorld: new THREE.Vector3(),
    _latchAge: 0,
    _brokeThisFrame: false,
    _authoritativeReason: false,
  };
}

// Layers the terrain correction on top of the animation pose:
//   anim pose -> ground sampling -> contact weights (support vs swing) ->
//   clamped pelvis offset -> two-bone IK -> foot orientation blend.
export class Grounder {
  constructor(char, terrain, metrics, platforms = null) {
    this.char = char;
    this.terrain = terrain;
    this.metrics = metrics;
    this.platforms = platforms;
    this.enabled = true;
    this.w = { L: 0, R: 0 };
    this.drop = 0;                            // smoothed fine pelvis offset
    this.dropLimits = { down: -0.35, up: 0.06 }; // fine offset cannot chase any height
    this.baseH = null;                        // terrain-following base height of the root
    this.baseVel = 0;
    this.baseRate = { up: 1.2, down: 2.5 };   // m/s the body may follow terrain
    this.feet = { L: footState(), R: footState() };
    this.ik = { L: makeIKOut(), R: makeIKOut() };
    this.prevKneeDir = { L: new THREE.Vector3(0, 0, 1), R: new THREE.Vector3(0, 0, 1) };
    this.baseRootY = 0;
    this._lastT = null;
  }

  reset(reason = RELEASE.RESET) {
    this.w.L = this.w.R = 0;
    this.drop = 0;
    this.baseH = null;
    this.baseVel = 0;
    this._lastT = null;
    for (const s of ['L', 'R']) this._releaseFoot(this.feet[s], reason);
  }

  // Scrubbing the timeline: latches are state that only has meaning in frame
  // order, so every anchored contact is invalidated with an explicit reason;
  // the next frame rebuilds it from current samples (no frame-N-1 dependency).
  seek(t) {
    this.reset(RELEASE.TIME_SEEK);
    this._lastRX = undefined;
    this._lastRZ = undefined;
    this.platforms?.update(t);
  }

  _releaseFoot(st, reason) {
    st.gy = null;
    st.planted = false;
    st.reachFade = 1;
    // anchor-driven releases (object gone / jump / edge / seek) are the
    // authoritative explanation and must survive later gait bookkeeping;
    // evaluate before clearing the anchor reference
    const authoritative = st.anchorObj !== null;
    if (authoritative || st.releaseReason === RELEASE.NONE) {
      st.releaseReason = reason;
    }
    // object failures are recorded on their own channel that static-ground
    // re-latching never clears, so the panel can still explain why the last
    // platform contact ended long after the foot is back on ordinary ground
    if (authoritative) st.objectReleaseReason = reason;
    st._authoritativeReason = authoritative;
    st._brokeThisFrame = authoritative;
    st.anchorObj = null;
    st.anchorFrame = 'world';
    st._prevSole = null;
    st._prevPlant = null;
  }

  // combined static-terrain + moving-object sample; highest top wins
  sampleAll(x, z) {
    const ts = this.terrain.sample(x, z);
    const ps = this.platforms ? this.platforms.sample(x, z) : null;
    if (!ps) return ts;
    if (!ts.hit || ps.y >= ts.y) return ps;
    return ts;
  }

  // Re-validate and refresh an object-bound anchor. Platform movement is
  // carried through the local->world transform, never fed through the gait
  // weight logic, so a moving plant does not read as foot sliding and a jump
  // beyond the follow policy breaks contact instead of stretching the leg.
  _refreshAnchor(st, dt) {
    const id = st.anchorObj;
    const p = this.platforms?.get(id) ?? null;
    if (!p) { this._releaseFoot(st, RELEASE.OBJECT_GONE); return; }
    const world = p.localToWorld(st.anchorLocal, _v1);
    const moved = world.distanceTo(st._anchorPrevWorld);
    const speed = dt > 0 ? moved / dt : 0;
    if (moved > MAX_FOLLOW_STEP || speed > MAX_FOLLOW_SPEED) {
      this._releaseFoot(st, RELEASE.TELEPORT);
      return;
    }
    if (!p.containsLocal(p.worldToLocal(world, _v2))) {
      this._releaseFoot(st, RELEASE.EDGE);
      return;
    }
    st.plantX = world.x;
    st.plantY = world.y;
    st.plantZ = world.z;
    st._anchorPrevWorld.copy(world);
  }

  pole(side) {
    // stable knee reference: character forward, slightly outward per leg
    return _v1.set(side === 'L' ? 0.15 : -0.15, 0, 1).normalize();
  }

  update(dt, t, distance) {
    const c = this.char;
    c.setAnimPose(t, distance);
    // moving objects advance first; their pose at time t is deterministic,
    // independent of how many frames were skipped
    this.platforms?.update(t);
    // implicit timeline jump (explicit seek() already resets): frame-to-frame
    // time gap far beyond the fixed step invalidates every latch
    if (this._lastT !== null && Math.abs(t - this._lastT) > Math.max(0.1, 4 * dt)) {
      this.reset(RELEASE.TIME_SEEK);
      this._lastRX = undefined;
      this._lastRZ = undefined;
    }
    this._lastT = t;

    // refresh object-bound anchors before anything uses the plant points
    for (const s of ['L', 'R']) this.feet[s]._brokeThisFrame = false;
    for (const s of ['L', 'R']) {
      const st = this.feet[s];
      if (st.planted && st.anchorObj !== null) this._refreshAnchor(st, dt);
    }
    // weighted average of anchor xz deltas: on a rotating table the hips
    // translate with the feet, while static-ground feet contribute nothing
    let carryX = 0, carryZ = 0, carryW = 0;
    for (const s of ['L', 'R']) {
      const st = this.feet[s];
      if (st.planted && st.anchorObj !== null) {
        const p = this.platforms.get(st.anchorObj);
        const world = p.localToWorld(st.anchorLocal, _v1);
        const pw = plantWindow(c.phase(s)) * st.reachFade;
        carryX += (world.x - st._anchorPrevWorld.x) * pw;
        carryZ += (world.z - st._anchorPrevWorld.z) * pw;
        carryW += pw;
      }
    }
    if (carryW > 0) {
      c.root.position.x += carryX;
      c.root.position.z += carryZ;
      c.root.updateMatrixWorld(true);
    }

    // teleport detection (path wrap, terrain swap, manual jump): a root
    // displacement far beyond walking speed invalidates latched plants,
    // smoothed ground heights and the base-height follow state
    if (this._lastRZ !== undefined) {
      const dx = c.root.position.x - this._lastRX;
      const dz = c.root.position.z - this._lastRZ;
      if (dx * dx + dz * dz > 0.36) this.reset();
    }
    this._lastRX = c.root.position.x;
    this._lastRZ = c.root.position.z;
    this.baseRootY = c.root.position.y;
    if (!this.enabled) {
      c.root.position.y = this.baseRootY;
      c.root.updateMatrixWorld(true);
      this.w.L = this.w.R = 0;
      this.feet.L.w = this.feet.R.w = 0;
      this.feet.L.hit = this.feet.R.hit = false;
      return;
    }

    // 0) terrain-following base height under the root: the body rides the
    //    terrain (including platform tops) with a rate-limited, velocity-
    //    smoothed follow; on sample miss it freezes in place.
    const rootSmp = this.sampleAll(c.root.position.x, c.root.position.z);
    if (rootSmp.hit) {
      if (this.baseH === null) { this.baseH = rootSmp.y; this.baseVel = 0; }
      else {
        const d = rootSmp.y - this.baseH;
        const rate = d > 0 ? this.baseRate.up : this.baseRate.down;
        const desiredVel = THREE.MathUtils.clamp(d * 6, -rate, rate);
        this.baseVel += (desiredVel - this.baseVel) * (1 - Math.exp(-dt / 0.08));
        this.baseH += this.baseVel * dt;
      }
    } else {
      this.baseVel = 0;
    }
    c.root.position.y = this.baseRootY + (this.baseH ?? 0) + this.drop;
    c.root.updateMatrixWorld(true);

    // 1) sample terrain, update contact weights, build per-foot targets
    const softMax = 0.985 * (LEG.thigh + LEG.shin);
    let dropErr = null;
    for (const s of ['L', 'R']) {
      const st = this.feet[s];
      const ankleJ = c.joints['ankle' + s];
      const anklePos = ankleJ.getWorldPosition(st.animPos);
      const animQuat = ankleJ.getWorldQuaternion(_q1);
      const smp = this.sampleAll(anklePos.x, anklePos.z);
      st.hit = smp.hit;
      if (smp.hit) {
        st.point.set(anklePos.x, smp.y, anklePos.z);
        st.normal.copy(smp.normal);
        st.groundY = smp.y;
        // surface velocity is zero on static ground; otherwise the bound
        // object's local rigid-body velocity at this world point
        if (smp.obj !== undefined) {
          const plat = this.platforms.get(smp.obj);
          plat.surfaceVelAt(st.point, st.surfaceVel);
        } else st.surfaceVel.set(0, 0, 0);
      } else {
        st.point.set(anklePos.x, anklePos.y - LEG.ankleH, anklePos.z);
        st.surfaceVel.set(0, 0, 0);
        this.metrics?.miss(s);
      }

      let target = 0;
      if (smp.hit) {
        const hAbove = anklePos.y - smp.y;
        const prox = THREE.MathUtils.clamp(1 - (hAbove - 0.10) / 0.20, 0, 1);
        const wPhase = supportWeight(c.phase(s));
        // support foot gets full weight; swing foot only a weak proximity
        // assist so the two feet are never both hard-snapped to the ground
        target = Math.max(wPhase, 0.15 * prox);
        if (hAbove > 0.4) target *= 0.25; // ground far below: don't stretch
        target = THREE.MathUtils.clamp(target, 0, 1);
      }
      // continuous enter/exit transition; release runs faster so the
      // correction lets go promptly at toe-off instead of dragging the
      // swing foot toward the floor
      const tau = target > this.w[s] ? 0.07 : 0.035;
      this.w[s] += (target - this.w[s]) * (1 - Math.exp(-dt / tau));
      const w = this.w[s];
      st.w = w;

      // contact latch: stores the touchdown point. On a moving object the
      // point is kept in the object's local frame and re-expressed in world
      // space every frame; on static ground it stays a world-space point.
      // The actual blend weight is the continuous plantWindow, so entry,
      // heel raise and release never switch branches discontinuously. A
      // riser directly ahead pulls the plant back so the toe clears it.
      // support-phase entry for moving objects: platform tops are flat, but
      // the ankle's height timing as the character walks onto a raised slab
      // can keep the blended `target` below 0.55 for the whole stance, so
      // the gait phase is used as the touchdown signal. Static terrain keeps
      // the original target-only entry untouched.
      const phaseEntry = smp.obj !== undefined &&
        supportWeight(c.phase(s)) > 0.55 && (anklePos.y - smp.y) < 0.25;
      if (!st.planted && !st._brokeThisFrame &&
          (target > 0.55 || phaseEntry) && smp.hit) {
        st.planted = true;
        st.releaseReason = RELEASE.NONE;
        st._latchAge = 0;
        st._authoritativeReason = false;
        let px = anklePos.x, pz = anklePos.z;
        for (let k = 0; k < 6; k++) {
          const ahead = this.sampleAll(px + c.heading.x * 0.19, pz + c.heading.z * 0.19);
          if (!ahead.hit || ahead.y <= smp.y + 0.03) break;
          px -= c.heading.x * 0.03; pz -= c.heading.z * 0.03;
        }
        // riser wall behind the plant (descending stairs): push the plant
        // forward until the heel clears the wall
        for (let k = 0; k < 6; k++) {
          const behind = this.sampleAll(px - c.heading.x * 0.08, pz - c.heading.z * 0.08);
          if (!behind.hit || behind.y <= smp.y + 0.02) break;
          px += c.heading.x * 0.03; pz += c.heading.z * 0.03;
        }
        const ps = this.sampleAll(px, pz);
        st.plantX = px; st.plantY = ps.hit ? ps.y : smp.y; st.plantZ = pz;
        st.reachFade = 1;
        if (smp.obj !== undefined) {
          const plat = this.platforms.get(smp.obj);
          st.anchorObj = plat.id;
          st.anchorFrame = 'object:' + plat.id;
          // a fresh object contact starts a new explanation cycle
          st.objectReleaseReason = RELEASE.NONE;
          plat.worldToLocal(new THREE.Vector3(px, st.plantY, pz), st.anchorLocal);
          plat.localToWorld(st.anchorLocal, st._anchorPrevWorld);
        } else {
          st.anchorObj = null;
          st.anchorFrame = 'world';
        }
      }
      let pw = st.planted ? plantWindow(c.phase(s)) : 0;
      if (st.planted) {
        // an anchor released earlier in this same frame (object gone / jump /
        // edge) stays released: never resurrect it through the gait reach path
        if (st._brokeThisFrame) {
          st.planted = false;
          pw = 0;
        }
      }
      if (st.planted) {
        // one-way reach release: when the planted leg nears full reach the
        // grip fades out (push-off) instead of pinning the knee at the
        // extension limit; it cannot re-grip until the next contact.
        // Object anchors evaluate distance to the plant point itself,
        // because st.target is still blended from the swing animation and
        // a rotating platform legitimately carries the plant toward the
        // reach limit; static-ground latches keep the original target test.
        // Static-ground latches keep the original immediate reach release
        // (the weight blend still grounds the foot); only object anchors get
        // an entry grace, because their plant-based reach estimate and the
        // rotating-table carry need the first blended frames to settle.
        if (st.anchorObj !== null) st._latchAge++;
        const grace = st.anchorObj !== null && st._latchAge <= 3;
        if (!grace) {
          const hipY = c.root.position.y - 0.05;
          let dx, dy, dz;
          if (st.anchorObj !== null) {
            dx = st.plantX - c.root.position.x;
            dy = (st.plantY + LEG.ankleH) - hipY;
            dz = st.plantZ - c.root.position.z;
          } else {
            dx = st.target.x - c.root.position.x;
            dy = st.target.y - hipY;
            dz = st.target.z - c.root.position.z;
          }
          const dEst = Math.hypot(dx, dy, dz);
          // Object anchors only release for a genuine over-extension past
          // the IK's own soft limit; the gait's normal stance reach must
          // not trip the one-way fade. Static ground keeps the original
          // tighter band that the existing tuning relies on.
          const lo = st.anchorObj !== null ? softMax * 1.015 : softMax * 0.96;
          const hi = st.anchorObj !== null ? softMax * 1.06 : softMax * 0.995;
          st.reachFade = Math.min(st.reachFade,
            1 - THREE.MathUtils.smoothstep(dEst, lo, hi));
        }
        pw *= st.reachFade;
        if (pw < 0.01) {
          // gait-driven release; never overwrites an authoritative
          // object/seek explanation already recorded for this contact
          if (!st._authoritativeReason) {
            st.releaseReason = st.reachFade < 0.99 ? RELEASE.REACH : RELEASE.TOE_OFF;
          }
          st.planted = false;
          st.anchorObj = null;
          st.anchorFrame = 'world';
        }
      } else st._latchAge = 0;

      // blended target xz (anim <-> latched plant)
      let tx = anklePos.x, tz = anklePos.z;
      if (pw > 0) {
        tx = THREE.MathUtils.lerp(anklePos.x, st.plantX, pw);
        tz = THREE.MathUtils.lerp(anklePos.z, st.plantZ, pw);
      }
      // provisional y (without the floor) for the declog probes
      st.target.set(tx, pw > 0
        ? THREE.MathUtils.lerp(anklePos.y, st.plantY + LEG.ankleH, pw)
        : anklePos.y, tz);

      // declog: the blended target must not end up inside terrain — e.g.
      // the plant release dragging the heel back into a riser, or the
      // blend-in cutting the corner below a higher tread. Step edges are
      // discontinuities (local normal stays vertical), so probe a foot
      // length to each side and walk toward strictly lower ground, at
      // most 6cm per frame so the knee never sees a teleport.
      for (let k = 0; k < 2; k++) {
        const as = this.sampleAll(st.target.x, st.target.z);
        const hs = this.sampleAll(
          st.target.x - c.heading.x * 0.08, st.target.z - c.heading.z * 0.08);
        const ankBad = as.hit && as.y > st.target.y - 0.02;
        const heelBad = hs.hit && hs.y > st.target.y - 0.02;
        if (!ankBad && !heelBad) break;
        const fw = this.sampleAll(st.target.x + c.heading.x * 0.08, st.target.z + c.heading.z * 0.08);
        const bk = this.sampleAll(st.target.x - c.heading.x * 0.08, st.target.z - c.heading.z * 0.08);
        const fy = fw.hit ? fw.y : Infinity;
        const by = bk.hit ? bk.y : Infinity;
        if (fy < by - 0.005) {
          st.target.x += c.heading.x * 0.03; st.target.z += c.heading.z * 0.03;
        } else if (by < fy - 0.005) {
          st.target.x -= c.heading.x * 0.03; st.target.z -= c.heading.z * 0.03;
        } else break;
      }

      // ground track sampled under the (declogged) target: the target
      // leads the solved ankle along the blend path, so the floor sees
      // risers and treads before the foot arrives and lifts/lowers it
      // gradually instead of snagging edges
      const gs = this.sampleAll(st.target.x, st.target.z);
      if (gs.hit) {
        const rawY = gs.y + LEG.ankleH;
        if (st.gy === null) st.gy = rawY;
        else st.gy += (rawY - st.gy) * (1 - Math.exp(-dt / 0.04));
      }
      let baseY = anklePos.y;
      if (st.gy !== null) {
        baseY = Math.max(THREE.MathUtils.lerp(anklePos.y, st.gy, w), st.gy - 0.008);
      }
      let ty = baseY;
      if (pw > 0) ty = THREE.MathUtils.lerp(baseY, st.plantY + LEG.ankleH, pw);
      st.target.y = ty;

      // orientation normal from the (declogged) target footprint, so a
      // riser edge right under the ankle cannot tilt the sole into a wall
      const ns = this.sampleAll(st.target.x, st.target.z);
      if (ns.hit && ns.normal) st.normal.copy(ns.normal);

      st.quat.copy(animQuat);
      if (smp.hit && w > 1e-3) {
        // a planted foot aligns to the tread at its plant point, not to
        // the edge gradient under the sliding ankle; and riser-wall
        // gradients steeper than 30° never tilt the sole
        if (st.planted) {
          const ps = this.sampleAll(st.plantX, st.plantZ);
          if (ps.hit && ps.normal) st.normal.copy(ps.normal);
        }
        _n.copy(st.normal);
        // riser edges produce steep finite-difference normals that would
        // pitch the sole into the step wall; real slopes here are ≤7°, so
        // anything beyond 20° is an edge artifact — treat it as flat
        if (_n.y < 0.94) _n.set(0, 1, 0);
        groundQuat(_n, c.heading, _q2);
        st.quat.slerp(_q2, Math.min(1, w));
      }

      if (smp.hit && pw > 0.3) {
        // pelvis error only from firmly planted feet: a toeing-off or
        // swinging foot must not drag the body down. Two signals:
        // the anim-space deficit and the true two-bone reach deficit —
        // a planted target below the reachable sphere must pull the
        // pelvis down or the sole floats.
        const e = st.target.y - anklePos.y;
        const hipY = c.root.position.y - 0.05;
        const dx = tx - c.root.position.x, dz = tz - c.root.position.z;
        const dh = Math.hypot(dx, dz);
        const reach = Math.sqrt(Math.max(softMax * 0.98 * softMax * 0.98 - dh * dh, 1e-6));
        const eReach = st.target.y - (hipY - reach);
        const em = Math.min(e, eReach);
        dropErr = dropErr === null ? em : Math.min(dropErr, em);
      }
    }

    // 2) pelvis offset: clamped and rate-limited
    let desired = dropErr === null ? 0
      : THREE.MathUtils.clamp(dropErr, this.dropLimits.down, this.dropLimits.up);
    let nd = this.drop + (desired - this.drop) * (1 - Math.exp(-dt / 0.09));
    const maxStep = 1.2 * dt;
    this.drop = THREE.MathUtils.clamp(nd, this.drop - maxStep, this.drop + maxStep);
    c.root.position.y = this.baseRootY + (this.baseH ?? 0) + this.drop;
    c.root.updateMatrixWorld(true);

    // 3) two-bone IK per leg toward the blended target
    for (const s of ['L', 'R']) {
      const st = this.feet[s];
      const hip = c.joints['thigh' + s].getWorldPosition(_v2);
      // soft reach limit: pull the target toward the hip before the IK's own
      // hard clamp can engage, so near full extension the solution moves
      // smoothly instead of snapping straight
      _v1.subVectors(st.target, hip);
      const d = _v1.length();
      if (d > softMax) st.target.copy(hip).addScaledVector(_v1.normalize(), softMax);
      const out = solveTwoBoneIK(hip, st.target, LEG.thigh, LEG.shin,
        this.pole(s), this.prevKneeDir[s], this.ik[s]);
      this.prevKneeDir[s].copy(out.kneeDir);
      st.clamped = out.clamped;
      if (out.clamped) this.metrics?.clamp(s);
      orientLimb(c.joints['thigh' + s], hip, out.knee, c.heading);
      orientLimb(c.joints['knee' + s], out.knee, out.ankle, c.heading);
    }

    // 4) foot orientation (after shins are oriented)
    for (const s of ['L', 'R']) setWorldQuat(c.joints['ankle' + s], this.feet[s].quat);

    // 5) relative surface velocity + metrics. Relative velocity (sole minus
    //    the bound surface) is the real sliding signal: a foot carried by a
    //    moving platform has near-zero relative speed even though its world
    //    velocity is large, so platform motion never reads as foot slip.
    //    Anchored feet measure at the plant point (the local-frame anchor),
    //    which removes IK soft-clamp and swing-blend noise from the signal.
    for (const s of ['L', 'R']) {
      const st = this.feet[s];
      const sole = c['sole' + s].getWorldPosition(_v2);
      const soleSmp = this.sampleAll(sole.x, sole.z);
      if (soleSmp.hit && soleSmp.obj !== undefined) {
        this.platforms.get(soleSmp.obj).surfaceVelAt(sole, st.surfaceVel);
      } else if (!soleSmp.hit) {
        st.surfaceVel.set(0, 0, 0);
      }
      if (st.anchorObj !== null) {
        // anchor plant world velocity vs. the bound surface velocity evaluated
        // at the SAME plant point: on a rotating table the surface speed
        // differs between sole and plant positions, so using the sole's value
        // would report a false ~0.6 m/s "slide" for a perfectly locked foot.
        const plat = this.platforms.get(st.anchorObj);
        const surfAtPlant = plat
          ? plat.surfaceVelAt(_v3.set(st.plantX, st.plantY, st.plantZ), _v4)
          : _v4.set(0, 0, 0);
        if (st._prevPlant === null) {
          st.relVel.set(0, 0, 0);
          st._prevPlant = new THREE.Vector3(st.plantX, st.plantY, st.plantZ);
        } else {
          st.relVel.set(
            (st.plantX - st._prevPlant.x) / Math.max(dt, 1e-6),
            (st.plantY - st._prevPlant.y) / Math.max(dt, 1e-6),
            (st.plantZ - st._prevPlant.z) / Math.max(dt, 1e-6)).sub(surfAtPlant);
          st._prevPlant.set(st.plantX, st.plantY, st.plantZ);
        }
      } else {
        st._prevPlant = null;
        if (st._prevSole === null) {
          st.relVel.set(0, 0, 0);
          st._prevSole = sole.clone();
        } else {
          st.relVel.subVectors(sole, st._prevSole).divideScalar(Math.max(dt, 1e-6)).sub(st.surfaceVel);
          st._prevSole.copy(sole);
        }
      }
    }
    if (this.metrics) {
      const m = this.metrics;
      const data = { soleY: {}, groundY: {}, hit: {}, w: {}, kneeFlex: {}, hipY: c.root.position.y, relVel: {} };
      for (const s of ['L', 'R']) {
        const st = this.feet[s];
        const sole = c['sole' + s].getWorldPosition(_v2);
        data.soleY[s] = sole.y;
        // penetration is measured against the surface directly below the
        // actual sole (static ground or platform top), not the animation's foot
        const soleSmp = this.sampleAll(sole.x, sole.z);
        data.groundY[s] = soleSmp.hit ? soleSmp.y : 0;
        data.hit[s] = soleSmp.hit;
        data.w[s] = st.w;
        data.relVel[s] = st.relVel.length();
        const hip = c.joints['thigh' + s].getWorldPosition(_v3);
        const knee = c.joints['knee' + s].getWorldPosition(new THREE.Vector3());
        const ankle = c.joints['ankle' + s].getWorldPosition(new THREE.Vector3());
        const v1 = hip.sub(knee), v2v = ankle.sub(knee);
        const ang = v1.angleTo(v2v);
        data.kneeFlex[s] = (Math.PI - ang) * 180 / Math.PI;
      }
      m.frame(data);
    }
  }
}
