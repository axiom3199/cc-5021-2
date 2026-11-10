import * as THREE from 'three';

// Body proportions (m). Leg reach and hip height are chosen so the stance
// knee keeps a natural slight bend and the heel-strike target stays inside
// the IK soft-reach limit.
export const LEG = { thigh: 0.45, shin: 0.45, ankleH: 0.08 };
export const HIP_Y = 1.005;
export const FOOT = { fwd: 0.19, back: 0.06 };

const CYCLE = 1.15;          // gait cycle duration (s) at 1x playback
const HIP_AMP = 22;          // hip swing amplitude (deg)
const KNEE_SWING = 62;       // peak swing knee flexion (deg)

const D2R = Math.PI / 180;

function smooth01(x) { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); }

function hipPitch(p) { // deg, + = leg forward
  const a = HIP_AMP, b = -16;
  return p < 0.62 ? a + (b - a) * smooth01(p / 0.62)
                  : b + (a - b) * smooth01((p - 0.62) / 0.38);
}
function kneeFlex(p) { // deg, + = flexion
  if (p < 0.62) return 3 + 6 * Math.sin(Math.PI * p / 0.62);
  const s = Math.sin(Math.PI * (p - 0.62) / 0.38);
  // exponent > 1 so the swing lands with zero slope into the stance
  // curve — a fractional exponent makes the knee snap at the cycle wrap
  return 3 + (KNEE_SWING - 3) * Math.pow(Math.max(0, s), 1.2);
}
function anklePitch(p) { // deg, + = dorsiflexion (toe up)
  if (p < 0.62) {
    const q = p / 0.62;
    return q < 0.4 ? 6 + (-2 - 6) * smooth01(q / 0.4)
                   : -2 + (-16 + 2) * smooth01((q - 0.4) / 0.6);
  }
  const q = (p - 0.62) / 0.38;
  return q < 0.35 ? -16 + (4 + 16) * smooth01(q / 0.35)
                  : 4 + 2 * smooth01((q - 0.35) / 0.65);
}

function joint(parent, x, y, z, name) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.name = name || '';
  parent.add(o);
  return o;
}

function boneMesh(parent, to, r, mat) {
  const len = to.length();
  const geo = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 0.02), 4, 10);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(to).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().normalize());
  m.castShadow = true;
  parent.add(m);
  return m;
}

function ball(parent, at, r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
  m.position.copy(at);
  m.castShadow = true;
  parent.add(m);
  return m;
}

export class Character {
  constructor({ ghost = false } = {}) {
    this.ghost = ghost;
    const mat = ghost
      ? new THREE.MeshBasicMaterial({ color: 0x9aa4ad, transparent: true, opacity: 0.35, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: 0x4a90d9, roughness: 0.6 });
    const matDark = ghost ? mat
      : new THREE.MeshStandardMaterial({ color: 0x2e3a46, roughness: 0.7 });
    this.materials = [mat, matDark];

    const j = this.joints = {};
    this.root = new THREE.Object3D();
    this.root.name = 'hips';
    this.root.position.set(0, HIP_Y, 0);
    j.hips = this.root;
    j.spine = joint(this.root, 0, 0.12, 0, 'spine');
    j.chest = joint(j.spine, 0, 0.18, 0, 'chest');
    j.neck = joint(j.chest, 0, 0.16, 0, 'neck');
    j.head = joint(j.neck, 0, 0.10, 0, 'head');
    j.shoulderL = joint(j.chest, 0.21, 0.12, 0, 'shoulderL');
    j.shoulderR = joint(j.chest, -0.21, 0.12, 0, 'shoulderR');
    j.elbowL = joint(j.shoulderL, 0, -0.28, 0, 'elbowL');
    j.elbowR = joint(j.shoulderR, 0, -0.28, 0, 'elbowR');
    j.handL = joint(j.elbowL, 0, -0.26, 0, 'handL');
    j.handR = joint(j.elbowR, 0, -0.26, 0, 'handR');
    j.thighL = joint(this.root, 0.10, -0.05, 0, 'thighL');
    j.thighR = joint(this.root, -0.10, -0.05, 0, 'thighR');
    j.kneeL = joint(j.thighL, 0, -LEG.thigh, 0, 'kneeL');
    j.kneeR = joint(j.thighR, 0, -LEG.thigh, 0, 'kneeR');
    j.ankleL = joint(j.kneeL, 0, -LEG.shin, 0, 'ankleL');
    j.ankleR = joint(j.kneeR, 0, -LEG.shin, 0, 'ankleR');

    // body meshes
    boneMesh(this.root, new THREE.Vector3(0, 0.12, 0), 0.13, matDark);           // pelvis
    boneMesh(j.spine, new THREE.Vector3(0, 0.18, 0), 0.12, mat);
    boneMesh(j.chest, new THREE.Vector3(0, 0.16, 0), 0.14, mat);
    boneMesh(j.neck, new THREE.Vector3(0, 0.10, 0), 0.05, mat);
    ball(j.head, new THREE.Vector3(0, 0.11, 0), 0.115, mat);                     // head
    for (const s of ['L', 'R']) {
      boneMesh(j['shoulder' + s], new THREE.Vector3(0, -0.28, 0), 0.05, mat);
      boneMesh(j['elbow' + s], new THREE.Vector3(0, -0.26, 0), 0.045, mat);
      ball(j['hand' + s], new THREE.Vector3(0, 0, 0), 0.055, matDark);
      boneMesh(j['thigh' + s], new THREE.Vector3(0, -LEG.thigh, 0), 0.075, mat);
      boneMesh(j['knee' + s], new THREE.Vector3(0, -LEG.shin, 0), 0.06, mat);
      ball(j['knee' + s], new THREE.Vector3(0, 0, 0), 0.07, matDark);
      // foot box: ankle at origin, sole at -ankleH, extends forward
      const footGeo = new THREE.BoxGeometry(0.09, LEG.ankleH, FOOT.fwd + FOOT.back);
      const foot = new THREE.Mesh(footGeo, matDark);
      foot.position.set(0, -LEG.ankleH / 2, (FOOT.fwd - FOOT.back) / 2);
      foot.castShadow = true;
      j['ankle' + s].add(foot);
      if (!ghost) {
        const sole = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6),
          new THREE.MeshBasicMaterial({ color: s === 'L' ? 0xff5555 : 0x55ff88 }));
        sole.position.set(0, -LEG.ankleH, 0.0); // penetration reference: directly under the ankle
        sole.name = 'sole' + s;
        j['ankle' + s].add(sole);
        this['sole' + s] = sole;
      }
    }

    this.heading = new THREE.Vector3(0, 0, 1); // character walks toward +Z
    this.speed = 0.81; // m/s, matched to stride length / cycle to limit foot sliding
    this.phaseL = 0;
    this.phaseR = 0.5;
  }

  phase(side) { return side === 'L' ? this.phaseL : this.phaseR; }

  // The "existing walk clip": evaluates the full animation pose (root motion
  // included) at sim time t. No terrain awareness lives here.
  setAnimPose(t, distance) {
    const j = this.joints;
    const g = (t / CYCLE) % 1;
    const pL = g, pR = (g + 0.5) % 1;
    this.phaseL = pL; this.phaseR = pR;

    const hipL = hipPitch(pL) * D2R, hipR = hipPitch(pR) * D2R;
    const knL = kneeFlex(pL) * D2R, knR = kneeFlex(pR) * D2R;
    const anL = anklePitch(pL) * D2R, anR = anklePitch(pR) * D2R;

    j.thighL.rotation.set(-hipL, 0, 0);
    j.thighR.rotation.set(-hipR, 0, 0);
    j.kneeL.rotation.set(knL, 0, 0);
    j.kneeR.rotation.set(knR, 0, 0);
    j.ankleL.rotation.set(-anL, 0, 0);
    j.ankleR.rotation.set(-anR, 0, 0);

    // arms swing opposite to legs
    const armL = -0.55 * hipR, armR = -0.55 * hipL;
    j.shoulderL.rotation.set(-armL, 0, 0.12);
    j.shoulderR.rotation.set(-armR, 0, -0.12);
    j.elbowL.rotation.set(-0.35 - 0.2 * Math.max(0, armL), 0, 0);
    j.elbowR.rotation.set(-0.35 - 0.2 * Math.max(0, armR), 0, 0);

    // pelvis: lowest at double support, highest at mid-stance
    const bob = -0.026 * Math.cos(4 * Math.PI * g);
    const sway = 0.026 * Math.sin(2 * Math.PI * (g + 0.25));
    this.root.position.set(sway, HIP_Y + bob, distance);
    this.root.rotation.set(0.06, 0.05 * Math.sin(2 * Math.PI * g + Math.PI / 2), 0.04 * Math.sin(2 * Math.PI * g));

    j.spine.rotation.set(-0.04, 0, 0);
    j.chest.rotation.set(0, -0.06 * Math.sin(2 * Math.PI * g + Math.PI / 2), 0);
    j.head.rotation.set(-0.02, 0.06 * Math.sin(2 * Math.PI * g + Math.PI / 2), 0);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
  }
}
