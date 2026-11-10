import * as THREE from 'three';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PRESETS = {
  'flat':       { label: '平地' },
  'slope-up':   { label: '上坡 (7°)' },
  'slope-down': { label: '下坡 (7°)' },
  'steps-up':   { label: '上台阶' },
  'steps-down': { label: '下台阶' },
  'mixed':      { label: '综合: 坡道+台阶+缺口' },
  'hole':       { label: '缺口 (单脚悬空)' },
};

// A terrain is a height profile h(z) plus a list of hole intervals where
// sampling explicitly misses. Sampling is live per frame, so any terrain
// change is reflected immediately (nothing is prebaked).
export function buildTerrain(preset, seed = 1) {
  const rnd = mulberry32(seed * 7919 + 13);
  const holes = [];        // [z0, z1] intervals where sampling misses
  const pieces = [];       // { z0, z1, fn } evaluated in order

  function addRamp(z0, z1, h0, h1) {
    pieces.push({ z0, z1, fn: (z) => h0 + ((h1 - h0) * (z - z0)) / (z1 - z0) });
  }
  function addFlat(z0, z1, h) {
    pieces.push({ z0, z1, fn: () => h });
  }
  function addSteps(z0, depths, hs) {
    // depths: per-step tread depth (m), hs: cumulative height of each tread
    let z = z0;
    for (let i = 0; i < depths.length; i++) {
      const h = hs[i];
      const zs = z, ze = z + depths[i];
      pieces.push({ z0: zs, z1: ze, fn: () => h });
      z = ze;
    }
    return z;
  }

  let length = 16;

  if (preset === 'flat') {
    addFlat(-2, 18, 0); length = 16;
  } else if (preset === 'slope-up') {
    addFlat(-2, 2, 0);
    addRamp(2, 10, 0, 1.0);
    addFlat(10, 20, 1.0); length = 18;
  } else if (preset === 'slope-down') {
    addFlat(-2, 2, 1.0);
    addRamp(2, 10, 1.0, 0);
    addFlat(10, 20, 0); length = 18;
  } else if (preset === 'steps-up' || preset === 'steps-down') {
    const n = 6, up = preset === 'steps-up';
    const hs = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += 0.12 * (0.85 + rnd() * 0.3); // 0.10..0.15 m risers
      hs.push(acc);
    }
    const total = hs[n - 1];
    const depths = Array.from({ length: n }, () => 1.0);
    if (up) {
      addFlat(-2, 2, 0);
      const ze = addSteps(2, depths, hs);
      addFlat(ze, ze + 10, total);
      length = ze + 8;
    } else {
      addFlat(-2, 2, total);
      const ze = addSteps(2, depths, hs.map((h) => total - h));
      addFlat(ze, ze + 10, 0);
      length = ze + 8;
    }
  } else if (preset === 'mixed') {
    addFlat(-2, 2, 0);
    addRamp(2, 6, 0, 0.45);
    const hs = []; let acc = 0.45;
    for (let i = 0; i < 4; i++) { acc += 0.11 * (0.9 + rnd() * 0.25); hs.push(acc); }
    const ze = addSteps(6, [0.9, 0.9, 0.9, 0.9], hs);
    addFlat(ze, ze + 3.0, acc);
    holes.push([ze + 1.2, ze + 1.9]);          // gap in the floor
    addRamp(ze + 3.0, ze + 6.5, acc, 0.25);
    addFlat(ze + 6.5, ze + 12, 0.25);
    length = ze + 10;
  } else if (preset === 'hole') {
    addFlat(-2, 14, 0);
    holes.push([4.0, 4.7]);
    length = 12;
  } else {
    throw new Error('unknown preset ' + preset);
  }

  function heightAt(z) {
    for (const p of pieces) if (z >= p.z0 && z < p.z1) return p.fn(z);
    return pieces[pieces.length - 1].fn(z);
  }
  function inHole(z) {
    for (const h of holes) if (z >= h[0] && z < h[1]) return true;
    return false;
  }

  const _n = new THREE.Vector3();
  function sample(x, z) {
    if (inHole(z)) return { hit: false, y: 0, normal: null };
    const y = heightAt(z);
    const e = 0.03;
    const dz = (heightAt(z + e) - heightAt(z - e)) / (2 * e);
    const dx = 0;
    _n.set(-dx, 1, -dz);
    // clamp extreme tilts at step risers so foot orientation stays sane
    const tilt = Math.abs(Math.atan2(Math.hypot(dx, dz), 1));
    if (tilt > Math.PI / 3) {
      const s = Math.tan(Math.PI / 3) / Math.hypot(dx, dz);
      _n.set(-dx * s, 1, -dz * s);
    }
    _n.normalize();
    return { hit: true, y, normal: _n.clone() };
  }

  // ---- mesh ----
  const width = 2.6, xStep = 0.1, zStep = 0.05;
  const zMin = -2, zMax = length + 2;
  const nx = Math.round((2 * width) / xStep) + 1;
  const nz = Math.round((zMax - zMin) / zStep) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const cLow = new THREE.Color(0x44584a), cHigh = new THREE.Color(0x9a8f6a), cPit = new THREE.Color(0x33272a);
  const c = new THREE.Color();
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = -width + i * xStep;
      const z = zMin + j * zStep;
      const hole = inHole(z);
      const y = hole ? -1.1 : heightAt(z);
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      if (hole) c.copy(cPit);
      else c.copy(cLow).lerp(cHigh, THREE.MathUtils.clamp(y / 1.2, 0, 1));
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      k++;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  return {
    preset, length, holes, sample, heightAt, inHole, mesh,
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
