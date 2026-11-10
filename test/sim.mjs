// Fast Node-only simulation of the grounding scenarios (no browser needed).
import { buildTerrain } from '../src/terrain.js';
import { Character } from '../src/character.js';
import { Grounder } from '../src/grounding.js';
import { Metrics } from '../src/metrics.js';

const SCENARIOS = [
  { name: 'flat-1x', preset: 'flat', speed: 1, dur: 10 },
  { name: 'slope-up-1x', preset: 'slope-up', speed: 1, dur: 16 },
  { name: 'slope-down-1x', preset: 'slope-down', speed: 1, dur: 16 },
  { name: 'steps-up-1x', preset: 'steps-up', speed: 1, dur: 14 },
  { name: 'steps-down-1x', preset: 'steps-down', speed: 1, dur: 14 },
  { name: 'mixed-1x', preset: 'mixed', speed: 1, dur: 20 },
  { name: 'hole-1x', preset: 'hole', speed: 1, dur: 10 },
  { name: 'mixed-0.5x', preset: 'mixed', speed: 0.5, dur: 30 },
  { name: 'mixed-2x', preset: 'mixed', speed: 2, dur: 10 },
];

const only = process.argv[2];

for (const sc of SCENARIOS) {
  if (only && !sc.name.includes(only)) continue;
  const terrain = buildTerrain(sc.preset, 7);
  const char = new Character();
  const metrics = new Metrics();
  const g = new Grounder(char, terrain, metrics);
  let t = 0, dist = 0.5;
  const dtSim = sc.speed / 120;
  for (let i = 0; i < 180; i++) { t += dtSim; dist += char.speed * dtSim; g.update(dtSim, t, dist); }
  metrics.reset();
  const steps = Math.floor(sc.dur * 120);
  let worst = { pen: -1, knee: -1 };
  for (let i = 0; i < steps; i++) {
    t += dtSim;
    dist += char.speed * dtSim;
    if (dist > terrain.length - 2) { dist -= terrain.length - 4; metrics.cut(); }
    g.update(dtSim, t, dist);
    // context capture
    const kj = Math.max(metrics.maxKneeJump.L, metrics.maxKneeJump.R);
    if (kj > worst.knee) worst.knee = kj, worst.kneeCtx = { t: t.toFixed(2), z: dist.toFixed(2), pL: char.phaseL.toFixed(2), pR: char.phaseR.toFixed(2), wL: g.w.L.toFixed(2), wR: g.w.R.toFixed(2), hitL: g.feet.L.hit, hitR: g.feet.R.hit, drop: g.drop.toFixed(3), baseH: (g.baseH ?? 0).toFixed(2) };
    const pen = Math.max(metrics.maxPen.L, metrics.maxPen.R);
    if (pen > worst.pen) worst.pen = pen, worst.penCtx = { t: t.toFixed(2), z: dist.toFixed(2), pL: char.phaseL.toFixed(2), pR: char.phaseR.toFixed(2), wL: g.w.L.toFixed(2), wR: g.w.R.toFixed(2), soleY: null, drop: g.drop.toFixed(3), baseH: (g.baseH ?? 0).toFixed(2) };
  }
  const s = metrics.summary();
  console.log(`${sc.name.padEnd(12)} pen=${(s.maxPenM * 100).toFixed(2)}cm rms=${(s.rmsPenM * 100).toFixed(2)}cm kneeJump=${s.maxKneeJumpDeg.toFixed(2)}° hipJump=${(s.maxHipJumpM * 1000).toFixed(1)}mm miss=${s.misses} clamp=${s.clamps}`);
  console.log(`  worst knee @`, worst.kneeCtx);
  console.log(`  worst pen  @`, worst.penCtx);
}
