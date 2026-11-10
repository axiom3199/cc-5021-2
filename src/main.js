import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTerrain, PRESETS } from './terrain.js';
import { Character } from './character.js';
import { Grounder } from './grounding.js';
import { Metrics } from './metrics.js';
import { PlatformWorld, PLATFORM_SCENARIOS, RELEASE_LABEL, RELEASE } from './platforms.js';

const state = {
  preset: 'mixed',
  seed: 3,
  speed: 1,
  paused: false,
  simTime: 0,
  distance: 0.5,
  show: { correct: true, ghost: false, contacts: true, targets: false, follow: true },
};

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c2126);
scene.fog = new THREE.Fog(0x1c2126, 18, 40);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(2.8, 2.0, -2.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 1.2);

const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a3226, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
sun.shadow.camera.top = 5; sun.shadow.camera.bottom = -5;
sun.shadow.camera.far = 30;
scene.add(sun);
scene.add(sun.target);

// ---------- actors ----------
const metrics = new Metrics();
const char = new Character();
scene.add(char.root);
const ghost = new Character({ ghost: true });
ghost.root.visible = false;
scene.add(ghost.root);

let terrain = null;
const platforms = new PlatformWorld(scene);
const grounder = new Grounder(char, null, metrics, platforms);

function setTerrain(preset, seed = state.seed) {
  if (terrain) { scene.remove(terrain.mesh); terrain.dispose(); }
  terrain = buildTerrain(preset, seed);
  scene.add(terrain.mesh);
  grounder.terrain = terrain;
  grounder.reset();
  metrics.reset();
  state.preset = preset;
}
setTerrain(state.preset);

// ---------- debug markers ----------
const contactGroup = new THREE.Group();
const targetGroup = new THREE.Group();
scene.add(contactGroup, targetGroup);
const markers = {};
for (const s of ['L', 'R']) {
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.9 }));
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.25, 0xffff66, 0.06, 0.035);
  contactGroup.add(sphere, arrow);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05),
    new THREE.MeshBasicMaterial({ color: s === 'L' ? 0xffa500 : 0x00cfff, depthTest: false }));
  targetGroup.add(cube);
  markers[s] = { sphere, arrow, cube };
}

function updateMarkers() {
  contactGroup.visible = state.show.contacts;
  targetGroup.visible = state.show.targets;
  for (const s of ['L', 'R']) {
    const st = grounder.feet[s];
    const m = markers[s];
    m.sphere.position.copy(st.point);
    m.sphere.material.color.set(st.hit ? (st.w > 0.5 ? 0x00ff88 : 0x88ccff) : 0xff3344);
    m.arrow.position.copy(st.point);
    m.arrow.setDirection(st.hit ? st.normal : new THREE.Vector3(0, 1, 0));
    m.cube.position.copy(st.target);
  }
}

function frameLabel(st) {
  if (st.anchorObj !== null) {
    const p = platforms.get(st.anchorObj);
    return p ? `台面局部坐标 (id=${p.id}「${p.name}」)` : `失效台面 id=${st.anchorObj}`;
  }
  return '世界坐标 (静态地面)';
}

function updateAnchorPanel() {
  const rows = ['L', 'R'].map((s) => {
    const st = grounder.feet[s];
    const side = s === 'L' ? '左脚' : '右脚';
    const status = st.planted ? '已锚定' : '未锚定';
    // while anchored show the live (empty) reason; once released, prefer the
    // persistent object-failure explanation so it stays on screen after the
    // foot is back on ordinary ground
    const reasonCode = st.anchorObj !== null
      ? st.releaseReason
      : (st.objectReleaseReason !== RELEASE.NONE ? st.objectReleaseReason : st.releaseReason);
    const reason = RELEASE_LABEL[reasonCode] ?? reasonCode;
    const rv = st.relVel.length();
    return `<tr><td>${side}</td><td>${status}</td><td>${frameLabel(st)}</td>` +
      `<td>${reason}</td><td>${rv.toFixed(3)}</td></tr>`;
  }).join('');
  $('anchors').innerHTML =
    '<table><thead><tr><th>脚</th><th>接触</th><th>锚点坐标系</th><th>失效原因</th><th>相对速度(m/s)</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
$('cbCorrect').addEventListener('change', (e) => { state.show.correct = e.target.checked; grounder.enabled = e.target.checked; });
$('cbGhost').addEventListener('change', (e) => { state.show.ghost = e.target.checked; ghost.root.visible = e.target.checked; });
$('cbContacts').addEventListener('change', (e) => { state.show.contacts = e.target.checked; });
$('cbTargets').addEventListener('change', (e) => { state.show.targets = e.target.checked; });
$('cbFollow').addEventListener('change', (e) => { state.show.follow = e.target.checked; });
$('rngSpeed').addEventListener('input', (e) => {
  state.speed = parseFloat(e.target.value);
  $('speedVal').textContent = state.speed.toFixed(2) + 'x';
});
const sel = $('selTerrain');
for (const [k, v] of Object.entries(PRESETS)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = v.label;
  sel.appendChild(o);
}
sel.value = state.preset;
sel.addEventListener('change', () => { setTerrain(sel.value); resetWalk(); });

const selPlat = $('selPlatform');
for (const [k, v] of Object.entries(PLATFORM_SCENARIOS)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = v.label;
  selPlat.appendChild(o);
}
selPlat.value = 'none';
selPlat.addEventListener('change', () => {
  platforms.buildScenario(selPlat.value);
  resetWalk();
});
$('btnRecycle').addEventListener('click', () => {
  // delete and rebuild every current object under a new generation id; the
  // same-name replacement must not inherit any old anchor
  for (const def of platforms._defs) platforms.recycle(def.name);
  grounder.reset(RELEASE.RESET);
});
$('rngSeek').addEventListener('input', (e) => {
  const t = parseFloat(e.target.value);
  $('seekVal').textContent = t.toFixed(2) + 's';
  state.paused = true;
  $('btnPause').textContent = '继续';
  state.simTime = t;
  state.distance = 0.5 + char.speed * t;
  grounder.seek(t);
  metrics.cut();
  stepSim(0); // rebuild contacts deterministically from samples at time t
});
$('btnRegen').addEventListener('click', () => {
  state.seed = (Math.random() * 1e6) | 0;
  setTerrain(state.preset, state.seed);
  resetWalk();
});
$('btnPause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('btnPause').textContent = state.paused ? '继续' : '暂停';
});
$('btnStep').addEventListener('click', () => { if (state.paused) stepSim(1 / 60); });
$('btnTest').addEventListener('click', () => showResults(runScenarios()));
$('btnDl').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(lastResults, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'grounding-metrics.json';
  a.click();
});

function resetWalk() {
  state.simTime = 0;
  state.distance = 0.5;
  grounder.reset();
  metrics.reset();
}

// ---------- scenario test runner ----------
const SCENARIOS = [
  { name: 'flat-1x', preset: 'flat', speed: 1, dur: 10 },
  { name: 'slope-up-1x', preset: 'slope-up', speed: 1, dur: 16 },
  { name: 'slope-down-1x', preset: 'slope-down', speed: 1, dur: 16 },
  { name: 'steps-up-1x', preset: 'steps-up', speed: 1, dur: 14 },
  { name: 'steps-down-1x', preset: 'steps-down', speed: 1, dur: 14 },
  { name: 'mixed-1x', preset: 'mixed', speed: 1, dur: 20 },
  { name: 'hole-1x (单脚悬空)', preset: 'hole', speed: 1, dur: 10 },
  { name: 'mixed-0.5x', preset: 'mixed', speed: 0.5, dur: 30 },
  { name: 'mixed-2x', preset: 'mixed', speed: 2, dur: 10 },
];

function runScenarios() {
  const prevPreset = state.preset, prevSeed = state.seed;
  const wasPaused = state.paused;
  state.paused = true;
  const results = [];
  for (const sc of SCENARIOS) {
    setTerrain(sc.preset, 7);
    state.simTime = 0; state.distance = 0.5;
    grounder.reset();
    const dtSim = sc.speed / 120;
    for (let i = 0; i < 180; i++) stepSim(dtSim); // warm-up: let weights settle
    metrics.reset();
    const steps = Math.floor(sc.dur * 120);
    for (let i = 0; i < steps; i++) stepSim(dtSim);
    results.push({ name: sc.name, speed: sc.speed, ...metrics.summary() });
  }
  setTerrain(prevPreset, prevSeed);
  state.simTime = 0; state.distance = 0.5;
  grounder.reset(); metrics.reset();
  state.paused = wasPaused;
  return results;
}

let lastResults = null;
function showResults(results) {
  lastResults = results;
  $('btnDl').disabled = false;
  const rows = results.map((r) =>
    `<tr><td>${r.name}</td><td>${(r.maxPenM * 100).toFixed(2)}</td><td>${(r.rmsPenM * 100).toFixed(2)}</td>` +
    `<td>${r.maxKneeJumpDeg.toFixed(2)}</td><td>${(r.maxHipJumpM * 1000).toFixed(1)}</td>` +
    `<td>${r.misses}</td><td>${r.clamps}</td></tr>`).join('');
  $('results').innerHTML =
    '<table><thead><tr><th>场景</th><th>最大穿透(cm)</th><th>RMS穿透(cm)</th>' +
    '<th>膝跳变(°/帧)</th><th>骨盆跳变(mm)</th><th>采样丢失</th><th>IK限幅</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;
}

// ---------- simulation ----------
function stepSim(dtSim) {
  state.simTime += dtSim;
  state.distance += char.speed * dtSim;
  if (state.distance > terrain.length - 2) {
    state.distance -= terrain.length - 4;
    metrics.cut();
  }
  grounder.update(dtSim, state.simTime, state.distance);
}

const FIXED = 1 / 120;
let acc = 0;
let last = performance.now();
const prevCharPos = new THREE.Vector3();
const charPos = new THREE.Vector3();

function animate(now) {
  requestAnimationFrame(animate);
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state.paused) {
    acc += dtReal * state.speed;
    let n = 0;
    while (acc >= FIXED && n < 40) { stepSim(FIXED); acc -= FIXED; n++; }
  }

  if (state.show.ghost) ghost.setAnimPose(state.simTime, state.distance);

  char.root.getWorldPosition(charPos);
  if (state.show.follow) {
    const delta = charPos.clone().sub(prevCharPos);
    camera.position.add(delta);
    controls.target.add(delta);
  }
  prevCharPos.copy(charPos);
  sun.position.set(charPos.x + 3, charPos.y + 6, charPos.z - 2);
  sun.target.position.copy(charPos);
  controls.update();

  updateMarkers();
  renderer.render(scene, camera);
  updateLive();
  updateAnchorPanel();
  const rng = $('rngSeek');
  if (document.activeElement !== rng) {
    rng.value = Math.min(12, state.simTime).toFixed(2);
    $('seekVal').textContent = state.simTime.toFixed(2) + 's';
  }
}

let liveTimer = 0;
function updateLive() {
  const now = performance.now();
  if (now - liveTimer < 120) return;
  liveTimer = now;
  const f = grounder.feet;
  $('live').textContent =
    `权重 L=${f.L.w.toFixed(2)} R=${f.R.w.toFixed(2)} | 骨盆偏移=${(grounder.drop * 100).toFixed(1)}cm | ` +
    `采样 L=${f.L.hit ? '命中' : '丢失'} R=${f.R.hit ? '命中' : '丢失'} | ` +
    `最大穿透=${(Math.max(metrics.maxPen.L, metrics.maxPen.R) * 100).toFixed(2)}cm`;
}

// ---------- headless hooks ----------
window.__app = {
  setTerrain: (p) => { setTerrain(p, 7); resetWalk(); },
  setSpeed: (v) => { state.speed = v; },
  setPlatform: (key) => {
    platforms.buildScenario(key);
    selPlat.value = key;
    resetWalk();
  },
  recyclePlatform: (name) => {
    const ids = platforms.recycle(name);
    grounder.reset(RELEASE.RESET);
    return ids;
  },
  seek: (t) => {
    state.paused = true;
    state.simTime = t;
    state.distance = 0.5 + char.speed * t;
    grounder.seek(t);
    metrics.cut();
    stepSim(0);
  },
  contacts: () => ['L', 'R'].map((s) => {
    const st = grounder.feet[s];
    return {
      side: s, planted: st.planted, anchorObj: st.anchorObj,
      frame: st.anchorFrame, reason: st.releaseReason,
      objectReason: st.objectReleaseReason,
      relVel: st.relVel.length(), surfaceVel: st.surfaceVel.toArray(),
      plant: [st.plantX, st.plantY, st.plantZ],
      local: st.anchorLocal.toArray(),
    };
  }),
  registry: () => [...platforms.registry.values()].map((p) => ({ id: p.id, name: p.name, pose: { ...p.pose } })),
  step: (dt = 1 / 120) => { stepSim(dt); },
  setToggles: (t) => {
    if (t.ghost !== undefined) { state.show.ghost = t.ghost; ghost.root.visible = t.ghost; $('cbGhost').checked = t.ghost; }
    if (t.contacts !== undefined) { state.show.contacts = t.contacts; $('cbContacts').checked = t.contacts; }
    if (t.targets !== undefined) { state.show.targets = t.targets; $('cbTargets').checked = t.targets; }
    if (t.correct !== undefined) { state.show.correct = t.correct; grounder.enabled = t.correct; $('cbCorrect').checked = t.correct; }
  },
  renderer, scene, camera,
};
window.__runTests = () => { const r = runScenarios(); showResults(r); return r; };
window.__samplePixels = () => {
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0, sum2 = 0;
  for (let i = 0; i < w * h; i++) {
    const l = px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
    sum += l; sum2 += l * l;
  }
  const mean = sum / (w * h);
  return { mean, std: Math.sqrt(Math.max(0, sum2 / (w * h) - mean * mean)) };
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.__ready = true;
requestAnimationFrame(animate);
