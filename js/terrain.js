// Terrain: a 400 m height grid of the Bay Area generated from coastline
// signed-distance fields plus named peaks, rendered as flat-shaded facets with
// vector coastline, contour and grid lines laid exactly on the surface.
import { GRID, OCEAN, BAY, ISLANDS, PEAKS, URBAN, PARKS, AIRFIELDS, RUNWAYS, ll } from './geo.js';
import { smoothstep, fbm2, clamp, lerp } from './math.js';
import { MeshBuilder } from './mesh.js';

function sdPoly(px, pz, poly) {
  let inside = false, dmin = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi, ez = zj - zi;
    const t = clamp(((px - xi) * ex + (pz - zi) * ez) / (ex * ex + ez * ez), 0, 1);
    const dx = px - (xi + ex * t), dz = pz - (zi + ez * t);
    const d = dx * dx + dz * dz;
    if (d < dmin) dmin = d;
  }
  const d = Math.sqrt(dmin);
  return inside ? d : -d;
}
function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// signed distance to land (positive on land)
export function landSD(x, z) {
  let water = Math.max(sdPoly(x, z, OCEAN), sdPoly(x, z, BAY));
  for (const isl of ISLANDS) water = Math.min(water, -sdPoly(x, z, isl));
  return -water;
}

const peaks = PEAKS.map(([la, lo, h, r]) => { const [x, z] = ll(la, lo); return { x, z, h, r }; });
const urban = URBAN.map(([la, lo, r]) => { const [x, z] = ll(la, lo); return { x, z, r }; });
const fields = AIRFIELDS.map(([la, lo, r]) => { const [x, z] = ll(la, lo); return { x, z, r }; });
// runway strips: flat out to more than one terrain cell diagonal (400 m grid) from the
// edges, so every terrain triangle under a runway is level with it
const strips = RUNWAYS.map(([, a, b, w]) => { const A = ll(...a), B = ll(...b); return { A, B, w }; });
const STRIP_FLAT = 600, STRIP_FADE = 950;
function stripDist(x, z, s) {
  const dx = s.B[0] - s.A[0], dz = s.B[1] - s.A[1];
  const t = clamp(((x - s.A[0]) * dx + (z - s.A[1]) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - s.A[0] - dx * t, z - s.A[1] - dz * t) - s.w / 2;
}

export function terrainHeightAt(x, z, sd) {
  let h = sd < 0 ? Math.max(sd * 0.012, -45) : landHeight(x, z, sd);
  // airfields are flat and always dry (SFO and Alameda sit on bay fill)
  for (const f of fields) {
    const d = Math.hypot(x - f.x, z - f.z);
    if (d < f.r) h = lerp(h, 3.5, smoothstep(f.r, f.r * 0.75, d));
  }
  for (const s of strips) {
    const d = stripDist(x, z, s);
    if (d < STRIP_FADE) h = lerp(h, 3.5, smoothstep(STRIP_FADE, STRIP_FLAT, d));
  }
  return h;
}
function landHeight(x, z, sd) {
  let h = Math.min(sd * 0.012, 10);
  // named peaks, combined with a soft maximum
  let acc = 0;
  for (const p of peaks) {
    const dx = (x - p.x) / p.r, dz = (z - p.z) / p.r;
    const d2 = dx * dx + dz * dz;
    if (d2 > 9) continue;
    const v = p.h * Math.exp(-d2 * 1.5);
    acc += v * v * v;
  }
  let hills = Math.cbrt(acc);
  const rough = fbm2(x / 2200, z / 2200, 4);
  hills *= 1 + 0.38 * rough;
  hills += Math.max(0, 22 * (fbm2(x / 1300 + 7, z / 1300 - 3, 3) + 0.35));
  const coast = smoothstep(-60, 450, sd);
  h += Math.max(0, hills) * coast;
  return h;
}

function materialAt(x, z, h, sd) {
  for (const f of fields) if (Math.hypot(x - f.x, z - f.z) < f.r * 0.8) return 2;
  for (const s of strips) if (stripDist(x, z, s) < STRIP_FLAT) return 2;
  if (sd < 0) return 0;
  for (const p of PARKS) if (pointInPoly(x, z, p)) return 3;
  if (h < 170) {
    for (const u of urban) {
      const d = Math.hypot(x - u.x, z - u.z) / u.r;
      if (d < 1 && fbm2(x / 900, z / 900, 2) * 0.5 + (1 - d) > 0.35) return 1;
    }
  }
  return 0;
}

export class Terrain {
  constructor() {
    const { x0, z0, x1, z1, cell } = GRID;
    this.x0 = x0; this.z0 = z0; this.cell = cell;
    this.nx = Math.round((x1 - x0) / cell) + 1;
    this.nz = Math.round((z1 - z0) / cell) + 1;
    const N = this.nx * this.nz;
    this.h = new Float32Array(N);
    this.mat = new Float32Array(N);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        const sd = landSD(x, z);
        let h = terrainHeightAt(x, z, sd);
        // fade to a plain at the grid border so it meets the outer skirt
        const edge = Math.min(i, j, this.nx - 1 - i, this.nz - 1 - j) * cell;
        if (h > 0) h = lerp(10, h, smoothstep(0, 5000, edge));
        const k = j * this.nx + i;
        this.h[k] = h;
        this.mat[k] = materialAt(x, z, h, sd);
      }
    }
  }

  // exact height of the rendered triangle surface
  heightAt(x, z) {
    const fx = (x - this.x0) / this.cell, fz = (z - this.z0) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.nx - 1 || fz >= this.nz - 1) return outsideHeight(x, z);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const k = j * this.nx + i;
    const h00 = this.h[k], h10 = this.h[k + 1], h01 = this.h[k + this.nx], h11 = this.h[k + this.nx + 1];
    if (v >= u) return h00 + (h11 - h01) * u + (h01 - h00) * v;
    return h00 + (h10 - h00) * u + (h11 - h10) * v;
  }
  normalAt(x, z) {
    const e = 5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const n = [-hx / (2 * e), 1, -hz / (2 * e)];
    const l = Math.hypot(n[0], n[1], n[2]);
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  buildGL(renderer) {
    const { nx, nz, cell, x0, z0 } = this;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = x0 + i * cell; pos[k * 3 + 1] = this.h[k]; pos[k * 3 + 2] = z0 + j * cell;
    }
    const idx = [];
    const H = this.h;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (H[a] < -3 && H[b] < -3 && H[c] < -3 && H[d] < -3) continue;
      idx.push(a, c, d, a, d, b);
    }
    this.gl = renderer.createTerrain(pos, this.mat, new Uint32Array(idx));
    this.lines = renderer.createLines(this._buildLines(idx));
    const sk = this._buildSkirt();
    this.skirtMesh = renderer.createMesh(sk.verts);
    this.skirtLines = renderer.createLines(sk.lines);
  }

  _buildLines(idx) {
    const out = [];
    const { nx, cell, x0, z0, h: H } = this;
    const P = (k) => [x0 + (k % nx) * cell, H[k], z0 + Math.floor(k / nx) * cell];
    const push = (a, b, c, w) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], c[3], w);
    const COAST = [0.55, 1.0, 0.95, 0.95];
    const levels = [];
    for (let L = 100; L <= 1200; L += 100) levels.push(L);
    const contourCol = (L) => (L % 500 === 0 ? [1.0, 0.85, 0.45, 0.55] : [0.85, 0.78, 0.45, 0.32]);
    for (let t = 0; t < idx.length; t += 3) {
      const ka = idx[t], kb = idx[t + 1], kc = idx[t + 2];
      const A = P(ka), B = P(kb), C = P(kc);
      const lo = Math.min(A[1], B[1], C[1]), hi = Math.max(A[1], B[1], C[1]);
      const cut = (L, col, w) => {
        const pts = [];
        for (const [p, q] of [[A, B], [B, C], [C, A]]) {
          if ((p[1] - L) * (q[1] - L) < 0) {
            const f = (L - p[1]) / (q[1] - p[1]);
            pts.push([p[0] + (q[0] - p[0]) * f, L, p[2] + (q[2] - p[2]) * f]);
          }
        }
        if (pts.length === 2) push(pts[0], pts[1], col, w);
      };
      if (lo < 0 && hi > 0) cut(0.0, COAST, 1.8);
      for (const L of levels) if (lo < L && hi > L) cut(L, contourCol(L), L % 500 === 0 ? 1.3 : 1.0);
    }
    // sparse surface grid over land (every 2 cells = 800 m)
    const G = [0.55, 0.95, 0.5, 0.22];
    for (let j = 0; j < this.nz; j += 2) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1;
      if (H[a] > 0.8 && H[b] > 0.8) push(P(a), P(b), G, 1.0);
    }
    for (let i = 0; i < nx; i += 2) for (let j = 0; j < this.nz - 1; j++) {
      const a = j * nx + i, b = a + nx;
      if (H[a] > 0.8 && H[b] > 0.8) push(P(a), P(b), G, 1.0);
    }
    return new Float32Array(out);
  }

  _buildSkirt() {
    const mb = new MeshBuilder([0.55, 0.95, 0.5, 0.3], 1.0);
    const LAND = [0.30, 0.55, 0.22];
    const Y = 10;
    const nw = [[-40000, -20000], [-47000, -20000], [-47000, -25000], [-43000, -31000], [-49000, -48000],
      [-80000, -120000], [-60000, -260000], [260000, -260000], [260000, -40000], [-40000, -40000]];
    const se = [[64000, -40000], [260000, -40000], [260000, 260000], [60000, 260000], [40000, 96000],
      [14000, 80000], [9000, 62000], [7000, 52000], [64000, 52000]];
    mb.poly(nw.map(([x, z]) => [x, Y, z]), LAND, null);
    mb.poly(se.map(([x, z]) => [x, Y, z]), LAND, null);
    // distant ranges
    const mtn = (la, lo, h, r, seed) => {
      const [cx, cz] = ll(la, lo);
      const n = 11;
      const ring = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + seed;
        const rr = r * (0.75 + 0.5 * Math.abs(Math.sin(seed * 3.1 + i * 1.7)));
        ring.push([cx + Math.cos(a) * rr, Y, cz + Math.sin(a) * rr]);
      }
      const mid = ring.map((p, i) => {
        const a = (i / n) * Math.PI * 2 + seed + 0.3;
        const rr = r * 0.45 * (0.8 + 0.4 * Math.abs(Math.cos(seed + i * 2.3)));
        return [cx + Math.cos(a) * rr, Y + h * (0.55 + 0.15 * Math.sin(i + seed)), cz + Math.sin(a) * rr];
      });
      const top = [cx + r * 0.08, Y + h, cz - r * 0.05];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        mb.poly([ring[i], ring[j], mid[j], mid[i]], [0.42, 0.50, 0.28]);
        mb.poly([mid[i], mid[j], top], [0.55, 0.48, 0.34]);
      }
    };
    mtn(38.669, -122.633, 1320, 9000, 1);     // Mt St Helena
    mtn(38.330, -122.550, 700, 7000, 2);      // Sonoma Mtn
    mtn(38.400, -122.300, 800, 9000, 3);      // Mayacamas
    mtn(37.341, -121.643, 1280, 10000, 4);    // Mt Hamilton
    mtn(37.700, -121.700, 520, 11000, 5);     // Altamont
    mtn(37.111, -121.842, 1150, 9000, 6);     // Loma Prieta
    mtn(37.200, -122.150, 800, 9000, 7);      // Ben Lomond
    mtn(38.050, -121.850, 450, 9000, 8);
    return mb.finish(30);
  }
}

function outsideHeight(x, z) {
  if (x < -40000 && z > -20000) return -45;
  if (z > 52000 && x < 7000 + (z - 52000) * 0.35) return -45;
  if (x < -40000 && x < -47000) return -45;
  return 10;
}
