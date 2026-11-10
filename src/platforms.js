import * as THREE from 'three';

// Why a release happened. The code is stored per foot and shown in the UI so
// a lost contact is always explainable instead of silently disappearing.
export const RELEASE = {
  NONE: 'none',
  TOE_OFF: 'toe-off',          // normal gait release at end of stance
  REACH: 'reach',              // leg at full extension, one-way grip fade
  OBJECT_GONE: 'object-gone',  // bound object deleted (vanish / recycle)
  TELEPORT: 'teleport',        // platform jump beyond the follow range
  TIME_SEEK: 'time-seek',      // playback scrubbed to another time
  EDGE: 'edge',                // anchor point no longer over the object
  RESET: 'reset',
};

export const RELEASE_LABEL = {
  'none': '接触中',
  'toe-off': '步态末期正常解除',
  'reach': '腿到达极限解除',
  'object-gone': '台面已删除 (物体代次失效)',
  'teleport': '台面跳位超限, 明确解除接触',
  'time-seek': '时间跳转, 锚点作废重建',
  'edge': '迈出边缘, 离开台面',
  'reset': '状态重置',
};

// Per-frame anchor motion beyond this displacement cannot be followed: the
// contact is released explicitly rather than stretching the leg after a
// jumping platform. Sized for the 1/120 fixed step; scaled by dt anyway.
export const MAX_FOLLOW_STEP = 0.12;   // m per frame
export const MAX_FOLLOW_SPEED = 3.0;   // m/s surface speed at the anchor

let nextId = 1;

// A platform is a rigid object whose pose is a pure function of sim time, so
// any time (including after a scrub) yields the same pose. Local frame origin
// is the centre of the top surface; the mesh hangs below it.
export class Platform {
  constructor(cfg) {
    this.id = nextId++;            // identity: never reused, even by same name
    this.name = cfg.name;          // non-unique label (recycled objects keep it)
    this.kind = cfg.kind;          // 'box' | 'disc'
    this.topY = cfg.topY;
    this.thick = cfg.thick ?? 0.2;
    this.size = cfg.size;          // box {w,d} | disc {r}
    this.motion = cfg.motion;      // (t) => { x, y, z, rotY }
    this.alive = cfg.alive ?? null; // optional (t) => boolean lifecycle
    this.color = cfg.color ?? 0x8a6fb0;
    this.pose = { x: 0, y: 0, z: 0, rotY: 0 };
    this.vel = new THREE.Vector3();
    this.omega = 0;
    this._buildMesh();
  }

  _buildMesh() {
    const geo = this.kind === 'disc'
      ? new THREE.CylinderGeometry(this.size.r, this.size.r, this.thick, 48)
      : new THREE.BoxGeometry(this.size.w, this.thick, this.size.d);
    const mat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.55, metalness: 0.15 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = this.name;
  }

  poseAt(t) { return this.motion(t); }

  // local (top-centre frame) -> world
  localToWorld(lp, out) {
    const c = Math.cos(this.pose.rotY), s = Math.sin(this.pose.rotY);
    return out.set(
      this.pose.x + c * lp.x + s * lp.z,
      this.pose.y + lp.y,
      this.pose.z - s * lp.x + c * lp.z);
  }

  worldToLocal(wp, out) {
    const c = Math.cos(this.pose.rotY), s = Math.sin(this.pose.rotY);
    const dx = wp.x - this.pose.x, dy = wp.y - this.pose.y, dz = wp.z - this.pose.z;
    return out.set(c * dx - s * dz, dy, s * dx + c * dz);
  }

  // world-space velocity of a surface point (translation + rotation about Y).
  // With the world = R(rotY)·local mapping used in localToWorld
  // (wx = c·lx + s·lz, wz = −s·lx + c·lz), the rotational part in world
  // components is v = ω·(rz, 0, −rx); getting this sign inverted would make
  // a foot locked to a rotating table read as sliding at twice the speed.
  surfaceVelAt(worldPoint, out) {
    out.copy(this.vel);
    if (this.omega !== 0) {
      const rx = worldPoint.x - this.pose.x;
      const rz = worldPoint.z - this.pose.z;
      out.x += this.omega * rz;
      out.z += -this.omega * rx;
    }
    return out;
  }

  containsLocal(lp) {
    if (this.kind === 'disc') return lp.x * lp.x + lp.z * lp.z <= this.size.r * this.size.r;
    return Math.abs(lp.x) <= this.size.w / 2 && Math.abs(lp.z) <= this.size.d / 2;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

const SCENARIO_DEFS = {
  // rotating round table on the walk path; feet on it ride the rotation
  'disc-rotate': () => [
    new Platform({
      name: '旋转圆台', kind: 'disc', topY: 0, thick: 0.22,
      size: { r: 1.25 }, color: 0x9a7fd0,
      motion: (t) => ({ x: 0, y: 0, z: 4.6, rotY: 0.35 * t }),
    }),
  ],
  // two independent slabs so the two feet can bind different objects
  'split': () => [
    new Platform({
      name: '左平移台', kind: 'box', topY: 0, thick: 0.2,
      size: { w: 0.7, d: 2.6 }, color: 0xd08a5a,
      motion: (t) => ({ x: -0.45 + 0.18 * Math.sin(1.1 * t), y: 0, z: 4.6, rotY: 0 }),
    }),
    new Platform({
      name: '右纵移台', kind: 'box', topY: 0, thick: 0.2,
      size: { w: 0.7, d: 2.6 }, color: 0x5aa0d0,
      motion: (t) => ({ x: 0.45, y: 0, z: 4.6 + 0.25 * Math.sin(0.8 * t), rotY: 0 }),
    }),
  ],
  // slab that exists only outside [4, 7) s; disappearance is an identity loss
  'vanish': () => [
    new Platform({
      name: '消失台面', kind: 'box', topY: 0, thick: 0.2,
      size: { w: 1.8, d: 2.2 }, color: 0x70c08a,
      motion: (t) => ({ x: 0, y: 0, z: 4.6, rotY: 0 }),
      alive: (t) => t < 4 || t >= 7,
    }),
  ],
  // discontinuous pose: 1.4 m jump at t=4, back at t=8. Sited on the actual
  // walk path (0.81 m/s -> z ~= 3.7 at t=4) so a foot is genuinely bound when
  // the discontinuity fires.
  'teleport': () => [
    new Platform({
      name: '跳位台面', kind: 'box', topY: 0, thick: 0.2,
      size: { w: 1.6, d: 1.6 }, color: 0xd06a6a,
      motion: (t) => {
        const z = t < 4 ? 3.1 : t < 8 ? 4.5 : 3.1;
        return { x: 0, y: 0, z, rotY: 0 };
      },
    }),
  ],
  // static slab; identity change is triggered explicitly through recycle()
  'recycle': () => [
    new Platform({
      name: '回收台面', kind: 'box', topY: 0, thick: 0.2,
      size: { w: 1.6, d: 2.0 }, color: 0xc0a050,
      motion: () => ({ x: 0, y: 0, z: 4.6, rotY: 0 }),
    }),
  ],
  // long slab sweeping sideways; used for the edge step-off check
  'translate': () => [
    new Platform({
      name: '横移长台', kind: 'box', topY: 0, thick: 0.2,
      size: { w: 1.4, d: 2.4 }, color: 0x6fb0c0,
      motion: (t) => ({ x: 0.55 * Math.sin(0.8 * t), y: 0, z: 4.6, rotY: 0 }),
    }),
  ],
};

export const PLATFORM_SCENARIOS = {
  'none': { label: '无移动台面 (静态地面)' },
  'disc-rotate': { label: '旋转圆台' },
  'split': { label: '双脚不同物体 (双平移台)' },
  'vanish': { label: '台面定时消失' },
  'teleport': { label: '台面突然跳位' },
  'recycle': { label: '台面回收 (同名不同代)' },
  'translate': { label: '横移长台 / 边缘迈出' },
};

// Owns the live object registry. Anchors reference objects by id, never by
// pointer, so a deleted id can never accidentally resolve to a recycled
// same-name object: the new object gets a fresh id and the lookup fails.
export class PlatformWorld {
  constructor(scene = null) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'platforms';
    scene?.add(this.group);
    this.registry = new Map(); // id -> Platform
    this.scenario = 'none';
    this._defs = [];
  }

  buildScenario(key) {
    this.clear();
    this.scenario = key;
    if (key === 'none') return;
    this._defs = SCENARIO_DEFS[key]?.() ?? [];
    for (const p of this._defs) {
      // lifecycle applies immediately: a scenario built inside a dead
      // window starts with no live object of that generation
      if (p.alive && !p.alive(0)) continue;
      this.registry.set(p.id, p);
      this.group.add(p.mesh);
    }
  }

  // delete by id and rebuild from its definition under a NEW id; the name is
  // preserved, proving anchors bind to object generations, not labels
  recycle(name) {
    const removed = [];
    for (const p of [...this.registry.values()]) {
      if (p.name === name) {
        this.group.remove(p.mesh);
        p.dispose();
        this.registry.delete(p.id);
        removed.push(p);
      }
    }
    const def = this._defs.find((d) => d.name === name);
    if (def) {
      const fresh = new Platform({
        name: def.name, kind: def.kind, topY: def.topY, thick: def.thick,
        size: { ...def.size }, color: def.color, motion: def.motion,
        alive: def.alive,
      });
      this.registry.set(fresh.id, fresh);
      this.group.add(fresh.mesh);
      // replace the definition slot so repeated recycles keep working
      const idx = this._defs.indexOf(def);
      if (idx >= 0) this._defs[idx] = fresh;
    }
    return removed.map((p) => p.id);
  }

  get(id) { return this.registry.get(id) ?? null; }

  clear() {
    for (const p of this.registry.values()) {
      this.group.remove(p.mesh);
      p.dispose();
    }
    this.registry.clear();
    this._defs = [];
  }

  // Advance every object to its deterministic pose at time t. Objects with an
  // alive() predicate enter/leave the registry by identity — no object pool
  // reuse, so reappearance is a brand-new generation with a fresh id.
  update(t) {
    if (this._defs.length) {
      for (const def of this._defs) {
        const alive = def.alive ? def.alive(t) : true;
        const registered = this.registry.has(def.id);
        if (alive && !registered) {
          // a definition whose object was deleted (vanish interval / recycle
          // replacement) comes back as a new generation
          const fresh = new Platform({
            name: def.name, kind: def.kind, topY: def.topY, thick: def.thick,
            size: { ...def.size }, color: def.color, motion: def.motion,
            alive: def.alive,
          });
          const idx = this._defs.indexOf(def);
          if (idx >= 0) this._defs[idx] = fresh;
          this.registry.set(fresh.id, fresh);
          this.group.add(fresh.mesh);
        } else if (!alive && registered) {
          this.group.remove(def.mesh);
          def.dispose();
          this.registry.delete(def.id);
        }
      }
    }
    const eps = 1e-3;
    for (const p of this.registry.values()) {
      const a = p.motion(Math.max(0, t - eps));
      const b = p.motion(t);
      const c = p.motion(t + eps);
      p.pose.x = b.x; p.pose.y = b.y; p.pose.z = b.z; p.pose.rotY = b.rotY;
      p.vel.set((c.x - a.x) / (2 * eps), (c.y - a.y) / (2 * eps), (c.z - a.z) / (2 * eps));
      p.omega = (c.rotY - a.rotY) / (2 * eps);
      p.mesh.position.set(b.x, b.y - p.thick / 2, b.z);
      p.mesh.rotation.set(0, b.rotY, 0);
      p.mesh.updateMatrixWorld(true);
    }
  }

  // Highest top surface under (x, z). Returns the object id alongside the
  // sample so contacts can bind their anchor to a specific generation.
  sample(x, z) {
    let best = null;
    const lp = new THREE.Vector3();
    for (const p of this.registry.values()) {
      p.worldToLocal(new THREE.Vector3(x, 0, z), lp);
      if (!p.containsLocal(lp)) continue;
      if (!best || p.topY > best.y) {
        best = { hit: true, y: p.topY, normal: new THREE.Vector3(0, 1, 0), obj: p.id, platform: p };
      }
    }
    return best;
  }

  dispose() {
    this.clear();
    this.scene?.remove(this.group);
  }
}
