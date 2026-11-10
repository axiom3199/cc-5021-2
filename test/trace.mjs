// Trace knee flexion and IK state frame-by-frame around a time window.
import { buildTerrain } from '../src/terrain.js';
import { Character, LEG } from '../src/character.js';
import { Grounder } from '../src/grounding.js';
import { Metrics } from '../src/metrics.js';
import * as THREE from 'three';

const [preset, t0, t1] = [process.argv[2] || 'steps-up', parseFloat(process.argv[3] || '5.0'), parseFloat(process.argv[4] || '5.5')];
const terrain = buildTerrain(preset, 7);
const char = new Character();
const metrics = new Metrics();
const g = new Grounder(char, terrain, metrics);
let t = 0, dist = 0.5;
const dt = 1 / 120;
const hip = new THREE.Vector3(), tgt = new THREE.Vector3();
let prev = { L: null, R: null };
for (let i = 0; i < 120 * (t1 + 1); i++) {
  t += dt; dist += char.speed * dt;
  if (dist > terrain.length - 2) dist -= terrain.length - 4;
  g.update(dt, t, dist);
  if (t < t0 || t > t1) continue;
  const out = [];
  for (const s of ['L', 'R']) {
    const st = g.feet[s];
    char.joints['thigh' + s].getWorldPosition(hip);
    const d = hip.distanceTo(st.target);
    const flex = (Math.PI - g.ik[s].interiorAngle) * 180 / Math.PI;
    const jump = prev[s] === null ? 0 : flex - prev[s];
    prev[s] = flex;
    out.push(`${s}: flex=${flex.toFixed(1)}(${jump >= 0 ? '+' : ''}${jump.toFixed(1)}) d=${d.toFixed(3)} w=${st.w.toFixed(2)} pl=${st.planted ? 1 : 0} cl=${st.clamped ? 1 : 0} ty=${st.target.y.toFixed(3)} animY=${st.animPos.y.toFixed(3)} gy=${(st.gy ?? -1).toFixed(3)} tz=${st.target.z.toFixed(2)} animZ=${st.animPos.z.toFixed(2)} pz=${st.plantZ.toFixed(2)} py=${st.plantY.toFixed(2)} ph=${char.phase(s).toFixed(2)}`);
  }
  console.log(`t=${t.toFixed(3)} z=${dist.toFixed(2)} drop=${g.drop.toFixed(3)} baseH=${(g.baseH ?? 0).toFixed(2)} | ${out.join(' | ')}`);
}
