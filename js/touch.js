// Touch controls for tablets (iPad): a floating stick under the right thumb, a
// throttle slider along the left edge and buttons for the switches. They feed the
// same Input object as the keyboard - buttons queue key codes, the stick is one
// more axis (input.touch) and the slider sets input.throttle directly.
// Shown on coarse-pointer devices and after any touch; a physical key hides them.
import { clamp } from './math.js';

// throttle track (fraction of its height from the bottom): IDLE..MIL up to MIL_F,
// a detent band, then afterburner from AB_F to the top
const MIL_F = 0.78, AB_F = 0.86;
const toF = (t) => (t <= 1 ? t * MIL_F : AB_F + ((t - 1) / 0.2) * (1 - AB_F));
const fromF = (f) => (f <= MIL_F ? f / MIL_F : f < AB_F ? 1 : 1 + ((f - AB_F) / (1 - AB_F)) * 0.2);

const el = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

// capture keeps a drag on its control when the finger slides off it
const capture = (node, id) => { try { node.setPointerCapture(id); } catch { /* pointer already gone */ } };

const fsEl = document.documentElement;
const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function toggleFullscreen() {
  if (isFullscreen()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
}

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.input = game.input;
    this.on = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
    this.buttons = [];
    this.mode = '';
    const root = this.root = el('div', 'touch', document.body);

    // ---- stick zone (right side of the screen)
    const zone = el('div', 't-zone', root);
    this.hint = el('div', 't-stick-hint', zone, '<span>STICK</span>');
    this.base = el('div', 't-stick-base', zone);
    this.knob = el('div', 't-stick-knob', this.base);
    this.stick = { id: null, cx: 0, cy: 0, r: 70 };
    zone.addEventListener('pointerdown', (e) => {
      if (this.stick.id !== null) return;
      e.preventDefault();
      capture(zone, e.pointerId);
      const s = this.stick;
      s.id = e.pointerId; s.cx = e.clientX; s.cy = e.clientY;
      s.r = clamp(Math.min(innerWidth, innerHeight) * 0.09, 55, 90);
      this.base.style.cssText = `width:${s.r * 2}px;height:${s.r * 2}px;left:${s.cx - s.r}px;top:${s.cy - s.r}px`;
      zone.classList.add('active');
      this.moveStick(e);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === this.stick.id) this.moveStick(e); });
    const release = (e) => {
      if (e.pointerId !== this.stick.id) return;
      this.stick.id = null;
      this.input.touch.x = 0; this.input.touch.y = 0;
      zone.classList.remove('active');
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);

    // ---- throttle slider (left edge); drags are relative so a touch never jumps it
    const thr = this.thr = el('div', 't-throttle', root);
    el('div', 't-thr-mark ab', thr).style.bottom = AB_F * 100 + '%';
    el('div', 't-thr-mark mil', thr).style.bottom = MIL_F * 100 + '%';
    el('div', 't-thr-lbl', thr, 'AB').style.bottom = (AB_F + 1) * 50 + '%';
    el('div', 't-thr-lbl', thr, 'MIL').style.bottom = MIL_F * 100 + '%';
    el('div', 't-thr-lbl', thr, 'IDLE').style.bottom = '0%';
    this.thrFill = el('div', 't-thr-fill', thr);
    this.thrKnob = el('div', 't-thr-knob', thr);
    this.thrDrag = null;
    thr.addEventListener('pointerdown', (e) => {
      if (this.thrDrag) return;
      e.preventDefault();
      capture(thr, e.pointerId);
      this.thrDrag = { id: e.pointerId, y0: e.clientY, f0: toF(this.input.throttle), h: thr.clientHeight };
      thr.classList.add('active');
    });
    thr.addEventListener('pointermove', (e) => {
      const d = this.thrDrag;
      if (!d || e.pointerId !== d.id) return;
      this.input.throttle = fromF(clamp(d.f0 + (d.y0 - e.clientY) / d.h, 0, 1));
      this.input.abDetent = false;
    });
    const thrUp = (e) => { if (this.thrDrag && e.pointerId === this.thrDrag.id) { this.thrDrag = null; thr.classList.remove('active'); } };
    thr.addEventListener('pointerup', thrUp);
    thr.addEventListener('pointercancel', thrUp);

    // ---- flight buttons
    const g = game;
    const left = el('div', 't-group t-left', root);
    this.button(left, 'GEAR', 'KeyG', { lit: () => g.ctl.gear });
    this.button(left, 'FLAPS', 'Pad2', { lit: () => g.ctl.flaps > 0, sub: () => ['AUTO', 'HALF', 'FULL'][g.ctl.flaps] });
    this.button(left, 'HOOK', 'KeyH', { lit: () => g.ctl.hook });
    this.button(left, 'SPD BRK', 'KeyB', { lit: () => g.ctl.speedBrake });
    this.button(left, 'ATC', 'KeyA', { lit: () => g.ac.apc });
    this.button(left, 'BRAKES', 'Space', { hold: true });
    const right = el('div', 't-group t-right', root);
    this.button(right, 'II', 'KeyP', { cls: 'pause' });
    this.button(right, 'VIEW', 'KeyV', { sub: () => g.viewName() });
    this.button(right, 'LAUNCH', 'KeyC', {
      cls: 'launch',
      label: () => (g.ac.state === 'cat' || g.ac.state === 'stroke' ? 'LAUNCH' : 'P.BRAKE'),
      lit: () => (g.ac.state === 'cat' ? g.ac.N >= 0.95 : g.parkBrake),
    });
    const respot = el('div', 't-group t-respot', root);
    this.button(respot, 'RESPOT', 'KeyR', { show: () => g.ac.state === 'crashed' || !!(g.ac.arrest && g.ac.arrest.stopped) });

    // ---- pause menu
    const pm = el('div', 't-group t-pause', root);
    const s = g.settings;
    this.button(pm, 'RESUME', 'KeyP', { cls: 'wide' });
    this.button(pm, 'RESPOT', 'KeyR');
    this.button(pm, 'QUIT', 'KeyQ', { sub: () => 'TO TITLE' });
    this.button(pm, 'GRAPHICS', 'KeyK', { sub: () => g.styleName() });
    this.button(pm, 'SCANLINES', 'KeyL', { lit: () => s.scan });
    this.button(pm, 'DOT FIELD', 'KeyD', { lit: () => s.dots });
    this.button(pm, 'SOUND', 'KeyN', { lit: () => s.sound });
    this.button(pm, 'VOICES', 'KeyJ', { lit: () => s.voice });
    this.button(pm, 'INVERT', 'KeyI', { shift: true, lit: () => s.invert, sub: () => 'PITCH' });
    if (canFullscreen) this.button(pm, 'FULL SCREEN', null, { action: toggleFullscreen, lit: isFullscreen });

    // ---- title extras
    if (canFullscreen) {
      const tt = el('div', 't-group t-title', root);
      this.button(tt, 'FULL SCREEN', null, { action: toggleFullscreen, lit: isFullscreen });
    }

    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.on = true; }, true);
    window.addEventListener('keydown', (e) => { if (!/^(Shift|Control|Alt|Meta)/.test(e.code)) this.on = false; });
    // Safari's own pinch / double-tap zoom gestures
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  button(parent, text, code, o = {}) {
    const b = el('div', 't-btn' + (o.cls ? ' ' + o.cls : ''), parent);
    const lbl = el('b', '', b, text), sub = o.sub ? el('small', '', b) : null;
    const rec = { b, lbl, sub, o, text, code, lit: null, show: null };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      b.classList.add('down');
      if (o.action) o.action();
      else if (o.hold) this.input.keys.add(code);
      else this.input.pressed.push({ code, shift: !!o.shift, key: '' });
    });
    const up = () => { b.classList.remove('down'); if (o.hold) this.input.keys.delete(code); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    this.buttons.push(rec);
    return rec;
  }

  moveStick(e) {
    const s = this.stick;
    let x = (e.clientX - s.cx) / s.r, y = (e.clientY - s.cy) / s.r;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    this.input.touch.x = x; this.input.touch.y = y;
    this.knob.style.transform = `translate(${x * s.r}px, ${y * s.r}px)`;
  }

  // space the canvas overlays should keep clear of on the left (throttle + buttons)
  get leftInset() { return this.mode === 'fly' || this.mode === 'pause' ? 96 : 0; }

  update() {
    const g = this.game;
    const mode = !this.on ? 'off' : g.state === 'flight' ? (g.paused ? 'pause' : 'fly') : g.state;
    if (mode !== this.mode) {
      this.mode = mode;
      this.root.dataset.mode = mode;
      if (mode !== 'fly') {
        // drop anything held when the controls go away
        this.stick.id = null; this.thrDrag = null;
        this.input.touch.x = 0; this.input.touch.y = 0;
        this.input.keys.delete('Space');
        this.root.querySelectorAll('.active,.down').forEach((n) => n.classList.remove('active', 'down'));
      }
    }
    if (mode === 'off' || mode === 'boot') return;
    for (const r of this.buttons) {
      const o = r.o;
      if (o.show) { const v = o.show(); if (v !== r.show) { r.show = v; r.b.style.display = v ? '' : 'none'; } }
      if (o.lit) { const v = !!o.lit(); if (v !== r.lit) { r.lit = v; r.b.classList.toggle('lit', v); } }
      if (o.label) { const v = o.label(); if (v !== r.text) { r.text = v; r.lbl.textContent = v; } }
      if (r.sub) { const v = o.sub(); if (v !== r.subText) { r.subText = v; r.sub.textContent = v; } }
    }
    if (mode === 'fly') {
      const t = this.input.throttle, f = toF(t);
      if (f !== this.thrF) {
        this.thrF = f;
        this.thrFill.style.height = f * 100 + '%';
        this.thrKnob.style.bottom = f * 100 + '%';
        this.thr.classList.toggle('ab', t > 1.001);
      }
    }
  }
}
