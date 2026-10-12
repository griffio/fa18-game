// Nimitz-class aircraft carrier: moving deck, catapult, arresting gear,
// Fresnel lens (IFLOLS) geometry and the 3D model.
// Local frame: +X starboard, +Y up (0 = waterline), +Z aft (bow at -Z).
import {
  DEG, KT, vadd, vsub, vscale, vdot, vlen, qrot, qrotInv, qmul, qaxis, qnorm, clamp, hex, m4fromQT, rng,
} from './math.js';
import { MeshBuilder } from './mesh.js';
import { textSegments } from './vfont.js';

export const DECK_H = 19.5;
const ANG = 9 * DEG;
// angled deck landing-area centreline
const R0 = [-2, DECK_H, 166];                      // ramp
const D_ANG = [-Math.sin(ANG), 0, -Math.cos(ANG)];  // forward along landing area
const U_ANG = [Math.cos(ANG), 0, -Math.sin(ANG)];   // to starboard, across the landing area
export const WIRES_S = [45, 57, 69, 81];            // metres from the ramp
const WIRE_HALF = 17;
export const TD_S = 63;                              // hook touchdown aim point
export const GS_DEG = 3.5;                           // glideslope

const DECK_OUTLINE = [
  [-14, -166], [14, -166], [24, -140], [33, -100], [37, -60], [39, -20], [39, 60], [37, 100], [33, 140], [26, 166],
  [-24, 166], [-30, 140], [-36, 100], [-42, 40], [-47, -20], [-48, -42], [-36, -70], [-26, -110], [-20, -140],
];
const WATERLINE = [
  [0, -162], [10, -140], [17, -100], [20, -50], [20.5, 0], [20.5, 80], [19, 130], [16, 158],
  [-16, 158], [-19, 130], [-20.5, 80], [-20.5, 0], [-20, -50], [-17, -100], [-10, -140],
];
const UPPER = [
  [0, -166], [13, -140], [22, -100], [26, -50], [27, 0], [27, 90], [25, 140], [22, 166],
  [-22, 166], [-25, 140], [-27, 90], [-27, 0], [-26, -50], [-22, -100], [-13, -140],
];

function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// collision boxes in local frame [x0,x1, y0,y1, z0,z1, name]
const BOXES = [
  [-27, 27, -6, 17.0, -150, 166, 'CARRIER HULL'],
  [-13, 13, -6, 17.0, -166, -140, 'CARRIER BOW'],
  [27, 36, DECK_H, DECK_H + 23, 8, 44, 'CARRIER ISLAND'],
  [30, 33.5, DECK_H, DECK_H + 40, 21, 28, 'ISLAND MAST'],
];
export const PARKED = [
  [27, -92, -28], [27, -72, -28], [27, -52, -28], [27, 70, -150], [26, 110, -150], [24, 132, -150],
];

export class Carrier {
  constructor(pos, hdgDeg, speedKt) {
    this.pos = pos.slice();
    this.hdg = hdgDeg * DEG;
    this.speed = speedKt * KT;
    this.t = 0;
    this.deckH = DECK_H;
    this.cat = { start: [7, DECK_H, -60], dir: [0, 0, -1], length: 94 };
    this._update(0);
    this.prevPos = this.pos.slice(); this.prevQ = this.q.slice(); this.lastDt = 1 / 240;
    this.jbd = 0; this.jbdCmd = false;
    this.radarAng = 0;
    this.waveOff = false;
    this.parkedBoxes = PARKED.map(([x, z, r]) => ({ x, z, r: r * DEG }));
  }

  _update(dt) {
    this.t += dt;
    const t = this.t;
    // gentle swell response
    this.pitch = 0.22 * DEG * Math.sin(t * 2 * Math.PI / 9.5) + 0.08 * DEG * Math.sin(t * 2 * Math.PI / 5.3 + 1);
    this.roll = 0.30 * DEG * Math.sin(t * 2 * Math.PI / 14 + 0.7) + 0.08 * DEG * Math.sin(t * 2 * Math.PI / 6.1);
    this.heave = 0.25 * Math.sin(t * 2 * Math.PI / 8.2 + 0.3);
    const qy = qaxis([0, 1, 0], -this.hdg);
    const qp = qaxis([1, 0, 0], this.pitch);
    const qr = qaxis([0, 0, 1], -this.roll);
    this.q = qnorm(qmul(qmul(qy, qp), qr));
    this.fwd = [Math.sin(this.hdg), 0, -Math.cos(this.hdg)];
    this.vel = vscale(this.fwd, this.speed);
  }

  update(dt) {
    this.prevPos = this.pos.slice();
    this.prevQ = this.q.slice();
    this.prevHeave = this.heave || 0;
    this.pos = vadd(this.pos, vscale(this.fwd || [0, 0, -1], this.speed * dt));
    this._update(dt);
    this.lastDt = dt;
    this.jbd += clamp((this.jbdCmd ? 1 : 0) - this.jbd, -dt / 2.5, dt / 2.5);
    this.radarAng += dt * 2 * Math.PI / 4.5;
  }

  // origin of the local frame in world (includes heave)
  origin() { return [this.pos[0], this.pos[1] + this.heave, this.pos[2]]; }
  toWorld(p) { return vadd(this.origin(), qrot(this.q, p)); }
  toLocal(p) { return qrotInv(this.q, vsub(p, this.origin())); }
  dirWorld(d) { return qrot(this.q, d); }
  dirLocal(d) { return qrotInv(this.q, d); }
  velocity() { return this.vel.slice(); }
  pointVelocity(pl) {
    const prevOrigin = [this.prevPos[0], this.prevPos[1] + this.prevHeave, this.prevPos[2]];
    const a = vadd(prevOrigin, qrot(this.prevQ, pl));
    const b = this.toWorld(pl);
    return vscale(vsub(b, a), 1 / Math.max(this.lastDt, 1e-4));
  }

  // surface query: returns deck surface if the point is above the flight deck
  deckAt(pw) {
    const l = this.toLocal(pw);
    if (l[1] < DECK_H - 3.5 || l[1] > DECK_H + 60) return null;
    if (!inPoly(l[0], l[2], DECK_OUTLINE)) return null;
    const onDeck = [l[0], DECK_H, l[2]];
    const w = this.toWorld(onDeck);
    return { y: w[1], n: this.dirWorld([0, 1, 0]), v: this.pointVelocity(onDeck), kind: 'deck' };
  }

  collide(points) {
    for (const p of points) {
      const l = this.toLocal(p);
      if (Math.abs(l[2]) > 200 || Math.abs(l[0]) > 70) continue;
      for (const b of BOXES) {
        if (l[0] > b[0] && l[0] < b[1] && l[1] > b[2] && l[1] < b[3] && l[2] > b[4] && l[2] < b[5]) {
          if (b[6] === 'CARRIER HULL' && !inPoly(l[0], l[2], UPPER)) continue;
          return b[6] === 'CARRIER HULL' || b[6] === 'CARRIER BOW' ? 'RAMP STRIKE' : b[6];
        }
      }
      // flight deck slab edge (flying into the deck from the side/below)
      if (l[1] > 17 && l[1] < DECK_H - 0.6 && inPoly(l[0], l[2], DECK_OUTLINE)) return 'RAMP STRIKE';
      for (const pk of this.parkedBoxes) {
        const dx = l[0] - pk.x, dz = l[2] - pk.z;
        if (dx * dx + dz * dz < 36 && l[1] < DECK_H + 4.5) return 'PARKED AIRCRAFT';
      }
    }
    return null;
  }

  // hook point crossing a cross-deck pendant between two world positions
  wireCrossing(p0w, p1w) {
    const a = this.toLocal(p0w), b = this.toLocal(p1w);
    const sa = vdot(vsub(a, R0), D_ANG), sb = vdot(vsub(b, R0), D_ANG);
    for (let k = 0; k < WIRES_S.length; k++) {
      const s = WIRES_S[k];
      if (sa < s && sb >= s) {
        const f = (s - sa) / (sb - sa);
        const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
        const lat = vdot(vsub(p, R0), U_ANG);
        if (Math.abs(lat) < WIRE_HALF && p[1] < DECK_H + 0.18 && p[1] > DECK_H - 1.5) return k;
      }
    }
    return -1;
  }

  // approach geometry for the lens, ICLS and LSO
  // returns along-deck distance to the touchdown point, glideslope / lineup errors (deg)
  groove(pw) {
    const l = this.toLocal(pw);
    const rel = vsub(l, R0);
    const s = vdot(rel, D_ANG);
    const lat = vdot(rel, U_ANG);
    const h = l[1] - DECK_H;
    const dist = TD_S - s;
    const gs = Math.atan2(h, Math.max(dist, 1)) / DEG;
    const lineup = Math.atan2(lat, Math.max(dist, 1)) / DEG;
    return { s, lat, h, dist, gsErr: gs - GS_DEG, lineup, behind: s < 0 };
  }
  // world-space heading of the landing area
  landingHeading() {
    const d = this.dirWorld(D_ANG);
    return Math.atan2(d[0], -d[2]);
  }
  // world point at a distance (m) behind the touchdown point, on glideslope
  approachPoint(dist) {
    const s = TD_S - dist;
    const p = vadd(R0, vscale(D_ANG, s));
    p[1] = DECK_H + Math.tan(GS_DEG * DEG) * dist;
    return this.toWorld(p);
  }
  catStartWorld() { return this.toWorld(this.cat.start); }
  lsoPlatform() { return this.toWorld([-38, DECK_H + 1.8, 138]); }
  islandView() { return this.toWorld([34, DECK_H + 21, 20]); }

  // ---------------------------------------------------------------- model
  buildModel(R) {
    const mb = new MeshBuilder(hex('#9fd8ff', 0.8), 1.3);
    const HULL = hex('#69717b'), HULL_D = hex('#59606a'), DECK = hex('#3b4046'), ISL = hex('#78808a');
    const DARK = hex('#23272c');
    const H = DECK_H;
    // hull: below waterline -> waterline -> hangar deck level
    const ringAt = (pts, y) => pts.map(([x, z]) => [x, y, z]);
    mb.loft([ringAt(WATERLINE, -4), ringAt(WATERLINE, 0), ringAt(UPPER, 17)], HULL, undefined, true, false, false);
    // stern transom & hangar openings
    mb.poly(ringAt(UPPER, 17), DARK, null);
    // flight deck slab
    mb.prism(DECK_OUTLINE, 17, H, HULL_D, undefined, 1, DECK, false);
    // sponson struts under the angled deck overhang
    const STR = hex('#7a828c', 0.7);
    for (let z = -60; z <= 120; z += 30) {
      const xEdge = z < -20 ? -47 : -47 + (z + 20) * 0.04;
      mb.line([-26, 9, z], [xEdge + 4, 17, z], STR, 1.2);
    }
    // island superstructure
    mb.box([31, H, 26], 8, 9, 36, ISL);
    mb.box([31.3, H + 9, 26], 6.5, 6, 28, ISL);
    mb.box([31.2, H + 15, 24], 7.5, 4, 20, ISL);
    mb.box([31.2, H + 15.6, 24], 7.6, 1.6, 20.1, DARK, null);   // bridge windows
    mb.box([31.5, H + 19, 24], 5, 4, 12, ISL);
    // mast
    const MC = hex('#aab4c0', 0.9);
    const mb0 = [31.5, H + 23, 24];
    for (const [dx, dz] of [[-1.5, -2], [1.5, -2], [-1.5, 2], [1.5, 2]]) mb.line([mb0[0] + dx, mb0[1], mb0[2] + dz], [mb0[0] + dx * 0.3, H + 38, mb0[2] + dz * 0.3], MC, 1.1);
    for (let y = H + 26; y < H + 38; y += 3) {
      const k = 1 - (y - H - 23) / 15 * 0.7;
      mb.polyline([[mb0[0] - 1.5 * k, y, mb0[2] - 2 * k], [mb0[0] + 1.5 * k, y, mb0[2] - 2 * k], [mb0[0] + 1.5 * k, y, mb0[2] + 2 * k], [mb0[0] - 1.5 * k, y, mb0[2] + 2 * k]], MC, 1, true);
    }
    mb.line([mb0[0], H + 33, mb0[2] - 6], [mb0[0], H + 33, mb0[2] + 6], MC, 1.2); // yardarm
    mb.line([mb0[0], H + 38, mb0[2]], [mb0[0], H + 44, mb0[2]], MC, 1);
    // hull numbers on the island
    const num = '68';
    const paint = (side) => {
      const x = side > 0 ? 35.05 : 26.95;
      textSegments(num, 0, 0, 6, 'center', (x1, y1, x2, y2) => {
        mb.line([x, H + 12 - y1, 26 - x1 * side], [x, H + 12 - y2, 26 - x2 * side], [1, 1, 1, 0.95], 2.2);
      }, 1.2);
    };
    paint(1); paint(-1);
    // bow number on deck
    textSegments(num, 0, 0, 14, 'center', (x1, y1, x2, y2) => {
      mb.line([x1, H + 0.06, -150 + y1], [x2, H + 0.06, -150 + y2], [1, 1, 1, 0.9], 2.0);
    }, 1.5);

    // ---- deck markings
    const Y = H + 0.05;
    const WHITE = [1, 1, 1, 0.85], YEL = [1, 0.85, 0.2, 0.9], RED = [1, 0.25, 0.2, 0.9];
    // deck edge
    mb.polyline(DECK_OUTLINE.map(([x, z]) => [x, Y, z]), [0.9, 0.95, 1, 0.55], 1.2, true);
    // angled deck centreline (dashed) and foul lines
    const P = (s, lat) => [R0[0] + D_ANG[0] * s + U_ANG[0] * lat, Y, R0[2] + D_ANG[2] * s + U_ANG[2] * lat];
    for (let s = 0; s < 205; s += 10) mb.line(P(s, 0), P(s + 5, 0), WHITE, 1.6);
    mb.line(P(0, -12), P(205, -12), WHITE, 1.4);
    mb.line(P(0, 12), P(205, 12), RED, 1.6);
    mb.line(P(0, 13), P(205, 13), YEL, 1.2);
    // ramp stripes
    for (let lat = -11; lat <= 11; lat += 2.2) mb.line(P(0, lat), P(4, lat + 1), WHITE, 1.5);
    // arresting wires
    for (const s of WIRES_S) {
      const a = P(s, -WIRE_HALF), b = P(s, WIRE_HALF);
      a[1] = b[1] = H + 0.15;
      mb.box([a[0], H, a[2]], 1.2, 0.4, 1.2, DARK, null);
      mb.box([b[0], H, b[2]], 1.2, 0.4, 1.2, DARK, null);
    }
    // centreline lights
    for (let s = 0; s < 205; s += 15) mb.point(P(s, 0), [1, 1, 0.85, 1], 3.2);
    for (let s = 0; s < 205; s += 22) { mb.point(P(s, -12.5), [1, 1, 1, 0.9], 2.6); mb.point(P(s, 12.5), [1, 1, 1, 0.9], 2.6); }
    // drop lights on the stern
    for (let y = 2; y < 17; y += 1.6) mb.point([-2, y, 158.3 + (y / 17) * 7.5], [1, 0.7, 0.2, 1], 3);
    // catapults
    const cats = [[7, -60, -154], [-9, -55, -150]];
    for (const [x, z0, z1] of cats) {
      mb.line([x, Y, z0], [x, Y, z1], YEL, 1.6);
      mb.line([x - 1.2, Y, z0], [x - 1.2, Y, z1], [0.6, 0.6, 0.6, 0.6], 1);
      mb.line([x + 1.2, Y, z0], [x + 1.2, Y, z1], [0.6, 0.6, 0.6, 0.6], 1);
    }
    // waist cats (parallel to the angled deck)
    for (const [x0, z0] of [[-16, 12], [-28, -2]]) {
      mb.line([x0, Y, z0], [x0 + D_ANG[0] * 85, Y, z0 + D_ANG[2] * 85], YEL, 1.4);
    }
    // elevators
    const elev = (x0, x1, z0, z1) => mb.polyline([[x0, Y, z0], [x1, Y, z0], [x1, Y, z1], [x0, Y, z1]], YEL, 1.2, true);
    elev(26, 39, -82, -63); elev(26, 39, -50, -31); elev(26, 39, 52, 70); elev(-47, -34, 58, 76);
    // LSO platform and lens
    mb.box([-40, H - 1.5, 138], 5, 1.5, 9, DARK);
    mb.box([-42, H, 80], 2.5, 3.6, 1, DARK, undefined, -ANG);

    // parked aircraft spots (simple chalked silhouettes are drawn by main game)
    // bow and stern wave / wake
    const WAKE = [0.9, 0.97, 1, 0.55];
    const r = rng(7);
    for (const side of [-1, 1]) {
      mb.polyline([[side * 2, 0.2, -164], [side * 25, 0.2, -110], [side * 55, 0.2, -30], [side * 90, 0.2, 70]], [0.9, 0.97, 1, 0.45], 1.5);
      const pts = [];
      for (let z = 160; z < 1600; z += 40) pts.push([side * (14 + (z - 160) * 0.035 + (r() - 0.5) * 4), 0.15, z]);
      mb.polyline(pts, WAKE, 1.6);
    }
    for (let z = 165; z < 1400; z += 18) {
      const w = 8 + (z - 165) * 0.015;
      const a = (r() - 0.5) * w;
      mb.line([a, 0.12, z], [a + (r() - 0.5) * 6, 0.12, z + 8 + r() * 10], [0.95, 1, 1, 0.5 * (1 - z / 1500)], 1.8);
    }
    const out = mb.finish(25);
    this.mesh = R.createMesh(out.verts);
    this.lines = R.createLines(out.lines);

    // JBD (jet blast deflector) - animated panel, hinged at its forward edge
    const jb = new MeshBuilder(hex('#cfe0ff', 0.7), 1.2);
    jb.poly([[-5, 0, 0], [5, 0, 0], [5, 0, 4.2], [-5, 0, 4.2]], hex('#4d545c'));
    for (let x = -4; x <= 4; x += 2) jb.line([x, 0.05, 0.2], [x, 0.05, 4], [0.7, 0.75, 0.8, 0.6], 1);
    const jo = jb.finish();
    this.jbdMesh = R.createMesh(jo.verts);
    this.jbdLines = R.createLines(jo.lines);
    // rotating SPS-48 radar
    const rb = new MeshBuilder(hex('#dfe8ff', 0.9), 1.2);
    rb.poly([[-2.6, 0, 0], [2.6, 0, 0], [2.4, 2.6, 0.5], [-2.4, 2.6, 0.5]], hex('#8a929b'));
    rb.line([0, -1.4, 0], [0, 0, 0], [0.8, 0.85, 0.9, 1], 1.2);
    const ro = rb.finish();
    this.radarMesh = R.createMesh(ro.verts);
    this.radarLines = R.createLines(ro.lines);
    // dynamic lens lights
    this.lensLines = R.createLines(null, 96);
    this.lensData = new Float32Array(96 * 11);
  }

  // which lens cell the ball appears in for an observer at world point `eye`
  ballFor(eye) {
    const g = this.groove(eye);
    // the lens is set up for the pilot's eye: hook-to-eye height ~ 4.3 m on approach
    const err = Math.atan2(g.h - 4.3, Math.max(g.dist, 1)) / DEG - GS_DEG;
    return { err, g };
  }

  wireEnds(k) {
    const s = WIRES_S[k];
    const P = (lat) => [R0[0] + D_ANG[0] * s + U_ANG[0] * lat, DECK_H + 0.15, R0[2] + D_ANG[2] * s + U_ANG[2] * lat];
    return [this.toWorld(P(-WIRE_HALF)), this.toWorld(P(WIRE_HALF))];
  }

  draw(R, eye, onCat, arrest) {
    const M = R.rel(this.q, this.origin());
    R.drawMesh(this.mesh, M);
    R.drawLines(this.lines, M, { bias: 0.0035 });
    // JBD behind catapult 1
    this.jbdCmd = !!onCat;
    const ang = this.jbd * 55 * DEG;
    const ql = qaxis([1, 0, 0], ang);
    const pl = [7, DECK_H + 0.02, this.cat.start[2] + 12];
    const Mj = R.rel(qmul(this.q, ql), this.toWorld(pl));
    R.drawMesh(this.jbdMesh, Mj);
    R.drawLines(this.jbdLines, Mj, { bias: 0.004 });
    // radar
    const qr = qmul(this.q, qaxis([0, 1, 0], this.radarAng));
    const Mr = R.rel(qr, this.toWorld([31.5, DECK_H + 41, 24]));
    R.drawMesh(this.radarMesh, Mr);
    R.drawLines(this.radarLines, Mr);
    // Fresnel lens: datum lights, ball, wave-off lights
    const d = this.lensData;
    let n = 0;
    const push = (p, c, w) => {
      const o = n * 11;
      d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = p[0]; d[o + 4] = p[1]; d[o + 5] = p[2];
      d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = 1; d[o + 10] = w; n++;
    };
    const L0 = [-42, DECK_H + 2.0, 80];
    const along = [Math.cos(ANG), 0, -Math.sin(ANG)];
    for (let i = 1; i <= 5; i++) {
      push(this.toWorld([L0[0], L0[1], L0[2] - along[2] * i * 0.7 + 0]), [0.2, 1, 0.3], 4);
      push(this.toWorld([L0[0], L0[1], L0[2] + along[2] * i * 0.7 + 1.5]), [0.2, 1, 0.3], 4);
    }
    const b = this.ballFor(eye);
    const cell = clamp(Math.round(b.err / 0.25), -6, 6);
    const col = cell <= -4 ? [1, 0.1, 0.05] : [1, 0.65, 0.1];
    push(this.toWorld([L0[0], L0[1] + cell * 0.18, L0[2] + 0.4]), col, 5.5);
    if (this.waveOff && Math.floor(R.time * 4) % 2 === 0) {
      push(this.toWorld([L0[0], L0[1] + 0.9, L0[2] - 1]), [1, 0, 0], 6);
      push(this.toWorld([L0[0], L0[1] + 0.9, L0[2] + 2]), [1, 0, 0], 6);
    }
    // cross-deck pendants (the engaged one is dragged into a V by the hook)
    const seg = (a, b, c, w) => {
      const o = n * 11;
      d[o] = a[0]; d[o + 1] = a[1]; d[o + 2] = a[2]; d[o + 3] = b[0]; d[o + 4] = b[1]; d[o + 5] = b[2];
      d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = c[3]; d[o + 10] = w; n++;
    };
    for (let k = 0; k < WIRES_S.length; k++) {
      const [a, b] = this.wireEnds(k);
      if (arrest && arrest.wire === k && arrest.hook) {
        seg(a, arrest.hook, [0.95, 0.95, 0.9, 1], 1.9);
        seg(arrest.hook, b, [0.95, 0.95, 0.9, 1], 1.9);
      } else seg(a, b, [0.9, 0.9, 0.85, 1], 1.8);
    }
    R.updateLines(this.lensLines, d, n);
    R.drawLines(this.lensLines, R.relWorld(), { bias: 0.004, styleFree: true, wscale: 1 });
  }
}
