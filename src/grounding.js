import * as THREE from 'three';
import { solveTwoBoneIK, makeIKOut } from './ik.js';
import { LEG } from './character.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
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
  };
}

// Layers the terrain correction on top of the animation pose:
//   anim pose -> ground sampling -> contact weights (support vs swing) ->
//   clamped pelvis offset -> two-bone IK -> foot orientation blend.
export class Grounder {
  constructor(char, terrain, metrics) {
    this.char = char;
    this.terrain = terrain;
    this.metrics = metrics;
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
  }

  reset() {
    this.w.L = this.w.R = 0;
    this.drop = 0;
    this.baseH = null;
    this.baseVel = 0;
    for (const s of ['L', 'R']) {
      this.feet[s].gy = null;
      this.feet[s].planted = false;
      this.feet[s].reachFade = 1;
    }
  }

  pole(side) {
    // stable knee reference: character forward, slightly outward per leg
    return _v1.set(side === 'L' ? 0.15 : -0.15, 0, 1).normalize();
  }

  update(dt, t, distance) {
    const c = this.char;
    c.setAnimPose(t, distance);
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
    //    terrain with a rate-limited, velocity-smoothed follow; on sample
    //    miss it freezes in place.
    const rootSmp = this.terrain.sample(c.root.position.x, c.root.position.z);
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
      const smp = this.terrain.sample(anklePos.x, anklePos.z);
      st.hit = smp.hit;
      if (smp.hit) {
        st.point.set(anklePos.x, smp.y, anklePos.z);
        st.normal.copy(smp.normal);
        st.groundY = smp.y;
      } else {
        st.point.set(anklePos.x, anklePos.y - LEG.ankleH, anklePos.z);
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

      // contact latch: stores the touchdown point; the actual blend weight
      // is the continuous plantWindow, so entry, heel raise and release
      // never switch branches discontinuously. If a riser is directly
      // ahead, the plant is pulled back so the toe clears the wall.
      if (!st.planted && target > 0.55 && smp.hit) {
        st.planted = true;
        let px = anklePos.x, pz = anklePos.z;
        for (let k = 0; k < 6; k++) {
          const ahead = this.terrain.sample(px + c.heading.x * 0.19, pz + c.heading.z * 0.19);
          if (!ahead.hit || ahead.y <= smp.y + 0.03) break;
          px -= c.heading.x * 0.03; pz -= c.heading.z * 0.03;
        }
        // riser wall behind the plant (descending stairs): push the plant
        // forward until the heel clears the wall
        for (let k = 0; k < 6; k++) {
          const behind = this.terrain.sample(px - c.heading.x * 0.08, pz - c.heading.z * 0.08);
          if (!behind.hit || behind.y <= smp.y + 0.02) break;
          px += c.heading.x * 0.03; pz += c.heading.z * 0.03;
        }
        const ps = this.terrain.sample(px, pz);
        st.plantX = px; st.plantY = ps.hit ? ps.y : smp.y; st.plantZ = pz;
        st.reachFade = 1;
      }
      let pw = st.planted ? plantWindow(c.phase(s)) : 0;
      if (st.planted) {
        // one-way reach release: when the planted leg nears full reach the
        // grip fades out (push-off) instead of pinning the knee at the
        // extension limit; it cannot re-grip until the next contact
        const hipY = c.root.position.y - 0.05;
        const dEst = Math.hypot(
          st.target.x - c.root.position.x,
          st.target.y - hipY,
          st.target.z - c.root.position.z);
        st.reachFade = Math.min(st.reachFade,
          1 - THREE.MathUtils.smoothstep(dEst, softMax * 0.96, softMax * 0.995));
        pw *= st.reachFade;
        if (pw < 0.01) st.planted = false;
      }

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
        const as = this.terrain.sample(st.target.x, st.target.z);
        const hs = this.terrain.sample(
          st.target.x - c.heading.x * 0.08, st.target.z - c.heading.z * 0.08);
        const ankBad = as.hit && as.y > st.target.y - 0.02;
        const heelBad = hs.hit && hs.y > st.target.y - 0.02;
        if (!ankBad && !heelBad) break;
        const fw = this.terrain.sample(st.target.x + c.heading.x * 0.08, st.target.z + c.heading.z * 0.08);
        const bk = this.terrain.sample(st.target.x - c.heading.x * 0.08, st.target.z - c.heading.z * 0.08);
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
      const gs = this.terrain.sample(st.target.x, st.target.z);
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
      const ns = this.terrain.sample(st.target.x, st.target.z);
      if (ns.hit && ns.normal) st.normal.copy(ns.normal);

      st.quat.copy(animQuat);
      if (smp.hit && w > 1e-3) {
        // a planted foot aligns to the tread at its plant point, not to
        // the edge gradient under the sliding ankle; and riser-wall
        // gradients steeper than 30° never tilt the sole
        if (st.planted) {
          const ps = this.terrain.sample(st.plantX, st.plantZ);
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

    // 5) metrics
    if (this.metrics) {
      const m = this.metrics;
      const data = { soleY: {}, groundY: {}, hit: {}, w: {}, kneeFlex: {}, hipY: c.root.position.y };
      for (const s of ['L', 'R']) {
        const st = this.feet[s];
        const sole = c['sole' + s].getWorldPosition(_v2);
        data.soleY[s] = sole.y;
        // penetration is measured against the terrain directly below the
        // actual sole, not below the animation's foot
        const soleSmp = this.terrain.sample(sole.x, sole.z);
        data.groundY[s] = soleSmp.hit ? soleSmp.y : 0;
        data.hit[s] = soleSmp.hit;
        data.w[s] = st.w;
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
