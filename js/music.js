// A tiny 4-channel "Protracker" player and an original title tune.
// Speed 6 / 50 Hz ticks (125 BPM), 16 rows per bar. Channel 0 bass, 1 lead,
// 2 arpeggio chords (the classic Amiga 3-note arps at tick rate), 3 drums.
import { rng } from './math.js';

const TICK = 0.02, SPEED = 6, ROW = TICK * SPEED;
const LOOKAHEAD = 1.2;   // seconds of notes queued ahead: outlasts background-tab timer throttling (1 s)
const SR = 22050;
const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const freq = (n) => {
  const m = /^([A-G]#?)(\d)$/.exec(n);
  if (!m) return 0;
  const midi = NOTE[m[1]] + (parseInt(m[2]) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
};
const CH = {
  Am: ['A3', 'C4', 'E4', 'A2'], F: ['F3', 'A3', 'C4', 'F2'], C: ['C4', 'E4', 'G4', 'C2'], G: ['G3', 'B3', 'D4', 'G2'],
  E: ['E3', 'G#3', 'B3', 'E2'], Dm: ['D3', 'F3', 'A3', 'D2'], Bb: ['A#3', 'D4', 'F4', 'A#2'],
};
const LEAD = {
  A1: 'E5 . . . D5 . C5 . B4 . C5 . A4 . . .', A2: 'C5 . . . A4 . F4 . A4 . C5 . F5 . E5 .',
  A3: 'E5 . . . G5 . . . E5 . D5 . C5 . . .', A4: 'D5 . . . B4 . G4 . B4 . D5 . G5 . . .',
  A5: 'A5 . . . G5 . E5 . C5 . E5 . A5 . G5 .', A6: 'F5 . . . E5 . C5 . A4 . C5 . F5 . A5 .',
  A7: 'G5 . . . F5 . D5 . B4 . D5 . G5 . B5 .', A8: 'G#5 . . . . . . . B5 . . . E5 . . .',
  B1: 'D5 . F5 . A5 . . . G5 . F5 . E5 . D5 .', B2: 'C5 . E5 . A5 . . . G5 . E5 . C5 . . .',
  B3: 'A4 . C5 . F5 . . . E5 . D5 . C5 . A4 .', B4: 'G4 . C5 . E5 . . . G5 . . . E5 . . .',
  B5: 'F5 . . . E5 . D5 . F5 . . . A5 . . .', B6: 'E5 . . . C5 . A4 . C5 . E5 . A5 . . .',
  B7: 'B5 . . . G#5 . E5 . G#5 . B5 . D6 . . .', B8: 'E6 . . . . . . . - . . . . . . .',
  '': '- . . . . . . . . . . . . . . .',
};
const BASS = ['r', '.', 'r', '.', 'o', '.', 'r', '.', 'r', '.', 'o', '.', 'r', 'r', 'o', '.'];
const DRUM_FULL = 'k.h.s.h.k.khs.hh';
const DRUM_HAT = '..h...h...h...h.';
// song: [chord, lead, drums]
const SONG = [
  ['Am', '', DRUM_HAT], ['F', '', DRUM_HAT], ['C', '', DRUM_FULL], ['G', '', DRUM_FULL],
  ['Am', 'A1', DRUM_FULL], ['F', 'A2', DRUM_FULL], ['C', 'A3', DRUM_FULL], ['G', 'A4', DRUM_FULL],
  ['Am', 'A5', DRUM_FULL], ['F', 'A6', DRUM_FULL], ['G', 'A7', DRUM_FULL], ['E', 'A8', DRUM_FULL],
  ['Dm', 'B1', DRUM_FULL], ['Am', 'B2', DRUM_FULL], ['F', 'B3', DRUM_FULL], ['C', 'B4', DRUM_FULL],
  ['Dm', 'B5', DRUM_FULL], ['Am', 'B6', DRUM_FULL], ['E', 'B7', DRUM_FULL], ['E', 'B8', 'k...s...k.k.s.ss'],
];

export class Music {
  constructor(audio) {
    this.a = audio;
    this.playing = false;
    this.active = new Set();   // sources queued ahead, so stop() can silence them
  }
  track(src) { this.active.add(src); src.onended = () => this.active.delete(src); }

  samples() {
    if (this.S) return;
    const ctx = this.a.ctx;
    const cyc = (n, fn) => {
      const b = ctx.createBuffer(1, n, SR);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.round(fn(i / n) * 127) / 127;
      return { b, base: SR / n };
    };
    const R = rng(7);
    this.S = {
      bass: cyc(337, (p) => (p < 0.5 ? p * 2 - 0.5 : 1.5 - p * 2) * 0.6 + (p * 2 - 1) * 0.35),
      lead: cyc(84, (p) => (p < 0.25 ? 0.55 : -0.45)),
      arp: cyc(84, (p) => (p < 0.5 ? 0.5 : -0.5)),
    };
    const one = (len, fn) => {
      const n = Math.floor(len * SR);
      const b = ctx.createBuffer(1, n, SR);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.round(Math.max(-1, Math.min(1, fn(i / SR))) * 127) / 127;
      return b;
    };
    this.S.k = one(0.3, (t) => Math.sin(2 * Math.PI * (40 + 110 * Math.exp(-t * 25)) * t) * Math.exp(-t * 9));
    this.S.s = one(0.25, (t) => ((R() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 185 * t) * 0.5) * Math.exp(-t * 16));
    this.S.h = one(0.06, (t) => (R() * 2 - 1) * Math.exp(-t * 70) * 0.6);
    // modern touch: a little stereo echo on the lead
    const d = ctx.createDelay(1); d.delayTime.value = ROW * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.3;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    this.mch = [-0.45, 0.45, 0.45, -0.45].map((p) => {
      const pan = ctx.createStereoPanner(); pan.pan.value = p; pan.connect(this.a.musicBus); return pan;
    });
    d.connect(fb).connect(d); d.connect(wet).connect(this.mch[3]);
    this.echo = d;
  }

  note(sample, f, t, dur, gain, ch, opts = {}) {
    const ctx = this.a.ctx;
    const src = ctx.createBufferSource();
    src.buffer = sample.b; src.loop = true;
    src.playbackRate.setValueAtTime(f / sample.base, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.setTargetAtTime(gain * (opts.sustain ?? 0.6), t + 0.02, opts.decay ?? 0.15);
    g.gain.setTargetAtTime(0, t + dur, 0.03);
    src.connect(g).connect(this.mch[ch]);
    if (opts.echo) g.connect(this.echo);
    if (opts.vib) {
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
      const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(18, t + 0.35);
      lfo.connect(lg).connect(src.detune); lfo.start(t); lfo.stop(t + dur + 0.2);
    }
    if (opts.arp) {
      // classic tracker arpeggio: cycle the chord every tick
      const n = Math.floor(dur / TICK);
      for (let i = 0; i < n; i++) src.playbackRate.setValueAtTime(opts.arp[i % opts.arp.length] / sample.base, t + i * TICK);
    }
    src.start(t); src.stop(t + dur + 0.2);
    this.track(src);
  }

  hit(name, t, gain) {
    const ctx = this.a.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.S[name];
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g).connect(this.mch[name === 'h' ? 1 : 2]);
    src.start(t);
    this.track(src);
  }

  start() {
    if (!this.a.ready || this.playing) return;
    this.samples();
    const ctx = this.a.ctx;
    this.a.musicBus.gain.cancelScheduledValues(ctx.currentTime);
    this.a.musicBus.gain.setValueAtTime(this.a.muted ? 0 : 0.55, ctx.currentTime);
    this.playing = true;
    this.bar = 0;
    this.t0 = ctx.currentTime + 0.1;
    this.next = this.t0;
    this.timer = setInterval(() => this.schedule(), 100);
    this.schedule();
  }
  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const ctx = this.a.ctx;
    this.a.musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    // notes already queued would otherwise play over the next start()
    for (const s of this.active) { try { s.stop(ctx.currentTime + 0.5); } catch { /* already stopped */ } }
    this.active.clear();
  }
  schedule() {
    if (!this.playing) return;
    const ctx = this.a.ctx;
    while (this.next < ctx.currentTime + LOOKAHEAD) {
      this.playBar(SONG[this.bar % SONG.length], this.next);
      this.next += 16 * ROW;
      this.bar++;
      if (this.bar >= SONG.length) this.bar = 4; // loop after the intro
    }
  }
  playBar([chord, leadKey, drums], t0) {
    const S = this.S;
    const ch = CH[chord];
    const root = ch[3];
    const rootO = root.replace(/\d/, (d) => String(+d + 1));
    // arpeggio for the whole bar
    this.note(S.arp, freq(ch[0]), t0, 16 * ROW - 0.01, 0.16, 2, { arp: ch.slice(0, 3).map(freq), sustain: 0.75, decay: 0.4 });
    // bass
    for (let i = 0; i < 16; i++) {
      const b = BASS[i];
      if (b === '.') continue;
      this.note(S.bass, freq(b === 'r' ? root : rootO), t0 + i * ROW, ROW * 1.6, 0.42, 0, { sustain: 0.5, decay: 0.08 });
    }
    // lead
    const toks = LEAD[leadKey].split(' ');
    for (let i = 0; i < toks.length; i++) {
      const n = toks[i];
      if (n === '.' || n === '-') continue;
      let len = 1;
      while (i + len < toks.length && toks[i + len] === '.') len++;
      this.note(S.lead, freq(n), t0 + i * ROW, len * ROW - 0.01, 0.26, 1, { vib: len > 2, echo: true, sustain: 0.7, decay: 0.3 });
    }
    // drums
    for (let i = 0; i < 16; i++) {
      const c = drums[i];
      if (c === 'k') this.hit('k', t0 + i * ROW, 0.75);
      else if (c === 's') this.hit('s', t0 + i * ROW, 0.5);
      else if (c === 'h') this.hit('h', t0 + i * ROW, 0.28);
    }
  }
}
