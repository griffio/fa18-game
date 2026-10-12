// MeshBuilder: accumulates flat-shaded polygons and vector line segments.
// Polygons are triangulated (ear clipping, so concave outlines work) and their
// outline edges are collected so that "feature edges" (silhouette creases and
// boundaries) can be emitted as glowing vector lines - the hidden-line
// wireframe look.
import { vsub, vcross, vnorm, vdot, vlen, vadd, vscale, clamp } from './math.js';

const KEY_PREC = 200; // 5 mm
const keyOf = (p) => `${Math.round(p[0] * KEY_PREC)},${Math.round(p[1] * KEY_PREC)},${Math.round(p[2] * KEY_PREC)}`;

export function polyNormal(pts) {
  // Newell's method
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return vnorm([nx, ny, nz]);
}

// Ear clipping triangulation of a simple planar polygon. Returns index triples.
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const nrm = polyNormal(pts);
  const ax = Math.abs(nrm[0]), ay = Math.abs(nrm[1]), az = Math.abs(nrm[2]);
  // project to 2D, dropping dominant axis
  let P;
  if (ax >= ay && ax >= az) P = pts.map((p) => [p[1], p[2]]);
  else if (ay >= az) P = pts.map((p) => [p[2], p[0]]);
  else P = pts.map((p) => [p[0], p[1]]);
  // signed area -> orientation
  let area = 0;
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const ccw = area > 0;
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const tris = [];
  const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => {
    const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = P[i0], b = P[i1], c = P[i2];
      const cr = cross2(a, b, c);
      if (ccw ? cr <= 1e-12 : cr >= -1e-12) continue; // reflex
      let ok = true;
      for (let j = 0; j < idx.length; j++) {
        const k = idx[j];
        if (k === i0 || k === i1 || k === i2) continue;
        if (inTri(P[k], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate; fall back to fan for the rest
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  else if (idx.length > 3) for (let i = 1; i < idx.length - 1; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  return tris;
}

export class MeshBuilder {
  constructor(edgeColor = [0.7, 0.9, 1.0, 0.9], edgeWidth = 1.4) {
    this.v = [];            // x,y,z, r,g,b, lit
    this.l = [];            // ax,ay,az, bx,by,bz, r,g,b,a, width
    this.edges = new Map();
    this.edgeColor = edgeColor;
    this.edgeWidth = edgeWidth;
    this.xf = null;         // optional point transform function
  }
  _x(p) { return this.xf ? this.xf(p) : p; }

  // pts: [[x,y,z]...]; col: [r,g,b]; edge: undefined=default, null=none, or [r,g,b,a]
  poly(ptsIn, col, edge, lit = 1) {
    const pts = ptsIn.map((p) => this._x(p));
    const tris = triangulate(pts);
    for (const t of tris) for (const i of t) this.v.push(pts[i][0], pts[i][1], pts[i][2], col[0], col[1], col[2], lit);
    if (edge !== null) {
      const ec = edge || this.edgeColor;
      const n = polyNormal(pts);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (vlen(vsub(a, b)) < 1e-4) continue;
        const ka = keyOf(a), kb = keyOf(b);
        const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        let e = this.edges.get(key);
        if (!e) { e = { a, b, n: [], c: ec }; this.edges.set(key, e); }
        e.n.push(n);
      }
    }
  }
  quad(a, b, c, d, col, edge, lit) { this.poly([a, b, c, d], col, edge, lit); }
  tri(a, b, c, col, edge, lit) { this.poly([a, b, c], col, edge, lit); }

  line(a, b, col, w = this.edgeWidth) {
    const A = this._x(a), B = this._x(b);
    this.l.push(A[0], A[1], A[2], B[0], B[1], B[2], col[0], col[1], col[2], col[3] ?? 1, w);
  }
  polyline(pts, col, w, closed = false) {
    for (let i = 0; i < pts.length - 1; i++) this.line(pts[i], pts[i + 1], col, w);
    if (closed && pts.length > 2) this.line(pts[pts.length - 1], pts[0], col, w);
  }
  point(p, col, size) { this.line(p, p, col, size); }

  // axis-aligned (optionally Y-rotated) box. c = centre of bottom face.
  box(c, sx, sy, sz, col, edge, rotY = 0, lit = 1, colTop) {
    const hx = sx / 2, hz = sz / 2;
    const cs = Math.cos(rotY), sn = Math.sin(rotY);
    const P = (x, y, z) => [c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs];
    const b = [P(-hx, 0, -hz), P(hx, 0, -hz), P(hx, 0, hz), P(-hx, 0, hz)];
    const t = [P(-hx, sy, -hz), P(hx, sy, -hz), P(hx, sy, hz), P(-hx, sy, hz)];
    this.poly([t[0], t[1], t[2], t[3]], colTop || col, edge, lit);
    this.poly([b[3], b[2], b[1], b[0]], col, edge, lit);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.poly([b[i], b[j], t[j], t[i]], col, edge, lit);
    }
  }
  // extrude XZ outline between y0 and y1
  prism(outline, y0, y1, col, edge, lit = 1, colTop, noBottom = false) {
    const n = outline.length;
    const bot = outline.map((p) => [p[0], y0, p[1]]);
    const top = outline.map((p) => [p[0], y1, p[1]]);
    this.poly(top, colTop || col, edge, lit);
    if (!noBottom) this.poly(bot.slice().reverse(), col, edge, lit);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.poly([bot[i], bot[j], top[j], top[i]], col, edge, lit);
    }
  }
  // loft between rings of equal point count
  loft(rings, col, edge, closed = true, capStart = false, capEnd = false, lit = 1) {
    const m = rings[0].length;
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      const lim = closed ? m : m - 1;
      for (let i = 0; i < lim; i++) {
        const j = (i + 1) % m;
        const q = [A[i], A[j], B[j], B[i]];
        // drop degenerate corners (e.g. pointed nose)
        const uniq = [];
        for (const p of q) if (!uniq.some((u) => vlen(vsub(u, p)) < 1e-4)) uniq.push(p);
        if (uniq.length >= 3) this.poly(uniq, col, edge, lit);
      }
    }
    if (capStart) this.poly(rings[0].slice().reverse(), col, edge, lit);
    if (capEnd) this.poly(rings[rings.length - 1], col, edge, lit);
  }
  cylinder(p0, p1, r0, r1, n, col, edge, caps = true, lit = 1) {
    const d = vnorm(vsub(p1, p0));
    let u = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const s = vnorm(vcross(d, u)); u = vcross(s, d);
    const ring = (p, r) => {
      const o = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        o.push(vadd(p, vadd(vscale(s, Math.cos(a) * r), vscale(u, Math.sin(a) * r))));
      }
      return o;
    };
    this.loft([ring(p0, r0), ring(p1, r1)], col, edge, true, caps, caps, lit);
  }

  // convert collected polygon edges into vector lines
  buildEdges(angleDeg = 25) {
    const cosT = Math.cos(angleDeg * Math.PI / 180);
    for (const e of this.edges.values()) {
      let draw = e.n.length !== 2;
      // winding is not guaranteed consistent, so compare |dot| (coplanar = smooth)
      if (!draw) draw = Math.abs(vdot(e.n[0], e.n[1])) < cosT;
      if (draw) this.l.push(e.a[0], e.a[1], e.a[2], e.b[0], e.b[1], e.b[2], e.c[0], e.c[1], e.c[2], e.c[3] ?? 1, this.edgeWidth);
    }
    this.edges.clear();
    return this;
  }

  merge(other) {
    for (const x of other.v) this.v.push(x);
    for (const x of other.l) this.l.push(x);
    return this;
  }

  // apply transform to everything already accumulated (used to position parts)
  transformAll(fn) {
    for (let i = 0; i < this.v.length; i += 7) {
      const p = fn([this.v[i], this.v[i + 1], this.v[i + 2]]);
      this.v[i] = p[0]; this.v[i + 1] = p[1]; this.v[i + 2] = p[2];
    }
    for (let i = 0; i < this.l.length; i += 11) {
      const a = fn([this.l[i], this.l[i + 1], this.l[i + 2]]);
      const b = fn([this.l[i + 3], this.l[i + 4], this.l[i + 5]]);
      this.l[i] = a[0]; this.l[i + 1] = a[1]; this.l[i + 2] = a[2];
      this.l[i + 3] = b[0]; this.l[i + 4] = b[1]; this.l[i + 5] = b[2];
    }
    return this;
  }

  finish(angleDeg = 25) {
    if (this.edges.size) this.buildEdges(angleDeg);
    return { verts: new Float32Array(this.v), lines: new Float32Array(this.l) };
  }
}

// Ring helper for fuselage-like lofts: superellipse cross-section in the XY plane at z.
export function ring(z, w, top, bot, yc = 0, n = 12, e = 2.4) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const x = w * Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
    const yy = Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
    out.push([x, yc + yy * (s > 0 ? top : bot), z]);
  }
  return out;
}
export { clamp };
