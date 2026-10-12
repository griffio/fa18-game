// Keyboard / mouse / gamepad input.
// Keyboard axes ramp like a real stick so digital keys give smooth inputs.
// Mouse works like the Amiga original's mouse flying: moving the mouse moves
// the stick, which stays where you leave it (optionally self-centring).
import { clamp } from './math.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = [];
    this.axes = { pitch: 0, roll: 0, yaw: 0 };
    this.throttle = 0.0;
    this.mouse = { on: false, x: 0, y: 0, locked: false, dx: 0, dy: 0, buttons: 0, wheel: 0 };
    this.invert = false;
    this.mouseCenter = true;
    this.padIndex = -1;
    this.padPrev = [];
    this.abDetent = false;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Backspace' || e.code.startsWith('F') && e.code.length <= 3) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.push({ code: e.code, shift: e.shiftKey, key: e.key });
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'PageUp') this.abDetent = false;
    });
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousemove', (e) => {
      if (this.mouse.locked) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => { this.mouse.buttons |= 1 << e.button; this.pressed.push({ code: 'Mouse' + e.button }); });
    window.addEventListener('mouseup', (e) => { this.mouse.buttons &= ~(1 << e.button); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerlockchange', () => { this.mouse.locked = document.pointerLockElement === canvas; });
    window.addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; this.pressed.push({ code: 'PadConnected' }); });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = -1; });
  }

  lockMouse() { if (this.canvas.requestPointerLock) this.canvas.requestPointerLock(); }
  unlockMouse() { if (document.exitPointerLock) document.exitPointerLock(); }

  consume() { const p = this.pressed; this.pressed = []; return p; }
  down(c) { return this.keys.has(c); }

  // returns control state for this frame
  update(dt, mouseFlight) {
    const k = (a, b) => (this.down(a) || (b && this.down(b)) ? 1 : 0);
    const ramp = (cur, target, up, back) => {
      const r = target === 0 ? back : (Math.sign(target) !== Math.sign(cur) && cur !== 0 ? back + up : up);
      const d = target - cur;
      return cur + clamp(d, -r * dt, r * dt);
    };
    // keyboard stick: Up = push (nose down), Down = pull (classic sim convention)
    let tp = k('ArrowDown', 'Numpad2') - k('ArrowUp', 'Numpad8');
    if (this.invert) tp = -tp;
    const tr = k('ArrowRight', 'Numpad6') - k('ArrowLeft', 'Numpad4');
    const ty = k('KeyX', 'Period') - k('KeyZ', 'Comma');
    const fine = this.down('ShiftLeft') || this.down('ShiftRight') ? 0.45 : 1;
    this.axes.pitch = ramp(this.axes.pitch, tp * fine, 1.3, 5);
    this.axes.roll = ramp(this.axes.roll, tr * fine, 3.5, 7);
    this.axes.yaw = ramp(this.axes.yaw, ty, 3, 6);
    let pitch = this.axes.pitch, roll = this.axes.roll, yaw = this.axes.yaw;

    // mouse stick
    if (mouseFlight && this.mouse.locked) {
      this.mouse.x0 = clamp((this.mouse.x0 || 0) + this.mouse.dx * 0.004, -1, 1);
      this.mouse.y0 = clamp((this.mouse.y0 || 0) + this.mouse.dy * 0.004 * (this.invert ? -1 : 1), -1, 1);
      if (this.mouseCenter) {
        const c = Math.exp(-dt * 1.2);
        this.mouse.x0 *= c; this.mouse.y0 *= c;
      }
      roll = clamp(roll + this.mouse.x0, -1, 1);
      pitch = clamp(pitch + this.mouse.y0, -1, 1);
    }
    this.mouse.dx = 0; this.mouse.dy = 0;

    // throttle
    const thUp = this.down('Equal') || this.down('NumpadAdd') || this.down('PageUp');
    const thDn = this.down('Minus') || this.down('NumpadSubtract') || this.down('PageDown');
    if (thUp) {
      if (this.throttle < 1) {
        this.throttle = Math.min(1, this.throttle + dt * 0.55);
        if (this.throttle >= 1) this.abDetent = true;   // stop at MIL; press again for AB
      } else if (!this.abDetent) this.throttle = Math.min(1.2, this.throttle + dt * 0.3);
    }
    if (thDn) this.throttle = Math.max(0, this.throttle - dt * 0.55);
    if (this.mouse.wheel) {
      this.throttle = clamp(this.throttle - this.mouse.wheel * 0.04, 0, 1.2);
      this.mouse.wheel = 0;
    }

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (!pad) for (const p of pads) if (p) { pad = p; this.padIndex = p.index; break; }
    this.padButtons = [];
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const ax = pad.axes;
      const curve = (v) => v * (0.4 + 0.6 * v * v);
      if (Math.abs(dz(ax[0])) > 0) roll = clamp(roll + curve(dz(ax[0])), -1, 1);
      if (Math.abs(dz(ax[1])) > 0) pitch = clamp(pitch + curve(dz(ax[1])) * (this.invert ? -1 : 1), -1, 1);
      if (ax.length > 2 && Math.abs(dz(ax[2])) > 0) yaw = clamp(yaw + dz(ax[2]), -1, 1);
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0, lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      if (rt > 0.05) this.throttle = clamp(this.throttle + rt * dt * 0.6, 0, this.throttle < 1 && this.throttle + rt * dt * 0.6 >= 1 ? 1 : 1.2);
      if (lt > 0.05) this.throttle = clamp(this.throttle - lt * dt * 0.6, 0, 1.2);
      pad.buttons.forEach((b, i) => {
        const was = this.padPrev[i];
        if (b.pressed && !was) this.pressed.push({ code: 'Pad' + i });
        this.padPrev[i] = b.pressed;
      });
      this.padBrake = pad.buttons[5] && pad.buttons[5].pressed;
    } else this.padBrake = false;

    return { pitch, roll, yaw };
  }
}
