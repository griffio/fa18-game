// "Paula" style sound engine: every sound is an 8-bit sample generated at a
// low sample rate and played back by pitch-shifting (playbackRate), exactly
// how Amiga games drove their four DMA voices. Voices are panned left/right
// like Paula's channels (softened for headphones) and the mix goes through
// a gentle A500-like output filter.
import { clamp, lerp, rng } from './math.js';

const SR = 22050;

function q8(x) { return Math.round(clamp(x, -1, 1) * 127) / 127; }

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voiceOn = true;
    this.ready = false;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.amigaFilter = ctx.createBiquadFilter();
    this.amigaFilter.type = 'lowpass';
    this.amigaFilter.frequency.value = 7200;
    this.amigaFilter.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    this.master.connect(this.amigaFilter).connect(comp).connect(ctx.destination);
    // Paula channel layout: 0 & 3 left, 1 & 2 right
    this.ch = [-0.45, 0.45, 0.45, -0.45].map((p) => {
      const pan = ctx.createStereoPanner();
      pan.pan.value = p;
      pan.connect(this.master);
      return pan;
    });
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 0.9; this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.55; this.musicBus.connect(this.master);
    this.makeSamples();
    this.startLoops();
    this.ready = true;
  }

  buf(len, fn, rate = SR) {
    const n = Math.floor(len * rate);
    const b = this.ctx.createBuffer(1, n, rate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = q8(fn(i / rate, i, n));
    return b;
  }
  // seamless noise loop with crossfaded ends
  loopBuf(len, gen) {
    const fade = 0.1;
    const n = Math.floor(len * SR), nf = Math.floor(fade * SR);
    const raw = new Float32Array(n + nf);
    for (let i = 0; i < n + nf; i++) raw[i] = gen(i / SR, i);
    const b = this.ctx.createBuffer(1, n, SR);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = raw[i];
      if (i < nf) { const t = i / nf; v = raw[i] * t + raw[n + i] * (1 - t); }
      d[i] = q8(v);
    }
    return b;
  }

  makeSamples() {
    const R = rng(42);
    const S = {};
    // turbine whine: integer-Hz partials so a 1 s loop is seamless
    S.whine = this.buf(1, (t) => {
      const v = 0.5 * Math.sin(2 * Math.PI * 830 * t + 0.6 * Math.sin(2 * Math.PI * 3 * t))
        + 0.25 * Math.sin(2 * Math.PI * 1661 * t) + 0.12 * Math.sin(2 * Math.PI * 3322 * t)
        + 0.18 * Math.sin(2 * Math.PI * 415 * t + 1);
      return v * (0.85 + 0.15 * Math.sin(2 * Math.PI * 7 * t)) * 0.8;
    });
    // low roar: brown noise
    let b = 0, b2 = 0;
    S.roar = this.loopBuf(2, () => { b = b * 0.985 + (R() * 2 - 1) * 0.15; b2 = b2 * 0.6 + b * 0.4; return b2 * 2.2; });
    // afterburner: rough wide-band noise with crackle
    let a1 = 0;
    S.ab = this.loopBuf(2, (t) => {
      a1 = a1 * 0.7 + (R() * 2 - 1) * 0.3;
      const crack = R() < 0.004 ? (R() * 2 - 1) * 1.5 : 0;
      return clamp(a1 * 1.6 + crack, -1, 1) * 0.9;
    });
    // wind / airflow
    let w1 = 0, w2 = 0;
    S.wind = this.loopBuf(2, () => { w1 = w1 * 0.9 + (R() * 2 - 1) * 0.1; w2 = w2 * 0.5 + (R() * 2 - 1) * 0.5; return w1 * 2.5 + w2 * 0.25; });
    // buffet thumps
    let f1 = 0;
    S.buffet = this.loopBuf(1, (t) => { f1 = f1 * 0.995 + (R() * 2 - 1) * 0.08; return clamp(f1 * 5 * (0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 11)), -1, 1); });
    // gear motor hum
    S.motor = this.buf(1, (t) => (((t * 117) % 1) * 2 - 1) * 0.35 + Math.sin(2 * Math.PI * 234 * t) * 0.2 + (R() - 0.5) * 0.15);
    // one-shots
    const env = (t, a, dcy) => (t < a ? t / a : Math.exp(-(t - a) / dcy));
    S.clunk = this.buf(0.5, (t) => (Math.sin(2 * Math.PI * (70 - t * 40) * t) * 0.9 + (R() - 0.5) * 0.6 * Math.exp(-t * 40) + Math.sin(2 * Math.PI * 840 * t) * 0.25 * Math.exp(-t * 18)) * env(t, 0.003, 0.09));
    S.thump = this.buf(0.7, (t) => (Math.sin(2 * Math.PI * (55 - t * 20) * t) + (R() - 0.5) * 0.9 * Math.exp(-t * 25)) * env(t, 0.004, 0.16));
    let c1 = 0;
    S.chirp = this.buf(0.45, (t) => { c1 = (R() * 2 - 1) - c1 * 0.2; return Math.sin(2 * Math.PI * 2100 * t + c1 * 2) * 0.5 * env(t, 0.01, 0.12) + c1 * 0.25 * env(t, 0.01, 0.1); });
    let k1 = 0;
    S.cat = this.buf(3.2, (t) => {
      k1 = k1 * 0.8 + (R() * 2 - 1) * 0.2;
      const whoosh = k1 * 3 * Math.min(1, t * 2) * (t < 2.5 ? 1 : Math.exp(-(t - 2.5) * 6));
      const clank = t > 2.55 ? (Math.sin(2 * Math.PI * 160 * t) + (R() - 0.5)) * Math.exp(-(t - 2.55) * 10) : 0;
      return clamp(whoosh + clank * 0.9 + Math.sin(2 * Math.PI * 40 * t) * 0.3 * Math.min(1, t), -1, 1);
    });
    let tr1 = 0;
    S.trap = this.buf(2.2, (t) => {
      tr1 = tr1 * 0.7 + (R() * 2 - 1) * 0.3;
      const twang = Math.sin(2 * Math.PI * (330 - 120 * t) * t) * Math.exp(-t * 3) * 0.6;
      const screech = Math.sin(2 * Math.PI * 1500 * t + tr1 * 3) * Math.exp(-t * 2) * 0.25;
      const rumble = tr1 * 1.2 * Math.exp(-t * 1.2);
      return clamp(twang + screech + rumble, -1, 1);
    });
    let e1 = 0, e2 = 0;
    S.boom = this.buf(3.5, (t) => {
      e1 = e1 * (0.9 + 0.09 * Math.min(1, t)) + (R() * 2 - 1) * 0.2;
      e2 = e2 * 0.5 + e1 * 0.5;
      return clamp(e2 * 4 * Math.exp(-t * 1.1) + Math.sin(2 * Math.PI * (45 - t * 10) * t) * Math.exp(-t * 2) * 0.8, -1, 1);
    });
    S.splash = this.buf(2, (t) => (R() * 2 - 1) * Math.exp(-t * 2.2) * (t < 0.03 ? t / 0.03 : 1) * 0.9);
    S.beep = this.buf(0.14, (t) => (Math.sin(2 * Math.PI * 1000 * t) > 0 ? 0.5 : -0.5) * (t < 0.12 ? 1 : 0));
    S.deedle = this.buf(0.5, (t) => (Math.sin(2 * Math.PI * (Math.floor(t * 16) % 2 ? 1300 : 950) * t) > 0 ? 0.45 : -0.45));
    S.click = this.buf(0.22, (t) => (t < 0.012 ? (R() - 0.5) * 1.6 : (R() - 0.5) * 0.5 * Math.exp(-(t - 0.012) * 18)));
    S.tone = this.buf(1, (t) => Math.sin(2 * Math.PI * 1200 * t) * 0.4);
    S.ab_light = this.buf(0.6, (t) => (R() * 2 - 1) * env(t, 0.005, 0.12) + Math.sin(2 * Math.PI * 60 * t) * env(t, 0.005, 0.15));
    this.S = S;
  }

  loop(buf, ch, gain = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = gain;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 8000; f.Q.value = 0.5;
    src.connect(f).connect(g).connect(this.ch[ch]);
    src.start();
    return { src, g, f };
  }

  startLoops() {
    const S = this.S;
    this.L = {
      whine: this.loop(S.whine, 0),
      roar: this.loop(S.roar, 1),
      ab: this.loop(S.ab, 2),
      wind: this.loop(S.wind, 3),
      buffet: this.loop(S.buffet, 1),
      motor: this.loop(S.motor, 2),
      stall: this.loop(S.tone, 3),
    };
  }

  // only schedule automation when a value really changes - avoids flooding the
  // Web Audio event timeline with ~1,300 identical events per second
  set(v, gain, rate, cutoff, tc = 0.06) {
    const t = this.ctx.currentTime;
    const g = this.muted ? 0 : gain;
    if (v.lg === undefined || Math.abs(g - v.lg) > 0.004 + v.lg * 0.02) { v.g.gain.setTargetAtTime(g, t, tc); v.lg = g; }
    if (rate !== undefined) {
      const r = clamp(rate, 0.05, 4);
      if (v.lr === undefined || Math.abs(r - v.lr) > v.lr * 0.003) { v.src.playbackRate.setTargetAtTime(r, t, 0.05); v.lr = r; }
    }
    if (cutoff !== undefined && (v.lc === undefined || Math.abs(cutoff - v.lc) > v.lc * 0.03)) { v.f.frequency.setTargetAtTime(cutoff, t, 0.08); v.lc = cutoff; }
  }

  // per-frame engine/airflow update
  // s: {N, ab, thrust, ias (m/s), alpha (deg), inside, dist, doppler, behind (0..1), gearMoving, stall, shake, rush (0..1), active, paused}
  update(s) {
    if (!this.ready) return;
    const L = this.L;
    if (!s.active || s.paused) {
      for (const k in L) this.set(L[k], 0, undefined, undefined, 0.1);
      return;
    }
    const dop = s.doppler || 1;
    const n = clamp((s.N - 0.1) / 0.9, 0, 1.2);
    const inside = s.inside;
    // distance attenuation outside
    const att = inside ? 1 : clamp(60 / Math.max(s.dist, 20), 0, 1.6) ** 1.1;
    const rearBoost = inside ? 1 : 0.6 + 0.8 * (s.behind || 0);
    const whineRate = (0.30 + 0.75 * n) * dop;
    this.set(L.whine, (inside ? 0.10 + 0.14 * n : 0.25 * n * att * (1.4 - (s.behind || 0) * 0.6)), whineRate, inside ? 2400 : 7000);
    this.set(L.roar, (inside ? 0.18 + 0.35 * n * n : 0.6 * n * att * rearBoost), (0.55 + 0.55 * n) * dop, inside ? 900 : 3500);
    this.set(L.ab, (inside ? 0.45 : 1.1 * att * rearBoost) * s.ab, (0.8 + 0.25 * s.ab) * dop, inside ? 1800 : 6000);
    const sp = s.ias / 154; // 300 kt
    this.set(L.wind, inside ? clamp(sp * sp * 0.22, 0, 0.6) + (s.rush || 0) * 0.2 : clamp(sp * 0.12 * att, 0, 0.3), 0.6 + sp * 0.5, 400 + sp * 2500);
    this.set(L.buffet, inside ? clamp((s.alpha - 24) / 12, 0, 1) * 0.6 * clamp(sp * 2, 0, 1) + (s.shake || 0) * 0.5 : 0, 0.8);
    this.set(L.motor, s.gearMoving ? (inside ? 0.12 : 0.05 * att) : 0, 1);
    this.set(L.stall, s.stall && Math.floor(performance.now() / 150) % 2 ? 0.12 : 0, s.stall ? (Math.floor(performance.now() / 150) % 2 ? 1 : 0.75) : 1, 8000, 0.01);
  }

  play(name, { gain = 1, rate = 1, ch = 2, delay = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.S[name];
    src.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g).connect(this.ch[ch]);
    src.start(ctx.currentTime + delay);
  }

  // radio / voice: Amiga had narrator.device - use the browser's speech synth
  say(text, who = 'lso', urgent = false) {
    if (!this.voiceOn || this.muted || !window.speechSynthesis) return;
    const ss = window.speechSynthesis;
    if (urgent) ss.cancel();
    if (!urgent && ss.pending) return;
    this.play('click', { gain: 0.5, ch: 3 });
    const u = new SpeechSynthesisUtterance(text);
    const voices = ss.getVoices();
    const en = voices.filter((v) => /en[-_]/i.test(v.lang));
    if (who === 'betty') {
      u.voice = en.find((v) => /female|samantha|victoria|karen|zira|susan|serena/i.test(v.name)) || en[0] || null;
      u.pitch = 1.25; u.rate = 1.15;
    } else if (who === 'pilot') {
      u.voice = en.find((v) => /daniel|alex|fred|david|male/i.test(v.name)) || en[0] || null;
      u.pitch = 0.9; u.rate = 1.2;
    } else {
      u.voice = en.find((v) => /fred|alex|daniel|david|male|google us/i.test(v.name)) || en[0] || null;
      u.pitch = 0.75; u.rate = 1.05;
    }
    u.volume = 0.9;
    ss.speak(u);
  }

  setMuted(m) {
    this.muted = m;
    if (m && window.speechSynthesis) window.speechSynthesis.cancel();
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }
}
