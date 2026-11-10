import * as THREE from 'three';

const _n = new THREE.Vector3();
const _k = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Analytic two-bone IK (hip -> knee -> ankle).
// - Soft extension limit: target distance is clamped to 99.9% of full leg
//   length so the knee never reaches perfect extension (avoids solution
//   flipping when the leg is almost straight).
// - The pole vector gives a stable knee-bend reference; it is blended with
//   the previous frame's knee direction for extra temporal stability.
export function solveTwoBoneIK(hip, target, lenA, lenB, pole, prevKneeDir, out) {
  const maxLen = (lenA + lenB) * 0.999;
  const minLen = Math.abs(lenA - lenB) * 1.001 + 1e-4;

  _n.subVectors(target, hip);
  let d = _n.length();
  let clamped = false;
  if (d > maxLen) { d = maxLen; clamped = true; }
  else if (d < minLen) { d = minLen; clamped = true; }
  if (_n.lengthSq() < 1e-12) _n.set(0, -1, 0);
  else _n.normalize();

  out.ankle.copy(hip).addScaledVector(_n, d);

  // Knee bend plane: project pole onto plane perpendicular to bone axis.
  _k.copy(pole);
  if (prevKneeDir) {
    _k.multiplyScalar(0.75).addScaledVector(prevKneeDir, 0.25);
    if (_k.lengthSq() < 1e-8) _k.copy(pole); // blended to zero: fall back
    _k.normalize();
  }
  _k.addScaledVector(_n, -_k.dot(_n));
  if (_k.lengthSq() < 1e-8) {
    _k.set(0, 0, 1).addScaledVector(_n, -_n.z);
    if (_k.lengthSq() < 1e-8) _k.set(1, 0, 0).addScaledVector(_n, -_n.x);
  }
  _k.normalize();

  const cosA = THREE.MathUtils.clamp((lenA * lenA + d * d - lenB * lenB) / (2 * lenA * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _dir.copy(_n).multiplyScalar(cosA).addScaledVector(_k, sinA);

  out.knee.copy(hip).addScaledVector(_dir, lenA);
  out.kneeDir.copy(_k);
  const cosK = THREE.MathUtils.clamp((lenA * lenA + lenB * lenB - d * d) / (2 * lenA * lenB), -1, 1);
  out.interiorAngle = Math.acos(cosK); // PI = fully straight
  out.clamped = clamped;
  return out;
}

export function makeIKOut() {
  return {
    knee: new THREE.Vector3(),
    ankle: new THREE.Vector3(),
    kneeDir: new THREE.Vector3(0, 0, 1),
    interiorAngle: Math.PI,
    clamped: false,
  };
}
