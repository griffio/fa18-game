// F/A-18 style head-up display: conformal pitch ladder (with the Hornet's
// bent bars), velocity vector, heading tape, airspeed / altitude, AoA
// E-bracket, ICLS needles, Fresnel lens repeater and carrier steering.
import { DEG, RAD, KT, FT, NM, clamp, wrap360, vnorm, vlen, vsub, qrot, vscale, vadd } from './math.js';

const GRN = [0.25, 1.0, 0.38, 1];
const GRN_D = [0.3, 0.95, 0.4, 0.55];
const AMBER = [1.0, 0.7, 0.15, 1];
const RED = [1.0, 0.2, 0.15, 1];

function clip(x1, y1, x2, y2, r) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy], q = [x1 - r.x0, r.x1 - x1, y1 - r.y0, r.y1 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [x1 + dx * t0, y1 + dy * t0, x1 + dx * t1, y1 + dy * t1];
}

export class HUD {
  constructor(d2) { this.d = d2; this.blink = 0; }

  draw(R, g) {
    const d = this.d, ac = g.ac, cv = g.cv;
    const t = g.time;
    const W = R.cssW, H = R.cssH;
    const f = R.proj[5];
    const pxDeg = (f * H / 2) * DEG;
    this.pxDeg = pxDeg;
    const fwd = qrot(ac.q, [0, 0, -1]);
    const B = R.projectDir(fwd);
    if (!B) return;
    const bx = B[0], by = B[1];
    const half = Math.min(13 * pxDeg, W * 0.3);
    const rect = { x0: bx - half, x1: bx + half, y0: by - 13 * pxDeg, y1: by + 15 * pxDeg };
    this.rect = rect;
    const lrect = { x0: rect.x0, x1: rect.x1, y0: rect.y0 + 40, y1: rect.y1 };
    const L = (x1, y1, x2, y2, c = GRN, w = 1.7) => {
      const k = clip(x1, y1, x2, y2, lrect);
      if (k) d.line(k[0], k[1], k[2], k[3], c, w);
    };
    const txt = (s, x, y, sz, c = GRN, al = 'left') => d.text(s, x, y, sz, c, al, 1.4);
    const e = ac.eulers;
    const fs = clamp(pxDeg * 0.42, 9, 15);   // font size

    // --- velocity vector
    const spd = vlen(ac.vel);
    const vdir = spd > 5 ? vscale(ac.vel, 1 / spd) : fwd;
    const V = R.projectDir(vdir);
    let vx = bx, vy = by;
    if (V) { vx = clamp(V[0], rect.x0 + 20, rect.x1 - 20); vy = clamp(V[1], rect.y0 + 20, rect.y1 - 20); }
    const vvCaged = V && (V[0] !== vx || V[1] !== vy);
    const vr = 7;
    d.circle(vx, vy, vr, GRN, 1.7, 16);
    // wings follow bank in the HUD
    const ca = Math.cos(-e.roll), sa = Math.sin(-e.roll);
    const rot = (x, y) => [vx + x * ca - y * sa, vy + x * sa + y * ca];
    let p1 = rot(-vr, 0), p2 = rot(-vr - 14, 0);
    d.line(p1[0], p1[1], p2[0], p2[1], GRN, 1.7);
    p1 = rot(vr, 0); p2 = rot(vr + 14, 0);
    d.line(p1[0], p1[1], p2[0], p2[1], GRN, 1.7);
    p1 = rot(0, -vr); p2 = rot(0, -vr - 8);
    d.line(p1[0], p1[1], p2[0], p2[1], GRN, 1.7);
    if (vvCaged && Math.floor(t * 3) % 2) d.line(vx - 10, vy - 10, vx + 10, vy + 10, GRN, 1.2);

    // --- pitch ladder (horizontal reference = velocity track)
    let hx = vdir[0], hz = vdir[2];
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-3) { hx = fwd[0]; hz = fwd[2]; } else { hx /= hl; hz /= hl; }
    const right = [-hz, 0, hx];
    for (let th = -90; th <= 90; th += 5) {
      const c = Math.cos(th * DEG), s = Math.sin(th * DEG);
      const D = [hx * c, s, hz * c];
      const P = R.projectDir(D);
      if (!P) continue;
      if (P[1] < rect.y0 - 200 || P[1] > rect.y1 + 200) continue;
      const Q = R.projectDir(vnorm(vadd(D, vscale(right, 0.02))));
      if (!Q) continue;
      let ex = Q[0] - P[0], ey = Q[1] - P[1];
      const el = Math.hypot(ex, ey) || 1;
      ex /= el; ey /= el;
      const nx = ey, ny = -ex; // screen "up" toward positive pitch
      // shift so the ladder centre-line passes through the velocity vector
      const offs = (vx - P[0]) * ex + (vy - P[1]) * ey;
      const cx = P[0] + ex * offs, cy = P[1] + ey * offs;
      if (th === 0) {
        const gap = 26, len = half * 0.85;
        L(cx + ex * gap, cy + ey * gap, cx + ex * len, cy + ey * len, GRN, 1.6);
        L(cx - ex * gap, cy - ey * gap, cx - ex * len, cy - ey * len, GRN, 1.6);
        continue;
      }
      const gap = 22, len = 42, tick = 7;
      const phi = (th / 2) * DEG;
      const cph = Math.cos(phi), sph = Math.sin(phi);
      for (const side of [1, -1]) {
        const ox = cx + ex * gap * side, oy = cy + ey * gap * side;
        const dx = ex * cph * side - nx * sph, dy = ey * cph * side - ny * sph;
        const x2 = ox + dx * len, y2 = oy + dy * len;
        if (th > 0) L(ox, oy, x2, y2, GRN, 1.5);
        else for (let k = 0; k < 3; k++) L(ox + dx * len * (k / 3), oy + dy * len * (k / 3), ox + dx * len * (k / 3 + 0.2), oy + dy * len * (k / 3 + 0.2), GRN, 1.5);
        const tk = th > 0 ? -1 : 1;
        L(ox, oy, ox + nx * tick * tk, oy + ny * tick * tk, GRN, 1.5);
        const lx = x2 + dx * 12, ly = y2 + dy * 12;
        if (lx > lrect.x0 && lx < lrect.x1 && ly > lrect.y0 && ly < lrect.y1) {
          d.textRot(Math.abs(th) + '', lx, ly, fs * 0.8, GRN, Math.atan2(ey, ex) + (side < 0 ? 0 : 0));
        }
      }
    }

    // --- boresight: gun cross (UA) or waterline (PA)
    if (ac.pa) {
      d.poly([[bx - 18, by], [bx - 10, by], [bx - 5, by + 6], [bx, by], [bx + 5, by + 6], [bx + 10, by], [bx + 18, by]], GRN, 1.6);
    } else {
      d.line(bx - 7, by, bx + 7, by, GRN, 1.4);
      d.line(bx, by - 7, bx, by + 2, GRN, 1.4);
    }

    // --- E-bracket (approach AoA)
    if (ac.pa) {
      const ebp = (deg) => R.projectDir(qrot(ac.q, [0, -Math.sin(deg * DEG), -Math.cos(deg * DEG)]));
      const top = ebp(6.9), mid = ebp(8.1), bot = ebp(9.3);
      if (top && bot && mid) {
        const x = vx - 22;
        d.line(x, top[1], x, bot[1], GRN, 1.6);
        d.line(x, top[1], x + 6, top[1], GRN, 1.6);
        d.line(x, bot[1], x + 6, bot[1], GRN, 1.6);
        d.line(x, mid[1], x + 9, mid[1], GRN, 1.6);
      }
    }

    // --- heading tape
    const hdg = wrap360(e.hdg * RAD);
    const ty = rect.y0 + 6;
    const pxH = 3.6;
    for (let k = Math.floor(hdg - 32); k <= hdg + 32; k++) {
      if (k % 5) continue;
      const x = bx + (k - hdg) * pxH;
      const big = k % 10 === 0;
      d.line(x, ty + 16, x, ty + 16 - (big ? 8 : 4), GRN, 1.4);
      if (big) txt(String(wrap360(k) / 10 | 0).padStart(2, '0'), x, ty, fs * 0.85, GRN, 'center');
    }
    d.poly([[bx - 5, ty + 25], [bx, ty + 19], [bx + 5, ty + 25]], GRN, 1.4);
    // carrier steering caret on the tape
    if (cv) {
      const dv = vsub(cv.pos, ac.pos);
      const brg = wrap360(Math.atan2(dv[0], -dv[2]) * RAD);
      let dh = ((brg - hdg + 540) % 360) - 180;
      const x = bx + clamp(dh, -32, 32) * pxH;
      d.poly([[x - 4, ty + 30], [x, ty + 26], [x + 4, ty + 30], [x, ty + 34]], AMBER, 1.4, true);
    }

    // --- airspeed & altitude boxes
    const ax = bx - half + 6, ay = by - 30;
    const kts = Math.max(0, ac.ias / KT);
    d.rect(ax, ay, 56, fs + 10, GRN, 1.4);
    txt(Math.round(kts).toString(), ax + 50, ay + 5, fs, GRN, 'right');
    txt('α ' + (ac.alpha * RAD).toFixed(1), ax, ay - fs - 8, fs * 0.85);
    txt('M ' + ac.mach.toFixed(2), ax, ay + fs + 18, fs * 0.85);
    txt('G ' + ac.nz.toFixed(1), ax, ay + 2 * fs + 26, fs * 0.85);
    txt((ac.nzMax || 1).toFixed(1), ax, ay + 3 * fs + 34, fs * 0.85);
    const alt = ac.pos[1] / FT;
    const altx = bx + half - 6;
    d.rect(altx - 72, ay, 72, fs + 10, GRN, 1.4);
    const altStr = Math.round(alt / 10) * 10;
    txt(altStr.toLocaleString('en-US').replace(',', ','), altx - 6, ay + 5, fs, GRN, 'right');
    const ralt = (ac.radarAlt ?? ac.pos[1]) / FT;
    if (ralt < 5000) txt('R ' + Math.max(0, Math.round(ralt)), altx - 6, ay - fs - 8, fs * 0.85, GRN, 'right');
    const vsi = ac.vel[1] / FT * 60;
    txt('VV ' + Math.round(vsi / 10) * 10, altx - 6, ay + fs + 18, fs * 0.85, GRN, 'right');

    // --- bank scale (PA)
    if (ac.pa) {
      const r = 70, cx = bx, cy = rect.y1 - 70 - 20;
      for (const a of [-45, -30, -20, -10, -5, 0, 5, 10, 20, 30, 45]) {
        const aa = (90 + a) * DEG;
        const l = a % 10 === 0 || Math.abs(a) === 45 ? 9 : 5;
        d.line(cx + Math.cos(aa) * r, cy + Math.sin(aa) * r, cx + Math.cos(aa) * (r + l), cy + Math.sin(aa) * (r + l), GRN, 1.3);
      }
      const ba = (90 - clamp(e.roll * RAD, -50, 50)) * DEG;
      d.poly([[cx + Math.cos(ba) * (r - 2), cy + Math.sin(ba) * (r - 2)], [cx + Math.cos(ba + 0.06) * (r - 11), cy + Math.sin(ba + 0.06) * (r - 11)], [cx + Math.cos(ba - 0.06) * (r - 11), cy + Math.sin(ba - 0.06) * (r - 11)]], GRN, 1.4, true);
    }

    // --- carrier: TACAN-like steering, ICLS needles, lens repeater
    if (cv) this.carrierAids(R, g, { bx, by, vx, vy, half, rect, fs, txt, pxDeg });

    // --- system status (left, under the box)
    const sx = rect.x0 + 4;
    let sy = rect.y1 - fs * 6.5;
    const status = [];
    if (ac.gear > 0.02) status.push(ac.gear >= 1 ? 'GEAR DN' : 'GEAR TRANS');
    status.push('FLAPS ' + ['AUTO', 'HALF', 'FULL'][ac.flapSel] + (ac.flapBlown ? ' SPD' : ''));
    if (ac.hookCmd) status.push('HOOK');
    if (ac.sb > 0.05) status.push('SPD BRK');
    if (ac.brakes > 0.1 && ac.wow) status.push('BRAKES');
    if (ac.apc) status.push('ATC');
    for (const s of status) { txt(s, sx, sy, fs * 0.75, GRN_D); sy += fs * 1.15; }
    // throttle / fuel (right)
    const thr = ac.thrCmd ?? 0;
    const rx = rect.x1 - 4;
    let ry = rect.y1 - fs * 4.2;
    txt(ac.ab > 0.05 ? 'AB ' + Math.round(clamp((thr - 1) / 0.2, 0, 1) * 100) + '%' : 'THR ' + Math.round(Math.min(thr, 1) * 100) + '%', rx, ry, fs * 0.75, ac.ab > 0.05 ? AMBER : GRN_D, 'right'); ry += fs * 1.15;
    txt('RPM ' + Math.round(ac.N * 100), rx, ry, fs * 0.75, GRN_D, 'right'); ry += fs * 1.15;
    txt('FUEL ' + Math.round(ac.fuel * 2.2046 / 10) * 10, rx, ry, fs * 0.75, ac.fuel < 900 ? AMBER : GRN_D, 'right');

    // --- warnings
    this.warnings(R, g, { bx, by, rect, fs, txt });
  }

  carrierAids(R, g, o) {
    const d = this.d, ac = g.ac, cv = g.cv;
    const { bx, by, half, rect, fs, txt } = o;
    // carrier designation diamond
    const cp = cv.toWorld([0, cv.deckH, 0]);
    const rng = vlen(vsub(cp, ac.pos));
    const P = R.project(cp);
    const inRect = P && P[0] > rect.x0 && P[0] < rect.x1 && P[1] > rect.y0 && P[1] < rect.y1;
    if (inRect) {
      const s = 9;
      d.poly([[P[0], P[1] - s], [P[0] + s, P[1]], [P[0], P[1] + s], [P[0] - s, P[1]]], GRN, 1.5, true);
      if (rng > 1500) txt('CV', P[0] + 12, P[1] - 4, fs * 0.7);
    }
    const dv = vsub(cv.pos, ac.pos);
    const brg = wrap360(Math.atan2(dv[0], -dv[2]) * RAD);
    txt('CV ' + String(Math.round(brg)).padStart(3, '0') + '  ' + (rng / NM).toFixed(1), rect.x1 - 4, rect.y1 - fs * 5.6, fs * 0.75, GRN, 'right');

    // approach aids
    const hookW = ac.toWorld(ac.hookTipBody());
    const gr = cv.groove(hookW);
    const eyeBall = cv.ballFor(ac.toWorld([0, 1.02, -5.25]));
    this.groove = gr;
    if (gr.behind && gr.dist < 10 * NM && Math.abs(gr.lineup) < 20 && ac.pa) {
      // ICLS: localizer (vertical) and glideslope (horizontal) needles
      const fsLoc = 60, fsGs = 60;
      const lx = bx - clamp(gr.lineup / 3, -1, 1) * fsLoc;
      const gy = by + clamp(eyeBall.err / 0.7, -1, 1) * fsGs;
      d.line(lx, by - 60, lx, by + 60, GRN, 1.4);
      d.line(bx - 60, gy, bx + 60, gy, GRN, 1.4);
    }
    // lens repeater (meatball) in close
    if (gr.behind && gr.dist < 1.6 * NM && Math.abs(gr.lineup) < 25) {
      const lx = rect.x0 - 46, ly = by;
      const ch = 9;
      d.fillRect(lx - 16, ly - ch * 6, 32, ch * 12, [0, 0, 0, 0.35]);
      d.rect(lx - 16, ly - ch * 6, 32, ch * 12, [0.6, 0.7, 0.7, 0.6], 1);
      for (let i = 0; i < 5; i++) {
        d.line(lx - 40 + i * 4.5, ly, lx - 37 + i * 4.5, ly, [0.2, 1, 0.3, 1], 3);
        d.line(lx + 20 + i * 4.5, ly, lx + 23 + i * 4.5, ly, [0.2, 1, 0.3, 1], 3);
      }
      const cell = clamp(eyeBall.err / 0.25, -5.5, 5.5);
      const yb = ly - cell * ch;
      const low = cell < -3.5;
      d.circle(lx, yb, 4, low ? RED : AMBER, 3, 10);
      d.fillRect(lx - 4, yb - 4, 8, 8, low ? RED : AMBER);
      if (cv.waveOff && Math.floor(g.time * 4) % 2) {
        for (const sx of [-24, 24]) for (let k = -2; k <= 2; k++) d.line(lx + sx, ly + k * 8, lx + sx, ly + k * 8 + 3, RED, 3.5);
      }
      d.text('BALL', lx, ly + ch * 6 + 6, 9, [0.6, 0.8, 0.7, 0.8], 'center');
    }
  }

  warnings(R, g, o) {
    const d = this.d, ac = g.ac;
    const { bx, by, rect, fs, txt } = o;
    const blink = Math.floor(g.time * 2.5) % 2 === 0;
    const w = g.warnings || {};
    if (w.pullUp) {
      if (blink) {
        d.line(bx - 60, by - 60, bx + 60, by + 60, GRN, 3);
        d.line(bx + 60, by - 60, bx - 60, by + 60, GRN, 3);
      }
      txt('PULL UP', bx, by + 74, fs * 1.4, GRN, 'center');
    }
    if (w.stall && blink) txt(ac.alpha * 57.3 > 37 ? 'DEPARTURE' : 'AOA - LOW SPEED', bx, by + 50, fs * 1.2, AMBER, 'center');
    if (w.gearSpeed) txt('GEAR SPEED', bx, by + 64, fs, AMBER, 'center');
    if (w.overG) txt('OVER G', bx, by - 60, fs * 1.2, AMBER, 'center');
    if (w.bingo && blink) txt('BINGO', bx, rect.y0 + 50, fs, AMBER, 'center');
    if (w.fuelOut) txt('FLAMEOUT', bx, rect.y0 + 50, fs * 1.2, RED, 'center');
    if (w.gear && blink) txt('GEAR', bx, by + 40, fs * 1.2, AMBER, 'center');
  }
}
