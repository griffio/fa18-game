// Cockpit instrument panel: two DDIs (tactical map + ADI/FCS), engine & fuel
// display, AoA indexer, gear/flap/hook lights, master caution, throttle.
import { DEG, RAD, KT, FT, NM, clamp, wrap360, vsub, vlen, lerp } from './math.js';
import { OCEAN, BAY, ISLANDS, RUNWAYS, LANDMARKS, ll } from './geo.js';

const G = [0.35, 1, 0.45, 1], GD = [0.3, 0.9, 0.4, 0.45], W = [0.85, 0.95, 1, 0.95];
const AMB = [1, 0.7, 0.15, 1], RED = [1, 0.22, 0.15, 1], CYAN = [0.4, 0.9, 1, 0.9];

function clipR(x1, y1, x2, y2, r) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy], q = [x1 - r.x0, r.x1 - x1, y1 - r.y0, r.y1 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [x1 + dx * t0, y1 + dy * t0, x1 + dx * t1, y1 + dy * t1];
}

// map features in world metres (x, z)
const COAST = [OCEAN, BAY, ...ISLANDS];
const BRIDGES = [
  [LANDMARKS.goldenGate, null],
  [LANDMARKS.bayBridgeSF, LANDMARKS.bayBridgeYBIW], [LANDMARKS.bayBridgeYBIE, LANDMARKS.bayBridgeOak],
  [LANDMARKS.richmondBridgeW, LANDMARKS.richmondBridgeE], [LANDMARKS.sanMateoBridgeW, LANDMARKS.sanMateoBridgeE],
];

export class Cockpit {
  constructor(d2) { this.d = d2; this.range = 20; this.mapPage = 0; }

  height(H) { return Math.round(H * 0.3); }

  draw(R, g) {
    const d = this.d, ac = g.ac;
    const Wd = R.cssW, H = R.cssH;
    const ph = this.height(H);
    const y0 = H - ph;
    const BODY = [0.11, 0.125, 0.14, 1], BEV = [0.28, 0.31, 0.35, 1];
    // glareshield hump + panel
    const gx0 = Wd * 0.3, gx1 = Wd * 0.7, gh = H * 0.035;
    const shape = [[0, y0 + 8], [gx0 - 30, y0 + 8], [gx0, y0 - gh], [gx1, y0 - gh], [gx1 + 30, y0 + 8], [Wd, y0 + 8], [Wd, H], [0, H]];
    d.fill([shape[0], shape[1], shape[6], shape[7]], BODY);
    d.fill([shape[1], shape[4], [gx1 + 30, H], [gx0 - 30, H]], BODY);
    d.fill([shape[1], shape[2], shape[3], shape[4]], BODY);
    d.fill([shape[4], shape[5], shape[6], [gx1 + 30, H]], BODY);
    d.poly(shape.slice(0, 6), BEV, 2);
    d.poly([[0, y0 + 11], [gx0 - 28, y0 + 11], [gx0 + 2, y0 - gh + 3], [gx1 - 2, y0 - gh + 3], [gx1 + 28, y0 + 11], [Wd, y0 + 11]], [0.05, 0.06, 0.07, 1], 1);
    // canopy bow & windscreen frame
    const CF = [0.16, 0.18, 0.2, 1];
    d.line(gx0, y0 - gh, gx0 - Wd * 0.12, 0, CF, 6);
    d.line(gx1, y0 - gh, gx1 + Wd * 0.12, 0, CF, 6);
    // HUD combiner frame
    const hc = Wd / 2;
    d.poly([[hc - Wd * 0.12, y0 - gh], [hc - Wd * 0.13, y0 - gh - H * 0.06], [hc + Wd * 0.13, y0 - gh - H * 0.06], [hc + Wd * 0.12, y0 - gh]], [0.4, 0.5, 0.5, 0.35], 1.5);

    const s = Math.min(ph * 0.82, Wd * 0.22);
    const dy = y0 + ph * 0.5 + 4;
    this.ddi(Wd * 0.18, dy, s, 'L', (r) => this.mapPageDraw(r, g));
    this.ddi(Wd * 0.82, dy, s, 'R', (r) => this.adiPage(r, g));
    const ew = Math.min(Wd * 0.2, ph * 1.2);
    this.engineDisplay(Wd * 0.5, y0 + ph * 0.22, ew, ph * 0.66, g);
    this.indexer(Wd * 0.5 - Wd * 0.16, y0 - gh * 0.5, g);
    this.lights(Wd * 0.5 + Wd * 0.16, y0 - gh * 0.5, g);
    // gear / flap / hook panel fits between the left DDI and the engine display
    const lx0 = Wd * 0.18 + s / 2 + 22, lx1 = Wd * 0.5 - ew / 2 - 8;
    this.gearPanel(lx0, lx1, y0 + ph * 0.3, g);
    const rx0 = Wd * 0.5 + ew / 2 + 8, rx1 = Wd * 0.82 - s / 2 - 22;
    this.throttle((rx0 + rx1) / 2, y0 + ph * 0.18, ph * 0.66, g);
  }

  ddi(cx, cy, s, side, content) {
    const d = this.d;
    const x = cx - s / 2, y = cy - s / 2;
    d.fillRect(x - 14, y - 14, s + 28, s + 28, [0.07, 0.08, 0.09, 1]);
    d.rect(x - 14, y - 14, s + 28, s + 28, [0.3, 0.33, 0.37, 1], 1.5);
    d.fillRect(x, y, s, s, [0.0, 0.02, 0.01, 1]);
    for (let i = 0; i < 5; i++) {
      const o = s * (0.15 + i * 0.175);
      for (const [bx, by, bw, bh] of [[x + o - 5, y - 11, 10, 7], [x + o - 5, y + s + 4, 10, 7], [x - 11, y + o - 5, 7, 10], [x + s + 4, y + o - 5, 7, 10]]) d.rect(bx, by, bw, bh, [0.35, 0.38, 0.42, 1], 1);
    }
    content({ x0: x + 3, y0: y + 3, x1: x + s - 3, y1: y + s - 3, cx, cy, s });
  }

  mapPageDraw(r, g) {
    const d = this.d, ac = g.ac, cv = g.cv;
    const e = ac.eulers;
    const hdg = e.hdg;
    const ox = r.cx, oy = r.y0 + (r.y1 - r.y0) * 0.68;
    const scale = (r.s * 0.6) / (this.range * NM);
    const cs = Math.cos(-hdg), sn = Math.sin(-hdg);
    const tr = (x, z) => {
      const dx = x - ac.pos[0], dz = z - ac.pos[2];
      const rx = dx * cs - dz * sn, rz = dx * sn + dz * cs;
      return [ox + rx * scale, oy + rz * scale];
    };
    const L = (a, b, c, w = 1.2) => { const k = clipR(a[0], a[1], b[0], b[1], r); if (k) d.line(k[0], k[1], k[2], k[3], c, w); };
    for (const poly of COAST) {
      let prev = tr(poly[poly.length - 1][0], poly[poly.length - 1][1]);
      for (const [x, z] of poly) { const p = tr(x, z); L(prev, p, CYAN, 1.2); prev = p; }
    }
    for (const [name, a, b] of RUNWAYS) {
      const A = ll(...a), B = ll(...b);
      L(tr(A[0], A[1]), tr(B[0], B[1]), W, 1.6);
    }
    const gg = 354 * DEG;
    L(tr(Math.sin(gg) * -1000, Math.cos(gg) * 1000), tr(Math.sin(gg) * 1000, -Math.cos(gg) * 1000), [1, 0.5, 0.3, 1], 2);
    for (const [a, b] of BRIDGES.slice(1)) L(tr(a[0], a[1]), tr(b[0], b[1]), [0.8, 0.85, 0.9, 1], 1.6);
    // range ring + compass
    d.circle(ox, oy, r.s * 0.3, GD, 1, 40);
    for (let k = 0; k < 36; k++) {
      const a = k * 10 * DEG - hdg - Math.PI / 2;
      const rr = r.s * 0.6, l = k % 3 === 0 ? 8 : 4;
      const p1 = [ox + Math.cos(a) * rr, oy + Math.sin(a) * rr], p2 = [ox + Math.cos(a) * (rr - l), oy + Math.sin(a) * (rr - l)];
      L(p1, p2, G, 1.2);
      if (k % 9 === 0) {
        const p = [ox + Math.cos(a) * (rr - 18), oy + Math.sin(a) * (rr - 18)];
        if (p[1] > r.y0 + 6 && p[1] < r.y1 - 10 && p[0] > r.x0 + 6 && p[0] < r.x1 - 6) d.text('NESW'[k / 9], p[0], p[1] - 5, 10, G, 'center');
      }
    }
    // carrier
    if (cv) {
      const p = tr(cv.pos[0], cv.pos[2]);
      if (p[0] > r.x0 && p[0] < r.x1 && p[1] > r.y0 && p[1] < r.y1) {
        const h = cv.hdg - hdg;
        const c = Math.cos(h), s = Math.sin(h);
        const sh = [[0, -9], [4, -4], [4, 8], [-4, 8], [-4, -4]].map(([x, y]) => [p[0] + x * c - y * s, p[1] + x * s + y * c]);
        d.poly(sh, AMB, 1.6, true);
        d.text('CV', p[0] + 9, p[1] - 4, 10, AMB);
      } else {
        const a = Math.atan2(p[1] - oy, p[0] - ox);
        const q = [ox + Math.cos(a) * r.s * 0.42, oy + Math.sin(a) * r.s * 0.42];
        d.poly([[q[0] + Math.cos(a) * 8, q[1] + Math.sin(a) * 8], [q[0] + Math.cos(a + 2.5) * 6, q[1] + Math.sin(a + 2.5) * 6], [q[0] + Math.cos(a - 2.5) * 6, q[1] + Math.sin(a - 2.5) * 6]], AMB, 1.5, true);
      }
    }
    // ownship
    d.poly([[ox, oy - 9], [ox, oy + 7]], W, 2);
    d.poly([[ox - 7, oy - 1], [ox + 7, oy - 1]], W, 2);
    d.poly([[ox - 3, oy + 6], [ox + 3, oy + 6]], W, 2);
    // labels
    d.text('SA', r.x0 + 6, r.y0 + 6, 11, G);
    d.text(String(this.range), r.x1 - 6, r.y0 + 6, 11, G, 'right');
    d.text(String(Math.round(wrap360(hdg * RAD))).padStart(3, '0'), r.cx, r.y0 + 6, 12, G, 'center');
    if (cv) {
      const dv = vsub(cv.pos, ac.pos);
      const brg = wrap360(Math.atan2(dv[0], -dv[2]) * RAD);
      d.text('CV ' + String(Math.round(brg)).padStart(3, '0') + '/' + (vlen(dv) / NM).toFixed(1), r.x0 + 6, r.y1 - 16, 10, AMB);
    }
    d.text('[ ] RNG', r.x1 - 6, r.y1 - 16, 9, GD, 'right');
  }

  adiPage(r, g) {
    const d = this.d, ac = g.ac;
    const e = ac.eulers;
    const cx = r.cx, cy = r.y0 + (r.y1 - r.y0) * 0.4;
    const ppd = r.s * 0.012;
    const rr = { x0: r.x0 + 10, x1: r.x1 - 10, y0: r.y0 + 10, y1: r.y0 + r.s * 0.72 };
    const L = (x1, y1, x2, y2, c, w = 1.3) => { const k = clipR(x1, y1, x2, y2, rr); if (k) d.line(k[0], k[1], k[2], k[3], c, w); };
    const ca = Math.cos(-e.roll), sa = Math.sin(-e.roll);
    const P = (x, y) => [cx + x * ca - y * sa, cy + x * sa + y * ca];
    const pd = e.pitch * RAD;
    for (let th = -90; th <= 90; th += 10) {
      const y = (pd - th) * ppd;
      const w = th === 0 ? r.s : th % 30 === 0 ? 40 : 22;
      const a = P(-w, y), b = P(w, y);
      L(a[0], a[1], b[0], b[1], th === 0 ? W : th > 0 ? CYAN : [0.85, 0.6, 0.35, 1], th === 0 ? 1.8 : 1.2);
      if (th !== 0 && th % 30 === 0) {
        const t = P(w + 14, y);
        if (t[1] > rr.y0 + 6 && t[1] < rr.y1 - 6 && t[0] < rr.x1 - 10 && t[0] > rr.x0 + 10) d.text(String(Math.abs(th)), t[0], t[1] - 4, 9, W, 'center');
      }
    }
    // aircraft symbol
    d.poly([[cx - 34, cy], [cx - 12, cy], [cx - 6, cy + 7], [cx, cy], [cx + 6, cy + 7], [cx + 12, cy], [cx + 34, cy]], AMB, 2.2);
    // bank pointer
    const rad = r.s * 0.3;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const aa = (a - 90) * DEG;
      L(cx + Math.cos(aa) * rad, cy + Math.sin(aa) * rad, cx + Math.cos(aa) * (rad + (a % 30 ? 4 : 8)), cy + Math.sin(aa) * (rad + (a % 30 ? 4 : 8)), W, 1.2);
    }
    const ba = (-e.roll * RAD - 90) * DEG;
    d.poly([[cx + Math.cos(ba) * (rad - 2), cy + Math.sin(ba) * (rad - 2)], [cx + Math.cos(ba + 0.07) * (rad - 12), cy + Math.sin(ba + 0.07) * (rad - 12)], [cx + Math.cos(ba - 0.07) * (rad - 12), cy + Math.sin(ba - 0.07) * (rad - 12)]], W, 1.4, true);
    d.text('ADI', r.x0 + 6, r.y0 + 6, 11, G);
    d.text(ac.fcsMode || '', r.x1 - 6, r.y0 + 6, 11, ac.fcsMode === 'PA' ? AMB : G, 'right');
    // FCS surface positions
    const fy = r.y0 + r.s * 0.76;
    const bar = (label, x, v, maxv) => {
      const h = r.s * 0.16;
      d.rect(x - 4, fy, 8, h, GD, 1);
      const m = fy + h / 2;
      const yy = m - clamp(v / maxv, -1, 1) * h / 2;
      d.line(x - 7, yy, x + 7, yy, G, 2.2);
      d.line(x - 4, m, x + 4, m, GD, 1);
      d.text(label, x, fy + h + 4, 8, GD, 'center');
    };
    const col = r.s / 9;
    let x = r.x0 + col * 0.8;
    bar('LE', x, ac.lef || 0, 34); x += col;
    bar('TE', x, (ac.flap || 0) * 45, 45); x += col;
    bar('AL', x, -(ac.da || 0) * RAD, 25); x += col;
    bar('ST', x, (ac.de || 0) * RAD, 24); x += col;
    bar('RD', x, (ac.dr || 0) * RAD, 30); x += col;
    bar('SB', x, (ac.sb || 0) * 60, 60); x += col;
    bar('HK', x, (ac.hookAng || 0) * RAD, 60); x += col;
    bar('G', x, ac.nz - 1, 7);
  }

  engineDisplay(cx, y, w, h, g) {
    const d = this.d, ac = g.ac;
    const x = cx - w / 2;
    d.fillRect(x, y, w, h, [0.0, 0.02, 0.01, 1]);
    d.rect(x, y, w, h, [0.3, 0.33, 0.37, 1], 1.5);
    const fs = clamp(h / 13, 8, 13);
    const rpm = ac.N * 100;
    const egt = 350 + ac.N * 300 + ac.ab * 180;
    const ff = ac.ff * 7936.6 / 2;
    const noz = ac.ab > 0.05 ? 40 + ac.ab * 40 : clamp(80 - (ac.N - 0.7) * 260, 0, 80);
    const row = (label, a, b, yy, c = W) => {
      d.text(a, cx - w * 0.22, yy, fs, c, 'right');
      d.text(label, cx, yy, fs * 0.8, GD, 'center');
      d.text(b, cx + w * 0.22, yy, fs, c, 'left');
    };
    let yy = y + fs * 0.8;
    const lh = fs * 1.75;
    row('RPM', rpm.toFixed(0), (rpm + 0.4).toFixed(0), yy); yy += lh;
    row('TEMP', egt.toFixed(0), (egt + 3).toFixed(0), yy, egt > 860 ? AMB : W); yy += lh;
    row('FF', String(Math.round(ff / 10) * 10), String(Math.round(ff / 10) * 10), yy, ac.ab > 0.05 ? AMB : W); yy += lh;
    row('NOZ', noz.toFixed(0), noz.toFixed(0), yy); yy += lh;
    const fuelLb = ac.fuel * 2.2046;
    d.text('FUEL', cx - w * 0.42, yy, fs * 0.8, GD);
    d.text(String(Math.round(fuelLb / 10) * 10), cx + w * 0.42, yy, fs * 1.1, fuelLb < 2000 ? AMB : W, 'right'); yy += lh;
    d.text('BINGO', cx - w * 0.42, yy, fs * 0.8, GD);
    d.text('2000', cx + w * 0.42, yy, fs, W, 'right'); yy += lh;
    const tt = Math.floor(g.time);
    d.text('ET ' + String(Math.floor(tt / 3600)).padStart(2, '0') + ':' + String(Math.floor(tt / 60) % 60).padStart(2, '0') + ':' + String(tt % 60).padStart(2, '0'), cx, yy, fs * 0.85, GD, 'center');
  }

  indexer(cx, cy, g) {
    const d = this.d, ac = g.ac;
    d.fillRect(cx - 14, cy - 28, 28, 56, [0.03, 0.03, 0.035, 1]);
    d.rect(cx - 14, cy - 28, 28, 56, [0.3, 0.33, 0.37, 1], 1);
    if (ac.gear < 0.98 || ac.wow) return;
    const a = ac.alpha * RAD;
    const slow = a > 8.8, fast = a < 7.4, onspd = a >= 7.4 && a <= 8.8;
    const dim = (c, on) => (on ? c : [c[0] * 0.12, c[1] * 0.12, c[2] * 0.12, 1]);
    d.poly([[cx - 9, cy - 22], [cx, cy - 12], [cx + 9, cy - 22]], dim([0.2, 1, 0.3, 1], slow || (a > 8.1 && onspd && a > 8.6)), 3);
    d.circle(cx, cy, 6, dim(AMB, onspd), 3, 12);
    d.poly([[cx - 9, cy + 22], [cx, cy + 12], [cx + 9, cy + 22]], dim(RED, fast || (onspd && a < 7.6)), 3);
  }

  lights(cx, cy, g) {
    const d = this.d;
    const w = g.warnings || {};
    const mc = (w.caution || w.bingo || w.overG || w.fuelOut) && Math.floor(g.time * 2.5) % 2 === 0;
    d.fillRect(cx - 34, cy - 14, 68, 28, mc ? [0.9, 0.6, 0.1, 1] : [0.18, 0.12, 0.03, 1]);
    d.text('MASTER', cx, cy - 10, 8, mc ? [0, 0, 0, 1] : [0.5, 0.35, 0.1, 1], 'center');
    d.text('CAUTION', cx, cy + 1, 8, mc ? [0, 0, 0, 1] : [0.5, 0.35, 0.1, 1], 'center');
  }

  gearPanel(x0, x1, cy, g) {
    const d = this.d, ac = g.ac;
    const sp = Math.max(0, x1 - x0);
    const k = Math.min(1, sp / 190);
    const cx = x0 + 36 * k;
    const down = ac.gear >= 1, trans = ac.gear > 0 && ac.gear < 1;
    // gear handle
    d.fillRect(cx - 34, cy - 6, 14, 54, [0.08, 0.08, 0.09, 1]);
    const hy = ac.gearCmd ? cy + 34 : cy;
    d.fillRect(cx - 33, hy, 12, 12, trans ? [0.9, 0.15, 0.1, 1] : [0.85, 0.85, 0.8, 1]);
    // three greens
    const gl = (x, y, lbl) => {
      d.fillRect(x - 9, y - 9, 18, 18, down ? [0.1, 0.8, 0.25, 1] : [0.05, 0.12, 0.06, 1]);
      d.text(lbl, x, y - 4, 8, down ? [0, 0.1, 0, 1] : [0.2, 0.35, 0.2, 1], 'center');
    };
    gl(cx + 6, cy, 'N'); gl(cx - 6 + 0, cy + 24, 'L'); gl(cx + 18, cy + 24, 'R');
    // flaps / hook
    const lw = 44 * k;
    const lamp = (x, y, txt, on, col) => {
      d.fillRect(x - lw / 2, y - 8, lw, 16, on ? col : [col[0] * 0.12, col[1] * 0.12, col[2] * 0.12, 1]);
      d.text(txt, x, y - 4, 8 * Math.min(1, k * 1.1), on ? [0, 0, 0, 1] : [col[0] * 0.4, col[1] * 0.4, col[2] * 0.4, 1], 'center');
    };
    const c1 = x0 + sp - lw * 1.6, c2 = x0 + sp - lw * 0.5;
    lamp(c1, cy, 'HALF', ac.flapSel === 1 && !ac.flapBlown, [0.2, 0.9, 0.3, 1]);
    lamp(c1, cy + 20, 'FULL', ac.flapSel === 2 && !ac.flapBlown, [0.2, 0.9, 0.3, 1]);
    lamp(c1, cy + 40, 'FLAPS', ac.flapBlown, AMB);
    const hookTrans = ac.hookCmd ? ac.hookAng < 40 * DEG && !ac.hookOnDeck && !ac.arrest : ac.hookAng > 8 * DEG;
    lamp(c2, cy, 'HOOK', hookTrans, AMB);
    lamp(c2, cy + 20, 'L BAR', ac.state === 'cat', [0.2, 0.9, 0.3, 1]);
    lamp(c2, cy + 40, 'ATC', ac.apc, [0.2, 0.9, 0.3, 1]);
  }

  throttle(cx, y, h, g) {
    const d = this.d, ac = g.ac;
    d.fillRect(cx - 10, y, 20, h, [0.06, 0.06, 0.07, 1]);
    d.rect(cx - 10, y, 20, h, [0.3, 0.33, 0.37, 1], 1);
    const tp = ac.thrCmd ?? 0;
    const k = clamp(tp / 1.2, 0, 1);
    const yy = y + h - k * h;
    const mil = y + h - (1 / 1.2) * h;
    d.line(cx - 14, mil, cx + 14, mil, AMB, 1.2);
    d.text('MIL', cx + 18, mil - 4, 8, AMB);
    d.text('AB', cx + 18, y + 2, 8, RED);
    d.text('IDLE', cx + 18, y + h - 8, 8, GD);
    d.fillRect(cx - 16, yy - 5, 32, 10, ac.ab > 0.05 ? [1, 0.5, 0.1, 1] : [0.75, 0.78, 0.8, 1]);
  }
}
