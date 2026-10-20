// Browser smoke test: drives the game in headless Chrome over the DevTools protocol.
//   node tools/smoke.mjs [url] [--out dir] [--chrome path]
// Serve the game first (python3 -m http.server 8000). Boots the title screen, flies a
// catapult shot, cycles the three graphics styles, checks for console errors, exceptions
// and GL errors, and exercises the lost-context path. Exit code 1 on any failure.
// Needs Node 22+ (built-in WebSocket) and a Chromium-based browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const URL_ = args.find((a) => /^https?:/.test(a)) || 'http://localhost:8000/index.html';
const OUT = opt('--out');
if (OUT) fs.mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (opt('--chrome')) return opt('--chrome');
  if (process.env.CHROME) return process.env.CHROME;
  const mac = ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  const win = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  for (const p of [...mac, ...win]) if (fs.existsSync(p)) return p;
  for (const n of ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser']) {
    try { return execSync(`which ${n}`, { stdio: 'pipe' }).toString().trim(); } catch { /* not there */ }
  }
  throw new Error('no Chromium-based browser found: pass --chrome <path>');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9222 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fa18-smoke-'));
const flags = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1280,800', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'];
if (process.platform === 'darwin') flags.push('--use-gl=angle', '--use-angle=metal');   // real GPU rather than SwiftShader
const chrome = spawn(findChrome(), [...flags, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch { /* gone */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', cleanup);

let page = null;
for (let i = 0; i < 50 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(200); }
}
if (!page) { console.error('Chrome did not start'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push('console.' + m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400));
  else if (m.method === 'Log.entryAdded') logs.push('log.' + m.params.entry.level + ': ' + m.params.entry.text.slice(0, 300));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + expr.slice(0, 80) + ' -> ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const keyDown = (code) => send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code });
const keyUp = (code) => send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code });
const key = async (code, holdMs = 60) => { await keyDown(code); await sleep(holdMs); await keyUp(code); };
const shot = async (name) => { if (!OUT) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
const waitFor = async (expr, timeout, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await ev(expr)) return; } catch { /* page reloading */ } await sleep(100); }
  throw new Error('timeout waiting for ' + label);
};
const perf = (tag) => ev(`({ tag: '${tag}', fps: +game.perf.fps.toFixed(1), physMs: +game.perf.phys.toFixed(2), renderCpuMs: +game.perf.render.toFixed(2), drawCalls: game.R.drawCalls, res: game.R.W + 'x' + game.R.H, scale: game.R.resScale || 1, glError: game.R.gl.getError(), state: game.state, ac: game.ac.state })`);

const R = {}, fail = [];
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL_ + (URL_.includes('?') ? '&' : '?') + 'r=' + Date.now() });
  const t0 = Date.now();
  await waitFor(`window.game && document.getElementById('loading').style.display === 'none'`, 60000, 'game init');
  R.loadMs = Date.now() - t0;
  await sleep(1500);
  R.gpu = await ev(`(() => { const gl = game.R.gl, x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);
  R.steps = [await perf('boot')]; await shot('1-boot');
  await key('Enter'); await sleep(1200); R.steps.push(await perf('title')); await shot('2-title');
  await key('Enter'); await sleep(1200); R.steps.push(await perf('cockpit')); await shot('3-cockpit');
  await keyDown('Equal'); await sleep(2600); await keyUp('Equal'); await sleep(2500);   // throttle to MIL, spool up
  await key('KeyC'); await sleep(9000);
  R.launch = await ev(`({ state: game.ac.state, altM: +game.ac.pos[1].toFixed(1), kt: +(game.ac.ias / 0.514444).toFixed(0) })`);
  if (R.launch.state !== 'fly' || R.launch.kt < 150 || R.launch.altM < 20) fail.push('catapult launch did not fly: ' + JSON.stringify(R.launch));
  await key('Digit3'); await sleep(800); R.steps.push(await perf('chase')); await shot('4-chase');
  await key('KeyK'); await sleep(800); R.steps.push(await perf('amiga')); await shot('5-amiga');
  await key('KeyK'); await sleep(800); R.steps.push(await perf('vector')); await shot('6-vector');
  await key('KeyK'); await key('Backquote'); await key('Digit1'); await sleep(1000); R.steps.push(await perf('cockpit-perf')); await shot('7-perf');
  for (const s of R.steps) if (s.glError) fail.push(`GL error ${s.glError} at ${s.tag}`);
  // lost context: the loop must stop and the loading screen explain; restoring reloads the page
  await ev(`(() => { window.__lose = game.R.gl.getExtension('WEBGL_lose_context'); window.__lose.loseContext(); return true; })()`);
  await sleep(700);
  R.contextLost = await ev(`({ lost: game.R.lost, overlayShown: document.getElementById('loading').style.display !== 'none', text: document.getElementById('loading').textContent })`);
  if (!R.contextLost.lost || !R.contextLost.overlayShown) fail.push('lost context not handled: ' + JSON.stringify(R.contextLost));
  await shot('8-lost');
  await ev(`(window.__lose.restoreContext(), true)`);
  await sleep(500);
  await waitFor(`window.game && !window.__lose && document.getElementById('loading').style.display === 'none'`, 60000, 'reload after restore');
  R.afterRestore = await ev(`({ state: game.state, lost: game.R.lost })`);
} catch (e) { fail.push(String(e.message || e)); }
R.logs = logs;
for (const l of logs) if (/^(EXCEPTION|console\.error|log\.error)/.test(l)) fail.push(l);
R.failures = fail;
console.log(JSON.stringify(R, null, 1));
console.log(fail.length ? `SMOKE TEST FAILED (${fail.length})` : 'SMOKE TEST PASSED');
ws.close();
process.exit(fail.length ? 1 : 0);
