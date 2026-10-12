// Static Bay Area scenery: Golden Gate & Bay Bridges, San Francisco skyline,
// Alcatraz, Sutro Tower, Oakland cranes, airfields, ships - plus the
// collision boxes for everything solid.
import { DEG, hex, lerp, rng, vadd, vscale, vsub, vlen, vnorm, vdot, clamp } from './math.js';
import { MeshBuilder } from './mesh.js';
import { LANDMARKS, RUNWAYS, ll } from './geo.js';

const ORANGE = hex('#c0412e'), ORANGE_E = [1.0, 0.55, 0.35, 0.9];
const STEEL = hex('#8d959e'), STEEL_E = [0.75, 0.9, 1.0, 0.85];
const CONC = hex('#b5b1a8');

export class Scenery {
  constructor(terrain) {
    this.terrain = terrain;
    this.boxes = [];
    this.grid = new Map();
    this.mb = new MeshBuilder([0.75, 0.92, 1.0, 0.8], 1.2);
    this.rand = rng(1988);
    this.goldenGate();
    this.bayBridge();
    this.otherBridges();
    this.city();
    this.alcatraz();
    this.landmarks();
    this.airfields();
    this.ships();
  }

  ground(x, z) { return this.terrain.heightAt(x, z); }

  // oriented box: centre c, unit axes u (length), v (width), up; half-sizes
  addBox(c, u, hl, hw, hh, name) {
    const v = [-u[2], 0, u[0]];
    const b = { c, u, v, h: [hl, hh, hw], name, r: Math.hypot(hl, hw, hh) };
    this.boxes.push(b);
    const C = 1000;
    const x0 = Math.floor((c[0] - b.r) / C), x1 = Math.floor((c[0] + b.r) / C);
    const z0 = Math.floor((c[2] - b.r) / C), z1 = Math.floor((c[2] + b.r) / C);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i + ',' + j;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(b);
    }
  }
  collide(p) {
    const k = Math.floor(p[0] / 1000) + ',' + Math.floor(p[2] / 1000);
    const list = this.grid.get(k);
    if (!list) return null;
    for (const b of list) {
      const d = vsub(p, b.c);
      if (Math.abs(vdot(d, b.u)) < b.h[0] && Math.abs(d[1]) < b.h[1] && Math.abs(vdot(d, b.v)) < b.h[2]) return b.name;
    }
    return null;
  }

  // ---------------------------------------------------------------- Golden Gate
  goldenGate() {
    const mb = this.mb;
    const hdg = 354 * DEG;
    const u = [Math.sin(hdg), 0, -Math.cos(hdg)];
    const v = [-u[2], 0, u[0]];
    const C = [0, 0, 0];
    const W = (a, b, y) => [C[0] + u[0] * a + v[0] * b, y, C[2] + u[2] * a + v[2] * b];
    const DECK = 67, HALF = 14;
    // towers
    for (const a0 of [-640, 640]) {
      for (const b0 of [-HALF, HALF]) {
        const leg = [W(a0 - 5, b0 - 4.5, 0), W(a0 + 5, b0 - 4.5, 0), W(a0 + 5, b0 + 4.5, 0), W(a0 - 5, b0 + 4.5, 0)];
        const top = [W(a0 - 3.5, b0 - 3.5, 227), W(a0 + 3.5, b0 - 3.5, 227), W(a0 + 3.5, b0 + 3.5, 227), W(a0 - 3.5, b0 + 3.5, 227)];
        mb.loft([leg, top], ORANGE, ORANGE_E, true, false, true);
        // art-deco recesses
        mb.line(W(a0 - 5.05, b0, 10), W(a0 - 3.55, b0, 220), [1, 0.6, 0.45, 0.5], 1);
        mb.line(W(a0 + 5.05, b0, 10), W(a0 + 3.55, b0, 220), [1, 0.6, 0.45, 0.5], 1);
      }
      for (const [y0, y1] of [[DECK - 9, DECK - 2], [118, 128], [160, 168], [196, 203], [219, 227]]) {
        const s = [W(a0 - 3.5, -HALF, y0), W(a0 + 3.5, -HALF, y0), W(a0 + 3.5, HALF, y0), W(a0 - 3.5, HALF, y0)];
        const t = s.map((p) => [p[0], y1, p[2]]);
        mb.loft([s, t], ORANGE, ORANGE_E, true, true, true);
      }
      // concrete pier
      const pier = [W(a0 - 25, -30, -2), W(a0 + 25, -30, -2), W(a0 + 25, 30, -2), W(a0 - 25, 30, -2)];
      mb.loft([pier, pier.map((p) => [p[0], 12, p[2]])], CONC, undefined, true, false, true);
      this.addBox(W(a0, 0, 113), u, 6, HALF + 5, 114, 'GOLDEN GATE BRIDGE TOWER');
    }
    // deck (stiffening truss)
    const a0 = -1300, a1 = 1060;
    const deckPts = (y) => [W(a0, -HALF, y), W(a1, -HALF, y), W(a1, HALF, y), W(a0, HALF, y)];
    mb.loft([deckPts(DECK - 7.6), deckPts(DECK)], ORANGE, ORANGE_E, true, true, true);
    this.addBox(W((a0 + a1) / 2, 0, DECK - 3.8), u, (a1 - a0) / 2, HALF, 4.2, 'GOLDEN GATE BRIDGE');
    // truss zig-zag
    for (const b of [-HALF - 0.1, HALF + 0.1]) {
      for (let a = a0; a < a1; a += 15) {
        mb.line(W(a, b, DECK - 7.6), W(a + 7.5, b, DECK), [1, 0.55, 0.4, 0.55], 1);
        mb.line(W(a + 7.5, b, DECK), W(a + 15, b, DECK - 7.6), [1, 0.55, 0.4, 0.55], 1);
      }
    }
    // roadway lanes
    mb.line(W(a0, 0, DECK + 0.05), W(a1, 0, DECK + 0.05), [1, 1, 0.8, 0.5], 1);
    // main cables + suspenders
    const cableY = (a) => {
      const aa = Math.abs(a);
      if (aa <= 640) return 72 + 148 * (a / 640) * (a / 640);
      const t = clamp((aa - 640) / 343, 0, 1);
      return lerp(220, DECK + 3, t) - 16 * 4 * t * (1 - t);
    };
    for (const b of [-HALF, HALF]) {
      const pts = [];
      for (let a = -983; a <= 983; a += 20) pts.push(W(a, b, cableY(a)));
      mb.polyline(pts, [1, 0.5, 0.35, 1], 2.2);
      for (let a = -975; a <= 975; a += 15.2) {
        if (Math.abs(Math.abs(a) - 640) < 6) continue;
        mb.line(W(a, b, cableY(a)), W(a, b, DECK), [1, 0.45, 0.3, 0.45], 0.8);
      }
      // suspender curtains are solid for collision purposes
      for (let a = -960; a < 960; a += 60) {
        const top = Math.min(cableY(a), cableY(a + 60));
        if (top - DECK < 2) continue;
        this.addBox(W(a + 30, b, (DECK + top) / 2), u, 30, 2.0, (top - DECK) / 2, 'GOLDEN GATE CABLES');
      }
    }
    // anchorage blocks
    for (const a of [-1000, 1000]) {
      const g = this.ground(...[W(a, 0, 0)[0], W(a, 0, 0)[2]]);
      const blk = [W(a - 30, -25, g - 5), W(a + 30, -25, g - 5), W(a + 30, 25, g - 5), W(a - 30, 25, g - 5)];
      mb.loft([blk, blk.map((p) => [p[0], DECK + 6, p[2]])], CONC, undefined, true, false, true);
    }
  }

  // ---------------------------------------------------------------- Bay Bridge
  bayBridge() {
    const mb = this.mb;
    const A = LANDMARKS.bayBridgeSF, B = LANDMARKS.bayBridgeYBIW;
    const P0 = [A[0], 0, A[1]], P1 = [B[0], 0, B[1]];
    const L = vlen(vsub(P1, P0));
    const u = vnorm(vsub(P1, P0)), v = [-u[2], 0, u[0]];
    const W = (s, b, y) => [P0[0] + u[0] * s + v[0] * b, y, P0[2] + u[2] * s + v[2] * b];
    const DECK = 60, HALF = 12;
    const deck = (s0, s1, y0, y1, half, thick, col, ecol, name) => {
      const pts = (y, yb) => [W(s0, -half, y), W(s1, -half, yb), W(s1, half, yb), W(s0, half, y)];
      mb.loft([pts(y0 - thick, y1 - thick), pts(y0, y1)], col, ecol, true, true, true);
      const c = W((s0 + s1) / 2, 0, (y0 + y1) / 2 - thick / 2);
      this.addBox(c, u, (s1 - s0) / 2, half, thick / 2 + Math.abs(y1 - y0) / 2 + 1, name);
    };
    deck(-200, L + 150, DECK, DECK, HALF, 10, STEEL, STEEL_E, 'BAY BRIDGE');
    const towers = [0.125, 0.375, 0.625, 0.875].map((f) => f * L);
    const anchors = [0, 0.5 * L, L];
    for (const s0 of towers) {
      for (const b0 of [-HALF, HALF]) {
        const leg = [W(s0 - 4, b0 - 3, 0), W(s0 + 4, b0 - 3, 0), W(s0 + 4, b0 + 3, 0), W(s0 - 4, b0 + 3, 0)];
        mb.loft([leg, leg.map((p) => [p[0], 160, p[2]])], STEEL, STEEL_E, true, false, true);
      }
      for (const y of [30, 95, 130, 155]) {
        const s = [W(s0 - 2, -HALF, y), W(s0 + 2, -HALF, y), W(s0 + 2, HALF, y), W(s0 - 2, HALF, y)];
        mb.loft([s, s.map((p) => [p[0], y + 4, p[2]])], STEEL, STEEL_E, true, true, true);
      }
      // X bracing
      mb.line(W(s0, -HALF, DECK + 5), W(s0, HALF, 125), STEEL_E, 1);
      mb.line(W(s0, HALF, DECK + 5), W(s0, -HALF, 125), STEEL_E, 1);
      this.addBox(W(s0, 0, 80), u, 5, HALF + 4, 81, 'BAY BRIDGE TOWER');
    }
    const ca = W(anchors[1], 0, 0);
    const cblk = [W(0.5 * L - 30, -20, -2), W(0.5 * L + 30, -20, -2), W(0.5 * L + 30, 20, -2), W(0.5 * L - 30, 20, -2)];
    mb.loft([cblk, cblk.map((p) => [p[0], 95, p[2]])], CONC, undefined, true, false, true);
    this.addBox([ca[0], 47, ca[2]], u, 30, 20, 49, 'BAY BRIDGE ANCHORAGE');
    // cables
    for (const b of [-HALF, HALF]) {
      const pts = [];
      const cable = (s) => {
        // piecewise: anchors at 0, L/2, L; towers at .125,.375,.625,.875
        const f = s / L;
        const seg = (fa, fb, ya, yb, sag) => {
          const t = (f - fa) / (fb - fa);
          return lerp(ya, yb, t) - sag * 4 * t * (1 - t);
        };
        if (f < 0.125) return seg(0, 0.125, DECK + 5, 156, 8);
        if (f < 0.375) return seg(0.125, 0.375, 156, 156, 90);
        if (f < 0.5) return seg(0.375, 0.5, 156, DECK + 30, 8);
        if (f < 0.625) return seg(0.5, 0.625, DECK + 30, 156, 8);
        if (f < 0.875) return seg(0.625, 0.875, 156, 156, 90);
        return seg(0.875, 1, 156, DECK + 5, 8);
      };
      for (let s = 0; s <= L; s += L / 120) pts.push(W(s, b, cable(s)));
      mb.polyline(pts, [0.85, 0.95, 1, 0.95], 2);
      for (let s = 15; s < L; s += 18) {
        const cy = cable(s);
        if (cy > DECK + 3) mb.line(W(s, b, cy), W(s, b, DECK), [0.7, 0.85, 1, 0.35], 0.8);
      }
    }
    // East span (1936 cantilever + truss causeway), YBI -> Oakland
    const E0 = LANDMARKS.bayBridgeYBIE, E1 = LANDMARKS.bayBridgeOak;
    const Q0 = [E0[0], 0, E0[1]], Q1 = [E1[0], 0, E1[1]];
    const LE = vlen(vsub(Q1, Q0));
    const ue = vnorm(vsub(Q1, Q0)), ve = [-ue[2], 0, ue[0]];
    const WE = (s, b, y) => [Q0[0] + ue[0] * s + ve[0] * b, y, Q0[2] + ue[2] * s + ve[2] * b];
    const deckY = (s) => (s < 1400 ? DECK : s < 3000 ? lerp(DECK, 22, (s - 1400) / 1600) : lerp(22, 8, (s - 3000) / (LE - 3000)));
    for (let s = 0; s < LE; s += 200) {
      const s1 = Math.min(LE, s + 200);
      const pts = (dy) => [WE(s, -HALF, deckY(s) + dy), WE(s1, -HALF, deckY(s1) + dy), WE(s1, HALF, deckY(s1) + dy), WE(s, HALF, deckY(s) + dy)];
      mb.loft([pts(-8), pts(0)], STEEL, STEEL_E, true, true, true);
      this.addBox(WE((s + s1) / 2, 0, (deckY(s) + deckY(s1)) / 2 - 4), ue, (s1 - s) / 2, HALF, 6 + Math.abs(deckY(s) - deckY(s1)) / 2, 'BAY BRIDGE');
      // piers
      mb.box(WE(s, 0, 0), 12, deckY(s) - 8, 30, CONC, undefined, Math.atan2(ue[0], ue[2]));
    }
    // cantilever truss over the main channel
    const truss = (sa, sb, h, col) => {
      for (const b of [-HALF, HALF]) {
        const top = [], bot = [];
        const n = Math.round((sb - sa) / 25);
        for (let i = 0; i <= n; i++) {
          const s = lerp(sa, sb, i / n);
          const t = i / n;
          const hh = h * (0.55 + 0.45 * Math.abs(Math.cos(t * Math.PI * 2)));
          top.push(WE(s, b, deckY(s) + hh));
          bot.push(WE(s, b, deckY(s)));
          if (i > 0) mb.line(i % 2 ? bot[i - 1] : top[i - 1], i % 2 ? top[i] : bot[i], STEEL_E, 1);
          mb.line(top[i], bot[i], [0.7, 0.85, 1, 0.5], 0.9);
        }
        mb.polyline(top, STEEL_E, 1.6);
      }
      this.addBox(WE((sa + sb) / 2, 0, deckY(sa) + h / 2), ue, (sb - sa) / 2, HALF, h / 2, 'BAY BRIDGE TRUSS');
    };
    truss(80, 1400, 70);
    for (let s = 1400; s < 2900; s += 300) truss(s, s + 290, 28);
  }

  otherBridges() {
    const mb = this.mb;
    const simple = (A, B, prof, name) => {
      const P0 = [A[0], 0, A[1]], P1 = [B[0], 0, B[1]];
      const L = vlen(vsub(P1, P0));
      const u = vnorm(vsub(P1, P0)), v = [-u[2], 0, u[0]];
      const W = (s, b, y) => [P0[0] + u[0] * s + v[0] * b, y, P0[2] + u[2] * s + v[2] * b];
      const step = 150;
      for (let s = 0; s < L; s += step) {
        const s1 = Math.min(L, s + step);
        const y0 = prof(s / L), y1 = prof(s1 / L);
        const pts = (dy) => [W(s, -8, y0 + dy), W(s1, -8, y1 + dy), W(s1, 8, y1 + dy), W(s, 8, y0 + dy)];
        mb.loft([pts(-4), pts(0)], STEEL, STEEL_E, true, true, true);
        mb.line(W(s, 0, 0), W(s, 0, y0 - 4), [0.7, 0.8, 0.9, 0.5], 1.2);
        this.addBox(W((s + s1) / 2, 0, (y0 + y1) / 2 - 2), u, (s1 - s) / 2, 8, 3 + Math.abs(y1 - y0) / 2, name);
      }
    };
    const hump = (centres, h, w, base) => (f) => {
      let y = base;
      for (const c of centres) y = Math.max(y, base + (h - base) * Math.max(0, 1 - Math.abs(f - c) / w));
      return y;
    };
    simple(LANDMARKS.richmondBridgeW, LANDMARKS.richmondBridgeE, hump([0.36, 0.62], 56, 0.08, 22), 'RICHMOND BRIDGE');
    simple(LANDMARKS.sanMateoBridgeW, LANDMARKS.sanMateoBridgeE, hump([0.1], 42, 0.06, 10), 'SAN MATEO BRIDGE');
  }

  // ---------------------------------------------------------------- city
  building(x, z, w, d, h, col, rot = 0, name = 'BUILDING') {
    const g = this.ground(x, z);
    this.mb.box([x, g - 3, z], w, h + 3, d, col, [0.55, 0.68, 0.8, 0.55], rot, 1);
    const u = [Math.cos(rot), 0, -Math.sin(rot)];
    this.addBox([x, g + h / 2, z], u, w / 2, d / 2, h / 2 + 1, name);
    return g;
  }
  city() {
    const r = this.rand;
    const mb = this.mb;
    const pal = [hex('#c9c4b8'), hex('#a9afb6'), hex('#d8d2c4'), hex('#8f979f'), hex('#b8a890')];
    // Financial District
    const [cx, cz] = LANDMARKS.sfCBD;
    const tp = LANDMARKS.transamerica, bofa = LANDMARKS.bofa;
    for (let i = -9; i <= 9; i++) for (let j = -9; j <= 9; j++) {
      const x = cx + i * 62 + (r() - 0.5) * 16, z = cz + j * 62 + (r() - 0.5) * 16;
      const d = Math.hypot(x - cx, z - cz);
      if (d > 620 || r() < 0.25) continue;
      if (Math.hypot(x - tp[0], z - tp[1]) < 60 || Math.hypot(x - bofa[0], z - bofa[1]) < 60) continue;
      if (this.terrain.heightAt(x, z) < 1.5) continue;
      const h = 25 + 165 * Math.exp(-(d * d) / (330 * 330)) * (0.35 + 0.65 * r()) + 10 * r();
      this.building(x, z, 24 + r() * 22, 24 + r() * 22, h, pal[Math.floor(r() * pal.length)], 0, 'SAN FRANCISCO');
    }
    // Transamerica Pyramid
    {
      const [x, z] = tp;
      const g = this.ground(x, z);
      const b = 27;
      const base = [[x - b, g, z - b], [x + b, g, z - b], [x + b, g, z + b], [x - b, g, z + b]];
      const apex = [x, g + 212, z];
      for (let i = 0; i < 4; i++) mb.poly([base[i], base[(i + 1) % 4], apex], hex('#e8e4da'));
      mb.line(apex, [x, g + 260, z], [1, 1, 1, 0.9], 1.4);
      this.addBox([x, g + 100, z], [1, 0, 0], 22, 22, 100, 'TRANSAMERICA PYRAMID');
      this.addBox([x, g + 236, z], [1, 0, 0], 3, 3, 26, 'TRANSAMERICA PYRAMID');
    }
    this.building(bofa[0], bofa[1], 52, 34, 237, hex('#4a3833'), 0, 'BANK OF AMERICA CENTER');
    // Embarcadero Center
    for (let i = 0; i < 4; i++) {
      const [x, z] = ll(37.7950, -122.4000 + i * 0.0016);
      this.building(x, z, 70, 22, 110 + (i === 3 ? 55 : i * 8), hex('#d6d0c2'), 0, 'EMBARCADERO CENTER');
    }
    // Lower city - scattered blocks over SF, Oakland
    const scatter = (lat, lon, rad, n, hmin, hmax, name) => {
      const [x0, z0] = ll(lat, lon);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * rad;
        const x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
        if (this.terrain.heightAt(x, z) < 2) continue;
        const h = hmin + (hmax - hmin) * Math.pow(r(), 2.2) * (1 - d / rad * 0.6);
        this.building(x, z, 20 + r() * 40, 20 + r() * 40, h, pal[Math.floor(r() * pal.length)], 0, name);
      }
    };
    scatter(37.7870, -122.4150, 1700, 70, 15, 70, 'SAN FRANCISCO');
    scatter(37.7700, -122.4400, 3500, 80, 10, 35, 'SAN FRANCISCO');
    const [ox, oz] = LANDMARKS.oaklandCBD;
    for (let k = 0; k < 26; k++) {
      const x = ox + (r() - 0.5) * 900, z = oz + (r() - 0.5) * 900;
      const d = Math.hypot(x - ox, z - oz);
      this.building(x, z, 25 + r() * 25, 25 + r() * 25, 25 + 110 * Math.exp(-d * d / (300 * 300)) * r(), pal[Math.floor(r() * pal.length)], 0, 'OAKLAND');
    }
    scatter(37.8650, -122.2700, 2000, 30, 10, 40, 'BERKELEY');
    scatter(37.5650, -122.3200, 2500, 30, 10, 45, 'SAN MATEO');
  }

  alcatraz() {
    const mb = this.mb;
    const [cx, cz] = LANDMARKS.alcatraz;
    const rot = -30 * DEG;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const k = 1 + 0.1 * Math.sin(a * 3 + 1);
      const x = Math.cos(a) * 280 * k, z = Math.sin(a) * 105 * k;
      out.push([cx + x * Math.cos(rot) - z * Math.sin(rot), cz + x * Math.sin(rot) + z * Math.cos(rot)]);
    }
    const top = out.map(([x, z]) => [cx + (x - cx) * 0.85, cz + (z - cz) * 0.85]);
    const ROCK = hex('#8a7f68'), GRN = hex('#5d7444');
    mb.loft([out.map(([x, z]) => [x, -3, z]), out.map(([x, z]) => [x, 6, z]), top.map(([x, z]) => [x, 38, z])], ROCK);
    mb.poly(top.map(([x, z]) => [x, 38, z]), GRN);
    mb.box([cx, 37, cz], 150, 15, 42, hex('#d9d4c6'), undefined, -rot);
    mb.cylinder([cx - 90, 37, cz + 30], [cx - 90, 62, cz + 30], 2.2, 1.6, 8, hex('#efeee8'));
    mb.point([cx - 90, 63, cz + 30], [1, 1, 0.7, 1], 4);
    this.addBox([cx, 26, cz], [Math.cos(rot), 0, Math.sin(rot)], 250, 95, 26, 'ALCATRAZ');
    this.addBox([cx, 45, cz], [Math.cos(rot), 0, Math.sin(rot)], 75, 21, 9, 'ALCATRAZ');
  }

  landmarks() {
    const mb = this.mb;
    // Coit Tower
    const [kx, kz] = LANDMARKS.coit;
    const kg = this.ground(kx, kz);
    mb.cylinder([kx, kg - 2, kz], [kx, kg + 64, kz], 6, 5.5, 10, hex('#e9e2d0'));
    this.addBox([kx, kg + 32, kz], [1, 0, 0], 6, 6, 33, 'COIT TOWER');
    // Sutro Tower - lattice
    const [sx, sz] = LANDMARKS.sutro;
    const sg = this.ground(sx, sz);
    const RW = [1, 0.35, 0.3, 0.95], WH = [1, 1, 1, 0.9];
    const legs = [0, 1, 2].map((i) => { const a = i * 2 * Math.PI / 3; return [Math.cos(a), Math.sin(a)]; });
    const at = (k, y, r) => [sx + legs[k][0] * r, sg + y, sz + legs[k][1] * r];
    for (let k = 0; k < 3; k++) {
      const pts = [];
      for (let y = 0; y <= 298; y += 18) {
        const r = y < 150 ? lerp(28, 6, y / 150) : 6 + (y > 230 ? 0 : 0);
        pts.push(at(k, y, r));
      }
      mb.polyline(pts, k === 0 ? RW : WH, 1.6);
      for (let i = 0; i < pts.length - 1; i++) {
        const nb = at((k + 1) % 3, i * 18, 0);
        mb.line(pts[i], [pts[i + 1][0] * 0.5 + nb[0] * 0, pts[i + 1][1], pts[i + 1][2]], [0.9, 0.6, 0.6, 0.35], 0.8);
      }
    }
    for (const y of [150, 230, 280]) {
      const r = y === 150 ? 6 : y === 230 ? 28 : 18;
      mb.polyline([at(0, y, r), at(1, y, r), at(2, y, r)], RW, 1.4, true);
    }
    mb.point([sx, sg + 300, sz], [1, 0.1, 0.1, 1], 5);
    this.addBox([sx, sg + 150, sz], [1, 0, 0], 26, 26, 150, 'SUTRO TOWER');
    // Port of Oakland container cranes
    const [px, pz] = LANDMARKS.portOakland;
    for (let i = 0; i < 9; i++) {
      const x = px - 700 + i * 110, z = pz + 250 - i * 40;
      const C = [0.95, 0.75, 0.3, 0.9];
      const leg = (dx, dz) => [x + dx, 5, z + dz];
      const topY = 60;
      for (const [dx, dz] of [[-12, -8], [12, -8], [-12, 8], [12, 8]]) mb.line(leg(dx, dz), [x + dx, topY, z + dz], C, 1.4);
      mb.polyline([[x - 12, topY, z - 8], [x + 12, topY, z - 8], [x + 12, topY, z + 8], [x - 12, topY, z + 8]], C, 1.4, true);
      // boom pointing out over the water
      mb.line([x, topY, z - 8], [x - 10, topY + 4, z - 60], C, 1.6);
      mb.line([x, topY + 20, z], [x - 10, topY + 4, z - 60], C, 1);
      mb.line([x, topY + 20, z], [x, topY, z + 20], C, 1);
      mb.line([x - 12, topY, z], [x, topY + 20, z], C, 1);
      this.addBox([x, 35, z], [1, 0, 0], 13, 9, 35, 'CONTAINER CRANE');
    }
    // Candlestick Park
    const [cx, cz] = LANDMARKS.candlestick;
    const cg = this.ground(cx, cz);
    const ringP = (r, y) => { const o = []; for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; o.push([cx + Math.cos(a) * r * 1.15, cg + y, cz + Math.sin(a) * r]); } return o; };
    mb.loft([ringP(160, 0), ringP(160, 32), ringP(115, 32), ringP(115, 2)], hex('#bfb8a8'));
    mb.poly(ringP(115, 1), hex('#3f7a33'));
  }

  airfields() {
    const mb = this.mb;
    for (const [name, a, b, w] of RUNWAYS) {
      const A = ll(...a), B = ll(...b);
      const d = vnorm([B[0] - A[0], 0, B[1] - A[1]]);
      const n = [-d[2], 0, d[0]];
      const y = Math.max(this.ground(A[0], A[1]), this.ground(B[0], B[1]), this.ground((A[0] + B[0]) / 2, (A[1] + B[1]) / 2)) + 0.08;
      const P = (s, l) => [A[0] + d[0] * s + n[0] * l, y, A[1] + d[2] * s + n[2] * l];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      mb.poly([P(0, -w / 2), P(L, -w / 2), P(L, w / 2), P(0, w / 2)], hex('#45484c'), null);
      const WHT = [1, 1, 1, 0.8];
      mb.line(P(0, -w / 2), P(L, -w / 2), WHT, 1.2);
      mb.line(P(0, w / 2), P(L, w / 2), WHT, 1.2);
      for (let s = 60; s < L - 60; s += 60) mb.line(P(s, 0), P(s + 30, 0), WHT, 1.4);
      for (const s0 of [6, L - 30]) for (let l = -w / 2 + 4; l < w / 2 - 3; l += 3.2) mb.line(P(s0, l), P(s0 + 24, l), WHT, 1.1);
      // approach / edge lights
      for (let s = 0; s <= L; s += 60) { mb.point(P(s, -w / 2 - 1), [1, 1, 0.8, 0.9], 2.2); mb.point(P(s, w / 2 + 1), [1, 1, 0.8, 0.9], 2.2); }
      for (let k = 1; k < 6; k++) { mb.point(P(-k * 60, 0), [1, 1, 1, 0.9], 2.6); mb.point(P(L + k * 60, 0), [1, 1, 1, 0.9], 2.6); }
    }
    // hangars at NAS Alameda
    const [hx, hz] = ll(37.7860, -122.3080);
    for (let i = 0; i < 5; i++) this.building(hx + i * 90, hz - 300 - i * 25, 70, 60, 22, hex('#9aa0a4'), 0, 'NAS ALAMEDA');
    // Moffett Field's Hangar One: the 1933 airship hangar, 345 m long, 94 m wide, 60 m high,
    // lying parallel to the runways
    const [ox, oz] = LANDMARKS.hangarOne;
    const og = this.ground(ox, oz);
    const ah = 338 * DEG, au = [Math.sin(ah), 0, -Math.cos(ah)], av = [-au[2], 0, au[0]];
    const rings = [];
    for (let k = 0; k <= 12; k++) {
      const s = (k / 12 - 0.5) * 345;
      const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s) / 172.5, 6)), 0.5) * 0.85 + 0.15;   // rounded clamshell ends
      const ring = [];
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * Math.PI;
        const l = -Math.cos(a) * 47 * e, y = Math.pow(Math.sin(a), 0.7) * 60 * e;
        ring.push([ox + au[0] * s + av[0] * l, og + y, oz + au[2] * s + av[2] * l]);
      }
      rings.push(ring);
    }
    mb.loft(rings, hex('#b9bec2'), undefined, false, true, true);
    this.addBox([ox, og + 30, oz], au, 172, 47, 31, 'HANGAR ONE');
    const [tx, tz] = LANDMARKS.moffettTower;
    this.building(tx, tz, 9, 9, 32, hex('#d8d4c8'), 0, 'MOFFETT TOWER');
    this.mb.box([tx, this.ground(tx, tz) + 34, tz], 13, 4, 13, hex('#33515f'), [0.55, 0.68, 0.8, 0.55]);
  }

  ships() {
    const mb = this.mb;
    const ship = (lat, lon, hdg, len) => {
      const [x, z] = ll(lat, lon);
      const u = [Math.sin(hdg * DEG), 0, -Math.cos(hdg * DEG)], v = [-u[2], 0, u[0]];
      const W = (a, b, y) => [x + u[0] * a + v[0] * b, y, z + u[2] * a + v[2] * b];
      const hw = len * 0.08;
      const hull = (y, k) => [W(len / 2, 0, y), W(len * 0.38, hw * k, y), W(-len / 2, hw * k, y), W(-len / 2, -hw * k, y), W(len * 0.38, -hw * k, y)];
      mb.loft([hull(-2, 0.95), hull(9, 1)], hex('#5b2a26'), undefined, true, false, true);
      mb.poly(hull(9, 1), hex('#6a6e70'));
      mb.box(W(-len * 0.38, 0, 9), len * 0.1, 14, hw * 1.7, hex('#e6e6e0'), undefined, Math.atan2(u[0], u[2]) + Math.PI / 2);
      for (let k = 0; k < 6; k++) mb.box(W(len * (0.3 - k * 0.1), 0, 9), len * 0.08, 7, hw * 1.6, [hex('#2f6aa3'), hex('#b8462f'), hex('#3d8a54')][k % 3], undefined, Math.atan2(u[0], u[2]) + Math.PI / 2);
      for (let s = 0; s < 400; s += 25) mb.line(W(-len / 2 - s, -hw - s * 0.04, 0.2), W(-len / 2 - s - 18, -hw - (s + 18) * 0.04, 0.2), [0.9, 0.97, 1, 0.45 * (1 - s / 400)], 1.4);
      this.addBox(W(0, 0, 8), u, len / 2, hw, 12, 'CARGO SHIP');
    };
    ship(37.8150, -122.4500, 110, 190);
    ship(37.7700, -122.3500, 200, 160);
    ship(37.8400, -122.3900, 30, 210);
  }

  build(R) {
    const o = this.mb.finish(28);
    this.mesh = R.createMesh(o.verts);
    this.lines = R.createLines(o.lines);
    this.mb = null;
  }
}
