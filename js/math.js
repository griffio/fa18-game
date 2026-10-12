// Small math library. Vectors are plain [x,y,z] arrays, quaternions [x,y,z,w],
// matrices Float32Array(16) column-major (WebGL convention).
//
// World frame: +X east, +Y up, +Z south (so north is -Z).
// Body frame:  +X right wing, +Y up, +Z aft (nose points -Z).

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G0 = 9.80665;
export const KT = 0.514444;          // m/s per knot
export const FT = 0.3048;            // m per foot
export const NM = 1852;              // m per nautical mile

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrapPi = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};
export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const sign = (x) => (x < 0 ? -1 : 1);

// ---------------------------------------------------------------- vec3
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vmadd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vnorm = (a) => {
  const l = vlen(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const vneg = (a) => [-a[0], -a[1], -a[2]];
export const vcopy = (a) => [a[0], a[1], a[2]];

// ---------------------------------------------------------------- quaternion
export const qident = () => [0, 0, 0, 1];
export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
export function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qaxis(axis, ang) {
  const s = Math.sin(ang / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
}
// rotate vector v by quaternion q
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
// inverse rotate (world -> body)
export const qrotInv = (q, v) => qrot(qconj(q), v);

// Heading (clockwise from north), pitch (nose up), roll (right wing down), radians.
export function qfromEuler(hdg, pitch, roll) {
  const qy = qaxis([0, 1, 0], -hdg);
  const qp = qaxis([1, 0, 0], pitch);
  const qr = qaxis([0, 0, 1], -roll);
  return qnorm(qmul(qmul(qy, qp), qr));
}
export function eulerFromQ(q) {
  const f = qrot(q, [0, 0, -1]);
  const u = qrot(q, [0, 1, 0]);
  const r = qrot(q, [1, 0, 0]);
  const pitch = Math.asin(clamp(f[1], -1, 1));
  let hdg;
  if (Math.abs(f[1]) > 0.999) hdg = Math.atan2(-u[0] * sign(f[1]), u[2] * sign(f[1]));
  else hdg = Math.atan2(f[0], -f[2]);
  const roll = Math.atan2(-r[1], u[1]);
  return { hdg, pitch, roll, f, u, r };
}
// integrate body angular velocity w (rad/s, body axes) over dt
export function qintegrate(q, w, dt) {
  const ang = Math.hypot(w[0], w[1], w[2]) * dt;
  if (ang < 1e-12) return q;
  const ax = [w[0] * dt / ang, w[1] * dt / ang, w[2] * dt / ang];
  return qnorm(qmul(q, qaxis(ax, ang)));
}
export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) {
    return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}
// quaternion that orients body so that -Z points along dir, +Y near up
export function qlookDir(dir, up = [0, 1, 0]) {
  const f = vnorm(dir);
  let r = vcross(f, up);
  if (vlen(r) < 1e-6) r = vcross(f, [0, 0, 1]);
  r = vnorm(r);
  const u = vcross(r, f);
  // matrix columns: x=r, y=u, z=-f
  return qfromBasis(r, u, vneg(f));
}
export function qfromBasis(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return qnorm(q);
}

// ---------------------------------------------------------------- mat4
export function m4() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function m4mul(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}
// rotation (from quaternion) + translation
export function m4fromQT(q, t, s = 1) {
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s; m[1] = 2 * (x * y + z * w) * s; m[2] = 2 * (x * z - y * w) * s;
  m[4] = 2 * (x * y - z * w) * s; m[5] = (1 - 2 * (x * x + z * z)) * s; m[6] = 2 * (y * z + x * w) * s;
  m[8] = 2 * (x * z + y * w) * s; m[9] = 2 * (y * z - x * w) * s; m[10] = (1 - 2 * (x * x + y * y)) * s;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
export function m4translate(t) { const m = m4(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; }
// rotation-only view matrix from camera orientation quaternion
export function m4viewRot(q) { return m4fromQT(qconj(q), [0, 0, 0]); }
export function m4perspective(fovy, aspect, near, far, shiftY = 0) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[9] = shiftY;                       // lens shift (moves image centre vertically)
  m[10] = (far + near) / (near - far); m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}
export function m4ortho(l, r, b, t, n = -1, f = 1) {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1;
  return m;
}
export function m4xform(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}
export function m4xform4(m, v, w = 1) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w,
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w,
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w,
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * w,
  ];
}
// general 4x4 inverse
export function m4invert(a) {
  const o = new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return m4();
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

// ---------------------------------------------------------------- noise
// deterministic hash-based value noise for terrain + turbulence
export function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}
export function fbm2(x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise2(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}
// 1D smooth noise for time-varying signals
export function vnoise1(t, seed = 0) { return vnoise2(t, seed * 17.13); }

// seeded RNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// colour helper: '#rrggbb' -> [r,g,b,a]
export function hex(h, a = 1) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}
