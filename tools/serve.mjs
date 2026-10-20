// Static dev server with caching disabled.
//   node tools/serve.mjs [port] [--host 0.0.0.0]      (npm start)
// Browsers key their cache on origin + path, so serving two projects from localhost:8000
// in turn can hand the game another project's cached modules: python3 -m http.server
// answers 304 Not Modified for any file older than the cached copy, and the game then
// dies on the loading screen with an import error. Cache-Control: no-store prevents it.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const port = +(args.find((a) => /^\d+$/.test(a)) || 8000);
const hi = args.indexOf('--host');
const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 ' + p); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(port, host, () => {
  console.log(`serving ${root} with caching off`);
  console.log(`  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  if (host === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${port}/  (iPad / other devices)`);
  }
});
