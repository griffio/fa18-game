// Low-poly F/A-18C Hornet with animated control surfaces, flaps, gear,
// tailhook and speed brake. Body frame: +X right, +Y up, +Z aft; CG at origin.
import { DEG, hex, lerp, m4, m4mul, m4fromQT, qaxis, vnorm, vsub, clamp } from './math.js';
import { MeshBuilder, ring } from './mesh.js';
import { HOOK } from './flightmodel.js';

const GREY = hex('#a3aab2'), GREY_D = hex('#8c939b'), GREY_L = hex('#b8bec5');
const GLASS = hex('#2a3644'), DARK = hex('#3c4044'), NOZ = hex('#55585c');
const WHITE = hex('#e4e6e8'), BLACK = hex('#202326'), RED = hex('#b02a22');
const EDGE = [0.62, 0.82, 0.98, 0.75];

// wing planform (right side)
const W = { x0: 1.25, x1: 5.6, le0: -1.1, le1: 1.06, te0: 2.95, te1: 2.42 };
const wp = (sx, c, y = 0) => {
  const le = lerp(W.le0, W.le1, sx), te = lerp(W.te0, W.te1, sx);
  return [lerp(W.x0, W.x1, sx), y, le + c * (te - le)];
};
const mirror = (p) => [-p[0], p[1], p[2]];

// rotation about an arbitrary axis through point p
function hinge(p, axis, ang) {
  const a = vnorm(axis);
  const q = qaxis(a, ang);
  const R = m4fromQT(q, [0, 0, 0]);
  const T1 = m4(); T1[12] = p[0]; T1[13] = p[1]; T1[14] = p[2];
  const T0 = m4(); T0[12] = -p[0]; T0[13] = -p[1]; T0[14] = -p[2];
  return m4mul(T1, m4mul(R, T0));
}

// oleo compression: slide a gear leg up its strut by c metres
function lift(c) { const T = m4(); T[13] = c; return T; }
const PARKED_COMP = 0.14;   // static strut compression of a parked jet (CG 2.06 m above the deck)

function part(R, build) {
  const mb = new MeshBuilder(EDGE, 1.2);
  build(mb);
  const o = mb.finish(28);
  return { mesh: R.createMesh(o.verts), lines: R.createLines(o.lines), cpu: o };
}

export class HornetModel {
  constructor(R) {
    this.parts = {};
    const P = this.parts;
    P.body = part(R, (mb) => {
      // fuselage
      const st = [
        [-8.95, 0.04, 0.04, 0.04, -0.05], [-8.3, 0.28, 0.28, 0.28, -0.05], [-7.3, 0.50, 0.48, 0.50, -0.02],
        [-6.2, 0.62, 0.58, 0.64, 0.0], [-5.0, 0.68, 0.64, 0.74, 0.0], [-3.8, 0.78, 0.68, 0.80, 0.0],
        [-2.5, 0.95, 0.70, 0.85, 0.0], [-1.0, 1.15, 0.72, 0.88, 0.0], [1.0, 1.28, 0.70, 0.85, 0.0],
        [3.0, 1.28, 0.66, 0.78, 0.0], [5.0, 1.18, 0.60, 0.68, 0.0], [6.5, 1.06, 0.54, 0.58, 0.0], [7.0, 1.0, 0.5, 0.52, 0.0],
      ];
      const rings = st.map(([z, w, t, b, yc]) => ring(z, w, t, b, yc, 12, 2.4));
      mb.loft(rings.slice(0, 3), GREY_D);
      mb.loft(rings.slice(2), GREY, undefined, true, false, true);
      // canopy + spine
      const can = [[-6.35, 0.05, 0.58], [-5.7, 0.42, 1.12], [-4.7, 0.52, 1.42], [-3.7, 0.50, 1.36], [-2.7, 0.36, 1.05]];
      const arc = (z, w, top, base = 0.55) => {
        const o = [];
        for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI; o.push([Math.cos(a) * w, base + (top - base) * Math.sin(a), z]); }
        return o;
      };
      mb.loft(can.map(([z, w, t]) => arc(z, w, t)), GLASS, [0.6, 0.9, 1, 0.9], false);
      const spine = [[-2.7, 0.36, 1.05], [-1.0, 0.30, 0.86], [2.0, 0.28, 0.78], [4.5, 0.22, 0.7]];
      mb.loft(spine.map(([z, w, t]) => arc(z, w, t, 0.6)), GREY_L, undefined, false);
      // canopy frame
      mb.line([-0.52, 1.0, -5.0], [0.52, 1.0, -5.0], [0.3, 0.35, 0.4, 1], 1.4);
      // LEX
      const lex = [[0.62, 0.1, -6.0], [0.95, 0.1, -4.6], [1.25, 0.08, -3.2], [1.55, 0.05, -2.0], [1.75, 0.03, -1.1], [1.25, 0.03, -1.1], [1.0, 0.1, -2.6], [0.74, 0.1, -4.6]];
      mb.poly(lex, GREY_L); mb.poly(lex.map(mirror), GREY_L);
      // intakes
      for (const s of [-1, 1]) {
        mb.box([s * 1.08, -0.86, -0.3], 0.62, 0.7, 3.2, GREY_D);
        mb.poly([[s * 0.77, -0.86, -1.9], [s * 1.39, -0.86, -1.9], [s * 1.39, -0.16, -1.9], [s * 0.77, -0.16, -1.9]], BLACK);
      }
      // fixed wing panels
      const wingFixed = (m) => {
        const pts = [wp(0, 0.17), wp(1, 0.17), wp(1, 0.74), wp(0.92, 0.74), wp(0.48, 0.74), wp(0, 0.74)];
        mb.poly(m ? pts.map(mirror) : pts, GREY);
        const tip = [wp(0.92, 0.74), wp(1, 0.74), wp(1, 1), wp(0.92, 1)];
        mb.poly(m ? tip.map(mirror) : tip, GREY);
      };
      wingFixed(false); wingFixed(true);
      // missile rails + AIM-9s
      for (const s of [-1, 1]) {
        mb.box([s * 5.68, -0.06, 1.7], 0.12, 0.12, 1.9, GREY_D);
        mb.cylinder([s * 5.82, -0.02, -0.4], [s * 5.82, -0.02, 2.5], 0.07, 0.07, 6, WHITE);
        mb.cylinder([s * 5.82, -0.02, -0.7], [s * 5.82, -0.02, -0.4], 0.0, 0.07, 6, hex('#8a8f94'), undefined, false);
        for (const [fx, fy] of [[0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]]) {
          mb.poly([[s * 5.82, -0.02, 2.0], [s * 5.82 + fx, -0.02 + fy, 2.25], [s * 5.82 + fx, -0.02 + fy, 2.5], [s * 5.82, -0.02, 2.5]], WHITE);
        }
      }
      // vertical tails (canted 20 deg out) - fixed fin part
      for (const s of [-1, 1]) {
        const base = (z) => [s * 1.0, 0.55, z];
        const top = (z) => [s * (1.0 + 3.0 * Math.sin(20 * DEG)), 0.55 + 3.0 * Math.cos(20 * DEG), z];
        const mid = (f, z) => { const b = base(z), t = top(z); return [lerp(b[0], t[0], f), lerp(b[1], t[1], f), z]; };
        // fin: LE root 3.0 -> LE tip 5.3, TE tip 6.6, rudder hinge at root 5.3 up to 60% span
        const fin = [base(3.0), top(5.3), top(6.6), mid(0.62, lerp(6.6, 6.0, 0.38)), mid(0.62, 5.62), base(5.25)];
        mb.poly(fin, GREY);
        // squadron tail flash
        const off = s * 0.03;
        const fl = [mid(0.72, 5.03 + 0.05), mid(0.97, 5.6), mid(0.97, 6.55), mid(0.72, 6.47)].map((p) => [p[0] + off * Math.cos(20 * DEG), p[1] - off * Math.sin(20 * DEG), p[2]]);
        mb.poly(fl, BLACK, null);
        const fl2 = [mid(0.80, 5.25), mid(0.88, 5.42), mid(0.88, 6.52), mid(0.80, 6.5)].map((p) => [p[0] + off * 1.6 * Math.cos(20 * DEG), p[1] - off * 1.6 * Math.sin(20 * DEG), p[2]]);
        mb.poly(fl2, RED, null);
      }
      // nozzles
      for (const s of [-1, 1]) {
        mb.cylinder([s * 0.55, -0.05, 6.9], [s * 0.55, -0.05, 7.85], 0.5, 0.42, 10, NOZ, undefined, false);
        mb.poly(ring(7.84, 0.4, 0.4, 0.4, -0.05, 10, 2).map((p) => [p[0] + s * 0.55, p[1], p[2]]), hex('#1a1a1a', 1), null);
      }
      // gun port + nose details
      mb.line([0.2, 0.32, -7.6], [0.26, 0.3, -7.2], [0.2, 0.2, 0.2, 1], 1.2);
    });

    // movable surfaces (built in body coordinates, rotated about hinge lines)
    const build = (pts) => part(R, (mb) => mb.poly(pts, GREY));
    P.lefR = build([wp(0, 0), wp(1, 0), wp(1, 0.17), wp(0, 0.17)]);
    P.lefL = build([wp(0, 0), wp(1, 0), wp(1, 0.17), wp(0, 0.17)].map(mirror));
    P.tefR = build([wp(0, 0.74), wp(0.48, 0.74), wp(0.48, 1), wp(0, 1)]);
    P.tefL = build([wp(0, 0.74), wp(0.48, 0.74), wp(0.48, 1), wp(0, 1)].map(mirror));
    P.ailR = build([wp(0.48, 0.74), wp(0.92, 0.74), wp(0.92, 1), wp(0.48, 1)]);
    P.ailL = build([wp(0.48, 0.74), wp(0.92, 0.74), wp(0.92, 1), wp(0.48, 1)].map(mirror));
    const stab = [[1.15, -0.1, 5.25], [3.3, -0.17, 7.05], [3.3, -0.17, 7.85], [1.15, -0.1, 7.75]];
    P.stabR = build(stab);
    P.stabL = build(stab.map(mirror));
    for (const s of [-1, 1]) {
      const base = (z) => [s * 1.0, 0.55, z];
      const top = (z) => [s * (1.0 + 3.0 * Math.sin(20 * DEG)), 0.55 + 3.0 * Math.cos(20 * DEG), z];
      const mid = (f, z) => { const b = base(z), t = top(z); return [lerp(b[0], t[0], f), lerp(b[1], t[1], f), z]; };
      P[s > 0 ? 'rudR' : 'rudL'] = build([base(5.25), mid(0.62, 5.62), mid(0.62, lerp(6.6, 6.0, 0.38)), base(6.0)]);
    }
    P.sb = part(R, (mb) => mb.poly([[-0.45, 0.66, 2.6], [0.45, 0.66, 2.6], [0.4, 0.62, 4.2], [-0.4, 0.62, 4.2]], GREY_L));
    // nose gear: strut + twin wheels (extended position)
    P.noseGear = part(R, (mb) => {
      mb.cylinder([0, -0.55, -5.2], [0, -1.86, -5.2], 0.07, 0.07, 6, hex('#cfd2d6'));
      mb.box([0, -1.6, -5.32], 0.18, 0.22, 0.28, hex('#cfd2d6'));
      for (const s of [-1, 1]) mb.cylinder([s * 0.1, -1.86, -5.2], [s * 0.26, -1.86, -5.2], 0.33, 0.33, 10, BLACK);
      mb.poly([[0.02, -0.55, -5.7], [0.02, -0.55, -4.6], [0.02, -1.2, -4.7], [0.02, -1.2, -5.6]], GREY_L); // door
    });
    for (const s of [-1, 1]) {
      P[s > 0 ? 'mainR' : 'mainL'] = part(R, (mb) => {
        mb.cylinder([s * 1.62, -0.5, 0.75], [s * 1.62, -1.7, 0.75], 0.09, 0.09, 6, hex('#cfd2d6'));
        mb.cylinder([s * 1.62, -1.7, 0.75], [s * 1.62, -1.7, 0.95], 0.06, 0.06, 6, hex('#cfd2d6'));
        mb.cylinder([s * 1.48, -1.7, 0.95], [s * 1.80, -1.7, 0.95], 0.5, 0.5, 12, BLACK);
      });
    }
    P.hook = part(R, (mb) => {
      const p0 = HOOK.pivot, L = HOOK.len;
      mb.box([0, p0[1] - 0.06, p0[2] + L / 2], 0.1, 0.12, L, hex('#d8d8d8'));
      mb.box([0, p0[1] - 0.12, p0[2] + L - 0.05], 0.16, 0.18, 0.25, hex('#3a3a3a'));
      for (let z = 0.2; z < L - 0.2; z += 0.36) mb.poly([[0.051, p0[1] - 0.06, p0[2] + z], [0.051, p0[1] - 0.06, p0[2] + z + 0.18], [0.051, p0[1] + 0.06, p0[2] + z + 0.18], [0.051, p0[1] + 0.06, p0[2] + z]], BLACK, null);
    });
    this.flameLines = R.createLines(null, 200);
    this.flameData = new Float32Array(200 * 11);
  }

  // Bake copies of a parked jet (gear down, surfaces neutral, hook stowed) into a
  // single static mesh, so a deck full of aircraft costs two draw calls.
  // placements: [{q, p}] in the parent's frame.
  bakeParked(R, placements) {
    const hookM = hinge(HOOK.pivot, [1, 0, 0], HOOK.up);
    const verts = [], lines = [];
    const xf = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
    for (const { q, p } of placements) {
      const M = m4fromQT(q, p);
      for (const [name, part] of Object.entries(this.parts)) {
        const Mp = name === 'hook' ? m4mul(M, hookM) : /^(noseGear|main[LR])$/.test(name) ? m4mul(M, lift(PARKED_COMP)) : M;
        const v = part.cpu.verts, l = part.cpu.lines;
        for (let i = 0; i < v.length; i += 7) {
          const a = xf(Mp, [v[i], v[i + 1], v[i + 2]]);
          verts.push(a[0], a[1], a[2], v[i + 3], v[i + 4], v[i + 5], v[i + 6]);
        }
        for (let i = 0; i < l.length; i += 11) {
          const a = xf(Mp, [l[i], l[i + 1], l[i + 2]]), b = xf(Mp, [l[i + 3], l[i + 4], l[i + 5]]);
          lines.push(a[0], a[1], a[2], b[0], b[1], b[2], l[i + 6], l[i + 7], l[i + 8], l[i + 9], l[i + 10]);
        }
      }
    }
    return { mesh: R.createMesh(new Float32Array(verts)), lines: R.createLines(new Float32Array(lines)) };
  }

  // s: {de, da, dr, flap (0..1), lef (deg), gear (0..1), hookAng, sb, ab (0..1), N}
  draw(R, q, pos, s, opts = {}) {
    const M = opts.pre ? m4mul(opts.pre, R.rel(q, pos)) : R.rel(q, pos);
    const P = this.parts;
    const tint = opts.tint;
    const drawPart = (p, local) => {
      const m = local ? m4mul(M, local) : M;
      R.drawMesh(p.mesh, m, 1, false, tint);
      if (!tint) R.drawLines(p.lines, m, { bias: 0.006 });
    };
    drawPart(P.body);
    const hingeL = (A, B, ang) => hinge(A, vsub(B, A), ang);
    const lef = -(s.lef || 0) * DEG;
    drawPart(P.lefR, hingeL(wp(0, 0.17), wp(1, 0.17), lef));
    drawPart(P.lefL, hingeL(mirror(wp(0, 0.17)), mirror(wp(1, 0.17)), -lef));
    const tef = (s.flap || 0) * 45 * DEG;
    drawPart(P.tefR, hingeL(wp(0, 0.74), wp(0.48, 0.74), tef));
    drawPart(P.tefL, hingeL(mirror(wp(0, 0.74)), mirror(wp(0.48, 0.74)), -tef));
    const droop = (s.flap || 0) * 30 * DEG;
    const ail = s.da || 0;
    drawPart(P.ailR, hingeL(wp(0.48, 0.74), wp(0.92, 0.74), droop - ail));
    drawPart(P.ailL, hingeL(mirror(wp(0.48, 0.74)), mirror(wp(0.92, 0.74)), -(droop + ail)));
    const de = s.de || 0;
    drawPart(P.stabR, hinge([0, -0.12, 6.4], [1, 0, 0], -de - 0.4 * ail));
    drawPart(P.stabL, hinge([0, -0.12, 6.4], [1, 0, 0], -de + 0.4 * ail));
    const ax = [Math.sin(20 * DEG), Math.cos(20 * DEG), 0];
    const dr = s.dr || 0;
    drawPart(P.rudR, hinge([1.0, 0.55, 5.25], [ax[0], ax[1], 0.12], dr));
    drawPart(P.rudL, hinge([-1.0, 0.55, 5.25], [-ax[0], ax[1], 0.12], dr));
    drawPart(P.sb, hinge([0, 0.66, 2.6], [1, 0, 0], -(s.sb || 0) * 55 * DEG));
    const g = s.gear ?? 1;
    if (g > 0.01) {
      const c = s.strutComp ? s.strutComp() : [0, 0, 0];   // N, L, R
      drawPart(P.noseGear, m4mul(hinge([0, -0.55, -5.2], [1, 0, 0], (1 - g) * 95 * DEG), lift(c[0])));
      drawPart(P.mainR, m4mul(hinge([1.62, -0.5, 0.75], [0, 0, 1], -(1 - g) * 88 * DEG), lift(c[2])));
      drawPart(P.mainL, m4mul(hinge([-1.62, -0.5, 0.75], [0, 0, 1], (1 - g) * 88 * DEG), lift(c[1])));
    }
    drawPart(P.hook, hinge(HOOK.pivot, [1, 0, 0], s.hookAng ?? HOOK.up));
    if (!tint) this.drawFlame(R, M, s);
  }

  drawFlame(R, M, s) {
    const ab = s.ab || 0;
    const N = s.N || 0;
    const d = this.flameData;
    let n = 0;
    const seg = (a, b, c, w) => {
      if (n >= 200) return;
      const o = n * 11;
      d[o] = a[0]; d[o + 1] = a[1]; d[o + 2] = a[2]; d[o + 3] = b[0]; d[o + 4] = b[1]; d[o + 5] = b[2];
      d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = c[3]; d[o + 10] = w; n++;
    };
    const t = R.time;
    for (const sx of [-0.55, 0.55]) {
      // nozzle glow ring (always a little hot)
      const glow = clamp((N - 0.7) * 2, 0, 1) * 0.35 + ab * 0.8;
      if (glow > 0.02) {
        for (let i = 0; i < 10; i++) {
          const a0 = (i / 10) * Math.PI * 2, a1 = ((i + 1) / 10) * Math.PI * 2;
          seg([sx + Math.cos(a0) * 0.38, -0.05 + Math.sin(a0) * 0.38, 7.86], [sx + Math.cos(a1) * 0.38, -0.05 + Math.sin(a1) * 0.38, 7.86], [1, 0.45 + ab * 0.3, 0.15, glow], 2);
        }
      }
      if (ab > 0.02) {
        const len = 2.2 + 3.5 * ab + Math.sin(t * 60 + sx) * 0.25;
        const fl = 0.85 + 0.15 * Math.sin(t * 47 + sx * 3);
        // flame cone
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + t * 3;
          const r0 = 0.36;
          seg([sx + Math.cos(a) * r0, -0.05 + Math.sin(a) * r0, 7.9], [sx + Math.cos(a) * 0.06, -0.05 + Math.sin(a) * 0.06, 7.9 + len], [1, 0.55, 0.2, 0.5 * ab * fl], 2.2);
        }
        // shock diamonds
        for (let k = 1; k <= 4; k++) {
          const z = 7.9 + k * len * 0.2;
          const r = 0.26 * (1 - k * 0.15);
          const c = [0.6, 0.75, 1.0, 0.75 * ab * fl];
          for (let i = 0; i < 6; i++) {
            const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2;
            seg([sx + Math.cos(a0) * r, -0.05 + Math.sin(a0) * r, z], [sx + Math.cos(a1) * r, -0.05 + Math.sin(a1) * r, z], c, 1.8);
          }
        }
        seg([sx, -0.05, 7.9], [sx, -0.05, 7.9 + len * 1.1], [1, 0.9, 0.6, 0.9 * ab], 3.5);
      }
    }
    if (!n) return;
    R.updateLines(this.flameLines, d, n);
    R.drawLines(this.flameLines, M, { bias: 0.002, styleFree: true, add: 1 });
  }
}
