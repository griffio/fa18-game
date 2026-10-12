// Reproduce: catapult launch with afterburner, then pull up with the keyboard.
import { Aircraft, F18 } from '../js/flightmodel.js';
import { Carrier } from '../js/carrier.js';
import { RAD, KT, DEG, clamp } from '../js/math.js';
const DT = 1 / 240;
const scenario = process.argv[2] || 'hold';
const cv = new Carrier([0, 0, 0], 285, 14);
const wind = () => { const w = 12 * KT, d = 105 * DEG; return [Math.sin(d) * w, 0, -Math.cos(d) * w]; };
const env = { wind, carrier: cv, surface: (p) => cv.deckAt(p) || { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' }, collide: (pts) => cv.collide(pts) };
const a = new Aircraft();
a.fuel = F18.fuelMax; a.mass = F18.massEmpty + a.fuel;
a.attachToCatapult(cv); a.flapSel = 1; a.flap = 0.5; a.N = 1;
const c = { pitch: 0, roll: 0, yaw: 0, throttle: +(process.argv[3] || 1.2), gear: true, flaps: 1, hook: false, speedBrake: false, brakes: 0 };
// keyboard ramp like Input (2.2/s up, 5/s back)
let key = 0, launched = false;
for (let i = 0; i < 240 * 45; i++) {
  const t = i * DT;
  cv.update(DT);
  if (t > 1 && !launched) { a.launch(); launched = true; }
  const tl = t - 4.5; // ~1.5 s after leaving the deck
  let target = 0;
  if (scenario === 'hold') target = tl > 0 && tl < 3 ? 1 : 0;          // hold Down arrow 3 s, then release
  if (scenario === 'tap') target = tl > 0 && tl < 1 ? 1 : 0;           // 1 s pull
  if (scenario === 'full') target = tl > 0 ? 1 : 0;                    // keep pulling
  if (scenario === 'climb' || scenario === 'climbUA') target = tl > 0 && tl < 4 ? 1 : 0; // zoom climb then let go
  if (scenario === 'climbUA' && tl > 0) { c.flaps = 0; c.gear = false; }
  key += clamp(target - key, -5 * DT, 2.2 * DT);
  c.pitch = key;
  a.step(DT, c, env); a.events.length = 0;
  if (a.state === 'crashed') { console.log('CRASH', a.crashReason, t.toFixed(1)); break; }
  if (i % 240 === 0 && t > 3.5) console.log(`t=${t.toFixed(1)} stick=${key.toFixed(2)} ias=${(a.ias / KT).toFixed(0)} aoa=${(a.alpha * RAD).toFixed(1)} pitch=${(a.eulers.pitch * RAD).toFixed(0)} gamma=${(Math.asin(a.vel[1] / Math.hypot(...a.vel)) * RAD).toFixed(0)} nz=${a.nz.toFixed(1)} alt=${a.pos[1].toFixed(0)} mode=${a.fcsMode}`);
}
