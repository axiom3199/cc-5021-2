// Moving-platform behavior tests (Node-only, deterministic).
// Every check asserts contact identity semantics, not frame-order luck:
// anchors bind object generations, store local-frame points, follow rigid
// transforms, and break with an explicit reason when following is impossible.
import * as THREE from 'three';
import { buildTerrain } from '../src/terrain.js';
import { Character } from '../src/character.js';
import { Grounder } from '../src/grounding.js';
import { Metrics } from '../src/metrics.js';
import { PlatformWorld, RELEASE, MAX_FOLLOW_STEP } from '../src/platforms.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${detail}`); }
}

function rig(key) {
  const terrain = buildTerrain('flat', 7);
  const char = new Character();
  const metrics = new Metrics();
  const world = new PlatformWorld(null);
  world.buildScenario(key);
  const g = new Grounder(char, terrain, metrics, world);
  return { terrain, char, metrics, world, g };
}

// advance the shared clock; platforms only move through the time argument
function step(g, char, sim, dt = 1 / 120) {
  sim.t += dt;
  sim.dist += char.speed * dt;
  g.update(dt, sim.t, sim.dist);
}

// ---- 1. rotating disc: local anchor, world transform, low relative slip ----
{
  const { char, g, world, metrics } = rig('disc-rotate');
  const disc = world._defs[0];
  const sim = { t: 0, dist: 0.5 };
  for (let i = 0; i < 120 * 6; i++) step(g, char, sim);
  const anchored = ['L', 'R'].filter((s) => g.feet[s].anchorObj === disc.id);
  check('disc: at least one foot anchors to the disc id', anchored.length > 0,
    `anchors=${['L', 'R'].map((s) => g.feet[s].anchorObj).join(',')}`);
  const s = anchored[0];
  if (s) {
    const st = g.feet[s];
    check('disc: anchor reports object local frame', st.anchorFrame === 'object:' + disc.id, st.anchorFrame);
    const local0 = st.anchorLocal.clone();
    const world0 = new THREE.Vector3(st.plantX, st.plantY, st.plantZ);
    for (let i = 0; i < 12; i++) step(g, char, sim);
    check('disc: local anchor point is invariant under rotation',
      st.anchorLocal.distanceTo(local0) < 1e-9, `drift=${st.anchorLocal.distanceTo(local0)}`);
    const p = world.get(disc.id);
    const expected = p.localToWorld(local0, new THREE.Vector3());
    const wErr = Math.hypot(st.plantX - expected.x, st.plantZ - expected.z);
    check('disc: world plant equals local point transformed by platform pose', wErr < 1e-9,
      `err=${wErr}`);
    check('disc: plant actually moved in world space with the table',
      Math.hypot(st.plantX - world0.x, st.plantZ - world0.z) > 1e-4);
    // relative slip sampled while this foot stays anchored
    let maxRel = 0;
    for (let i = 0; i < 24; i++) {
      step(g, char, sim);
      if (g.feet[s].anchorObj === disc.id) maxRel = Math.max(maxRel, g.feet[s].relVel.length());
    }
    check('disc: anchored sole relative speed stays small (no false sliding)',
      maxRel < 0.6, `maxRel=${maxRel.toFixed(3)}`);
    void metrics;
  }
}

// ---- 2. two feet on two different objects ----
{
  const { char, g } = rig('split');
  const [left, right] = g.platforms._defs;
  const seen = new Set();
  let simultaneous = false;
  const sim = { t: 0, dist: 0.5 };
  for (let i = 0; i < 120 * 9; i++) {
    step(g, char, sim);
    const ids = ['L', 'R'].map((s) => g.feet[s].anchorObj);
    ids.forEach((id) => id !== null && seen.add(id));
    if (ids[0] !== null && ids[1] !== null && ids[0] !== ids[1]) simultaneous = true;
  }
  check('split: both object ids were bound at some point',
    seen.has(left.id) && seen.has(right.id), `seen=${[...seen].join(',')}`);
  check('split: simultaneous distinct-object contacts occur', simultaneous);
}

// ---- 3. platform vanishes: object-gone release, no stale follow ----
{
  const { char, g, world } = rig('vanish');
  const v = g.platforms._defs[0];
  const sim = { t: 0, dist: 0.5 };
  let anchoredBefore = false;
  for (let i = 0; i < 120 * 3.9; i++) {
    step(g, char, sim);
    if (g.feet.L.anchorObj === v.id || g.feet.R.anchorObj === v.id) anchoredBefore = true;
  }
  check('vanish: contact established before disappearance', anchoredBefore);
  // advance into the [4,7) dead window
  for (let i = 0; i < 120 * 0.6; i++) step(g, char, sim);
  check('vanish: object removed from registry at t in [4,7)', world.get(v.id) === null,
    `t=${sim.t.toFixed(2)}`);
  const stale = ['L', 'R'].some((x) => g.feet[x].anchorObj === v.id);
  check('vanish: no foot keeps following the deleted object', !stale);
  const reasons = ['L', 'R'].map((x) => g.feet[x].objectReleaseReason);
  check('vanish: release reason is object-gone', reasons.includes(RELEASE.OBJECT_GONE),
    reasons.join(','));
  // reappearance at t=7 is a new generation: fresh id, no inherited anchor
  const oldId = v.id;
  while (sim.t < 7.4) step(g, char, sim);
  const back = [...world.registry.values()][0];
  check('vanish: reappearing object gets a fresh generation id',
    back && back.id !== oldId, `old=${oldId} new=${back?.id}`);
}

// ---- 4. same-name recycled object: fresh generation, old anchor invalid ----
{
  const { char, g, world } = rig('recycle');
  const old = world._defs[0];
  const sim = { t: 0, dist: 0.5 };
  for (let i = 0; i < 120 * 5; i++) step(g, char, sim);
  const hadAnchor = g.feet.L.anchorObj === old.id || g.feet.R.anchorObj === old.id;
  check('recycle: contact was possible on the old generation', hadAnchor);
  const removed = world.recycle(old.name);
  check('recycle: old generation id deleted', removed.includes(old.id));
  const fresh = [...world.registry.values()][0];
  check('recycle: new object keeps the name but gets a new id',
    fresh.name === old.name && fresh.id !== old.id);
  g.reset(RELEASE.RESET);
  sim.t += 1 / 120; sim.dist += char.speed / 120;
  g.update(1 / 120, sim.t, sim.dist);
  // any contact after the rebuild can only bind the NEW generation; the
  // deleted id must never resolve again, so no anchor is inherited
  const noInheritance = ['L', 'R'].every((x) => g.feet[x].anchorObj !== old.id);
  const freshOnly = ['L', 'R'].every((x) => {
    const id = g.feet[x].anchorObj;
    return id === null || id === fresh.id;
  });
  check('recycle: new same-name object inherits no anchor',
    noInheritance && freshOnly,
    `L=${g.feet.L.anchorObj} R=${g.feet.R.anchorObj} old=${old.id} fresh=${fresh.id}`);
}

// ---- 5. sudden jump beyond follow range: explicit teleport release ----
{
  const { char, g } = rig('teleport');
  const jp = g.platforms._defs[0];
  const sim = { t: 0, dist: 0.5 };
  let anchored = false;
  for (let i = 0; i < 120 * 3.9; i++) {
    step(g, char, sim);
    if (g.feet.L.anchorObj === jp.id || g.feet.R.anchorObj === jp.id) anchored = true;
  }
  check('teleport: anchor established before the jump', anchored,
    `t=${sim.t.toFixed(2)} L=${g.feet.L.anchorObj} R=${g.feet.R.anchorObj}`);
  // walk up to the frame just before the t=4 discontinuity and remember which
  // foot is actually riding the slab across it
  let boundSide = null;
  while (sim.t < 4 - 1 / 120) {
    step(g, char, sim);
    for (const x of ['L', 'R']) if (g.feet[x].anchorObj === jp.id) boundSide = x;
  }
  check('teleport: foot still bound approaching t=4', boundSide !== null,
    `L=${g.feet.L.anchorObj} R=${g.feet.R.anchorObj}`);
  // cross the t=4 discontinuity in a single step: 1.4 m > MAX_FOLLOW_STEP
  step(g, char, sim);
  const st = g.feet[boundSide];
  const released = st.anchorObj === null && st.objectReleaseReason === RELEASE.TELEPORT;
  check('teleport: out-of-range jump gives an explicit teleport release', released,
    `side=${boundSide} reason=${st.objectReleaseReason} stepLimit=${MAX_FOLLOW_STEP}`);
  // the released foot must not silently re-grip the jumped object: any later
  // contact has to be a brand-new latch through the normal touchdown path,
  // which clears the object-failure channel. A still-set teleport reason with
  // an anchor already present would mean the old anchor was carried over.
  let carriedOver = false;
  for (let i = 0; i < 120 * 0.3; i++) {
    step(g, char, sim);
    const s2 = g.feet[boundSide];
    if (s2.anchorObj === jp.id && s2.objectReleaseReason === RELEASE.TELEPORT) carriedOver = true;
  }
  check('teleport: released anchor is not carried onto the jumped object', !carriedOver);
}

// ---- 6. edge step-off: anchor ends with an explicit reason ----
{
  const { char, g } = rig('translate');
  const slab = g.platforms._defs[0];
  const sim = { t: 0, dist: 0.5 };
  let boundFrames = 0;
  const reasonsSeen = new Set();
  for (let i = 0; i < 120 * 10; i++) {
    step(g, char, sim);
    if (g.feet.L.anchorObj === slab.id || g.feet.R.anchorObj === slab.id) boundFrames++;
    reasonsSeen.add(g.feet.L.releaseReason).add(g.feet.R.releaseReason);
  }
  check('edge: platform contact happened', boundFrames > 0, `frames=${boundFrames}`);
  check('edge: no lingering anchor after walking past the slab',
    g.feet.L.anchorObj === null && g.feet.R.anchorObj === null);
  check('edge: an explicit non-reach release reason was recorded',
    [RELEASE.EDGE, RELEASE.TOE_OFF].some((r) => reasonsSeen.has(r)),
    [...reasonsSeen].join(','));
}

// ---- 7. time seek: anchors invalidated and rebuilt deterministically ----
{
  const { char, g } = rig('disc-rotate');
  const id = g.platforms._defs[0].id;
  const sim = { t: 0, dist: 0.5 };
  for (let i = 0; i < 120 * 6; i++) step(g, char, sim);
  const before = g.feet.L.anchorObj === id || g.feet.R.anchorObj === id;
  check('seek: anchored contact existed before scrub', before);
  g.seek(9.0);
  check('seek: scrub clears every anchor',
    g.feet.L.anchorObj === null && g.feet.R.anchorObj === null);
  check('seek: time-seek reason recorded',
    g.feet.L.releaseReason === RELEASE.TIME_SEEK ||
    g.feet.R.releaseReason === RELEASE.TIME_SEEK);
  const snap = () => ['L', 'R'].map((x) => ({
    anchorObj: g.feet[x].anchorObj,
    plant: [g.feet[x].plantX, g.feet[x].plantY, g.feet[x].plantZ],
    frame: g.feet[x].anchorFrame,
  }));
  sim.t = 9.0; sim.dist = 0.5 + char.speed * 9.0;
  step(g, char, sim);
  const a = JSON.stringify(snap());
  g.seek(9.0);
  sim.t = 9.0; sim.dist = 0.5 + char.speed * 9.0;
  step(g, char, sim);
  const b = JSON.stringify(snap());
  check('seek: same time reproduces identical contact state (no frame-N-1 dependency)', a === b);
}

// ---- 8. static ground path unchanged: world frame, no object binding ----
{
  const { char, g } = rig('none');
  const sim = { t: 0, dist: 0.5 };
  for (let i = 0; i < 120 * 4; i++) step(g, char, sim);
  check('static: contacts stay world-frame with no object binding',
    ['L', 'R'].every((x) => g.feet[x].anchorObj === null && g.feet[x].anchorFrame === 'world'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
