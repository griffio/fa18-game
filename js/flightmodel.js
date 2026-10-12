// F/A-18C Hornet flight model.
//
// Six-degree-of-freedom rigid body integrated at 240 Hz:
//  * ISA atmosphere, wind with boundary-layer shear, turbulence and carrier airwake
//  * Non-linear lift / drag / moment coefficients vs AoA and Mach (LEX high-alpha
//    lift, transonic drag rise, flaps, gear, speed brake, ground effect)
//  * Two F404-GE-402 engines: spool dynamics, afterburner light-off, thrust lapse
//    with altitude and Mach, real specific fuel consumption
//  * Fly-by-wire control laws (non-linear dynamic inversion) that command g
//    (UA mode) or AoA-limited g (PA mode) with neutral-stick flight-path hold, a
//    roll-rate command system and sideslip suppression. The FCS can only use the
//    real control surface deflections and rates, so authority fades with dynamic
//    pressure exactly where the real aircraft runs out of control power.
//  * Oleo-pneumatic landing gear with progressive springs, orifice damping, tyre
//    friction, brakes and nose-wheel steering, working on terrain and moving decks
//  * Tailhook, arresting gear and steam catapult.
import {
  DEG, RAD, G0, KT, clamp, lerp, smoothstep, vadd, vsub, vscale, vmadd, vdot, vcross, vlen, vnorm,
  qrot, qrotInv, qintegrate, qmul, qconj, qnorm, eulerFromQ, qfromEuler, vnoise1,
} from './math.js';

// ------------------------------------------------------------------ atmosphere
export function isa(h) {
  h = clamp(h, -500, 25000);
  let T, p;
  if (h < 11000) { T = 288.15 - 0.0065 * h; p = 101325 * Math.pow(T / 288.15, 5.25588); }
  else { T = 216.65; p = 22632.1 * Math.exp(-(h - 11000) / 6341.62); }
  const rho = p / (287.053 * T);
  return { T, p, rho, a: Math.sqrt(1.4 * 287.053 * T), sigma: rho / 1.225 };
}

// ------------------------------------------------------------------ data
const interp = (tab, x) => {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1], [x1, y1] = tab[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tab[tab.length - 1][1];
};

// clean-wing lift (auto LEF/TEF scheduling included), alpha in degrees
const CL_TAB = [[-90, 0], [-60, -0.75], [-40, -1.0], [-22, -0.95], [-12, -0.72], [0, 0.06], [10, 0.67],
  [18, 1.15], [25, 1.45], [30, 1.60], [35, 1.68], [40, 1.64], [50, 1.40], [60, 1.05], [70, 0.70], [80, 0.35], [90, 0]];
// lift-curve-slope compressibility factor (low aspect ratio wing)
const CLA_MACH = [[0, 1], [0.6, 1.08], [0.8, 1.2], [0.95, 1.33], [1.05, 1.3], [1.2, 1.2], [1.5, 1.0], [2.0, 0.72]];
const CD0_TAB = [[0, 0.0215], [0.75, 0.0215], [0.85, 0.024], [0.92, 0.032], [1.0, 0.050], [1.05, 0.058],
  [1.2, 0.054], [1.5, 0.046], [2.0, 0.040]];
const K_TAB = [[0, 0.115], [0.9, 0.125], [1.1, 0.18], [1.5, 0.24], [2.0, 0.30]];

export const F18 = {
  S: 37.16, b: 11.43, c: 3.51,
  massEmpty: 11450,          // kg: empty + pilot + 578 rds 20mm + 2x AIM-9 + rails
  fuelMax: 4930,             // kg internal (10,860 lb)
  Iref: [205000, 230000, 31000], // body x (pitch), y (yaw), z (roll) at 16,000 kg
  thrMil: 2 * 48900,         // N sea-level static, 2x F404-GE-402
  thrAB: 2 * 79200,
  sfcMil: 2.29e-5,           // kg/(N*s)  (0.81 lb/lbf/hr)
  sfcAB: 4.93e-5,            // (1.74 lb/lbf/hr)
  nMax: 7.5, nMin: -3.0,
  eye: [0, 1.02, -5.25],     // pilot eye point (body)
};

// gear: attach point (body), extended length to tyre bottom, stroke, spring, damping
const GEAR = [
  { id: 'N', att: [0, -0.55, -5.2], len: 1.65, stroke: 0.36, k: 150e3, c1: 17e3, c2: 5e3, steer: true, brake: 0 },
  { id: 'L', att: [-1.62, -0.5, 0.75], len: 1.70, stroke: 0.46, k: 430e3, c1: 52e3, c2: 14e3, steer: false, brake: 1 },
  { id: 'R', att: [1.62, -0.5, 0.75], len: 1.70, stroke: 0.46, k: 430e3, c1: 52e3, c2: 14e3, steer: false, brake: 1 },
];
// points that must never touch anything
const HARDPOINTS = [
  [0, 0.0, -8.9], [0, 1.45, -4.6], [-2.05, 3.35, 6.5], [2.05, 3.35, 6.5], [-5.95, 0, 1.6], [5.95, 0, 1.6],
  [-3.3, -0.15, 7.8], [3.3, -0.15, 7.8], [-0.55, -0.5, 7.7], [0.55, -0.5, 7.7], [0, -0.98, -2.5],
  [0, -0.95, 2.8], [-1.05, -0.85, -1.0], [1.05, -0.85, -1.0], [0, -0.9, -6.5],
];
export const HOOK = { pivot: [0, -0.6, 5.9], len: 2.3, up: 5 * DEG, down: 48 * DEG };

export const FLAPS = ['AUTO', 'HALF', 'FULL'];

export class Aircraft {
  constructor() { this.reset(); }

  reset() {
    this.pos = [0, 1000, 0];
    this.vel = [0, 0, -150];
    this.q = [0, 0, 0, 1];
    this.w = [0, 0, 0];              // body angular velocity (x pitch, y yaw-left, z roll-left)
    this.fuel = F18.fuelMax;
    this.mass = F18.massEmpty + this.fuel;
    this.N = 0.70;                   // engine core speed fraction (N2)
    this.ab = 0;                     // afterburner level 0..1 (actual)
    this.abLit = 0;                  // light-off progress
    this.thrust = 0;
    this.ff = 0;
    this.gear = 1; this.gearCmd = true;
    this.flapSel = 0;                // 0 AUTO, 1 HALF, 2 FULL
    this.flap = 0;                   // actual trailing edge flap 0..1 (FULL=1)
    this.lef = 0;                    // leading edge flap (deg) for animation
    this.hookCmd = false; this.hookAng = HOOK.up;
    this.sbCmd = false; this.sb = 0;
    this.de = 0; this.da = 0; this.dr = 0; // control surfaces (rad)
    this.steer = 0;
    this.accLast = [0, 0, 0];
    this.wow = false; this.wheel = GEAR.map(() => ({ contact: false, comp: 0, surf: null }));
    this.state = 'fly';              // fly | cat | stroke | crashed
    this.cat = null; this.arrest = null;
    this.apc = false; this.apcI = 0;
    this.crashed = false; this.crashReason = '';
    this.events = [];
    this.t = 0;
    this.nz = 1; this.nzMax = 1; this.nzMaxAbs = 1; this.groundSpeedRel = 0; this.alpha = 0; this.radarAlt = 1000; this.beta = 0; this.mach = 0; this.ias = 0; this.tas = 0;
    this.pa = false;
    this.flameout = false;
    this.lastHookTip = null;
    this.gs = 0;
    this.updateAir({ wind: () => [0, 0, 0] });
  }

  // strut compression in metres [nose, left, right], for drawing the gear
  strutComp() {
    if (this.cat) { const c = Math.max(0, 2.2 - this.cat.h); return [c, c, c]; }
    return this.wheel.map((w, i) => w.comp * GEAR[i].stroke);
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  get eulers() { return eulerFromQ(this.q); }
  toWorld(pBody) { return vadd(this.pos, qrot(this.q, pBody)); }
  hookTipBody() {
    const a = this.hookAng;
    return [HOOK.pivot[0], HOOK.pivot[1] - Math.sin(a) * HOOK.len, HOOK.pivot[2] + Math.cos(a) * HOOK.len];
  }

  // ---------------------------------------------------------------- aero data
  static CL(aDeg, mach, flap) {
    let a = aDeg;
    let cl;
    if (Math.abs(a) <= 90) cl = interp(CL_TAB, a);
    else cl = -0.8 * interp(CL_TAB, Math.sign(a) * (180 - Math.abs(a)));
    // compressibility on the linear part
    const lin = 1 - smoothstep(14, 26, Math.abs(a));
    cl *= 1 + (interp(CLA_MACH, mach) - 1) * lin;
    // trailing-edge flaps + drooped ailerons
    // flaps keep roughly half their increment up to the stall: CLmax ~2.0 with FULL flaps
    cl += 0.70 * flap * lerp(1, 0.5, smoothstep(15, 35, Math.abs(a))) * (Math.abs(a) < 90 ? 1 : 0);
    return cl;
  }
  // total lift / drag coefficients for a configuration (shared by the sim and analysis tools)
  // ge: ground-effect factor 0..1
  static aero(aDeg, mach, flap, gear, sb, hookDown, ge = 0) {
    let CL = Aircraft.CL(aDeg, mach, flap) * (1 + 0.06 * ge);
    const CD0 = interp(CD0_TAB, mach) + 0.025 * gear + 0.05 * flap * flap + 0.012 * flap + 0.07 * sb + 0.002 * (hookDown ? 1 : 0);
    const K = interp(K_TAB, mach) * (1 - 0.45 * ge);
    // induced drag at all AoA, plus separated-flow drag that grows smoothly beyond ~11 deg (LEX keeps flow attached)
    // (F/A-18 high-alpha data: CD ~0.3 @ 20, ~0.75 @ 35, ~1.1 @ 50 deg)
    const sep = Math.sin(Math.max(0, Math.abs(aDeg) - 11) * DEG);
    return { CL, CD: CD0 + K * CL * CL + 2.0 * sep * sep };
  }

  // invert lift curve on its linear region
  static alphaForCL(cl, mach, flap) {
    // bisection on the monotonic part of the real lift curve (-14..35 deg)
    let lo = -14, hi = 35;
    if (cl >= Aircraft.CL(hi, mach, flap)) return hi + (cl - Aircraft.CL(hi, mach, flap)) * 20;
    if (cl <= Aircraft.CL(lo, mach, flap)) return lo;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (Aircraft.CL(mid, mach, flap) < cl) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  updateAir(env) {
    const at = isa(this.pos[1]);
    this.atm = at;
    const wind = env.wind ? env.wind(this.pos, this.t) : [0, 0, 0];
    this.windV = wind;
    const vAir = vsub(this.vel, wind);
    const vb = qrotInv(this.q, vAir);
    const V = vlen(vb);
    this.tas = V;
    this.vb = vb;
    if (V > 0.5) {
      this.alpha = Math.atan2(-vb[1], -vb[2]);
      this.beta = Math.asin(clamp(vb[0] / V, -1, 1));
    } else { this.alpha = 0; this.beta = 0; }
    this.mach = V / at.a;
    this.qbar = 0.5 * at.rho * V * V;
    this.ias = V * Math.sqrt(at.sigma); // EAS ~ CAS
  }

  // ---------------------------------------------------------------- main step
  step(dt, ctl, env) {
    if (this.state === 'crashed') { this.t += dt; return; }
    this.t += dt;
    this.updateSystems(dt, ctl);
    this.updateEngine(dt, ctl);

    if (this.state === 'cat' || this.state === 'stroke') { this.stepCatapult(dt, ctl, env); return; }

    this.updateAir(env);
    const m = this.mass;
    const scaleI = 0.72 + 0.28 * (m / 16000);
    const Ib = [F18.Iref[0] * scaleI, F18.Iref[1] * scaleI, F18.Iref[2] * scaleI];
    const { S, b, c } = F18;
    const V = Math.max(this.tas, 0.1);
    const qbar = this.qbar;
    const a = this.alpha, be = this.beta;
    const aD = a * RAD;
    const M = this.mach;
    // body rates in conventional p q r (roll right, pitch up, yaw right)
    const p = -this.w[2], q = this.w[0], r = -this.w[1];
    const ph = (p * b) / (2 * V), qh = (q * c) / (2 * V), rh = (r * b) / (2 * V);

    // height above surface for ground effect / radar altitude
    const sBelow = env.surface ? env.surface(this.pos) : { y: 0 };
    this.radarAlt = this.pos[1] - sBelow.y;
    this.surfBelow = sBelow;
    this.groundSpeedRel = vlen(vsub(this.vel, sBelow.v || [0, 0, 0]));
    const hge = clamp(this.radarAlt - 2.0, 0, 50) / F18.b;

    // ---- coefficients
    const flap = this.flap;
    const ge = hge < 1 ? (1 - hge) * (1 - hge) : 0;
    const co = Aircraft.aero(aD, M, flap, this.gear, this.sb, this.hookAng > 0.2, ge);
    const CL = co.CL;
    const CD = co.CD + 0.6 * Math.sin(be) * Math.sin(be);
    // pitch: static stability gets much stronger supersonic (aero centre moves aft)
    const cma = -0.12 - 0.5 * smoothstep(0.95, 1.3, M);
    const wHi = smoothstep(35 * DEG, 60 * DEG, Math.abs(a));
    const CmStatic = 0.02 + lerp(cma, -0.45, wHi) * Math.sin(a) - 0.05 * flap + 0.015 * this.sb;
    const Cmq = -4.5, CmDe = 0.75;
    // lateral-directional
    const cnbScale = 1 - smoothstep(20, 45, Math.abs(aD)) * 1.6; // goes negative at very high AoA
    const Cnb = 0.12 * cnbScale, Cnr = -0.25, Cnp = -0.03, CnDr = 0.075, CnDa = -0.008;
    const Clb = -0.08, Clp = -0.30, Clr = 0.10;
    const ClDa = 0.115 * Math.max(0.3, 1 - Math.abs(aD) / 45), ClDr = 0.01;
    const CYb = -0.9, CYdr = 0.15;
    const sb_ = Math.sin(be);

    // ---- flight control system
    const fcs = this.fcs(dt, ctl, { qbar, V, a, be, p, q, r, ph, qh, rh, Ib, CmStatic, Cmq, CmDe, Clb, Clp, Clr, ClDa, Cnb, Cnr, Cnp, CnDr, CnDa, M, flap, m });
    const deR = 45 * DEG * dt, daR = 100 * DEG * dt, drR = 80 * DEG * dt;
    this.de += clamp(fcs.de - this.de, -deR, deR);
    this.da += clamp(fcs.da - this.da, -daR, daR);
    this.dr += clamp(fcs.dr - this.dr, -drR, drR);

    // departure: asymmetric vortex shedding at very high AoA
    const dep = smoothstep(38, 55, Math.abs(aD));
    const Cnrand = dep * 0.015 * vnoise1(this.t * 0.7, 3);
    const Clrand = dep * 0.010 * vnoise1(this.t * 1.3, 7);

    const Cm = CmStatic + Cmq * qh + CmDe * this.de;
    const Cl = Clb * sb_ + Clp * ph + Clr * rh + ClDa * this.da + ClDr * this.dr + Clrand;
    const Cn = Cnb * sb_ + Cnr * rh + Cnp * ph + CnDr * this.dr + CnDa * this.da + Cnrand;
    const CY = CYb * sb_ + CYdr * this.dr;

    // ---- forces (body frame)
    const Fb = [0, 0, 0];
    if (V > 0.5) {
      const vh = vscale(this.vb, 1 / V);
      let ld = [0, -vh[2], vh[1]]; // cross(right, vhat)
      const ll = vlen(ld);
      ld = ll > 1e-6 ? vscale(ld, 1 / ll) : [0, 1, 0];
      const L = qbar * S * CL, D = qbar * S * CD, Y = qbar * S * CY;
      for (let i = 0; i < 3; i++) Fb[i] += ld[i] * L - vh[i] * D;
      Fb[0] += Y;
    }
    Fb[2] -= this.thrust;
    // aero moments -> body xyz torques
    const Tb = [qbar * S * c * Cm, -qbar * S * b * Cn, -qbar * S * b * Cl];

    let F = qrot(this.q, Fb);
    // ---- landing gear, hook, arresting gear
    const gearOut = this.gearForces(dt, ctl, env);
    F = vadd(F, gearOut.F);
    const Tg = qrotInv(this.q, gearOut.T);
    for (let i = 0; i < 3; i++) Tb[i] += Tg[i];
    const ar = this.arrestForces(dt, env);
    if (ar) {
      F = vadd(F, ar.F);
      const Ta = qrotInv(this.q, ar.T);
      for (let i = 0; i < 3; i++) Tb[i] += Ta[i];
    }

    // specific force -> load factor
    const fBody = qrotInv(this.q, F);
    this.nz = fBody[1] / (m * G0);
    this.nx = -fBody[2] / (m * G0);
    this.ny = fBody[0] / (m * G0);

    // ---- integrate
    const acc = vadd(vscale(F, 1 / m), [0, -G0, 0]);
    this.accLast = acc;
    this.vel = vmadd(this.vel, acc, dt);
    this.pos = vmadd(this.pos, this.vel, dt);
    const w = this.w;
    const Iw = [Ib[0] * w[0], Ib[1] * w[1], Ib[2] * w[2]];
    const gyro = vcross(w, Iw);
    for (let i = 0; i < 3; i++) w[i] += ((Tb[i] - gyro[i]) / Ib[i]) * dt;
    this.q = qintegrate(this.q, w, dt);

    // ---- structural limits and collisions
    if (Math.abs(this.nz) > this.nzMaxAbs) this.nzMaxAbs = Math.abs(this.nz);
    if (!this.wow && this.nz > this.nzMax) this.nzMax = this.nz;
    if (this.nz > 12.5 || this.nz < -6.5) this.crash('OVERSTRESS - AIRFRAME FAILURE', 'air');
    this.checkCollisions(env);
    this.p = p; this.qr = q; this.r = r;
  }

  // ---------------------------------------------------------------- FCS
  fcs(dt, ctl, k) {
    const { qbar, V, a, be, p, q, r, ph, qh, rh, Ib, CmStatic, Cmq, CmDe, Clb, Clp, Clr, ClDa, Cnb, Cnr, Cnp, CnDr, CnDa, M, flap, m } = k;
    const { S, b, c } = F18;
    const direct = this.wow || V < 32 || qbar < 400;
    let de, da, dr;
    if (direct) {
      // mechanical / ground mode: surfaces follow the stick
      de = ctl.pitch * 24 * DEG;
      // take-off roll: once there's airflow over the tail the PA-mode pitch-rate
      // feedback is active, so aft stick rotates at ~6°/s instead of slamming the tail down
      if (this.wow && qbar > 400) de += clamp(6 * (ctl.pitch * 6 * DEG - q), -20 * DEG, 20 * DEG) * smoothstep(400, 2000, qbar);
      da = ctl.roll * 25 * DEG;
      dr = ctl.yaw * 30 * DEG;
      this.fcsMode = this.wow ? 'GND' : 'DIR';
      this.aInt = 0;
      return { de: clamp(de, -24 * DEG, 24 * DEG), da, dr };
    }
    this.fcsMode = this.pa ? 'PA' : 'UA';
    const qS = Math.max(qbar, 1) * S;
    // ---------------- pitch: g command with flight-path hold at neutral stick
    const e = this.eulers;
    const phi = e.roll;
    const spd = vlen(this.vel);
    const gam = spd > 1 ? Math.asin(clamp(this.vel[1] / spd, -1, 1)) : 0;
    const aphi = Math.abs(phi);
    let gPhi;
    if (aphi < 60 * DEG || aphi > 120 * DEG) gPhi = 1 / Math.cos(phi);
    else gPhi = lerp(2, -2, (aphi - 60 * DEG) / (60 * DEG));
    const nNeutral = clamp(Math.cos(gam) * gPhi, F18.nMin, 2.2);
    // non-linear stick gradient: fine control around neutral, full g at the stops
    const s0 = clamp(ctl.pitch, -1, 1);
    const s = s0 * (0.28 + 0.72 * s0 * s0);
    let nCmd;
    if (this.pa) nCmd = nNeutral + (s >= 0 ? s * 2.6 : s * 1.8);
    else {
      const nMax = F18.nMax * Math.min(1, 15200 / m + 0.06);
      nCmd = s >= 0 ? nNeutral + s * (nMax - nNeutral) : nNeutral + s * (nNeutral - F18.nMin);
    }
    nCmd = clamp(nCmd, F18.nMin, F18.nMax);
    // AoA limits. At low speed the stick position effectively commands AoA: with the
    // stick near neutral the FCS will not hold more than a modest AoA, so a climb that
    // bleeds off energy lets the nose drop instead of hanging the jet on the limiter
    // (speed stability). Pulling opens the full limit in proportion to stick travel.
    const aLim = (this.pa ? 22 : 35) * DEG, aMin = -10 * DEG;
    const aNeutral = (this.pa ? 12 : 18) * DEG;
    const aMax = lerp(aNeutral, aLim, clamp(s0 * 1.25, 0, 1));
    this.aLimit = aLim;
    // flight-path frame: lift direction and the specific force that actually curves the path
    const vh = vscale(this.vb, 1 / V);
    let ld = [0, -vh[2], vh[1]];
    const lln = vlen(ld); ld = lln > 1e-6 ? vscale(ld, 1 / lln) : [0, 1, 0];
    const aB = qrotInv(this.q, this.accLast);
    const gB = qrotInv(this.q, [0, -G0, 0]);
    const nPath = (vdot(aB, ld) - vdot(gB, ld)) / G0;   // (L + T sin a) / W
    this.nPath = nPath;
    const clReq = (nCmd * m * G0 - this.thrust * Math.sin(a)) / qS;
    // integral g-trim absorbs lift-curve non-linearity / ground effect / turbulence
    const nErr = nCmd - nPath;
    if (Math.abs(nErr) < 0.6) this.aInt = clamp((this.aInt || 0) + nErr * 0.03 * dt, -5 * DEG, 5 * DEG);
    let aCmd = Aircraft.alphaForCL(clReq, M, flap) * DEG + (this.aInt || 0);
    aCmd = clamp(aCmd, aMin, aMax);
    this.aCmd = aCmd;
    // rotation rate of the flight path in the body pitch plane
    const qFp = vdot(aB, ld) / V;
    const qDes = clamp(qFp + 1.7 * (aCmd - a), -1.2, 1.2);
    const qdotDes = clamp(4.2 * (qDes - q), -2.5, 2.5);
    const CmNeed = (Ib[0] * qdotDes) / (qS * c) - (CmStatic + Cmq * qh);
    de = clamp(CmNeed / CmDe, -24 * DEG, 24 * DEG);

    // ---------------- roll: rate command
    const pMaxBase = this.pa ? 120 : 220;
    const pMax = pMaxBase * DEG * (1 - 0.6 * smoothstep(15 * DEG, 35 * DEG, a));
    const pCmd = ctl.roll * pMax;
    const pdotDes = 7 * (pCmd - p);
    const ClNeed = (Ib[2] * pdotDes) / (qS * b) - (Clb * Math.sin(be) + Clp * ph + Clr * rh);
    da = clamp(ClNeed / ClDa, -25 * DEG, 25 * DEG);

    // ---------------- yaw: sideslip suppression + turn coordination, pedals command beta
    const bCmd = ctl.yaw * (this.pa ? 10 : 6) * DEG * clamp(9000 / Math.max(qbar, 1), 0.15, 1);
    const ca = Math.max(Math.cos(a), 0.25);
    const sideAcc = aB[0] + 0; // body lateral specific acceleration incl. gravity
    const rDes = (sideAcc / V + p * Math.sin(a) + 2.2 * (be - bCmd)) / ca;
    const rdotDes = 4.5 * (rDes - r);
    const CnNeed = (Ib[1] * rdotDes) / (qS * b) - (Cnb * Math.sin(be) + Cnr * rh + Cnp * ph + CnDa * da);
    dr = clamp(CnNeed / CnDr, -30 * DEG, 30 * DEG);
    return { de, da, dr };
  }

  // ---------------------------------------------------------------- systems
  updateSystems(dt, ctl) {
    // gear: ~5 s cycle
    this.gearCmd = ctl.gear;
    const gt = this.gearCmd ? 1 : 0;
    if (this.wow && !this.gearCmd) this.gearCmd = true; // weight-on-wheels interlock
    const prevG = this.gear;
    this.gear += clamp((this.gearCmd ? 1 : 0) - this.gear, -dt / 5, dt / 5);
    if (prevG < 1 && this.gear >= 1) this.emit('gearLocked');
    if (prevG > 0 && this.gear <= 0) this.emit('gearUp');
    if ((prevG === 1 || prevG === 0) && this.gear !== prevG) this.emit('gearMove');
    // flaps: blow back to AUTO above 250 KCAS
    this.flapSel = ctl.flaps;
    const blown = this.ias > 250 * KT && this.flapSel > 0;
    this.flapBlown = blown;
    const ft = blown ? 0 : [0, 0.5, 1][this.flapSel];
    this.flap += clamp(ft - this.flap, -dt / 3, dt / 3);
    this.pa = this.flapSel > 0 && this.flap > 0.05;
    // auto leading-edge flaps follow AoA (UA) or 34 deg (PA)
    const lefT = this.flap > 0.05 ? 34 * this.flap : clamp(this.alpha * RAD * 1.1, 0, 25);
    this.lef += clamp(lefT - this.lef, -20 * dt, 20 * dt);
    // hook
    this.hookCmd = ctl.hook;
    if (!this.hookCmd && this.arrest) this.releaseWire();
    const ht = this.hookCmd ? (this.arrest ? 14 * DEG : HOOK.down) : HOOK.up;
    this.hookAng += clamp(ht - this.hookAng, -(this.arrest ? 120 : 45) * DEG * dt, 90 * DEG * dt);
    // speed brake
    this.sbCmd = ctl.speedBrake && this.nz < 6;
    this.sb += clamp((this.sbCmd ? 1 : 0) - this.sb, -dt / 1.5, dt / 2);
    this.brakes = ctl.brakes;
  }

  updateEngine(dt, ctl) {
    let thr = clamp(ctl.throttle, 0, 1.2);
    // approach power compensator: holds on-speed AoA (8.1 deg) with the throttle
    if (this.apc) {
      if (!this.pa || this.wow || this.state !== 'fly') { this.apc = false; this.emit('apcOff'); }
      else {
        const err = this.alpha * RAD - (this.apcTarget ?? 8.1);
        this.apcI = clamp(this.apcI + err * 0.05 * dt, -0.3, 0.6);
        thr = clamp(0.45 + this.apcI + 0.09 * err + 0.25 * this.w[0], 0.0, 1.0);
        this.apcThrottle = thr;
      }
    }
    this.thrCmd = thr;
    const atm = this.atm || isa(this.pos[1]);
    const out = this.fuel <= 0;
    if (out && !this.flameout) { this.flameout = true; this.emit('flameout'); }
    const mil = Math.min(thr, 1);
    let Nt = out ? 0.12 : 0.70 + 0.30 * mil;
    const dN = Nt - this.N;
    const rate = dN > 0 ? (this.N < 0.8 ? 0.10 : 0.16) : 0.22;
    this.N += clamp(dN * 2.2, -rate, rate) * dt;
    // afterburner light-off needs >95% N2
    const abWant = !out && thr > 1.001 && this.N > 0.95 ? (thr - 1) / 0.2 : 0;
    if (abWant > 0) this.abLit = Math.min(1, this.abLit + dt / 0.6); else this.abLit = 0;
    const abT = this.abLit >= 1 ? abWant : 0;
    if (this.ab === 0 && abT > 0) this.emit('abLight');
    this.ab += clamp(abT - this.ab, -dt * 3, dt * 1.6);
    if (this.ab < 0.001 && abT === 0) this.ab = 0;
    // thrust
    const sig = atm.sigma, Mn = this.mach;
    const ramMil = 1 + 0.10 * Mn - 0.12 * Mn * Mn;
    const ramAB = (1 + 0.18 * Mn - 0.05 * Mn * Mn) * (Mn > 1.7 ? Math.max(0, 1 - (Mn - 1.7) * 1.2) : 1);
    const Tmil = F18.thrMil * Math.pow(sig, 0.8) * ramMil;
    const Tab = F18.thrAB * Math.pow(sig, 0.7) * ramAB;
    const frac = Math.pow(clamp((this.N - 0.62) / 0.38, 0, 1), 1.8);
    let T = Tmil * frac;
    let ffDry = Math.max(0.12 * (this.N > 0.6 ? 1 : 0), F18.sfcMil * T);
    let ffAB = 0;
    if (this.ab > 0) {
      const Tw = Tmil + (Tab - Tmil) * (0.3 + 0.7 * this.ab);
      ffAB = F18.sfcAB * Tw - F18.sfcMil * Tmil;
      T = lerp(T, Tw, Math.min(1, this.ab * 4));
    }
    if (out) { T = 0; ffDry = 0; ffAB = 0; }
    this.thrust = T;
    this.ff = ffDry + ffAB;                    // kg/s
    this.fuel = Math.max(0, this.fuel - this.ff * dt);
    this.mass = F18.massEmpty + this.fuel;
  }

  // ---------------------------------------------------------------- gear
  gearForces(dt, ctl, env) {
    let F = [0, 0, 0], T = [0, 0, 0];
    let anyWow = false;
    const R = (v) => qrot(this.q, v);
    const fwdW = R([0, 0, -1]);
    const gearDown = this.gear > 0.98;
    for (let i = 0; i < GEAR.length; i++) {
      const g = GEAR[i], st = this.wheel[i];
      const rBody = [g.att[0], g.att[1] - g.len, g.att[2]];
      const rW = R(rBody);
      const pW = vadd(this.pos, rW);
      const s = env.surface ? env.surface(pW) : { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' };
      st.surf = s.kind;
      const n = s.n;
      const d = (s.y - pW[1]) * n[1];
      if (!gearDown || d <= 0) {
        if (st.contact) st.contact = false;
        st.comp = 0;
        continue;
      }
      // point velocity relative to the surface
      const wW = R(this.w);
      const vP = vadd(this.vel, vcross(wW, rW));
      const vRel = vsub(vP, s.v || [0, 0, 0]);
      const vn = vdot(vRel, n);
      if (!st.contact) {
        st.contact = true;
        const sink = -vn;
        this.emit('touch', { gear: g.id, sink, kind: s.kind });
        if (s.kind === 'water') { this.crash('DITCHED', 'water'); return { F, T }; }
        if (sink > (g.steer ? 9.5 : 8.2)) { this.crash('GEAR COLLAPSE - ' + (sink / 0.3048).toFixed(0) + ' FT/S SINK', s.kind); return { F, T }; }
      }
      if (s.kind === 'water') { this.crash('DITCHED', 'water'); return { F, T }; }
      anyWow = true;
      const x = Math.min(d, g.stroke);
      st.comp = x / g.stroke;
      let Fn = g.k * x * (1 + 3 * Math.pow(x / g.stroke, 3)) - g.c1 * vn - g.c2 * vn * Math.abs(vn);
      if (d > g.stroke) {
        Fn += 6e6 * (d - g.stroke) - 2e5 * Math.min(vn, 0);
        if (d > g.stroke + 0.25) { this.crash('GEAR FAILURE', s.kind); return { F, T }; }
      }
      Fn = Math.max(0, Fn);
      // wheel axes on the surface
      let fw = vsub(fwdW, vscale(n, vdot(fwdW, n)));
      fw = vnorm(fw);
      if (g.steer) {
        const ang = this.steer;
        const side0 = vcross(fw, n);
        fw = vnorm(vadd(vscale(fw, Math.cos(ang)), vscale(side0, Math.sin(ang))));
      }
      const side = vcross(fw, n);
      const vT = vsub(vRel, vscale(n, vn));
      const vLong = vdot(vT, fw), vLat = vdot(vT, side);
      const mu = 0.022 + (g.brake ? this.brakes * 0.55 : 0);
      const fLong = -mu * Fn * clamp(vLong / 0.25, -1, 1);
      // tyre side force: slip-angle based at speed, viscous "scrub" when slow
      const slip = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5));
      const fSlip = -0.8 * Fn * clamp(slip / 0.14, -1, 1);
      const fScrub = -0.8 * Fn * clamp(vLat / 0.3, -1, 1);
      const fLat = lerp(fScrub, fSlip, smoothstep(2, 6, Math.abs(vLong)));
      const Fw = vadd(vadd(vscale(n, Fn), vscale(fw, fLong)), vscale(side, fLat));
      F = vadd(F, Fw);
      T = vadd(T, vcross(rW, Fw));
    }
    const was = this.wow;
    this.wow = anyWow;
    if (!was && anyWow) this.emit('wow');
    if (was && !anyWow) this.emit('airborne');
    // nose-wheel steering
    const gs = this.groundSpeedRel || 0;
    this.steer = this.wow ? ctl.yaw * 30 * DEG * clamp(1.2 - gs / 25, 0.15, 1) : 0;
    // tailhook rides on the surface
    this.updateHook(env);
    return { F, T };
  }

  updateHook(env) {
    // keep the hook point on top of the surface (spring-loaded hook)
    if (!this.hookCmd || this.arrest) return;
    const tipW = () => this.toWorld(this.hookTipBody());
    let tw = tipW();
    const s = env.surface ? env.surface(tw) : null;
    if (s && tw[1] < s.y && s.kind !== 'water') {
      let lo = HOOK.up, hi = this.hookAng;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        this.hookAng = mid;
        const p = tipW();
        if (p[1] < s.y) hi = mid; else lo = mid;
      }
      this.hookAng = lo;
      this.hookOnDeck = true;
    } else this.hookOnDeck = false;
  }

  // ---------------------------------------------------------------- carrier ops
  stepCatapult(dt, ctl, env) {
    const cv = env.carrier;
    const cat = this.cat;
    this.updateAir(env);
    if (this.state === 'cat') {
      cat.s = 0;
    } else {
      // steam catapult stroke: ~3 g to end speed over the 94 m track
      const L = cv.cat.length;
      const vEnd = cat.vEnd;
      const acc = (vEnd * vEnd) / (2 * L);
      cat.v = Math.min(vEnd, cat.v + acc * dt);
      cat.s += cat.v * dt;
      this.nx = acc / G0 + 0.2;
      if (cat.s >= L) {
        // launch!
        const fwd = cv.dirWorld(cv.cat.dir);
        this.vel = vadd(cv.velocity(), vscale(fwd, cat.v));
        this.state = 'fly';
        this.cat = null;
        this.wow = false;
        this.wheel.forEach((w) => (w.contact = false));
        this.emit('catEnd');
        // nose strut extension at the end of the stroke kicks the nose up and the
        // FCS has the stabilators pre-set for the hands-off fly-away
        this.w = [11 * DEG, 0, 0];
        this.de = 10 * DEG;
        this.aInt = 0;
        return;
      }
    }
    const pl = vadd(cv.cat.start, vscale(cv.cat.dir, cat.s));
    pl[1] = cv.deckH + cat.h;
    this.pos = cv.toWorld(pl);
    this.q = qnorm(qmul(cv.q, cat.qLocal));
    this.vel = vadd(cv.velocity(), vscale(cv.dirWorld(cv.cat.dir), cat.v || 0));
    this.w = [0, 0, 0];
    this.wow = true;
    this.nz = 1;
    this.radarAlt = cat.h;
    this.de = this.da = this.dr = 0;
  }

  attachToCatapult(cv) {
    const hdgLocal = 0;
    this.state = 'cat';
    this.cat = { s: 0, v: 0, h: 2.06, qLocal: [0, 0, 0, 1], vEnd: 0 };
    this.arrest = null;
    this.crashed = false;
    this.gear = 1; this.gearCmd = true;
    this.hookAng = HOOK.up;
    this.wheel.forEach((w) => (w.contact = true));
    this.stepCatapult(0, {}, { carrier: cv, wind: cv.windFn });
  }

  // parked on a runway at ground height y, nose on heading hdg (rad), struts at static compression
  placeOnGround(x, y, z, hdg) {
    this.state = 'fly';
    this.cat = null; this.arrest = null;
    this.crashed = false;
    this.gear = 1; this.gearCmd = true;
    this.hookAng = HOOK.up;
    this.pos = [x, y + 2.13, z];
    this.q = qfromEuler(hdg, 0, 0);
    this.vel = [0, 0, 0]; this.w = [0, 0, 0];
    this.wow = true;
    this.wheel.forEach((w) => (w.contact = true));
    this.radarAlt = 2.13;
  }

  launch() {
    if (this.state !== 'cat') return false;
    // end speed tuned to gross weight: 135 kt at 16,000 kg
    this.cat.vEnd = 69.5 * Math.sqrt(this.mass / 16000);
    this.cat.v = 0;
    this.state = 'stroke';
    this.emit('catStart');
    return true;
  }

  checkWire(env) {
    const cv = env.carrier;
    // hook must be extended (it rides the deck at a shallow angle when the tail is low)
    if (!cv || this.arrest || !this.hookCmd || this.hookAng < 8 * DEG) { this.lastHookTip = null; return; }
    const tip = this.toWorld(this.hookTipBody());
    if (this.lastHookTip) {
      const w = cv.wireCrossing(this.lastHookTip, tip);
      if (w >= 0) {
        const rv = vsub(this.vel, cv.velocity());
        const closure = Math.hypot(rv[0], rv[2]);
        // Mk 7 arresting gear engaging-speed limit for the Hornet (~150 kt closure)
        if (closure > 150 * KT) {
          this.emit('wireBreak', { wire: w + 1, closure });
        } else {
          this.arrest = { wire: w, dist: 0, max: 100, stopped: false, anchor: null };
          this.emit('trap', { wire: w + 1, closure, hard: closure > 140 * KT });
        }
      }
    }
    this.lastHookTip = tip;
  }

  arrestForces(dt, env) {
    const cv = env.carrier;
    if (!cv) return null;
    this.checkWire(env);
    const ar = this.arrest;
    if (!ar) return null;
    // During the run-out the pendant pulls the hook shank almost level, so the
    // load acts roughly along the deck at hook-pivot height.
    const rW = qrot(this.q, HOOK.pivot);
    const pivW = vadd(this.pos, rW);
    const vDeck = cv.velocity();
    const wW = qrot(this.q, this.w);
    const vP = vsub(vadd(this.vel, vcross(wW, rW)), vDeck);
    const up = cv.dirWorld([0, 1, 0]);
    const vH = vsub(vP, vscale(up, vdot(vP, up)));
    const sp = vlen(vH);
    let F;
    if (!ar.stopped) {
      ar.dist += sp * dt;
      ar.t = (ar.t || 0) + dt;
      const rem = Math.max(3, ar.max - ar.dist);
      // purchase-cable slack, then arresting-engine pressure that rises with pay-out
      const ramp = clamp((ar.t - 0.12) / 0.45, 0, 1);
      const aKin = Math.min((sp * sp) / (2 * rem), 4.0 * G0);
      const Fmag = (aKin * ramp + 1.5) * this.mass + 1700 * ar.dist * ramp;
      this.nxArrest = Fmag / (this.mass * G0);
      const dir = sp > 0.05 ? vscale(vH, 1 / sp) : cv.dirWorld([0, 0, -1]);
      F = vscale(dir, -Fmag);
      if (sp < 0.6 && ar.dist > 15) {
        ar.stopped = true;
        ar.anchor = cv.toLocal(pivW);
        this.emit('trapStop', { wire: ar.wire + 1, dist: ar.dist });
      }
    } else {
      // wire tension holds the jet, even at full power
      const anchorW = cv.toWorld(ar.anchor);
      const dx = vsub(pivW, anchorW);
      const dxH = vsub(dx, vscale(up, vdot(dx, up)));
      F = vadd(vscale(dxH, -90000), vscale(vH, -70000));
      this.nxArrest = 0;
    }
    return { F, T: vcross(rW, F) };
  }

  releaseWire() {
    if (this.arrest) { this.arrest = null; this.emit('wireRelease'); }
  }

  // ---------------------------------------------------------------- collisions
  checkCollisions(env) {
    if (this.state === 'crashed') return;
    if (this.radarAlt < 25) for (const hp of HARDPOINTS) {
      const p = this.toWorld(hp);
      const s = env.surface ? env.surface(p) : null;
      if (s && p[1] < s.y - 0.02) {
        this.crashPoint = hp;
        // gear-up landings and scraped tails are fatal, as is the sea
        this.crash(s.kind === 'water' ? 'SPLASH - AIRCRAFT LOST AT SEA' : s.kind === 'deck' ? 'CRASHED ON DECK' : 'CRASHED INTO TERRAIN', s.kind);
        return;
      }
    }
    if (env.collide) {
      const pts = [this.pos, this.toWorld([0, 0, -8]), this.toWorld([-5.8, 0, 1.6]), this.toWorld([5.8, 0, 1.6]), this.toWorld([0, 3, 6.3]), this.toWorld([0, -0.9, 0])];
      const hit = env.collide(pts, this);
      if (hit) this.crash('COLLISION - ' + hit, 'object');
    }
  }

  crash(reason, kind) {
    if (this.state === 'crashed') return;
    this.state = 'crashed';
    this.crashed = true;
    this.crashReason = reason;
    this.crashKind = kind;
    this.emit('crash', { reason, kind, pos: this.pos.slice(), vel: this.vel.slice() });
    this.arrest = null;
  }
}
