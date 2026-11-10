// Per-frame metrics: sole penetration vs. terrain, knee-flexion jump between
// frames, pelvis jump, terrain-sample misses, IK reach clamps and relative
// sole-surface sliding (a foot carried by a moving platform must not count).
export class Metrics {
  constructor() { this.reset(); }

  reset() {
    this.frames = 0;
    this.maxPen = { L: 0, R: 0 };       // max penetration depth (m), contact only
    this.sumPen2 = { L: 0, R: 0 };
    this.nPen = { L: 0, R: 0 };
    this.maxKneeJump = { L: 0, R: 0 };  // max per-frame knee-flexion change (deg)
    this.maxHipJump = 0;                // max per-frame pelvis height change (m)
    this.misses = { L: 0, R: 0 };       // terrain sample misses
    this.clamps = { L: 0, R: 0 };       // IK reach clamps
    this.maxSlip = { L: 0, R: 0 };      // max sole-vs-surface relative speed (m/s)
    this.sumSlip2 = { L: 0, R: 0 };
    this.nSlip = { L: 0, R: 0 };
    this._knee = { L: null, R: null };
    this._hipY = null;
  }

  // discontinuity (e.g. terrain loop teleport): drop temporal baselines
  cut() { this._knee = { L: null, R: null }; this._hipY = null; }

  miss(s) { this.misses[s]++; }
  clamp(s) { this.clamps[s]++; }

  frame({ soleY, groundY, hit, w, kneeFlex, hipY, relVel }) {
    this.frames++;
    for (const s of ['L', 'R']) {
      if (hit[s] && w[s] > 0.5) {
        const pen = groundY[s] - soleY[s]; // > 0 => sole below ground
        if (pen > this.maxPen[s]) this.maxPen[s] = pen;
        // rms counts penetration only — a foot hovering above ground at
        // push-off is not penetration
        const pos = Math.max(0, pen);
        this.sumPen2[s] += pos * pos;
        this.nPen[s]++;
        // relative slip only meaningful while weighted onto the surface
        const rv = relVel ? relVel[s] : 0;
        if (rv > this.maxSlip[s]) this.maxSlip[s] = rv;
        this.sumSlip2[s] += rv * rv;
        this.nSlip[s]++;
      }
      if (this._knee[s] !== null) {
        const j = Math.abs(kneeFlex[s] - this._knee[s]);
        if (j > this.maxKneeJump[s]) this.maxKneeJump[s] = j;
      }
      this._knee[s] = kneeFlex[s];
    }
    if (this._hipY !== null) {
      const j = Math.abs(hipY - this._hipY);
      if (j > this.maxHipJump) this.maxHipJump = j;
    }
    this._hipY = hipY;
  }

  summary() {
    const rms = (s) => this.nPen[s] ? Math.sqrt(this.sumPen2[s] / this.nPen[s]) : 0;
    const slipRms = (s) => this.nSlip[s] ? Math.sqrt(this.sumSlip2[s] / this.nSlip[s]) : 0;
    return {
      frames: this.frames,
      maxPenM: Math.max(this.maxPen.L, this.maxPen.R),
      rmsPenM: Math.max(rms('L'), rms('R')),
      maxKneeJumpDeg: Math.max(this.maxKneeJump.L, this.maxKneeJump.R),
      maxHipJumpM: this.maxHipJump,
      maxSlipMs: Math.max(this.maxSlip.L, this.maxSlip.R),
      rmsSlipMs: Math.max(slipRms('L'), slipRms('R')),
      misses: this.misses.L + this.misses.R,
      clamps: this.clamps.L + this.clamps.R,
    };
  }
}
