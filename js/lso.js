// Landing Signal Officer: calls the ball, talks you down, waves off unsafe
// passes and grades every pass in LSO shorthand, e.g. "OK 3-WIRE (LO)X F IC".
import { RAD, NM, clamp, vlen } from './math.js';

const SEGS = [['X', 1400, 900], ['IM', 900, 450], ['IC', 450, 150], ['AR', 150, -10]];

export class LSO {
  constructor(game) {
    this.g = game;
    this.reset();
    this.log = [];
  }
  reset() {
    this.state = 'idle';
    this.samples = { X: [], IM: [], IC: [], AR: [] };
    this.lastCall = -10;
    this.calledBall = false;
    this.waveOff = false;
    this.pending = null;
  }

  say(text, who = 'lso', urgent = false) {
    this.g.radio(text, who === 'pilot' ? 'pilot' : 'lso');
    this.g.audio.say(text, who, urgent);
  }

  update(dt, ac, cv, t) {
    if (ac.state !== 'fly' || ac.wow) {
      if (this.state === 'groove' && ac.wow) this.state = 'touch';
      return;
    }
    const gr = cv.groove(ac.toWorld(ac.hookTipBody()));
    const ball = cv.ballFor(ac.toWorld([0, 1.02, -5.25]));
    const inCone = gr.behind && gr.dist < 1500 && gr.dist > -5 && Math.abs(gr.lineup) < 12 && gr.h > -2 && gr.h < 160;
    if (this.state === 'idle' || this.state === 'done') {
      if (inCone && gr.dist < 1350 && gr.dist > 600 && ac.gear > 0.5 && !this.waveOff) {
        this.state = 'groove';
        this.samples = { X: [], IM: [], IC: [], AR: [] };
        this.calledBall = false;
        this.tGroove = t;
      }
      if (this.waveOff && t - this.waveOffT > 6) { this.waveOff = false; cv.waveOff = false; this.state = 'idle'; }
      return;
    }
    if (this.state === 'waveoff') {
      if (t - this.waveOffT > 6 || !inCone) { cv.waveOff = false; this.state = 'idle'; this.waveOff = false; }
      return;
    }
    if (this.state !== 'groove') return;
    if (!inCone) {
      // flew out of the groove without landing
      this.state = 'idle';
      return;
    }
    // ball call
    if (!this.calledBall && t - this.tGroove > 1.0) {
      this.calledBall = true;
      const fuel = (ac.fuel * 2.2046 / 1000).toFixed(1);
      this.say(`Hornet ball, ${fuel}`, 'pilot');
      this.pending = { t: t + 2.0, text: 'Roger ball.' };
    }
    if (this.pending && t > this.pending.t) { this.say(this.pending.text); this.pending = null; this.lastCall = t; }
    // samples
    const aoa = ac.alpha * RAD;
    for (const [name, a, b] of SEGS) {
      if (gr.dist <= a && gr.dist > b) this.samples[name].push({ e: ball.err, l: gr.lineup, a: aoa });
    }
    // wave-off criteria
    const close = gr.dist < 650;
    let wo = null;
    if (close && ac.gear < 1) wo = 'Wave off, wave off. Gear!';
    else if (close && !ac.hookCmd) wo = 'Wave off, wave off. Hook!';
    else if (gr.dist < 450 && ball.err < -1.15) wo = 'Wave off! Wave off!';
    else if (gr.dist < 350 && Math.abs(gr.lineup) > 3.5) wo = 'Wave off! Wave off!';
    else if (gr.dist < 300 && (aoa > 12 || aoa < 4.5)) wo = 'Wave off! Wave off!';
    if (wo) {
      this.state = 'waveoff';
      this.waveOff = true; this.waveOffT = t;
      cv.waveOff = true;
      this.say(wo, 'lso', true);
      this.record({ grade: 'WO', pts: 1, text: 'WAVE OFF', wire: 0 });
      return;
    }
    // coaching calls
    if (t - this.lastCall > 2.4 && this.calledBall && !this.pending) {
      let call = null;
      if (ball.err < -0.85) call = 'Power! Power!';
      else if (ball.err < -0.5) call = 'Power.';
      else if (gr.lineup < -1.3) call = 'Right for lineup.';
      else if (gr.lineup > 1.3) call = 'Come left.';
      else if (ball.err > 0.75) call = "You're high.";
      else if (aoa > 9.6) call = "Don't go slow.";
      else if (aoa < 6.6) call = "You're fast.";
      else if (ball.err > 0.4 && gr.dist < 300) call = 'Easy with it.';
      if (call) { this.say(call, 'lso', call.startsWith('Power')); this.lastCall = t; }
    }
  }

  comments() {
    const out = [];
    let worst = 0;
    for (const [name] of SEGS) {
      const S = this.samples[name];
      if (!S.length) continue;
      const avg = (k) => S.reduce((s, x) => s + x[k], 0) / S.length;
      const e = avg('e'), l = avg('l'), a = avg('a');
      const tag = (code, m) => { worst = Math.max(worst, m); return m === 1 ? `(${code})` : m === 3 ? `_${code}_` : code; };
      const mag = (v, t1, t2, t3) => (Math.abs(v) > t3 ? 3 : Math.abs(v) > t2 ? 2 : Math.abs(v) > t1 ? 1 : 0);
      let m = mag(e, 0.3, 0.55, 0.95);
      if (m) out.push(tag(e > 0 ? 'H' : 'LO', m) + name);
      m = mag(l, 0.7, 1.4, 2.5);
      if (m) out.push(tag(l > 0 ? 'LUR' : 'LUL', m) + name);
      m = a > 8.1 ? mag(a - 8.1, 0.9, 1.6, 2.6) : mag(a - 8.1, 0.9, 1.6, 2.6);
      if (m) out.push(tag(a > 8.1 ? 'SLO' : 'F', m) + name);
    }
    return { text: out.join(' '), worst };
  }

  onTrap(wire, ac, cv) {
    if (this.state === 'waveoff') {
      this.say('Cut pass! You were waved off.', 'lso', true);
      this.record({ grade: 'C', pts: 0, text: 'CUT - IGNORED WAVE OFF', wire });
      this.state = 'done';
      return;
    }
    const c = this.comments();
    let grade, pts;
    const noComments = c.text === '';
    if (c.worst >= 3) { grade = 'NO GRADE'; pts = 2; }
    else if (wire === 1) { grade = c.worst >= 2 ? 'NO GRADE' : 'FAIR'; pts = c.worst >= 2 ? 2 : 3; }
    else if (c.worst === 2) { grade = 'FAIR'; pts = 3; }
    else if (noComments && wire === 3) { grade = '_OK_'; pts = 5; }
    else { grade = 'OK'; pts = 4; }
    // dangerous low in close
    if (/_LO_(IC|AR)/.test(c.text)) { grade = 'CUT'; pts = 0; }
    this.record({ grade, pts, text: `${grade}  ${wire}-WIRE  ${c.text}`.trim(), wire });
    this.state = 'done';
    const spoken = { '_OK_': 'Outstanding pass. OK three wire.', OK: 'OK pass.', FAIR: 'Fair pass.', 'NO GRADE': 'No grade.', CUT: 'Cut pass. That was dangerous.' }[grade];
    this.g.later(2.2, () => this.say(spoken + (wire === 1 ? ' Watch the one wire.' : '')));
  }

  onBolter() {
    this.say('Bolter, bolter, bolter!', 'lso', true);
    const c = this.comments();
    this.record({ grade: 'B', pts: 2.5, text: `BOLTER  ${c.text}`, wire: 0 });
    this.state = 'done';
  }
  onCrash(reason) {
    if (this.state === 'groove' || this.state === 'touch' || this.state === 'waveoff') {
      this.record({ grade: 'C', pts: 0, text: 'CRASH - ' + reason, wire: 0 });
    }
    this.state = 'idle';
  }

  record(r) {
    r.t = this.g.time;
    this.log.push(r);
    this.g.showGrade(r);
  }
  stats() {
    const traps = this.log.filter((r) => r.wire > 0).length;
    const passes = this.log.length;
    const gpa = passes ? this.log.reduce((s, r) => s + r.pts, 0) / passes : 0;
    return { traps, passes, gpa, boarding: passes ? traps / passes : 0 };
  }
}
