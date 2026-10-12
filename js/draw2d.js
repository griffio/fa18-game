// Screen-space vector drawing helpers (CSS pixel coordinates) on top of the
// renderer's screen line batch, so HUD and panels get the same AA + bloom.
import { textSegments, textWidth } from './vfont.js';

export class Draw2D {
  constructor(R) { this.R = R; }
  line(x1, y1, x2, y2, c, w = 1.5) { this.R.sline(x1, y1, x2, y2, c, w); }
  poly(pts, c, w = 1.5, closed = false) {
    for (let i = 0; i < pts.length - 1; i++) this.R.sline(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], c, w);
    if (closed && pts.length > 2) { const a = pts[pts.length - 1], b = pts[0]; this.R.sline(a[0], a[1], b[0], b[1], c, w); }
  }
  circle(x, y, r, c, w = 1.5, n = 24, a0 = 0, a1 = Math.PI * 2) {
    let px = x + Math.cos(a0) * r, py = y + Math.sin(a0) * r;
    for (let i = 1; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      const nx = x + Math.cos(a) * r, ny = y + Math.sin(a) * r;
      this.R.sline(px, py, nx, ny, c, w);
      px = nx; py = ny;
    }
  }
  rect(x, y, w, h, c, lw = 1.5) { this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c, lw, true); }
  text(str, x, y, size, c, align = 'left', w = 1.4, spacing = 1.5) {
    textSegments(String(str), x, y, size, align, (x1, y1, x2, y2) => this.R.sline(x1, y1, x2, y2, c, w), spacing);
  }
  // text rotated about (x,y)
  textRot(str, x, y, size, c, ang, align = 'center', w = 1.4) {
    const cs = Math.cos(ang), sn = Math.sin(ang);
    textSegments(String(str), 0, -size / 2, size, align, (x1, y1, x2, y2) => {
      this.R.sline(x + x1 * cs - y1 * sn, y + x1 * sn + y1 * cs, x + x2 * cs - y2 * sn, y + x2 * sn + y2 * cs, c, w);
    });
  }
  tw(str, size) { return textWidth(String(str), size); }
  fill(pts, c) { this.R.sfill(pts, c); }
  fillRect(x, y, w, h, c) { this.R.srect(x, y, w, h, c); }
}
