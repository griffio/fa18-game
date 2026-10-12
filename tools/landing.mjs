// Landing-speed analysis: thrust vs speed in landing configuration, and traps at a
// range of approach speeds.
import { Aircraft, isa, F18, HOOK } from '../js/flightmodel.js';
import { Carrier } from '../js/carrier.js';
import { DEG, RAD, KT, FT, G0, clamp, vsub, vadd, vdot, qfromEuler } from '../js/math.js';

const DT = 1 / 240;
const at = isa(0);
// ---- thrust available at sea level vs speed (steady engine)
function thrust(N, thr, kts) {
  const a = new Aircraft();
  a.pos = [0, 0, 0]; a.vel = [0, 0, -kts * KT]; a.updateAir({ wind: () => [0, 0, 0] });
  a.N = N; a.ab = thr > 1 ? 1 : 0; a.abLit = 1;
  a.updateEngine(0, { throttle: thr });
  return a.thrust;
}
console.log('--- thrust available, sea level (kN)');
console.log(' KCAS   idle   MIL    MAX AB');
for (const k of [0, 100, 130, 150, 200, 250, 300]) console.log(`${String(k).padStart(5)} ${(thrust(0.70, 0, k) / 1000).toFixed(1).padStart(6)} ${(thrust(1, 1, k) / 1000).toFixed(1).padStart(6)} ${(thrust(1, 1.2, k) / 1000).toFixed(1).padStart(6)}`);

// ---- steady 3.5 deg glideslope in landing config (gear, flaps FULL, hook)
function steady(kts, mass) {
  const V = kts * KT, q = 0.5 * at.rho * V * V, S = F18.S, W = mass * G0;
  const gam = -3.5 * DEG;
  // iterate on AoA so that L + T sin a = W cos g and T = D + W sin g
  let a = 8 * DEG, T = 30000;
  for (let i = 0; i < 40; i++) {
    const CLreq = (W * Math.cos(gam) - T * Math.sin(a)) / (q * S);
    a = Aircraft.alphaForCL(CLreq, V / at.a, 1) * DEG;
    const aD = a * RAD;
    const { CD } = Aircraft.aero(aD, V / at.a, 1, 1, 0, true);
    const D = q * S * CD;
    T = Math.max(0, (D + W * Math.sin(gam)) / Math.cos(a));
  }
  // throttle setting for that thrust: invert N -> thrust at this speed
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (thrust(0.70 + 0.30 * m, m, kts) < T) lo = m; else hi = m; }
  const mil = thrust(1, 1, kts);
  return { aoa: a * RAD, T, thr: T > mil ? NaN : lo, N: 0.70 + 0.30 * lo, excess: (mil - T) / W };
}
for (const mass of [13900, 15400]) {
  console.log(`\n--- 3.5 deg glideslope, gear + FULL flaps + hook, ${mass} kg (${Math.round(mass * 2.2046)} lb)`);
  console.log(' KCAS   AoA   thrust req kN  throttle  N%   climb grad. available at MIL (wave-off)');
  for (const k of [105, 110, 115, 120, 125, 130, 135, 140, 145, 150, 160, 170, 180]) {
    const r = steady(k, mass);
    console.log(`${String(k).padStart(5)} ${r.aoa.toFixed(1).padStart(5)}  ${(r.T / 1000).toFixed(1).padStart(8)}      ${isNaN(r.thr) ? '  >MIL' : (r.thr * 100).toFixed(0).padStart(5) + '%'}  ${(r.N * 100).toFixed(0).padStart(3)}   ${(r.excess * 100).toFixed(1)}%`);
  }
}

// ---- dynamic: traps flown at different approach AoAs (speeds) by a scripted pilot
function trap(targetAoA, fuel) {
  const cv = new Carrier([0, 0, 0], 285, 14);
  const wind = () => { const w = 12 * KT, d = 105 * DEG; return [Math.sin(d) * w, 0, -Math.cos(d) * w]; };
  const env = { wind, carrier: cv, surface: (p) => cv.deckAt(p) || { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' }, collide: (pts) => cv.collide(pts) };
  const a = new Aircraft();
  a.fuel = fuel; a.mass = F18.massEmpty + fuel;
  const start = cv.approachPoint(1500);
  const lh = cv.landingHeading();
  a.pos = start; a.q = qfromEuler(lh, (targetAoA - 3.5) * DEG, 0);
  const air = steadySpeed(targetAoA, a.mass);
  a.vel = vadd(wind(), [Math.sin(lh) * air, -Math.tan(3.5 * DEG) * (air - 13), -Math.cos(lh) * air]);
  a.gear = 1; a.flap = 1; a.flapSel = 2; a.hookAng = HOOK.down; a.N = 0.8; a.updateAir(env);
  a.apc = true; a.apcTarget = targetAoA;
  const c = { pitch: 0, roll: 0, yaw: 0, throttle: 0.5, gear: true, flaps: 2, hook: true, speedBrake: false, brakes: 0 };
  let touch = null, trapEv = null, engageClosure = null, maxG = 0, tdAoA = null, tdIas = null, tdPitch = null;
  for (let i = 0; i < 240 * 45; i++) {
    cv.update(DT);
    const g = cv.groove(a.toWorld(a.hookTipBody()));
    if (g.dist > 5 && !a.wow) {
      const rv = vsub(a.vel, cv.velocity());
      const closure = rv[0] * Math.sin(lh) - rv[2] * Math.cos(lh);
      const vsDes = -Math.tan(3.5 * DEG) * closure - (g.h - Math.tan(3.5 * DEG) * g.dist) * 0.35;
      c.pitch = clamp((vsDes - a.vel[1]) * 0.16, -0.7, 0.7);
      const U = cv.dirWorld([Math.cos(9 * DEG), 0, -Math.sin(9 * DEG)]);
      const bank = g.dist < 120 ? 0 : clamp((-g.lat * 0.5 - vdot(rv, U) * 2.5) * DEG, -10 * DEG, 10 * DEG);
      c.roll = clamp((bank - a.eulers.roll) * 1.5 - (a.p || 0) * 0.3, -0.6, 0.6);
    } else { c.pitch = 0; c.roll = 0; if (a.wow) { a.apc = false; c.throttle = 1; } }
    a.step(DT, c, env);
    for (const e of a.events) {
      if (e.type === 'touch' && !touch) { touch = e; tdAoA = a.alpha * RAD; tdIas = a.ias / KT; tdPitch = a.eulers.pitch * RAD; }
      if (e.type === 'wireBreak') trapEv = { wire: e.wire + ' (PARTED)' };
      if (e.type === 'trap') { trapEv = e; const rv = vsub(a.vel, cv.velocity()); engageClosure = Math.hypot(rv[0], rv[2]) / KT; }
    }
    a.events.length = 0;
    if (a.arrest && !a.arrest.stopped) maxG = Math.max(maxG, a.nxArrest || 0);
    if (a.state === 'crashed') break;
    if (a.arrest && a.arrest.stopped) break;
  }
  return { a, touch, trapEv, engageClosure, maxG, tdAoA, tdIas, tdPitch };
}
function steadySpeed(aoa, mass) {
  let lo = 95, hi = 220;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (steady(m, mass).aoa > aoa) lo = m; else hi = m; }
  return lo * KT;
}
console.log('\n--- carrier traps flown at different approach AoA (13,900 kg, 26 kt wind over deck)');
console.log(' AoA  approach  touchdown: KIAS pitch  sink ft/s   wire  engage closure  peak decel  run-out  result');
let lastEvents;
for (const aoa of [-1.5, 0, 1.5, 3, 4, 5, 6, 7, 8.1, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
  const r = trap(aoa, 2450);
  const app = steadySpeed(aoa, 13900) / KT;
  const res = r.a.state === 'crashed' ? 'CRASH: ' + r.a.crashReason : r.a.arrest?.stopped ? (r.engageClosure > 140 ? 'TRAPPED (HARD)' : 'TRAPPED') : String(r.trapEv?.wire).includes('PARTED') ? 'WIRE PARTED - TOO FAST' : 'BOLTER/NO WIRE';
  console.log(`${aoa.toFixed(1).padStart(4)}  ${app.toFixed(0).padStart(5)} kt   ${(r.tdIas ?? 0).toFixed(0).padStart(5)}  ${(r.tdPitch ?? 0).toFixed(1).padStart(5)}  ${r.touch ? (r.touch.sink / FT).toFixed(1).padStart(6) : '     -'}     ${r.trapEv ? r.trapEv.wire : '-'}     ${r.engageClosure ? r.engageClosure.toFixed(0).padStart(4) + ' kt' : '     -'}      ${r.maxG.toFixed(1)} g     ${r.a.arrest ? r.a.arrest.dist.toFixed(0).padStart(3) + ' m' : '   -'}   ${res}`);
}
