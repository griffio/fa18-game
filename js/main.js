// INTERCEPTOR // BAY AREA - a WebGL tribute to F/A-18 Interceptor (Amiga, 1988).
import {
  DEG, RAD, KT, FT, NM, G0, clamp, lerp, smoothstep, vadd, vsub, vscale, vlen, vnorm, vdot, vcross,
  qrot, qmul, qaxis, qnorm, qfromEuler, vmadd, qintegrate, qlookDir, qslerp, eulerFromQ, wrap360, vnoise1, m4, rng,
} from './math.js';
import { Renderer, STYLES } from './gl.js';
import { Terrain } from './terrain.js';
import { Scenery } from './scenery.js';
import { Carrier, DECK_H, PARKED } from './carrier.js';
import { Aircraft, F18, HOOK } from './flightmodel.js';
import { HornetModel } from './hornet.js';
import { Effects } from './effects.js';
import { Draw2D } from './draw2d.js';
import { HUD } from './hud.js';
import { Cockpit } from './cockpit.js';
import { AudioEngine } from './audio.js';
import { Music } from './music.js';
import { Input } from './input.js';
import { LSO } from './lso.js';
import { textWidth } from './vfont.js';

const PHYS_DT = 1 / 240;
const WIND_FROM = 285 * DEG, WIND_KT = 12;
const WIND = [-Math.sin(WIND_FROM) * WIND_KT * KT, 0, Math.cos(WIND_FROM) * WIND_KT * KT];
const SUN = vnorm([-0.45, 0.72, 0.52]);

const VIEWS = ['COCKPIT', 'HUD', 'CHASE', 'ORBIT', 'TOWER', 'FLY-BY', 'LSO', 'CARRIER'];

class Game {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.loading = document.getElementById('loading');
    try {
      this.R = new Renderer(this.canvas);
    } catch (e) {
      this.loading.innerHTML = '<p>WebGL2 is required.<br><small>' + e.message + '</small></p>';
      throw e;
    }
    this.time = 0;
    this.state = 'boot';
    this.view = 0;
    this.messages = [];
    this.radioLog = [];
    this.paused = false;
    this.mouseFlight = false;
    this.perf = { phys: 0, render: 0, fps: 60 };
    this.look = { yaw: 0, pitch: 0, dyaw: 0, dpitch: 0 };
    this.settings = this.loadSettings();
    this.R.setStyle(this.settings.style);
    this.R.scanlines = this.settings.scan;
    this.R.dotsOn = this.settings.dots;
  }

  loadSettings() {
    const def = { style: 'hybrid', dots: true, scan: true, invert: false, voice: true, sound: true, mouseCenter: true };
    try { return Object.assign(def, JSON.parse(localStorage.getItem('fa18-settings-v2') || '{}')); } catch { return def; }
  }
  saveSettings() { try { localStorage.setItem('fa18-settings-v2', JSON.stringify(this.settings)); } catch { /* ignore */ } }

  async init() {
    const step = (msg) => new Promise((r) => { this.loading.querySelector('.msg').textContent = msg; setTimeout(r, 30); });
    await step('GENERATING BAY AREA TERRAIN');
    this.terrain = new Terrain();
    this.terrain.buildGL(this.R);
    await step('BUILDING SAN FRANCISCO');
    this.scenery = new Scenery(this.terrain);
    this.scenery.build(this.R);
    await step('COMMISSIONING CVN-68');
    this.cv = new Carrier([-21000, 0, 2500], 285, 14);
    this.cv.buildModel(this.R);
    this.hornet = new HornetModel(this.R);
    this.parked = this.hornet.bakeParked(this.R, PARKED.map(([x, z, rot]) => ({ q: qaxis([0, 1, 0], -rot * DEG), p: [x, DECK_H + 2.06, z] })));
    this.fx = new Effects(this.R);
    this.d2 = new Draw2D(this.R);
    this.hud = new HUD(this.d2);
    this.cockpit = new Cockpit(this.d2);
    this.audio = new AudioEngine();
    this.music = new Music(this.audio);
    this.input = new Input(this.canvas);
    this.input.invert = this.settings.invert;
    this.input.mouseCenter = this.settings.mouseCenter;
    this.audio.voiceOn = this.settings.voice;
    this.ac = new Aircraft();
    this.lso = new LSO(this);
    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0, gear: true, flaps: 1, hook: false, speedBrake: false, brakes: 1 };
    this.env = {
      wind: (p, t) => this.wind(p, t),
      surface: (p) => this.surface(p),
      collide: (pts) => this.collide(pts),
      carrier: this.cv,
    };
    this.cam = { pos: [0, 100, 0], q: [0, 0, 0, 1], fovy: 55 * DEG, shiftY: 0 };
    this.orbit = { yaw: 2.4, pitch: 0.25, dist: 32 };
    this.respot();
    this.loading.style.display = 'none';
    window.addEventListener('resize', () => this.R.resize());
    this.canvas.addEventListener('mousedown', (e) => this.onClick(e));
    let drag = null;
    this.canvas.addEventListener('mousedown', (e) => { if (!this.input.mouse.locked) drag = [e.clientX, e.clientY]; });
    window.addEventListener('mouseup', () => (drag = null));
    window.addEventListener('mousemove', (e) => {
      if (drag && (this.view === 3 || this.state === 'title')) {
        this.orbit.yaw -= (e.clientX - drag[0]) * 0.006;
        this.orbit.pitch = clamp(this.orbit.pitch + (e.clientY - drag[1]) * 0.005, -1.2, 1.4);
        drag = [e.clientX, e.clientY];
      }
    });
    // right-mouse drag: look around the cockpit (springs back on release)
    window.addEventListener('mousemove', (e) => {
      if ((e.buttons & 2) && this.state === 'flight' && this.view <= 1 && !this.input.mouse.locked) {
        this.look.dyaw = clamp(this.look.dyaw - e.movementX * 0.006, -2.6, 2.6);
        this.look.dpitch = clamp(this.look.dpitch - e.movementY * 0.006, -0.5, 1.2);
      }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) { this.look.dyaw = 0; this.look.dpitch = 0; } });
    this.canvas.addEventListener('wheel', (e) => { if (this.view === 3 && !this.mouseFlight) this.orbit.dist = clamp(this.orbit.dist * (e.deltaY > 0 ? 1.12 : 0.89), 12, 600); });
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  onClick() {
    if (this.state === 'boot') { this.boot(); return; }
    if (this.state === 'title') { this.startFlight(); return; }
    if (this.state === 'flight' && this.mouseFlight && !this.input.mouse.locked && !this.paused) this.input.lockMouse();
  }
  boot() {
    this.audio.init();
    this.audio.setMuted(!this.settings.sound);
    this.state = 'title';
    this.music.start();
  }
  startFlight() {
    this.audio.init();
    this.music.stop();
    this.state = 'flight';
    this.view = 0;
    this.respot();
    this.msg('CVN-68 - CATAPULT ONE', 'big');
    this.later(1.2, () => this.msg('THROTTLE TO MIL (+)  ·  FLAPS HALF  ·  PRESS C TO LAUNCH', 'hint', 7));
  }

  // ------------------------------------------------------------------ environment
  wind(p, t) {
    const h = Math.max(p[1] - (p[1] > 600 ? 0 : Math.max(0, this.terrain.heightAt(p[0], p[2]))), 1);
    const shear = clamp(Math.pow(h / 10, 0.14), 0.45, 1.3);
    let w = vscale(WIND, shear);
    // turbulence: stronger near the ground / over hills
    let amp = 0.25 + 0.55 * Math.exp(-h / 300);
    // carrier air-wake ("the burble") behind the ship
    const l = this.cv.toLocal(p);
    let down = 0;
    if (l[2] > 150 && l[2] < 1600 && Math.abs(l[0]) < 160 && l[1] < 180) {
      const s = l[2] - 166;
      const vfall = Math.exp(-((l[1] - 30) * (l[1] - 30)) / (70 * 70)) * Math.exp(-(l[0] * l[0]) / (90 * 90));
      down = (-1.2 * Math.exp(-((s - 380) * (s - 380)) / (230 * 230)) + 1.0 * Math.exp(-((s - 40) * (s - 40)) / (60 * 60))) * vfall;
      amp += 0.8 * Math.exp(-((s - 200) * (s - 200)) / (350 * 350)) * vfall;
    }
    const k = 0.6;
    const tu = [
      vnoise1(t * k + p[0] * 0.003, 1) + 0.5 * vnoise1(t * 2.3 + p[2] * 0.01, 2),
      vnoise1(t * k + p[2] * 0.003, 3) + 0.5 * vnoise1(t * 2.1 + p[0] * 0.01, 4),
      vnoise1(t * k + p[1] * 0.004, 5) + 0.5 * vnoise1(t * 2.7 + p[0] * 0.012, 6),
    ];
    return [w[0] + tu[0] * amp, down + tu[1] * amp * 0.6, w[2] + tu[2] * amp];
  }
  surface(p) {
    const dk = this.cv.deckAt(p);
    if (dk) return dk;
    const h = this.terrain.heightAt(p[0], p[2]);
    if (h > 0.05) return { y: h, n: this.terrain.normalAt(p[0], p[2]), v: [0, 0, 0], kind: 'land' };
    return { y: 0, n: [0, 1, 0], v: [0, 0, 0], kind: 'water' };
  }
  collide(pts) {
    for (const p of pts) {
      const s = this.scenery.collide(p);
      if (s) return s;
    }
    return this.cv.collide(pts);
  }

  later(sec, fn) { (this.timers = this.timers || []).push({ t: this.time + sec, fn }); }
  runTimers() {
    if (!this.timers || !this.timers.length) return;
    const due = this.timers.filter((x) => x.t <= this.time);
    this.timers = this.timers.filter((x) => x.t > this.time);
    for (const x of due) x.fn();
  }

  // ------------------------------------------------------------------ messages
  msg(text, kind = 'info', dur = 4) { this.messages.push({ text, kind, t: this.time, dur }); if (this.messages.length > 6) this.messages.shift(); }
  radio(text, who) { this.radioLog.push({ text: (who === 'pilot' ? 'PILOT: ' : who === 'betty' ? '' : 'LSO: ') + text.toUpperCase(), t: this.time, who }); if (this.radioLog.length > 4) this.radioLog.shift(); }
  showGrade(r) { this.gradeShow = { ...r, t: this.time }; }

  // ------------------------------------------------------------------ flow
  respot() {
    const ac = this.ac;
    ac.reset();
    ac.fuel = F18.fuelMax; ac.mass = F18.massEmpty + ac.fuel;
    ac.flapSel = 1; ac.flap = 0.5;
    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0, gear: true, flaps: 1, hook: false, speedBrake: false, brakes: 1 };
    if (this.input) this.input.throttle = 0;
    ac.attachToCatapult(this.cv);
    ac.N = 0.7;
    this.cv.waveOff = false;
    this.timers = [];
    this.messages = [];
    this.radioLog = [];
    this.gradeShow = null;
    this.fx && this.fx.clear();
    this.lso && this.lso.reset();
    this.crashT = null;
    this.landedMsg = false;
    this.flyby = null;
    this.warnState = {};
    this.R.flash = 0; this.R.fade = 1;
    this.blackout = 0;
  }

  handleKeys() {
    const ac = this.ac;
    for (const k of this.input.consume()) {
      const c = k.code;
      if (this.state === 'boot') { this.boot(); continue; }
      if (this.state === 'title') {
        if (c === 'Enter' || c === 'Space' || c === 'Pad0' || c === 'Pad9') this.startFlight();
        else this.optionKey(c, k.shift);
        continue;
      }
      if (c === 'Escape' || c === 'KeyP' || c === 'Pad9') { this.togglePause(); continue; }
      if (this.optionKey(c, k.shift)) continue;
      if (this.paused) {
        if (c === 'KeyQ') { this.paused = false; this.respot(); this.state = 'title'; this.input.unlockMouse(); this.music.start(); }
        else if (c === 'KeyR') { this.paused = false; this.respot(); this.msg('RESPOTTED ON CAT 1 - FUEL FULL'); }
        if (!this.paused && window.speechSynthesis) window.speechSynthesis.cancel();
        continue;
      }
      switch (c) {
        case 'KeyG': case 'Pad3':
          if (ac.wow && this.ctl.gear) { this.msg('WEIGHT ON WHEELS - GEAR HANDLE LOCKED'); break; }
          this.ctl.gear = !this.ctl.gear; this.audio.play('clunk', { gain: 0.5, ch: 3, rate: 0.8 }); break;
        case 'KeyF': case 'Pad2':
          // F lowers the flaps a notch (AUTO > HALF > FULL), Shift+F raises them
          if (k.shift) this.ctl.flaps = Math.max(0, this.ctl.flaps - 1);
          else this.ctl.flaps = c === 'Pad2' ? (this.ctl.flaps + 1) % 3 : Math.min(2, this.ctl.flaps + 1);
          this.msg('FLAPS ' + ['AUTO', 'HALF', 'FULL'][this.ctl.flaps]); this.audio.play('click', { gain: 0.3, ch: 0 }); break;
        case 'KeyH': case 'Pad1':
          this.ctl.hook = !this.ctl.hook; this.msg(this.ctl.hook ? 'HOOK DOWN' : 'HOOK UP'); this.audio.play('clunk', { gain: 0.3, ch: 0, rate: 1.4 }); break;
        case 'KeyB': case 'Pad4':
          this.ctl.speedBrake = !this.ctl.speedBrake; this.msg(this.ctl.speedBrake ? 'SPEED BRAKE OUT' : 'SPEED BRAKE IN'); break;
        case 'KeyA':
          if (ac.pa && !ac.wow) { ac.apc = !ac.apc; ac.apcI = 0; this.msg(ac.apc ? 'ATC ENGAGED - APPROACH POWER COMPENSATOR' : 'ATC DISENGAGED'); this.audio.play('beep', { gain: 0.25, ch: 3, rate: ac.apc ? 1.2 : 0.8 }); }
          else this.msg('ATC NEEDS FLAPS HALF/FULL AND AIRBORNE');
          break;
        case 'KeyC': case 'Pad0': this.tryLaunch(); break;
        case 'KeyR': this.respot(); this.msg('RESPOTTED ON CAT 1 - FUEL FULL'); break;
        case 'Tab':
          this.input.throttle = this.input.throttle > 1.0 ? 1.0 : 1.2; this.input.abDetent = false; break;
        case 'Backspace': this.input.throttle = 0; break;
        case 'BracketLeft': this.cockpit.range = Math.max(5, this.cockpit.range / 2); break;
        case 'BracketRight': this.cockpit.range = Math.min(80, this.cockpit.range * 2); break;
        case 'Pad8': case 'KeyV':
          this.view = (this.view + 1) % VIEWS.length; this.msg('VIEW: ' + VIEWS[this.view], 'info', 1.5); this.flyby = null; break;
        default:
          if (/^Digit[1-8]$/.test(c)) { this.view = parseInt(c.slice(5)) - 1; this.flyby = null; this.msg('VIEW: ' + VIEWS[this.view], 'info', 1.5); }
          else if (/^F[1-8]$/.test(c)) { this.view = parseInt(c.slice(1)) - 1; this.flyby = null; }
      }
    }
  }

  optionKey(c, shift = false) {
    const s = this.settings;
    switch (c) {
      case 'KeyK': {
        const order = ['hybrid', 'amiga', 'vector'];
        s.style = order[(order.indexOf(s.style) + 1) % 3];
        this.R.setStyle(s.style);
        this.msg('GRAPHICS: ' + STYLES[s.style].name, 'info', 2);
        break;
      }
      case 'KeyD': s.dots = !s.dots; this.R.dotsOn = s.dots; this.msg('GROUND DOT FIELD ' + (s.dots ? 'ON' : 'OFF'), 'info', 2); break;
      case 'KeyL': s.scan = !s.scan; this.R.scanlines = s.scan; this.msg('SCANLINES ' + (s.scan ? 'ON' : 'OFF'), 'info', 2); break;
      case 'KeyI':
        if (!shift) { this.msg('SHIFT+I TO INVERT PITCH (CURRENTLY ' + (s.invert ? 'INVERTED' : 'NORMAL - DOWN ARROW = NOSE UP') + ')', 'info', 3); return true; }
        s.invert = !s.invert; this.input.invert = s.invert; this.msg(s.invert ? 'PITCH INVERTED - DOWN ARROW = NOSE DOWN' : 'PITCH NORMAL - DOWN ARROW = NOSE UP', 'info', 3); break;
      case 'KeyN': s.sound = !s.sound; this.audio.setMuted(!s.sound); this.msg('SOUND ' + (s.sound ? 'ON' : 'OFF'), 'info', 2); break;
      case 'KeyJ': s.voice = !s.voice; this.audio.voiceOn = s.voice; this.msg('RADIO VOICES ' + (s.voice ? 'ON' : 'OFF'), 'info', 2); break;
      case 'KeyM':
        this.mouseFlight = !this.mouseFlight;
        if (this.mouseFlight) { this.input.lockMouse(); this.input.mouse.x0 = 0; this.input.mouse.y0 = 0; } else this.input.unlockMouse();
        this.msg(this.mouseFlight ? 'MOUSE FLIGHT ON (CLICK TO CAPTURE)' : 'MOUSE FLIGHT OFF', 'info', 2.5);
        break;
      case 'Backquote': this.showPerf = !this.showPerf; return true;
      case 'KeyO': s.mouseCenter = !s.mouseCenter; this.input.mouseCenter = s.mouseCenter; this.msg('MOUSE STICK ' + (s.mouseCenter ? 'SELF-CENTRING' : 'STAYS PUT (AMIGA STYLE)'), 'info', 2.5); break;
      default: return false;
    }
    this.saveSettings();
    return true;
  }

  togglePause() {
    if (this.state !== 'flight') return;
    this.paused = !this.paused;
    if (this.paused) { this.input.unlockMouse(); if (window.speechSynthesis) window.speechSynthesis.pause(); }
    else if (window.speechSynthesis) window.speechSynthesis.resume();
  }

  tryLaunch() {
    const ac = this.ac;
    if (ac.state !== 'cat') return;
    if (ac.N < 0.95) { this.msg('ADVANCE THROTTLE TO MIL BEFORE SALUTING THE CAT OFFICER', 'warn'); return; }
    if (this.ctl.flaps === 0) this.msg('WARNING - FLAPS AUTO FOR LAUNCH', 'warn');
    if (ac.launch()) {
      this.audio.play('cat', { gain: 1.0, ch: 2 });
      this.launchT = this.time;
    }
  }

  // ------------------------------------------------------------------ physics
  physics(dt) {
    const ac = this.ac, cv = this.cv;
    const ax = this.input.update(dt, this.mouseFlight && this.state === 'flight');
    const ctl = this.ctl;
    ctl.pitch = ax.pitch; ctl.roll = ax.roll; ctl.yaw = ax.yaw;
    ctl.throttle = this.input.throttle;
    if (this.autopilot) this.autopilot(ac, ctl, dt);
    const brake = this.input.down('Space') || this.input.padBrake;
    ctl.brakes = brake || (ac.arrest && ac.arrest.stopped) || ac.state === 'cat' ? 1 : 0;
    if (ac.apc) this.input.throttle = ac.apcThrottle ?? this.input.throttle;
    this.acc = (this.acc || 0) + dt;
    let steps = 0;
    while (this.acc >= PHYS_DT && steps < 40) {
      this.acc -= PHYS_DT;
      steps++;
      cv.update(PHYS_DT);
      ac.step(PHYS_DT, ctl, this.env);
      if (ac.events.length) this.handleEvents();
    }
    if (steps >= 40) this.acc = 0;
    if (ac.state !== 'crashed' && this.state === 'flight') {
      this.lso.update(dt, ac, cv, this.time);
      this.fx.vapour(ac, dt, this.time);
    }
    this.fx.update(dt);
  }

  handleEvents() {
    const ac = this.ac, a = this.audio;
    for (const e of ac.events) {
      switch (e.type) {
        case 'gearMove': break;
        case 'gearLocked': a.play('clunk', { gain: 0.7, ch: 0 }); this.msg('GEAR DOWN - 3 GREEN'); break;
        case 'gearUp': a.play('clunk', { gain: 0.6, ch: 0, rate: 0.9 }); this.msg('GEAR UP'); break;
        case 'abLight': a.play('ab_light', { gain: 0.6, ch: 1 }); break;
        case 'catStart': this.msg('LAUNCH!', 'big', 2); break;
        case 'catEnd': {
          this.fx.steam(this.cv.toWorld([7, DECK_H, -150]), this.cv.toWorld([7, DECK_H, -60]), this.cv.velocity());
          this.msg('AIRBORNE - GEAR UP (G)  ·  FLAPS AUTO (SHIFT+F)  ·  ACCELERATE', 'hint', 6);
          break;
        }
        case 'touch': {
          if (e.kind !== 'water' && e.sink > 1.0) {
            a.play('thump', { gain: clamp(e.sink / 4, 0.2, 1), ch: 1 });
            a.play('chirp', { gain: 0.45, ch: 2, rate: 0.9 + Math.random() * 0.2 });
            const g = { N: [0, -2.2, -5.2], L: [-1.62, -2.2, 0.75], R: [1.62, -2.2, 0.75] }[e.gear];
            this.fx.tyreSmoke(ac.toWorld(g), this.ac.surfBelow?.v || [0, 0, 0]);
          }
          if (e.sink > 5.5 && e.kind !== 'water') this.msg('HARD LANDING ' + (e.sink / FT).toFixed(0) + ' FT/S', 'warn');
          break;
        }
        case 'wireBreak':
          a.play('trap', { gain: 1, ch: 2, rate: 1.3 });
          this.msg(`PENDANT PARTED - ${Math.round(e.closure / KT)} KT CLOSURE (LIMIT 150)`, 'warn', 5);
          this.lso.say('Power! Power! You parted the wire!', 'lso', true);
          break;
        case 'trap':
          a.play('trap', { gain: 1, ch: 2 });
          this.msg(e.wire + '-WIRE!' + (e.hard ? '  HARD TRAP' : ''), 'big', 3);
          if (e.hard) this.msg(`ENGAGED AT ${Math.round(e.closure / KT)} KT - CLOSE TO THE 150 KT GEAR LIMIT`, 'warn', 4);
          this.lso.onTrap(e.wire, ac, this.cv);
          break;
        case 'trapStop':
          this.msg('ARRESTED - THROTTLE IDLE.  R: RESPOT ON CAT   H: HOOK UP & TAXI', 'hint', 8);
          break;
        case 'airborne':
          if (this.lastWowDeck && this.lso.state === 'touch') this.lso.onBolter();
          break;
        case 'wow':
          this.lastWowDeck = ac.surfBelow?.kind === 'deck' || (ac.wheel.some((w) => w.surf === 'deck'));
          break;
        case 'flameout': this.msg('FLAMEOUT - OUT OF FUEL', 'warn', 6); a.say('Engine left, engine right', 'betty', true); break;
        case 'crash': this.onCrash(e); break;
      }
    }
    ac.events.length = 0;
  }

  onCrash(e) {
    const ac = this.ac;
    this.crashT = this.time;
    this.crashPos = e.pos;
    if (e.kind === 'water') {
      this.fx.splash(e.pos, e.vel, 1 + Math.min(1, vlen(e.vel) / 150));
      this.audio.play('splash', { gain: 1, ch: 2 });
      this.audio.play('boom', { gain: 0.5, ch: 1, rate: 0.7 });
    } else {
      this.fx.explosion(e.pos, e.vel, 1);
      this.audio.play('boom', { gain: 1, ch: 1 });
      this.audio.play('boom', { gain: 0.8, ch: 2, rate: 0.85, delay: 0.08 });
      this.R.flash = 0.8; this.R.flashCol = [1, 0.7, 0.3];
    }
    this.lso.onCrash(e.reason);
    this.msg(e.reason, 'big', 99);
    this.later(1.5, () => this.msg('PRESS R TO RESPOT ON THE CATAPULT', 'hint', 99));
    if (this.view <= 2 || this.view === 5) this.view = 3;
    this.orbit = { yaw: Math.atan2(-e.vel[0], e.vel[2]) + 0.6, pitch: 0.35, dist: 140 };
    this.input.unlockMouse();
  }

  // ------------------------------------------------------------------ warnings
  warnings(dt) {
    const ac = this.ac, w = {};
    if (ac.state !== 'fly' || this.state !== 'flight') { this.warn = w; return; }
    const ra = ac.radarAlt;
    const vs = ac.vel[1];
    const nearCV = vlen(vsub(this.cv.pos, ac.pos)) < 3000;
    const tti = vs < -3 ? ra / -vs : 99;
    w.pullUp = !ac.wow && ((ac.gear < 0.5 && tti < 6 && ra < 2500) || (ac.gear >= 0.5 && tti < 3 && !nearCV && ra > 5));
    const aoa = ac.alpha * RAD;
    // AoA / departure warning: on the limiter while slow, or past the departure region
    w.stall = !ac.wow && ac.tas > 20 && ((aoa > (ac.pa ? 20.5 : 33) && ac.ias < 150 * KT) || aoa > 37);
    w.gearSpeed = ac.gear > 0.5 && ac.ias > 250 * KT && !ac.wow;
    w.overG = ac.nz > 7.6;
    w.bingo = ac.fuel * 2.2046 < 2000;
    w.fuelOut = ac.flameout;
    w.gear = ac.gear < 0.5 && !ac.wow && ac.ias < 165 * KT && ra < 150 && vs < -1;
    w.caution = w.pullUp || w.stall || w.overG || w.gear || ac.flapBlown;
    const ws = this.warnState;
    const once = (key, cond, fn, repeat = 0) => {
      if (cond && (!ws[key] || (repeat && this.time - ws[key] > repeat))) { ws[key] = this.time; fn(); }
      if (!cond && ws[key] && !repeat) ws[key] = 0;
      if (!cond && repeat) ws[key] = 0;
    };
    once('pull', w.pullUp, () => this.audio.say('Pull up! Pull up!', 'betty', true), 2.5);
    once('bingo', w.bingo, () => { this.audio.say('Bingo, bingo.', 'betty'); this.msg('BINGO FUEL - RETURN TO MOTHER', 'warn', 5); });
    once('overg', w.overG, () => this.audio.say('Over G. Over G.', 'betty', true));
    once('gearw', w.gear, () => this.audio.play('beep', { gain: 0.4, ch: 3 }), 0.6);
    this.warn = w;
  }

  // ------------------------------------------------------------------ camera
  updateCamera(dt) {
    const ac = this.ac, cam = this.cam;
    const R = this.R;
    let pos, q, fov = 55 * DEG, shift = 0;
    const tgt = ac.pos;
    this.inside = false;
    this.lookingAway = false;
    const lookAt = (from, to, up = [0, 1, 0]) => qlookDir(vsub(to, from), up);
    const zoomFov = (dist, size = 40) => clamp(2 * Math.atan(size / Math.max(dist, 1)), 2.5 * DEG, 60 * DEG);
    const view = this.state === 'title' ? -1 : this.view;
    if (view === 0 || view === 1) {
      // cockpit: pilot's eye, with buffet and launch/trap shake
      this.inside = true;
      const shake = this.shakeAmt();
      const t = this.time;
      const sx = vnoise1(t * 25, 1) * shake, sy = vnoise1(t * 23, 2) * shake;
      // head: Q / E glance left / right, right-mouse drag to look around
      const L = this.look;
      let ty = L.dyaw, tp = L.dpitch;
      if (this.input.down('KeyQ')) { ty = 1.45; tp = 0.15; }
      if (this.input.down('KeyE')) { ty = -1.45; tp = 0.15; }
      const k = 1 - Math.exp(-dt * 9);
      L.yaw += (ty - L.yaw) * k; L.pitch += (tp - L.pitch) * k;
      this.lookingAway = Math.abs(L.yaw) > 0.3 || Math.abs(L.pitch) > 0.3;
      pos = ac.toWorld([F18.eye[0] + sx * 0.03 - Math.sin(L.yaw) * 0.12, F18.eye[1] + sy * 0.03, F18.eye[2]]);
      q = qmul(ac.q, qmul(qaxis([0, 1, 0], L.yaw), qaxis([1, 0, 0], L.pitch)));
      q = qmul(q, qfromEuler(sx * 0.004, sy * 0.004, 0));
      if (view === 0 && !this.lookingAway) { fov = 62 * DEG; shift = -0.22; } else { fov = 62 * DEG; shift = 0; }
    } else if (view === 2) {
      // chase: follows the flight path with a little lag
      const back = qrot(ac.q, [0, 3.6, 24]);
      const desired = vadd(tgt, back);
      if (!this.chasePos || vlen(vsub(this.chasePos, desired)) > 300) this.chasePos = desired;
      const k = 1 - Math.exp(-dt * 6);
      this.chasePos = vadd(vadd(this.chasePos, vscale(ac.vel, dt)), vscale(vsub(desired, vadd(this.chasePos, vscale(ac.vel, dt))), k));
      pos = this.chasePos;
      q = lookAt(pos, vadd(tgt, qrot(ac.q, [0, 1.2, -12])), qrot(ac.q, [0, 1, 0]));
      fov = 52 * DEG;
    } else if (view === 3 || view === -1) {
      const o = this.orbit;
      if (view === -1) o.yaw += dt * 0.08;
      const center = this.state === 'flight' && ac.state === 'crashed' && this.crashPos ? this.crashPos : tgt;
      const d = [Math.cos(o.pitch) * Math.sin(o.yaw), Math.sin(o.pitch), Math.cos(o.pitch) * Math.cos(o.yaw)];
      pos = vadd(center, vscale(d, view === -1 ? 30 : o.dist));
      const floor = Math.max(this.surface(pos).y, 0) + 1.5;
      if (pos[1] < floor) pos[1] = floor;
      q = lookAt(pos, center);
      fov = 50 * DEG;
    } else if (view === 4) {
      // tower: carrier island (Pri-Fly)
      pos = this.cv.islandView();
      if (vlen(vsub(pos, tgt)) > 25000) pos = vadd(tgt, [800, 120, 800]);
      q = lookAt(pos, tgt);
      fov = zoomFov(vlen(vsub(pos, tgt)), 30);
    } else if (view === 5) {
      // fly-by: camera planted ahead of the jet, it screams past
      const fb = this.flyby;
      const fwd = vnorm(ac.vel);
      if (!fb || vdot(vsub(tgt, fb), fwd) > 260 || vlen(vsub(fb, tgt)) > 2500) {
        const side = vnorm(vcross(fwd, [0, 1, 0]));
        const spd = Math.max(vlen(ac.vel), 30);
        this.flyby = vadd(vadd(tgt, vscale(fwd, Math.min(spd * 3.5, 900))), vadd(vscale(side, 25 + Math.random() * 25), [0, 8 + Math.random() * 10, 0]));
        const fl = Math.max(this.surface(this.flyby).y, 0) + 3;
        if (this.flyby[1] < fl) this.flyby[1] = fl;
      }
      pos = this.flyby;
      q = lookAt(pos, tgt);
      fov = zoomFov(vlen(vsub(pos, tgt)), 25);
    } else if (view === 6) {
      pos = this.cv.lsoPlatform();
      q = lookAt(pos, tgt);
      fov = zoomFov(vlen(vsub(pos, tgt)), 35);
    } else {
      // carrier ops view: from the bow quarter
      pos = this.cv.toWorld([140, 60, -260]);
      q = lookAt(pos, vlen(vsub(tgt, this.cv.pos)) < 2500 ? tgt : this.cv.toWorld([0, 20, 40]));
      fov = 45 * DEG;
    }
    cam.pos = pos; cam.q = q; cam.fovy = fov; cam.shiftY = shift;
    // camera relative velocity for doppler
    const cpPrev = this.camPrev || pos;
    this.camVel = vscale(vsub(pos, cpPrev), 1 / Math.max(dt, 1e-3));
    this.camPrev = pos.slice();
  }
  shakeAmt() {
    const ac = this.ac;
    let s = 0;
    if (ac.state === 'stroke') s += 2.5;
    if (ac.arrest && !ac.arrest.stopped) s += 1.5;
    s += clamp((ac.alpha * RAD - 24) / 12, 0, 1) * clamp(ac.ias / 100, 0, 1) * 1.4;
    s += ac.wow ? clamp((ac.groundSpeedRel || 0) / 60, 0, 1) * 0.8 : 0;
    s += clamp((ac.mach - 0.92) * 10, 0, 1) * (1.05 - ac.mach > 0 ? 1 : 0) * 0.8;
    s += this.time - (this.crashT ?? -99) < 1 ? 4 : 0;
    return s;
  }

  // ------------------------------------------------------------------ audio
  updateAudio() {
    const ac = this.ac, cam = this.cam;
    if (!this.audio.ready) return;
    const rel = vsub(ac.pos, cam.pos);
    const dist = vlen(rel);
    let dop = 1;
    if (!this.inside && dist > 1) {
      const dir = vscale(rel, 1 / dist);
      const vs = vdot(ac.vel, dir), vo = vdot(this.camVel || [0, 0, 0], dir);
      dop = clamp((340 - vo) / (340 + vs), 0.45, 2.2);
    }
    const fwd = qrot(ac.q, [0, 0, -1]);
    const behind = dist > 1 ? clamp(vdot(fwd, vscale(rel, 1 / dist)), 0, 1) : 0;
    this.audio.update({
      active: this.state === 'flight' && ac.state !== 'crashed',
      paused: this.paused,
      N: ac.N, ab: ac.ab, ias: ac.tas, alpha: ac.alpha * RAD,
      inside: this.inside && this.state === 'flight',
      dist: this.state === 'title' ? 60 : dist, doppler: dop, behind,
      gearMoving: ac.gear > 0 && ac.gear < 1,
      stall: this.warn?.stall,
      shake: ac.state === 'stroke' ? 0.8 : (ac.arrest && !ac.arrest.stopped ? 0.6 : 0),
    });
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = clamp(dt, 0, 0.05);
    this.handleKeys();
    if (this.state === 'boot') { this.render(dt); return; }
    if (!this.paused) {
      this.time += dt;
      this.R.time = this.time;
      if (this.state === 'title') {
        // attract mode: Hornet idling on the catapult
        this.cv.update(dt);
        this.ac.N = 0.72;
        this.ac.stepCatapult(0, {}, this.env);
      } else {
        const t0 = performance.now();
        this.physics(dt);
        this.perf.phys = this.perf.phys * 0.95 + (performance.now() - t0) * 0.05;
      }
      this.warnings(dt);
      this.runTimers();
      this.R.flash = Math.max(0, this.R.flash - dt * 1.5);
      // g-induced greyout above ~7.5 g sustained
      const gl = this.ac.nz;
      this.blackout = clamp((this.blackout || 0) + (gl > 7.2 ? (gl - 7.2) * 0.25 * dt : -0.35 * dt), 0, 0.8);
      this.R.fade = this.inside ? 1 - this.blackout : 1;
    }
    // Physics runs in fixed 1/240 s steps, so a frame gets 4 or 5 of them. Present the
    // jet and the ship where they are *now* by advancing them through the leftover
    // sub-step time; otherwise the jet lurches fore/aft against a smooth camera.
    const ac = this.ac, cv = this.cv;
    const physPos = ac.pos, physQ = ac.q, cvPos = cv.pos;
    const lead = this.state === 'flight' && !this.paused ? (this.acc || 0) : 0;
    if (lead > 0) {
      cv.pos = vmadd(cvPos, cv.vel, lead);
      if (ac.state !== 'crashed') { ac.pos = vmadd(physPos, ac.vel, lead); ac.q = qintegrate(physQ, ac.w, lead); }
    }
    this.updateCamera(dt);
    this.updateAudio();
    this.dynamicResolution(dt);
    const t1 = performance.now();
    this.render(dt);
    ac.pos = physPos; ac.q = physQ; cv.pos = cvPos;
    const p = this.perf;
    p.render = p.render * 0.95 + (performance.now() - t1) * 0.05;
    p.fps = p.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
  }

  // Dynamic resolution: if the GPU can't hold ~50 fps, render fewer pixels (down to
  // 55% scale); climb back when there's headroom. Hysteresis + cooldown avoid hunting.
  dynamicResolution(dt) {
    const d = this.dyn || (this.dyn = { avg: 1 / 60, t: 0, cool: 3 });
    if (this.state === 'boot' || this.paused || dt <= 0) return;
    d.avg = d.avg * 0.97 + dt * 0.03;
    d.cool -= dt;
    if (d.cool > 0) return;
    const R = this.R;
    const cur = R.resScale || 1;
    if (d.avg > 1 / 48 && cur > 0.55) { R.resScale = Math.max(0.55, cur * 0.85); d.cool = 2.5; }
    else if (d.avg < 1 / 57.5 && cur < 1) { R.resScale = Math.min(1, cur * 1.08); d.cool = 6; }
  }

  drawPerf() {
    const d = this.d2, p = this.perf, W = this.R.cssW;
    const c = [0.6, 1, 0.7, 0.9];
    const lines = [`FPS ${p.fps.toFixed(0)}`, `PHYSICS ${p.phys.toFixed(2)} MS`, `RENDER CPU ${p.render.toFixed(2)} MS`,
      `DRAW CALLS ${this.R.drawCalls}`, `RES ${this.R.W}X${this.R.H} (${Math.round((this.R.resScale || 1) * 100)}%)`, `PARTICLES ${this.fx.p.length}`];
    d.fillRect(W - 210, 50, 196, lines.length * 16 + 10, [0, 0, 0, 0.5]);
    lines.forEach((t, i) => d.text(t, W - 200, 56 + i * 16, 10, c));
  }

  render(dt) {
    const R = this.R, ac = this.ac, cv = this.cv;
    if (!this.terrain) return;
    R.beginFrame(this.cam, SUN, R.styleName === 'vector' ? 1 / 30000 : 1 / 42000);
    R.drawSky();
    R.drawTerrain(this.terrain.gl);
    R.drawMesh(this.terrain.skirtMesh, R.relWorld());
    R.drawSea();
    R.drawMesh(this.scenery.mesh, R.relWorld());
    const arr = ac.arrest ? { wire: ac.arrest.wire, hook: ac.toWorld(ac.hookTipBody()) } : null;
    cv.draw(R, this.cam.pos, ac.state === 'cat' || ac.state === 'stroke', arr);
    // parked Hornets (baked into one mesh in the carrier's frame)
    if (vlen(vsub(cv.pos, this.cam.pos)) < 9000) {
      const Mp = R.rel(cv.q, cv.origin());
      R.drawMesh(this.parked.mesh, Mp);
      R.drawLines(this.parked.lines, Mp, { bias: 0.006 });
    }
    // player aircraft + shadow
    const visible = !(this.inside && this.state === 'flight') && ac.state !== 'crashed';
    if (visible) {
      this.hornet.draw(R, ac.q, ac.pos, ac);
    }
    if (ac.state !== 'crashed' && (ac.radarAlt ?? 999) < 400 && !this.inside) this.drawShadow();
    R.drawLines(this.terrain.lines, R.relWorld(), { bias: 0.0045, detailFar: 9000, terrain: true });
    R.drawLines(this.terrain.skirtLines, R.relWorld(), { bias: 0.004, detailFar: 30000, terrain: true });
    R.drawLines(this.scenery.lines, R.relWorld(), { bias: 0.004 });
    this.fx.draw(R, this.time);
    R.flushLines();
    // 2D overlays
    if (this.state === 'boot') this.drawBoot();
    else if (this.state === 'title') this.drawTitle();
    else {
      if (this.inside && this.lookingAway) this.drawLookInfo();
      else if (this.inside) {
        if (this.view === 0) this.cockpit.draw(R, this.hudData());
        this.hud.draw(R, this.hudData());
      } else this.drawExternalInfo();
      if (this.paused) { R.flushScreen(); this.drawPause(); } else this.drawMessages();
    }
    if (this.state === 'flight' && this.settings.invert) this.d2.text('PITCH INV', 20, 44, 11, [1, 0.6, 0.2, 0.9]);
    if (this.showPerf) this.drawPerf();
    R.flushScreen();
    R.endFrame();
  }

  drawShadow() {
    const R = this.R, ac = this.ac;
    const s = this.surface(ac.pos);
    if (ac.pos[1] - s.y > 400) return;
    const n = s.n;
    const c = this.cam.pos;
    const p0 = [ac.pos[0] - c[0], s.y - c[1], ac.pos[2] - c[2]];
    const L = SUN;
    const d = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2] + 0.06;
    const nl = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
    const S = new Float32Array(16);
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) S[col * 4 + row] = (row === col ? 1 : 0) - (L[row] * n[col]) / nl;
    S[12] = (L[0] * d) / nl; S[13] = (L[1] * d) / nl; S[14] = (L[2] * d) / nl; S[15] = 1;
    const dark = s.kind === 'water' ? [0.05, 0.16, 0.32, 1] : [0.12, 0.13, 0.14, 1];
    this.hornet.draw(R, ac.q, ac.pos, ac, { pre: S, tint: dark });
  }

  hudData() { return { ac: this.ac, cv: this.cv, time: this.time, warnings: this.warn, game: this }; }

  // ------------------------------------------------------------------ overlays
  drawMessages() {
    const d = this.d2, W = this.R.cssW, H = this.R.cssH;
    const panelH = this.inside && this.view === 0 ? this.cockpit.height(H) : 0;
    let y = this.inside ? H * 0.045 : H * 0.16;
    for (const m of this.messages) {
      const age = this.time - m.t;
      if (age > m.dur) continue;
      const a = clamp(m.dur - age, 0, 1);
      const sz = m.kind === 'big' ? 20 : m.kind === 'hint' ? 12 : 13;
      const col = m.kind === 'warn' ? [1, 0.6, 0.15, a] : m.kind === 'hint' ? [0.75, 0.9, 1, a] : m.kind === 'big' ? [1, 1, 1, a] : [0.85, 1, 0.85, a];
      d.text(m.text, W / 2, y, sz, col, 'center', m.kind === 'big' ? 2 : 1.4);
      y += sz * 1.8;
    }
    // virtual stick position (mouse flight)
    if (this.mouseFlight) {
      const sx = W - 70, sy = H - panelH - (this.inside ? 70 : 100);
      d.rect(sx - 30, sy - 30, 60, 60, [0.6, 0.8, 1, 0.5], 1);
      d.line(sx - 30, sy, sx + 30, sy, [0.6, 0.8, 1, 0.25], 1);
      d.line(sx, sy - 30, sx, sy + 30, [0.6, 0.8, 1, 0.25], 1);
      const m = this.input.mouse;
      d.circle(sx + (m.x0 || 0) * 28, sy + (m.y0 || 0) * 28, 4, m.locked ? [1, 0.8, 0.3, 1] : [1, 0.3, 0.2, 1], 2, 10);
      if (!m.locked) d.text('CLICK', sx, sy + 36, 9, [1, 0.4, 0.3, 1], 'center');
    }
    // radio
    let ry = H - panelH - (this.inside ? 30 : 60);
    for (let i = this.radioLog.length - 1; i >= 0; i--) {
      const r = this.radioLog[i];
      const age = this.time - r.t;
      if (age > 6) continue;
      d.text(r.text, 20, ry, 12, r.who === 'pilot' ? [0.7, 0.85, 1, clamp(6 - age, 0, 1)] : [1, 0.85, 0.4, clamp(6 - age, 0, 1)], 'left', 1.3);
      ry -= 20;
    }
    // LSO grade card
    const gs = this.gradeShow;
    if (gs && this.time - gs.t < 9) {
      const a = clamp(9 - (this.time - gs.t), 0, 1);
      const bw = Math.max(320, textWidth(gs.text, 15) + 40);
      const x = this.inside ? 16 : W / 2 - bw / 2, y0 = this.inside ? H * 0.11 : H * 0.3;
      const cxg = x + bw / 2;
      d.fillRect(x, y0, bw, 70, [0, 0, 0, 0.55 * a]);
      d.rect(x, y0, bw, 70, [1, 0.8, 0.3, a], 1.5);
      d.text('LSO GRADE', cxg, y0 + 10, 11, [1, 0.8, 0.3, a], 'center');
      d.text(gs.text, cxg, y0 + 34, 15, [1, 1, 1, a], 'center', 1.6);
    }
  }

  // compact readout while the pilot's head is turned away from the HUD
  drawLookInfo() {
    const d = this.d2, ac = this.ac, W = this.R.cssW, H = this.R.cssH;
    const c = [0.3, 1, 0.45, 0.85];
    const s = `${Math.round(ac.ias / KT)} KT   ${Math.round(ac.pos[1] / FT)} FT   ${ac.nz.toFixed(1)} G   AOA ${(ac.alpha * RAD).toFixed(1)}`;
    d.text(s, W / 2, H - 40, 13, c, 'center');
    // carrier direction cue
    const P = this.R.project(this.cv.toWorld([0, DECK_H, 0]));
    if (P && P[0] > 0 && P[0] < W && P[1] > 0 && P[1] < H) {
      d.poly([[P[0], P[1] - 10], [P[0] + 10, P[1]], [P[0], P[1] + 10], [P[0] - 10, P[1]]], [1, 0.75, 0.2, 0.9], 1.5, true);
      d.text('CV', P[0] + 14, P[1] - 5, 10, [1, 0.75, 0.2, 0.9]);
    }
  }

  drawExternalInfo() {
    const d = this.d2, ac = this.ac, W = this.R.cssW, H = this.R.cssH;
    const c = [0.85, 0.95, 1, 0.9];
    d.text(VIEWS[this.view] + ' VIEW', 20, 20, 13, c);
    const e = ac.eulers;
    const y = H - 28;
    const items = [
      `${Math.round(ac.ias / KT)} KT`, `M ${ac.mach.toFixed(2)}`, `${Math.round(ac.pos[1] / FT)} FT`,
      `HDG ${String(Math.round(wrap360(e.hdg * RAD))).padStart(3, '0')}`, `${ac.nz.toFixed(1)} G`,
      `${ac.ab > 0.05 ? 'AB' : 'THR'} ${Math.round(Math.min(ac.thrCmd ?? 0, 1) * 100)}%`,
      `FUEL ${Math.round(ac.fuel * 2.2046)}`,
    ];
    let x = 20;
    for (const s of items) { d.text(s, x, y, 12, c); x += textWidth(s, 12) + 26; }
    const flags = [ac.gear > 0.5 ? 'GEAR' : '', ['', 'FLAPS 1/2', 'FLAPS FULL'][ac.flapSel], ac.hookCmd ? 'HOOK' : '', ac.sb > 0.1 ? 'SPD BRK' : ''].filter(Boolean).join('  ');
    d.text(flags, W - 20, y, 12, [1, 0.8, 0.3, 0.9], 'right');
  }

  drawBoot() {
    const d = this.d2, W = this.R.cssW, H = this.R.cssH, t = performance.now() / 1000;
    d.fillRect(0, 0, W, H, [0.02, 0.03, 0.08, 0.82]);
    // floppy disk
    const cx = W / 2, cy = H * 0.42, s = Math.min(W, H) * 0.16;
    const C = [0.6, 0.85, 1, 1];
    d.poly([[cx - s, cy - s], [cx + s * 0.8, cy - s], [cx + s, cy - s * 0.8], [cx + s, cy + s], [cx - s, cy + s]], C, 2, true);
    d.rect(cx - s * 0.55, cy - s, s * 1.1, s * 0.62, C, 1.6);
    d.rect(cx + s * 0.15, cy - s * 0.92, s * 0.25, s * 0.46, C, 1.4);
    d.rect(cx - s * 0.7, cy + s * 0.05, s * 1.4, s * 0.88, C, 1.4);
    d.text('F/A-18', cx, cy + s * 0.32, s * 0.2, [1, 1, 1, 1], 'center', 1.6);
    const blink = Math.floor(t * 2) % 2;
    d.text('INSERT DISK', cx, cy + s * 1.35, 20, [1, 1, 1, 1], 'center', 2);
    if (blink) d.text('CLICK OR PRESS ANY KEY TO BOOT', cx, cy + s * 1.35 + 34, 13, [0.6, 0.85, 1, 1], 'center');
  }

  drawTitle() {
    const d = this.d2, W = this.R.cssW, H = this.R.cssH, t = this.time;
    const gold = [1, 0.78, 0.25, 1], cyan = [0.5, 0.9, 1, 1], white = [1, 1, 1, 1];
    const sz = Math.min(W / 14, 64);
    // copper-bar title
    const title = 'INTERCEPTOR';
    const ty = H * 0.13;
    for (let i = 0; i < 4; i++) {
      const c = [1, 0.35 + i * 0.15, 0.1 + i * 0.1, 0.35 + i * 0.2];
      d.text(title, W / 2 + (i - 3) * 1.2, ty + (i - 3) * 1.2, sz, c, 'center', 2.2 + (3 - i) * 0.5, 1.2);
    }
    d.text('F/A-18', W / 2, ty - sz * 0.55, sz * 0.4, cyan, 'center', 2);
    d.text('BAY AREA  ·  CARRIER QUALIFICATION', W / 2, ty + sz * 1.25, sz * 0.24, cyan, 'center', 1.5);
    // menu panel
    const lines = [
      ['ENTER / CLICK', 'START SOLO FLIGHT FROM CVN-68'],
      ['', ''],
      ['ARROWS', 'STICK  (DOWN = PULL)   Z / X  RUDDER'],
      ['+ / -', 'THROTTLE (STOPS AT MIL, PRESS AGAIN FOR AB)'],
      ['TAB', 'AFTERBURNER   BACKSPACE  IDLE'],
      ['G  F  H  B', 'GEAR  FLAPS DOWN (SHIFT+F UP)  HOOK  SPD BRK'],
      ['C', 'CATAPULT LAUNCH (SALUTE)     SPACE  WHEEL BRAKES'],
      ['A', 'ATC - APPROACH POWER COMPENSATOR'],
      ['1 - 8', 'VIEWS: COCKPIT HUD CHASE ORBIT TOWER FLYBY LSO SHIP'],
      ['Q / E', 'LOOK LEFT / RIGHT  (RIGHT-MOUSE DRAG: LOOK AROUND)'],
      ['M  O', 'MOUSE FLIGHT  /  MOUSE SELF-CENTRING'],
      ['K  L  D', 'GRAPHICS: ' + STYLES[this.settings.style].name + '  /  SCANLINES  /  DOT FIELD'],
      ['N  J  SHIFT+I', 'SOUND  /  RADIO VOICES  /  INVERT PITCH'],
      ['R  P', 'RESPOT ON CATAPULT  /  PAUSE'],
    ];
    const lh = clamp(H * 0.03, 14, 22);
    const bw = Math.min(W * 0.8, 760), bx = W / 2 - bw / 2, by = H * 0.36;
    d.fillRect(bx, by - 14, bw, lines.length * lh + 26, [0, 0.02, 0.06, 0.62]);
    d.rect(bx, by - 14, bw, lines.length * lh + 26, [0.4, 0.7, 1, 0.6], 1.2);
    lines.forEach(([k, v], i) => {
      const y = by + i * lh;
      const pulse = i === 0 ? 0.6 + 0.4 * Math.sin(t * 5) : 1;
      d.text(k, bx + bw * 0.3, y, lh * 0.52, i === 0 ? [1, 0.8, 0.3, pulse] : gold, 'right', 1.3);
      d.text(v, bx + bw * 0.34, y, lh * 0.52, i === 0 ? [1, 1, 1, pulse] : white, 'left', 1.3);
    });
    d.text('A TRIBUTE TO F/A-18 INTERCEPTOR - AMIGA 1988', W / 2, H - 34, 11, [0.6, 0.75, 0.9, 0.8], 'center');
  }

  drawPause() {
    const d = this.d2, W = this.R.cssW, H = this.R.cssH;
    d.fillRect(0, 0, W, H, [0.0, 0.01, 0.03, 0.82]);
    d.text('PAUSED', W / 2, H * 0.12, 30, [1, 1, 1, 1], 'center', 2.4);
    const keys = [
      ['ARROWS', 'STICK (DOWN = PULL)'], ['Z / X', 'RUDDER / NOSEWHEEL'], ['+ / -  TAB', 'THROTTLE  /  AFTERBURNER'],
      ['G F H B', 'GEAR FLAPS(SHIFT=UP) HOOK SPEEDBRAKE'], ['C  SPACE', 'CATAPULT  /  WHEEL BRAKES'], ['A', 'APPROACH POWER COMPENSATOR'],
      ['1-8  V', 'VIEWS'], ['Q E', 'LOOK LEFT / RIGHT'], ['`', 'PERFORMANCE STATS'], ['[ ]', 'MAP RANGE'], ['K L D', 'GRAPHICS STYLE / SCANLINES / DOTS'], ['M O SHIFT+I', 'MOUSE / SELF-CENTRE / INVERT'],
      ['N J', 'SOUND / RADIO VOICES'],
    ];
    keys.forEach(([k, v], i) => {
      const y = H * 0.5 + i * 18;
      d.text(k, W / 2 - 10, y, 11, [1, 0.8, 0.3, 1], 'right');
      d.text(v, W / 2 + 10, y, 11, [0.85, 0.95, 1, 1], 'left');
    });
    const st = this.lso.stats();
    d.text(`PASSES ${st.passes}   TRAPS ${st.traps}   BOARDING RATE ${(st.boarding * 100).toFixed(0)}%   GPA ${st.gpa.toFixed(2)}`, W / 2, H * 0.2, 13, [1, 0.8, 0.3, 1], 'center');
    const log = this.lso.log.slice(-8);
    if (!log.length) d.text('NO PASSES YET - TRAP ABOARD CVN-68 TO GET GRADED', W / 2, H * 0.26, 12, [0.6, 0.7, 0.8, 1], 'center');
    log.forEach((r, i) => d.text(r.text, W / 2, H * 0.26 + i * 20, 12, [0.85, 0.95, 1, 1], 'center'));
    d.text('P / ESC  RESUME     Q  QUIT TO TITLE     R  RESPOT', W / 2, H * 0.86, 13, [0.6, 0.85, 1, 1], 'center');
    d.text('CARRIER LANDING: GEAR + FLAPS FULL + HOOK, 8.1 DEG AOA (AMBER DONUT), FLY THE BALL. FULL POWER ON TOUCHDOWN.', W / 2, H * 0.92, 11, [0.7, 0.8, 0.9, 1], 'center');
  }
}

// debug / testing helper: place the jet anywhere in flight
Game.prototype.debugPlace = function (x, y, z, hdgDeg, kt, opts = {}) {
  const ac = this.ac;
  ac.state = 'fly'; ac.cat = null; ac.arrest = null;
  ac.pos = [x, y, z];
  ac.q = qfromEuler(hdgDeg * DEG, (opts.pitch || 0) * DEG, (opts.roll || 0) * DEG);
  const v = kt * KT;
  const pc = Math.cos((opts.pitch || 0) * DEG), ps = Math.sin((opts.pitch || 0) * DEG);
  ac.vel = [Math.sin(hdgDeg * DEG) * v * pc, v * ps, -Math.cos(hdgDeg * DEG) * v * pc];
  ac.w = [0, 0, 0];
  ac.N = 0.9;
  this.input.throttle = opts.thr ?? 0.85;
  this.ctl.gear = !!opts.gear; ac.gear = opts.gear ? 1 : 0;
  this.ctl.flaps = opts.flaps || 0; ac.flapSel = this.ctl.flaps; ac.flap = [0, 0.5, 1][this.ctl.flaps];
  this.ctl.hook = !!opts.hook; ac.hookCmd = !!opts.hook;
  ac.wow = false; ac.wheel.forEach((w) => (w.contact = false));
  this.chasePos = null;
};
Game.prototype.debugApproach = function (dist = 1800, opts = {}) {
  const cv = this.cv, ac = this.ac;
  const p = cv.approachPoint(dist);
  p[1] += opts.dh || 0;
  const lh = cv.landingHeading();
  this.debugPlace(p[0], p[1], p[2], lh * RAD, 0, { gear: true, flaps: 2, hook: true, pitch: 4.6 });
  const air = 134 * KT;
  const wv = this.wind(p, this.time);
  const gs = 3.5 * DEG;
  ac.vel = [Math.sin(lh) * air * Math.cos(gs) + wv[0], -Math.sin(gs) * (air - 26 * KT), -Math.cos(lh) * air * Math.cos(gs) + wv[2]];
  ac.hookAng = HOOK.down;
  ac.N = 0.8;
  ac.fuel = 2200; ac.mass = F18.massEmpty + ac.fuel;
  ac.apc = !!opts.apc;
  this.lso.reset();
};
// debug: fly the ball automatically (used for automated testing)
Game.prototype.debugAutoLand = function () {
  const cv = this.cv;
  let lastLat = null;
  this.autopilot = (ac, ct, dt) => {
    if (ac.state !== 'fly') return;
    const g = cv.groove(ac.toWorld(ac.hookTipBody()));
    if (g.dist > 5 && !ac.wow) {
      const lh = cv.landingHeading();
      const rv = vsub(ac.vel, cv.velocity());
      const closure = rv[0] * Math.sin(lh) - rv[2] * Math.cos(lh);
      const hGs = Math.tan(3.5 * DEG) * g.dist;
      const vsDes = -Math.tan(3.5 * DEG) * closure - (g.h - hGs) * 0.25;
      ct.pitch = clamp((vsDes - ac.vel[1]) * 0.13, -0.5, 0.5);
      const U = cv.dirWorld([Math.cos(9 * DEG), 0, -Math.sin(9 * DEG)]);
      const latRate = vdot(rv, U);
      const e = ac.eulers;
      const bankDes = g.dist < 120 ? 0 : clamp((-g.lat * 0.5 - latRate * 2.5) * DEG, -10 * DEG, 10 * DEG);
      ct.roll = clamp((bankDes - e.roll) * 1.5 - (ac.p || 0) * 0.3, -0.6, 0.6);
    } else { ct.pitch = 0; ct.roll = 0; if (ac.wow) { ac.apc = false; this.input.throttle = 1; } }
  };
};
const game = new Game();
game.init();
window.game = game;
