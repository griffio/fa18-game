// Offline validation of the flight model against F/A-18C reference performance.
import { Aircraft, isa, F18 } from '../js/flightmodel.js';
import { Carrier, DECK_H } from '../js/carrier.js';
import { DEG, RAD, KT, FT, G0, qfromEuler, vlen, vadd, vscale, eulerFromQ, clamp, vsub } from '../js/math.js';

const DT = 1 / 240;
const flatSea = { wind: () => [0, 0, 0], surface: (p) => ({ y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' }) };
const ctl0 = () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0.8, gear: false, flaps: 0, hook: false, speedBrake: false, brakes: 0 });

function spawn(alt, ias, hdg = 0, opts = {}) {
  const a = new Aircraft();
  const at = isa(alt);
  const tas = ias / Math.sqrt(at.sigma);
  a.pos = [0, alt, 0];
  a.q = qfromEuler(hdg, 0, 0);
  a.vel = [Math.sin(hdg) * tas, 0, -Math.cos(hdg) * tas];
  a.gear = opts.gear ? 1 : 0;
  a.flap = opts.flap || 0; a.flapSel = opts.flaps || 0;
  a.fuel = opts.fuel ?? 3500; a.mass = F18.massEmpty + a.fuel;
  a.N = opts.N ?? 0.9;
  a.updateAir(flatSea);
  return a;
}
function run(a, ctl, secs, env = flatSea, cb) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    if (cb) cb(a, i * DT, ctl);
    a.events.length = 0;
    a.step(DT, ctl, env);
    if (a.state === 'crashed' && process.env.V) {
      const hp = a.crashPoint; if (hp) { const p = a.toWorld(hp); const sf = env.surface(p); console.log('    crash detail: point', hp, 'world y', p[1].toFixed(2), 'surface', sf.kind, sf.y.toFixed(2), 'cg y', a.pos[1].toFixed(2), 'roll', (a.eulers.roll*RAD).toFixed(1), 'pitch', (a.eulers.pitch*RAD).toFixed(1), 'local', env.carrier ? env.carrier.toLocal(p).map(v=>v.toFixed(1)) : ''); }
    }
    if (a.state === 'crashed') return false;
  }
  return true;
}
const kt = (v) => (v / KT).toFixed(0);
const ft = (m) => (m / FT).toFixed(0);

function vmax(alt, thr, label) {
  const a = spawn(alt, 250 * KT, 0, { N: 1 });
  const c = ctl0(); c.throttle = thr;
  // simple altitude hold via the stick
  run(a, c, 240, flatSea, (ac, t, ct) => {
    const vs = ac.vel[1];
    ct.pitch = clamp((alt - ac.pos[1]) * 0.004 - vs * 0.02, -0.5, 0.5);
  });
  console.log(`${label}: Vmax at ${ft(alt)} ft = M${a.mach.toFixed(2)} ${kt(a.ias)} KEAS  alt ${ft(a.pos[1])} ft  fuel used ${(3500 - a.fuel).toFixed(0)} kg`);
}

console.log('--- level speed');
vmax(100, 1.0, 'MIL SL');
vmax(100, 1.2, 'MAX AB SL');
vmax(11000, 1.0, 'MIL 36k');
vmax(11000, 1.2, 'MAX AB 36k');

console.log('--- trim / AoA at speeds (sea level, 3500 kg fuel)');
for (const ias of [140, 180, 250, 350, 450]) {
  const a = spawn(300, ias * KT, 0, {});
  const c = ctl0(); c.throttle = 0.7;
  let thr = 0.7;
  run(a, c, 60, flatSea, (ac, t, ct) => {
    ct.pitch = clamp((300 - ac.pos[1]) * 0.003 - ac.vel[1] * 0.02, -0.4, 0.4);
    thr = clamp(thr + (ias * KT - ac.ias) * 0.0004, 0, 1.2); ct.throttle = thr;
  });
  console.log(`  ${ias} KEAS: AoA ${(a.alpha * RAD).toFixed(1)} deg, throttle ${(thr * 100).toFixed(0)}%  N ${(a.N * 100).toFixed(0)}%  stab ${(a.de * RAD).toFixed(1)}  ff ${(a.ff * 7936).toFixed(0)} pph`);
}

console.log('--- approach config (gear, flaps FULL), on-speed AoA 8.1');
{
  const a = spawn(200, 135 * KT, 0, { gear: true, flap: 1, flaps: 2, fuel: 2500 });
  const c = ctl0(); c.gear = true; c.flaps = 2; c.throttle = 0.5;
  a.apc = true;
  run(a, c, 60, flatSea, (ac, t, ct) => {
    // fly a 3.5 deg glide path with the stick, APC holds AoA
    const target = -Math.tan(3.5 * DEG) * vlen(ac.vel);
    ct.pitch = clamp((target - ac.vel[1]) * 0.08, -0.5, 0.5);
    if (ac.pos[1] < 60) ac.pos[1] = 200;
  });
  console.log(`  on-speed: ${kt(a.ias)} KEAS AoA ${(a.alpha * RAD).toFixed(1)} throttle ${(a.thrCmd * 100).toFixed(0)}% N ${(a.N * 100).toFixed(1)}% pitch ${(a.eulers.pitch * RAD).toFixed(1)} sink ${(a.vel[1] / FT * 60).toFixed(0)} fpm, mass ${a.mass.toFixed(0)}`);
}

console.log('--- 1g stall / min speed, idle, clean');
{
  const a = spawn(3000, 200 * KT, 0, { N: 0.7 });
  const c = ctl0(); c.throttle = 0;
  let minIas = 1e9, maxA = 0;
  run(a, c, 50, flatSea, (ac, t, ct) => {
    ct.pitch = clamp((3000 - ac.pos[1]) * 0.01 - ac.vel[1] * 0.05, -1, 1);
    if (ac.ias < minIas) minIas = ac.ias;
    maxA = Math.max(maxA, ac.alpha);
  });
  console.log(`  min IAS ${kt(minIas)} kt, max AoA ${(maxA * RAD).toFixed(1)}`);
}

console.log('--- roll performance (full lateral stick, 1 s)');
for (const ias of [150, 250, 350, 500]) {
  const a = spawn(3000, ias * KT, 0, {});
  const c = ctl0(); c.throttle = 0.9;
  let pmax = 0, t90 = null;
  run(a, c, 2.5, flatSea, (ac, t, ct) => {
    ct.roll = 1;
    pmax = Math.max(pmax, ac.p || 0);
    const r = ac.eulers.roll;
    if (t90 === null && r > 89 * DEG) t90 = t;
  });
  console.log(`  ${ias} KEAS: peak roll rate ${((pmax) * RAD).toFixed(0)} deg/s, 90 deg in ${t90?.toFixed(2)} s`);
}

console.log('--- pull (full aft stick)');
for (const ias of [200, 300, 350, 450, 550]) {
  const a = spawn(3000, ias * KT, 0, {});
  const c = ctl0(); c.throttle = 1.0;
  let nmax = 0, amax = 0, tg = null;
  run(a, c, 3, flatSea, (ac, t, ct) => {
    ct.pitch = 1;
    nmax = Math.max(nmax, ac.nz); amax = Math.max(amax, ac.alpha);
    if (tg === null && ac.nz > 0.9 * nmax && t > 0.2 && nmax > 2) tg = t;
  });
  console.log(`  ${ias} KEAS: max g ${nmax.toFixed(2)}  max AoA ${(amax * RAD).toFixed(1)} `);
}

console.log('--- sustained turn rate at 15000 ft, MIL & AB, 350 kt');
for (const thr of [1.0, 1.2]) {
  const alt = 4572;
  const a = spawn(alt, 330 * KT, 0, { N: 1 });
  const c = ctl0(); c.throttle = thr;
  let h0 = 0;
  run(a, c, 40, flatSea, (ac, t, ct) => {
    // bank 80 deg, pull to hold altitude
    const e = ac.eulers;
    ct.roll = clamp((78 * DEG - e.roll) * 2, -1, 1);
    ct.pitch = clamp(0.3 + (alt - ac.pos[1]) * 0.01 - ac.vel[1] * 0.03, -1, 1);
    if (t > 30 && h0 === 0) h0 = Math.atan2(ac.vel[0], -ac.vel[2]);
  });
  const h1 = Math.atan2(a.vel[0], -a.vel[2]);
  console.log(`  thr ${thr}: speed ${kt(a.ias)} KEAS  g ${a.nz.toFixed(1)}  alt ${ft(a.pos[1])}  turn rate ~${(Math.abs(((h1 - h0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) / 10 * RAD).toFixed(1)} deg/s`);
}

console.log('--- climb (MIL & MAX AB, 350 KEAS to 30000 ft)');
for (const thr of [1.0, 1.2]) {
  const a = spawn(100, 350 * KT, 0, { N: 1, fuel: 4930 });
  const c = ctl0(); c.throttle = thr;
  let t30 = null; let rocMax = 0;
  run(a, c, 300, flatSea, (ac, t, ct) => {
    ct.pitch = clamp((ac.ias - 350 * KT) * 0.01, -0.5, 0.5);
    rocMax = Math.max(rocMax, ac.vel[1]);
    if (t30 === null && ac.pos[1] > 30000 * FT) t30 = t;
  });
  console.log(`  thr ${thr}: initial ROC ${(rocMax / FT * 60).toFixed(0)} fpm, 30k ft in ${t30?.toFixed(0)} s`);
}

console.log('--- catapult launch');
for (const [flaps, thr, label] of [[1, 1.0, 'HALF flaps MIL'], [1, 1.2, 'HALF flaps MAX'], [0, 1.0, 'flaps AUTO MIL (bad)']]) {
  const cv = new Carrier([0, 0, 0], 285, 14);
  const windFn = (p) => { const w = 12 * KT; const d = 105 * DEG; return [Math.sin(d) * w, 0, -Math.cos(d) * w]; };
  const env = {
    wind: windFn, carrier: cv,
    surface: (p) => cv.deckAt(p) || { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' },
    collide: (pts) => cv.collide(pts),
  };
  const a = new Aircraft();
  a.fuel = 4930; a.mass = F18.massEmpty + a.fuel;
  a.attachToCatapult(cv);
  const c = ctl0(); c.throttle = thr; c.gear = true; c.flaps = flaps;
  a.flapSel = flaps; a.flap = [0, 0.5, 1][flaps];
  let minH = 1e9; let launched = false; let tEnd = 0; let vEnd = 0;
  const ok = run(a, c, 14, env, (ac, t) => {
    cv.update(DT);
    if (t > 3 && !launched) { ac.N = 1; ac.launch(); launched = true; }
    if (ac.state === 'fly' && !tEnd) { tEnd = t; vEnd = ac.ias; }
    if (ac.state === 'fly') minH = Math.min(minH, ac.pos[1]);
  });
  console.log(`  ${label}: ${ok ? 'flying' : 'CRASH ' + a.crashReason} end-speed ${kt(vEnd)} KEAS, settle min alt ${minH.toFixed(1)} m (deck ${DECK_H}), after 11 s alt ${a.pos[1].toFixed(0)} m ${kt(a.ias)} kt AoA ${(a.alpha * RAD).toFixed(1)}`);
}

console.log('--- carrier approach + trap (scripted pilot, APC on)');
for (const [offH, label] of [[0, 'on glideslope'], [8, 'high (+8 m)'], [-4, 'low (-4 m)']]) {
  const cv = new Carrier([0, 0, 0], 285, 14);
  const windFn = (p) => { const w = 12 * KT; const d = 105 * DEG; return [Math.sin(d) * w, 0, -Math.cos(d) * w]; };
  const env = {
    wind: windFn, carrier: cv,
    surface: (p) => cv.deckAt(p) || { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' },
    collide: (pts) => cv.collide(pts),
  };
  const a = new Aircraft();
  a.fuel = 2200; a.mass = F18.massEmpty + a.fuel;
  // start 1500 m behind touchdown on glideslope
  const start = cv.approachPoint(1500);
  start[1] += offH;
  const lh = cv.landingHeading();
  a.pos = start;
  a.q = qfromEuler(lh, -3.5 * DEG + 8.1 * DEG, 0);
  const vRel = 140 * KT - 12 * KT; // approx closure
  a.vel = vadd(cv.velocity(), [Math.sin(lh) * vRel * 0.95, -Math.tan(3.5 * DEG) * vRel, -Math.cos(lh) * vRel * 0.95]);
  a.gear = 1; a.flap = 1; a.flapSel = 2; a.hookAng = 58 * DEG; a.N = 0.82;
  a.updateAir(env);
  a.apc = true;
  const c = ctl0(); c.gear = true; c.flaps = 2; c.hook = true; c.throttle = 0.5;
  let trap = null, touch = null, maxSink = 0, events = [];
  run(a, c, 40, env, (ac, t, ct) => {
    cv.update(DT);
    for (const e of ac.events) { events.push(e.type); if (e.type === 'trap') trap = e.wire; if (e.type === 'touch' && !touch) touch = e; if (process.env.V && e.type !== 'gearMove') console.log('    event', t.toFixed(2), JSON.stringify(e)); }
    if (process.env.V3 && t > 27.6 && t < 29.3 && Math.round(t * 240) % 12 === 0) { const l = cv.toLocal(ac.pos); const rv = cv.dirLocal(vsub(ac.vel, cv.velocity())); const e = ac.eulers; console.log(`      t=${t.toFixed(2)} local=${l.map(x=>x.toFixed(1))} vrel=${rv.map(x=>x.toFixed(1))} hdgRelDeck=${((e.hdg - cv.hdg)*RAD).toFixed(1)} roll=${(e.roll*RAD).toFixed(1)} p=${(ac.w[2]*-RAD).toFixed(0)} r=${(-ac.w[1]*RAD).toFixed(0)} wow=${ac.wow} comp=${ac.wheel.map(w=>w.comp.toFixed(2))} arrest=${ac.arrest?ac.arrest.dist.toFixed(0):'-'} da=${(ac.da*RAD).toFixed(1)} dr=${(ac.dr*RAD).toFixed(1)}`); }
    if (process.env.V2 && t > 20 && t < 24 && Math.round(t * 240) % 24 === 0) console.log(`      t=${t.toFixed(1)} y=${ac.pos[1].toFixed(1)} vy=${ac.vel[1].toFixed(2)} nz=${ac.nz.toFixed(2)} a=${(ac.alpha*RAD).toFixed(1)} acmd=${(ac.aCmd*RAD).toFixed(1)} pitch=${ct.pitch.toFixed(2)} mode=${ac.fcsMode} wow=${ac.wow} thr=${ac.thrCmd.toFixed(2)} T=${(ac.thrust/1000).toFixed(0)} ralt=${ac.radarAlt.toFixed(1)} wind=${ac.windV.map(x=>x.toFixed(1))}`);
    if (process.env.V && Math.round(t * 240) % (cv.groove(ac.toWorld(ac.hookTipBody())).dist < 200 ? 24 : 240) === 0) { const hw = ac.toWorld(ac.hookTipBody()); const gg = cv.groove(hw); console.log(`    t=${t.toFixed(1)} dist=${gg.dist.toFixed(0)} h=${gg.h.toFixed(1)} gsErr=${gg.gsErr.toFixed(2)} lineup=${gg.lineup.toFixed(2)} lat=${gg.lat.toFixed(1)} a=${(ac.alpha*RAD).toFixed(1)} ias=${(ac.ias/KT).toFixed(0)} roll=${(ac.eulers.roll*RAD).toFixed(1)}`); }
    const hookW = ac.toWorld(ac.hookTipBody());
    const g = cv.groove(hookW);
    if (g.dist > 5 && !ac.wow) {
      // simple pilot: steer for lineup and fly the ball
      const hGs = Math.tan(3.5 * DEG) * g.dist;
      const lhd = cv.landingHeading();
      const rv = vsub(ac.vel, cv.velocity());
      const closure = rv[0] * Math.sin(lhd) - rv[2] * Math.cos(lhd);
      const vsDes = -Math.tan(3.5 * DEG) * closure - (g.h - hGs) * 0.25;
      ct.pitch = clamp((vsDes - ac.vel[1]) * 0.13, -0.5, 0.5);
      const e = ac.eulers;
      const latRate = (g.lat - (ac._lastLat ?? g.lat)) * 240; ac._lastLat = g.lat;
      const bankDes = g.dist < 120 ? 0 : clamp((-g.lat * 0.6 - latRate * 3.0) * DEG, -12 * DEG, 12 * DEG);
      ct.roll = clamp((bankDes - e.roll) * 3, -1, 1);
    } else { ct.pitch = 0; ct.roll = 0; if (ac.wow) { ac.apc = false; ct.throttle = 1.0; } }
  });
  console.log(`  ${label}: ${a.state === 'crashed' ? 'CRASH ' + a.crashReason + ' @' + JSON.stringify(a.crashPoint) : 'OK'}, touchdown sink ${touch ? (touch.sink / FT).toFixed(1) + ' ft/s on ' + touch.kind : '-'}, wire ${trap ?? 'none (bolter)'}, arrest ${a.arrest ? (a.arrest.stopped ? 'stopped after ' + a.arrest.dist.toFixed(0) + ' m' : 'running') : '-'}`);
}

console.log('--- parked on deck stability (brakes)');
{
  const cv = new Carrier([0, 0, 0], 285, 14);
  const env = { wind: () => [0, 0, 0], carrier: cv, surface: (p) => cv.deckAt(p) || { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' }, collide: (pts) => cv.collide(pts) };
  const a = new Aircraft();
  a.attachToCatapult(cv);
  a.state = 'fly'; a.cat = null;
  a.pos[1] += 0.3;
  const c = ctl0(); c.throttle = 0; c.gear = true; c.brakes = 1;
  const l0 = cv.toLocal(a.pos);
  run(a, c, 20, env, () => cv.update(DT));
  const l1 = cv.toLocal(a.pos);
  console.log(`  ${a.state}: drift ${vlen(vsub(l1, l0)).toFixed(2)} m, height above deck ${(l1[1] - DECK_H).toFixed(2)} m, pitch ${(a.eulers.pitch * RAD).toFixed(2)} deg, comp ${a.wheel.map((w) => w.comp.toFixed(2)).join('/')}`);
}
