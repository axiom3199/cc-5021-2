// Debug probe: log frames where penetration exceeds a threshold.
import { buildTerrain } from '../src/terrain.js';
import { Character, LEG } from '../src/character.js';
import { Grounder } from '../src/grounding.js';
import { Metrics } from '../src/metrics.js';
import * as THREE from 'three';

const preset = process.argv[2] || 'flat';
const terrain = buildTerrain(preset, 7);
const char = new Character();
const metrics = new Metrics();
const g = new Grounder(char, terrain, metrics);
let t = 0, dist = 0.5;
const dt = 1 / 120;
const v = new THREE.Vector3();
let logged = 0;
for (let i = 0; i < 120 * 12 && logged < 12; i++) {
  t += dt; dist += char.speed * dt;
  g.update(dt, t, dist);
  for (const s of ['L', 'R']) {
    const st = g.feet[s];
    if (st.w < 0.3) continue;
    const sole = char['sole' + s].getWorldPosition(v);
    const soleSmp = terrain.sample(sole.x, sole.z);
    if (!soleSmp.hit) continue;
    const pen = soleSmp.y - sole.y;
    if (pen > 0.012 || (pen < -0.05 && st.w > 0.5)) {
      const ankleW = char.joints['ankle' + s].getWorldPosition(new THREE.Vector3());
      const gSole = terrain.sample(sole.x, sole.z);
      const gAnkle = terrain.sample(ankleW.x, ankleW.z);
      console.log(`t=${t.toFixed(2)} z=${dist.toFixed(2)} ${s} pen=${(pen * 100).toFixed(2)}cm w=${st.w.toFixed(2)} ` +
        `ankleY=${ankleW.y.toFixed(3)} soleY=${sole.y.toFixed(3)} tgtY=${st.target.y.toFixed(3)} ` +
        `soleZ=${sole.z.toFixed(2)}(g=${gSole.hit ? gSole.y.toFixed(2) : 'X'}) ankleZ=${ankleW.z.toFixed(2)}(g=${gAnkle.hit ? gAnkle.y.toFixed(2) : 'X'}) ` +
        `tgtZ=${st.target.z.toFixed(2)} plantZ=${st.plantZ.toFixed(2)} drop=${g.drop.toFixed(3)} cl=${st.clamped ? 1 : 0} pl=${st.planted ? 1 : 0} ph=${char.phase(s).toFixed(2)}`);
      logged++;
    }
  }
}
