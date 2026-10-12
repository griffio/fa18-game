// Vector particle effects: explosions, debris, splashes, tyre smoke,
// catapult steam and wing-tip / LEX vapour trails.
import { vadd, vscale, vlen, clamp, rng, lerp } from './math.js';

const MAX = 6000;

export class Effects {
  constructor(R) {
    this.p = [];
    this.trails = [[], [], [], []];
    this.lines = R.createLines(null, MAX);
    this.data = new Float32Array(MAX * 11);
    this.rnd = rng(99);
    this.trailT = 0;
  }
  clear() { this.p = []; this.trails = [[], [], [], []]; }

  add(p) { if (this.p.length < 2500) this.p.push(p); }

  explosion(pos, vel, scale = 1) {
    const r = this.rnd;
    const v0 = vscale(vel, 0.25);
    for (let i = 0; i < 160 * scale; i++) {
      const d = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const s = (8 + r() * 45) * scale;
      this.add({ p: pos.slice(), v: vadd(v0, vscale(d, s)), life: 0, max: 0.8 + r() * 1.6, c0: [1, 0.85, 0.4], c1: [0.7, 0.15, 0.05], w: 3.5 + r() * 3, drag: 1.8, g: -2, streak: 0.08 });
    }
    for (let i = 0; i < 60 * scale; i++) {
      const d = [r() * 2 - 1, r() * 1.5, r() * 2 - 1];
      this.add({ p: pos.slice(), v: vadd(vscale(vel, 0.4), vscale(d, 25 + r() * 50)), life: 0, max: 2 + r() * 3, c0: [0.9, 0.9, 0.9], c1: [0.4, 0.4, 0.4], w: 1.6, drag: 0.3, g: 9.8, streak: 0.06, debris: true });
    }
    for (let i = 0; i < 80 * scale; i++) {
      const d = [(r() - 0.5) * 6, 2 + r() * 5, (r() - 0.5) * 6];
      this.add({ p: vadd(pos, [(r() - 0.5) * 10, r() * 5, (r() - 0.5) * 10]), v: d, life: -r() * 3, max: 7 + r() * 6, c0: [0.35, 0.33, 0.3], c1: [0.2, 0.2, 0.2], w: 10 + r() * 12, drag: 0.4, g: -0.8, streak: 0, alpha: 0.35 });
    }
  }
  splash(pos, vel, scale = 1) {
    const r = this.rnd;
    for (let i = 0; i < 220 * scale; i++) {
      const a = r() * Math.PI * 2, s = r() * 14;
      const v = [Math.cos(a) * s + vel[0] * 0.15, 15 + r() * 45 * scale, Math.sin(a) * s + vel[2] * 0.15];
      this.add({ p: [pos[0], 0.5, pos[2]], v, life: 0, max: 2 + r() * 2.5, c0: [0.9, 0.96, 1], c1: [0.6, 0.75, 0.9], w: 2 + r() * 2, drag: 0.4, g: 9.8, streak: 0.04, floor: true, alpha: 0.7 });
    }
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      this.add({ p: [pos[0], 0.3, pos[2]], v: [Math.cos(a) * 18, 0, Math.sin(a) * 18], life: 0, max: 4, c0: [0.9, 1, 1], c1: [0.6, 0.8, 1], w: 3, drag: 0.3, g: 0, streak: 0.3 });
    }
  }
  tyreSmoke(pos, vel) {
    const r = this.rnd;
    for (let i = 0; i < 10; i++) this.add({ p: pos.slice(), v: vadd(vscale(vel, 0.6), [(r() - 0.5) * 4, r() * 3, (r() - 0.5) * 4]), life: 0, max: 1 + r(), c0: [0.85, 0.85, 0.85], c1: [0.6, 0.6, 0.6], w: 8 + r() * 8, drag: 2, g: -0.5, streak: 0, alpha: 0.4 });
  }
  steam(a, b, vel) {
    const r = this.rnd;
    for (let i = 0; i < 70; i++) {
      const t = r();
      const p = [lerp(a[0], b[0], t), lerp(a[1], b[1], t) + 0.3, lerp(a[2], b[2], t)];
      this.add({ p, v: vadd(vscale(vel, 0.95), [(r() - 0.5) * 2, 1 + r() * 3, (r() - 0.5) * 2]), life: -t * 0.3, max: 1.5 + r() * 1.5, c0: [1, 1, 1], c1: [0.8, 0.85, 0.9], w: 6 + r() * 10, drag: 0.8, g: -0.5, streak: 0, alpha: 0.4 });
    }
  }
  sparks(pos, vel) {
    const r = this.rnd;
    for (let i = 0; i < 12; i++) this.add({ p: pos.slice(), v: vadd(vscale(vel, 0.8), [(r() - 0.5) * 8, r() * 4, (r() - 0.5) * 8]), life: 0, max: 0.4 + r() * 0.4, c0: [1, 0.9, 0.5], c1: [1, 0.4, 0.1], w: 2, drag: 1, g: 9.8, streak: 0.04 });
  }

  // vapour: wing-tip vortices under g, LEX vortices at high AoA
  vapour(ac, dt, time) {
    this.trailT += dt;
    const g = ac.nz, aoa = ac.alpha * 57.3, spd = ac.tas;
    const humid = 0.5;
    const tipOn = spd > 80 && (g > 4.2 - humid || aoa > 16) && ac.state === 'fly';
    const lexOn = spd > 60 && aoa > 14 && ac.state === 'fly';
    if (this.trailT > 0.03) {
      this.trailT = 0;
      const pts = [ac.toWorld([-5.9, 0, 1.6]), ac.toWorld([5.9, 0, 1.6]), ac.toWorld([-1.1, 0.25, -2.5]), ac.toWorld([1.1, 0.25, -2.5])];
      const on = [tipOn, tipOn, lexOn, lexOn];
      for (let i = 0; i < 4; i++) {
        const tr = this.trails[i];
        if (on[i]) tr.push({ p: pts[i], t: time, k: i < 2 ? clamp((g - 3.5) / 3, 0.2, 1) : clamp((aoa - 12) / 12, 0.2, 1) });
        else if (tr.length && tr[tr.length - 1].p) tr.push({ p: null, t: time });
        while (tr.length && time - tr[0].t > (i < 2 ? 1.6 : 0.5)) tr.shift();
      }
    }
  }

  update(dt) {
    const keep = [];
    for (const q of this.p) {
      q.life += dt;
      if (q.life > q.max) continue;
      if (q.life < 0) { keep.push(q); continue; }
      const k = Math.exp(-q.drag * dt);
      q.v = [q.v[0] * k, (q.v[1] - q.g * dt) * k, q.v[2] * k];
      q.p = vadd(q.p, vscale(q.v, dt));
      if (q.floor && q.p[1] < 0) { q.p[1] = 0; q.v = [q.v[0] * 0.3, 0, q.v[2] * 0.3]; }
      keep.push(q);
    }
    this.p = keep;
  }

  draw(R, time) {
    const d = this.data;
    let n = 0;
    const seg = (a, b, c, a1, w) => {
      if (n >= MAX) return;
      const o = n * 11;
      d[o] = a[0]; d[o + 1] = a[1]; d[o + 2] = a[2]; d[o + 3] = b[0]; d[o + 4] = b[1]; d[o + 5] = b[2];
      d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = a1; d[o + 10] = w; n++;
    };
    for (const q of this.p) {
      if (q.life < 0) continue;
      const t = q.life / q.max;
      const c = [lerp(q.c0[0], q.c1[0], t), lerp(q.c0[1], q.c1[1], t), lerp(q.c0[2], q.c1[2], t)];
      const al = (q.alpha ?? 1) * (1 - t) * (q.alpha ? Math.min(1, q.life * 4) : 1);
      const tail = q.streak ? vadd(q.p, vscale(q.v, -q.streak)) : q.p;
      seg(tail, q.p, c, al, q.w * (q.alpha ? 1 + t * 2 : 1));
    }
    for (let i = 0; i < 4; i++) {
      const tr = this.trails[i];
      const life = i < 2 ? 1.6 : 0.5;
      for (let j = 1; j < tr.length; j++) {
        const a = tr[j - 1], b = tr[j];
        if (!a.p || !b.p) continue;
        const age = time - b.t;
        const al = (1 - age / life) * 0.55 * b.k;
        if (al <= 0) continue;
        seg(a.p, b.p, [0.95, 0.98, 1], al, i < 2 ? 2.2 + age * 4 : 6 + age * 20);
      }
    }
    if (!n) return;
    R.updateLines(this.lines, d, n);
    R.drawLines(this.lines, R.relWorld(), { bias: 0.001, styleFree: true, add: 0.5, glow: 0.3 });
  }
}
