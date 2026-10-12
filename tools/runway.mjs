// Field take-off from NAS Moffett runway 32R: roll distance, rotation and lift-off speed.
//   node tools/runway.mjs [throttle] [rotateKt] [flaps 0|1|2] [pilot|hold]
// pilot: smooth rotation to 10° pitch; hold: keyboard Down arrow held from Vr until 2 s after lift-off
import { Aircraft, F18 } from '../js/flightmodel.js';
import { Carrier } from '../js/carrier.js';
import { Terrain } from '../js/terrain.js';
import { MOFFETT } from '../js/geo.js';
import { RAD, KT, FT, DEG, clamp } from '../js/math.js';
const DT = 1 / 240;
const thr = +(process.argv[2] || 1.0), vr = +(process.argv[3] || 140) * KT, flaps = +(process.argv[4] ?? 1), mode = process.argv[5] || 'pilot';
const terrain = new Terrain();
const cv = new Carrier([-21000, 0, 2500], 285, 14);
const wind = () => { const w = 12 * KT, d = 285 * DEG; return [-Math.sin(d) * w, 0, Math.cos(d) * w]; };
const surface = (p) => {
  const h = terrain.heightAt(p[0], p[2]);
  return h > 0.05 ? { y: h, n: terrain.normalAt(p[0], p[2]), v: [0, 0, 0], kind: 'land' } : { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' };
};
const env = { wind, carrier: cv, surface, collide: () => null };
const [x0, z0] = MOFFETT.thr, [x1, z1] = MOFFETT.end;
const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L;
const hdg = Math.atan2(ux, -uz);
const a = new Aircraft();
a.fuel = F18.fuelMax; a.mass = F18.massEmpty + a.fuel;
a.flapSel = flaps; a.flap = [0, 0.5, 1][flaps];
a.placeOnGround(x0 + ux * 60, terrain.heightAt(x0 + ux * 60, z0 + uz * 60), z0 + uz * 60, hdg);
console.log(`runway ${MOFFETT.rwy}: ${(L / FT).toFixed(0)} ft, hdg ${(hdg * RAD + 360) % 360 | 0}°, field elev ${terrain.heightAt(x0, z0).toFixed(1)} m, mass ${a.mass.toFixed(0)} kg`);
const c = { pitch: 0, roll: 0, yaw: 0, throttle: thr, gear: true, flaps, hook: false, speedBrake: false, brakes: 1 };
let key = 0, rolled = null, rot = null, lift = null, maxPitch = 0;
for (let i = 0; i < 240 * 60; i++) {
  const t = i * DT;
  c.brakes = a.N < 0.95 && t < 8 ? 1 : 0;
  if (!c.brakes && rolled === null) rolled = { t, p: a.pos.slice() };
  const dist = rolled ? Math.hypot(a.pos[0] - rolled.p[0], a.pos[2] - rolled.p[2]) : 0;
  const pa = a.eulers.pitch * RAD;
  let target = a.ias > vr ? clamp((10 - pa) * 0.06 - a.w[0] * RAD * 0.05, -0.4, 1) : 0;
  if (mode === 'hold') target = a.ias > vr && (!lift || t - lift.t < 2) ? 1 : 0;
  key += clamp(target - key, -5 * DT, 2.2 * DT);
  c.pitch = key;
  // lineup: keep on the centreline with rudder
  const lat = (a.pos[0] - x0) * uz - (a.pos[2] - z0) * ux;
  const hErr = Math.atan2(Math.sin(a.eulers.hdg - hdg), Math.cos(a.eulers.hdg - hdg));
  c.yaw = a.wow ? clamp(lat * 0.03 - hErr * 4, -1, 1) : 0;
  a.step(DT, c, env);
  maxPitch = Math.max(maxPitch, pa);
  for (const e of a.events) if (e.type === 'touch' && e.sink > 0.5) console.log('touch', e.gear, e.sink.toFixed(2));
  a.events.length = 0;
  if (a.state === 'crashed') { console.log('CRASH', a.crashReason, t.toFixed(2), 'pitch', (a.eulers.pitch * RAD).toFixed(1), 'ra', a.radarAlt.toFixed(2), 'vs', a.vel[1].toFixed(1)); break; }
  if (!rot && a.wheel[0].comp === 0 && rolled && dist > 10) rot = { t, d: dist, ias: a.ias };
  if (!lift && !a.wow && rolled) lift = { t, d: dist, ias: a.ias };
  if (i % 240 === 0 || (lift && t - lift.t > 6)) console.log(`t=${t.toFixed(0)} N=${(a.N * 100).toFixed(0)}% ias=${(a.ias / KT).toFixed(0)} dist=${(dist / FT).toFixed(0)}ft pitch=${pa.toFixed(1)} aoa=${(a.alpha * RAD).toFixed(1)} alt=${(a.radarAlt / FT).toFixed(0)}ft lat=${lat.toFixed(1)}m wow=${a.wow} ${a.fcsMode}`);
  if (lift && t - lift.t > 6) break;
}
if (rot) console.log(`nose-wheel lift-off ${(rot.ias / KT).toFixed(0)} kt at ${(rot.d / FT).toFixed(0)} ft`);
console.log(`max pitch ${maxPitch.toFixed(1)}°`);
if (lift) console.log(`LIFT-OFF ${(lift.ias / KT).toFixed(0)} kt, ground roll ${(lift.d / FT).toFixed(0)} ft, ${(lift.t - rolled.t).toFixed(1)} s from brake release`);
