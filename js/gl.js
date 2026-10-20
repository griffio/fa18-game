// WebGL2 renderer: flat-shaded polygons, anti-aliased instanced vector lines,
// procedural sky + sea, logarithmic depth, MSAA, bloom and an optional Amiga
// OCS 12-bit palette pass.
import { m4, m4mul, m4fromQT, m4perspective, m4ortho, m4invert, m4viewRot, vsub, qconj } from './math.js';

const LOGDEPTH = `uniform float uLogC;`;


// Interceptor-style ground dot field: jittered lattice of square dots in world
// space, ~constant size on screen. Each lattice level fades out once a pixel
// covers too much ground for it, so dense dots only appear close to the surface.
const DOTS = `
uniform float uPx;
vec2 hash2(vec2 c){
  uvec2 q = uvec2(ivec2(c) + ivec2(262144));
  q = q * uvec2(1664525u, 1013904223u);
  q.x += q.y * 1664525u; q.y += q.x * 1664525u;
  q = q ^ (q >> 16u);
  q.x += q.y * 1664525u; q.y += q.x * 1664525u;
  q = q ^ (q >> 16u);
  return vec2(q) * (1.0/4294967295.0);
}
// Jinv maps a ground offset (m) to a screen offset (px); wpp = ground metres per pixel
float dotLayer(vec2 xz, float S, float rpx, mat2 Jinv, float wpp){
  vec2 g = xz / S;
  vec2 c = floor(g);
  vec2 p = c + 0.18 + 0.64*hash2(c + vec2(S*7.0, S*13.0));
  vec2 pix = abs(Jinv * ((g - p) * S));
  float r = rpx * uPx;
  float a = clamp(r + 0.5 - max(pix.x, pix.y), 0.0, 1.0);   // square, pixel-like dots
  return a * (1.0 - smoothstep(S*0.035, S*0.09, wpp / uPx));
}
float dotField(vec2 xz){
  vec2 ddx = dFdx(xz), ddy = dFdy(xz);
  mat2 J = mat2(ddx, ddy);
  float det = determinant(J);
  if (abs(det) < 1e-8) return 0.0;
  mat2 Jinv = inverse(J);
  float wpp = max(length(ddx), length(ddy));
  float a = max(dotLayer(xz, 4.0, 1.0, Jinv, wpp), dotLayer(xz, 9.0, 1.1, Jinv, wpp));
  return max(a, max(dotLayer(xz, 45.0, 1.25, Jinv, wpp), dotLayer(xz, 220.0, 1.4, Jinv, wpp)));
}`;

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
uniform mat4 uModel; uniform mat4 uVP;
out vec3 vRel; out vec4 vCol; out float vW;
void main(){
  vec4 w = uModel*vec4(aPos,1.0);
  vRel = w.xyz; vCol = aCol;
  gl_Position = uVP*w; vW = gl_Position.w;
}`;
const FOG = `
uniform vec3 uFog; uniform float uFogDen;
float fogF(float d){
  float x = d*uFogDen;
  float f = 1.0 - exp(-x*x*0.6 - x*0.35);
  return clamp(f,0.0,1.0);
}`;
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vRel; in vec4 vCol; in float vW;
uniform vec3 uSun; uniform float uFillMix; uniform vec3 uFillCol; uniform float uGlow; uniform float uLevels; uniform vec4 uTint;
${LOGDEPTH}
${FOG}
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;
void main(){
  vec3 n = normalize(cross(dFdx(vRel), dFdy(vRel)));
  float diff = max(dot(n,uSun),0.0);
  float sh = 0.42 + 0.10*abs(n.y) + 0.58*diff;
  if(uLevels>0.0) sh = floor(sh*uLevels+0.5)/uLevels;
  vec3 c = mix(vCol.rgb, vCol.rgb*sh, vCol.a);
  c = mix(c, uFillCol*(0.55+0.45*sh), uFillMix*vCol.a);
  c = mix(c, uTint.rgb, uTint.a);
  float fg = fogF(length(vRel));
  c = mix(c, uFog, fg);
  o = vec4(c, 1.0);
  og = vec4(c*(1.0-vCol.a)*uGlow*(1.0-uTint.a)*(1.0-fg), 1.0);
  gl_FragDepth = log2(1.0+vW)*uLogC;
}`;

const TERR_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in float aMat;
uniform mat4 uVP; uniform vec3 uCam;
out vec3 vRel; out float vW; flat out float vH; flat out float vMat; out vec2 vWXZ;
void main(){
  vec3 r = aPos - uCam;
  vRel = r; vH = aPos.y; vMat = aMat; vWXZ = aPos.xz;
  gl_Position = uVP*vec4(r,1.0); vW = gl_Position.w;
}`;
const TERR_FS = `#version 300 es
precision highp float;
in vec3 vRel; in float vW; flat in float vH; flat in float vMat; in vec2 vWXZ;
uniform vec3 uSun; uniform float uFillMix; uniform vec3 uFillCol; uniform float uLevels;
uniform float uDots; uniform vec3 uLandDot; uniform float uLandDotMix; uniform float uDotGlow;
${LOGDEPTH}
${FOG}
${DOTS}
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;
vec3 pal(float h, float m, float ny){
  vec3 c;
  if(h < 3.5) c = vec3(0.80,0.74,0.52);
  else if(h < 40.0) c = vec3(0.30,0.55,0.22);
  else if(h < 110.0) c = vec3(0.35,0.56,0.24);
  else if(h < 220.0) c = vec3(0.45,0.53,0.27);
  else if(h < 380.0) c = vec3(0.52,0.48,0.30);
  else if(h < 560.0) c = vec3(0.56,0.46,0.33);
  else c = vec3(0.62,0.56,0.46);
  if(ny < 0.80) c = mix(c, vec3(0.50,0.42,0.32), 0.65);
  if(m > 0.5 && m < 1.5) c = mix(c, vec3(0.62,0.62,0.60), h < 160.0 ? 0.8 : 0.35);   // city
  if(m > 1.5 && m < 2.5) c = vec3(0.36,0.37,0.38);                                  // airfield
  if(m > 2.5) c = vec3(0.26,0.52,0.24);                                             // park
  if(h < 0.0) c = vec3(0.45,0.52,0.45);
  return c;
}
void main(){
  vec3 n = normalize(cross(dFdx(vRel), dFdy(vRel)));
  float diff = max(dot(n,uSun),0.0);
  float sh = 0.45 + 0.55*diff;
  if(uLevels>0.0) sh = floor(sh*uLevels+0.5)/uLevels;
  vec3 c = pal(vH, vMat, n.y) * sh;
  c = mix(c, uFillCol*(0.5+0.5*sh), uFillMix);
  float dt = uDots > 0.0 ? dotField(vWXZ) * uDots : 0.0;
  vec3 dc = mix(c * 0.45, uLandDot, uLandDotMix);
  c = mix(c, dc, dt);
  float fg = fogF(length(vRel));
  c = mix(c, uFog, fg);
  o = vec4(c, 1.0);
  og = vec4(uLandDot * dt * uDotGlow * (1.0 - fg), 1.0);
  gl_FragDepth = log2(1.0+vW)*uLogC;
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in vec4 aCol;
layout(location=4) in float aWidth;
uniform mat4 uModel; uniform mat4 uVP; uniform vec2 uRes; uniform float uWScale; uniform float uNear; uniform float uDetailFar; uniform float uMinW;
out vec4 vCol; out vec2 vLP; out float vLen; out float vHW; out float vInvW; out float vDist; out float vThin;
void main(){
  vec4 wa = uModel*vec4(aA,1.0), wb = uModel*vec4(aB,1.0);
  vec4 ca = uVP*wa, cb = uVP*wb;
  if((ca.w < uNear && cb.w < uNear) || aWidth < uMinW){ gl_Position = vec4(2.0,2.0,2.0,1.0); return; }
  if(ca.w < uNear){ float t=(uNear-ca.w)/(cb.w-ca.w); ca=mix(ca,cb,t); wa=mix(wa,wb,t);}
  else if(cb.w < uNear){ float t=(uNear-cb.w)/(ca.w-cb.w); cb=mix(cb,ca,t); wb=mix(wb,wa,t);}
  vec2 sa = (ca.xy/ca.w*0.5+0.5)*uRes, sb = (cb.xy/cb.w*0.5+0.5)*uRes;
  vec2 d = sb - sa; float len = length(d);
  vec2 dir = len > 1e-4 ? d/len : vec2(1.0,0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = aWidth*uWScale*0.5;
  float hw = max(w, 0.6);
  vThin = clamp(w/0.6, 0.0, 1.0);
  float ext = hw + 1.0;
  bool isB = aCorner.x > 0.5;
  vec2 p = (isB ? sb : sa) + dir*(isB ? ext : -ext) + nrm*aCorner.y*ext;
  vLP = vec2(isB ? len+ext : -ext, aCorner.y*ext);
  vLen = len; vHW = hw;
  vec4 c = isB ? cb : ca;
  vInvW = 1.0/c.w;
  vDist = length(isB ? wb.xyz : wa.xyz);
  // level of detail: hairline detail (cables, struts, hatching) fades out with distance
  float dmid = length(mix(wa.xyz, wb.xyz, 0.5));
  if (aWidth < 1.05) vThin *= clamp((uDetailFar - dmid)/(uDetailFar*0.5), 0.0, 1.0);
  else if (aWidth < 1.25) vThin *= clamp((uDetailFar*3.0 - dmid)/(uDetailFar*1.5), 0.0, 1.0);
  // fully faded detail (or invisible colour): collapse the quad so nothing is rasterised
  if (vThin <= 0.0 || aCol.a <= 0.0){ gl_Position = vec4(2.0,2.0,2.0,1.0); return; }
  vCol = aCol;
  gl_Position = vec4(p/uRes*2.0-1.0, 0.0, 1.0);
}`;
const LINE_FS = `#version 300 es
precision highp float;
in vec4 vCol; in vec2 vLP; in float vLen; in float vHW; in float vInvW; in float vDist; in float vThin;
uniform float uBias; uniform float uAdd; uniform float uIntensity; uniform float uGlowK;
${LOGDEPTH}
${FOG}
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;
void main(){
  float a = clamp(vLP.x, 0.0, vLen);
  float dd = length(vec2(vLP.x - a, vLP.y));
  float cov = clamp(vHW + 0.5 - dd, 0.0, 1.0) * vThin;
  if(cov <= 0.0) discard;
  float f = fogF(vDist);
  float al = vCol.a * cov * (1.0 - f*0.97);
  vec3 c = vCol.rgb * uIntensity;
  c = mix(c, uFog, f*(1.0-uAdd));
  o = vec4(c*al, al);
  og = vec4(vCol.rgb*uIntensity*al*uGlowK*(1.0-f), al);
  float w = 1.0/vInvW;
  gl_FragDepth = log2(1.0 + w*(1.0-uBias))*uLogC;
}`;

const FS_TRI_VS = `#version 300 es
out vec2 vUV;
void main(){
  vec2 p = vec2(gl_VertexID==1 ? 3.0 : -1.0, gl_VertexID==2 ? 3.0 : -1.0);
  vUV = p*0.5+0.5;
  gl_Position = vec4(p,0.0,1.0);
}`;
const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform mat4 uInvVP; uniform vec3 uSun; uniform vec3 uZen; uniform vec3 uHor; uniform vec3 uGnd; uniform float uSunAmt;
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;
void main(){
  vec4 p = uInvVP*vec4(vUV*2.0-1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz/p.w);
  float e = d.y;
  vec3 c;
  if(e >= 0.0) c = mix(uHor, uZen, pow(clamp(e,0.0,1.0), 0.45));
  else c = mix(uHor, uGnd, clamp(-e*6.0,0.0,1.0));
  float s = max(dot(d,uSun),0.0);
  c += uSunAmt*(vec3(1.0,0.9,0.7)*pow(s,8.0)*0.18 + vec3(1.0,0.95,0.85)*pow(s,300.0)*0.6);
  float disc = smoothstep(0.99955,0.99975,s);
  c = mix(c, vec3(1.25,1.2,1.05), disc*uSunAmt);
  o = vec4(c, 1.0);
  og = vec4(vec3(1.0,0.9,0.7)*(disc*0.9 + pow(s,40.0)*0.25)*uSunAmt, 1.0);
}`;
const SEA_VS = `#version 300 es
layout(location=0) in vec2 aXZ;
uniform mat4 uVP; uniform vec3 uCam; uniform float uR;
out vec3 vRel; out vec2 vWXZ; out float vW;
void main(){
  vec3 r = vec3(aXZ.x*uR, -uCam.y, aXZ.y*uR);
  vRel = r; vWXZ = r.xz + uCam.xz;
  gl_Position = uVP*vec4(r,1.0); vW = gl_Position.w;
}`;
const SEA_FS = `#version 300 es
precision highp float;
in vec3 vRel; in vec2 vWXZ; in float vW;
uniform vec3 uSun; uniform vec3 uSea; uniform vec3 uSeaFar; uniform vec3 uGrid; uniform float uGridA;
uniform float uDots; uniform vec3 uSeaDot; uniform float uDotGlow;
${LOGDEPTH}
${FOG}
${DOTS}
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;
void main(){
  float d = length(vRel);
  vec3 v = vRel/d;
  float graze = clamp(-v.y, 0.0, 1.0);
  vec3 c = mix(uSeaFar, uSea, pow(graze, 0.35));
  vec3 h = normalize(uSun - v);
  float sp = pow(max(h.y,0.0), 900.0);
  c += vec3(1.0,0.95,0.8)*sp*0.5;
  float glow = 0.0;
  if(uGridA > 0.0){
    vec2 g = vWXZ/400.0;
    vec2 fw = fwidth(g);
    vec2 gg = abs(fract(g-0.5)-0.5)/max(fw,1e-5);
    float line = 1.0 - clamp(min(gg.x,gg.y), 0.0, 1.0);
    float fade = exp(-d/9000.0) * clamp(1.0 - max(fw.x,fw.y)*2.5, 0.0, 1.0);
    c = mix(c, uGrid, line*uGridA*fade);
    glow = line*fade*uGridA*0.6;
  }
  float dt = uDots > 0.0 ? dotField(vWXZ) * uDots : 0.0;
  c = mix(c, uSeaDot, dt);
  float fg = fogF(d);
  c = mix(c, uFog, fg);
  o = vec4(c, 1.0);
  og = vec4((uGrid*glow + uSeaDot*dt*uDotGlow)*(1.0-fg), 1.0);
  gl_FragDepth = log2(1.0+vW)*uLogC;
}`;

const SFILL_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aCol;
uniform vec2 uRes;
out vec4 vCol;
void main(){ vCol = aCol; gl_Position = vec4(aPos.x/uRes.x*2.0-1.0, 1.0-aPos.y/uRes.y*2.0, 0.0, 1.0); }`;
const SFILL_FS = `#version 300 es
precision highp float;
in vec4 vCol;
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;
void main(){ o = vec4(vCol.rgb*vCol.a, vCol.a); og = vec4(0.0,0.0,0.0,vCol.a); }`;

// --- post
const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel;
out vec4 o;
void main(){
  vec3 acc = vec3(0.0);
  for(int i=0;i<4;i++){
    vec2 off = vec2(i==1||i==3 ? 1.0 : -1.0, i>=2 ? 1.0 : -1.0)*uTexel*0.5;
    acc += texture(uTex, vUV+off).rgb;
  }
  o = vec4(acc*0.25, 1.0);
}`;
const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel;
out vec4 o;
void main(){
  vec3 c = texture(uTex, vUV).rgb*4.0;
  c += texture(uTex, vUV+vec2(-1,-1)*uTexel).rgb;
  c += texture(uTex, vUV+vec2( 1,-1)*uTexel).rgb;
  c += texture(uTex, vUV+vec2(-1, 1)*uTexel).rgb;
  c += texture(uTex, vUV+vec2( 1, 1)*uTexel).rgb;
  o = vec4(c/8.0, 1.0);
}`;
const UP_FS = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel;
out vec4 o;
void main(){
  vec3 c = vec3(0.0);
  c += texture(uTex, vUV+vec2(-2,0)*uTexel).rgb;
  c += texture(uTex, vUV+vec2(2,0)*uTexel).rgb;
  c += texture(uTex, vUV+vec2(0,-2)*uTexel).rgb;
  c += texture(uTex, vUV+vec2(0,2)*uTexel).rgb;
  c += texture(uTex, vUV+vec2(-1,-1)*uTexel).rgb*2.0;
  c += texture(uTex, vUV+vec2(1,-1)*uTexel).rgb*2.0;
  c += texture(uTex, vUV+vec2(-1,1)*uTexel).rgb*2.0;
  c += texture(uTex, vUV+vec2(1,1)*uTexel).rgb*2.0;
  o = vec4(c/12.0, 1.0);
}`;
const COMP_FS = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uScene; uniform sampler2D uBloom;
uniform float uBloomAmt; uniform float uOCS; uniform float uScan; uniform vec2 uRes; uniform float uFlash; uniform vec3 uFlashCol; uniform float uFade;
out vec4 o;
void main(){
  vec3 c = texture(uScene, vUV).rgb;
  if(uOCS > 0.5){
    // Amiga OCS: 4 bits per gun
    c = floor(clamp(c,0.0,1.0)*15.0+0.5)/15.0;
  }
  vec3 b = texture(uBloom, vUV).rgb;
  c += b*uBloomAmt;
  if(uScan > 0.0){
    float y = vUV.y*uRes.y;
    float s = 0.5+0.5*cos(y*3.14159*0.5);
    c *= 1.0 - uScan*0.18*s;
  }
  vec2 q = vUV-0.5;
  c *= 1.0 - dot(q,q)*0.45;
  c = mix(c, uFlashCol, uFlash);
  c *= uFade;
  o = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log, src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    throw new Error('shader compile failed: ' + log);
  }
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link failed: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

// ----------------------------------------------------------------- styles
export const STYLES = {
  hybrid: {
    name: 'HYBRID', lineGlow: 0.4, fillMix: 0.0, levels: 0, lineInt: 1.0, lineAdd: 0.6, bloom: 0.85, ocs: false, scan: 0.35,
    zen: [0.09, 0.20, 0.52], hor: [0.56, 0.68, 0.82], gnd: [0.5, 0.58, 0.66],
    sea: [0.10, 0.27, 0.52], seaFar: [0.36, 0.5, 0.68], grid: [0.55, 0.85, 1.0], gridA: 0.0,
    dots: 0.85, seaDot: [0.78, 0.9, 1.0], landDot: [0.1, 0.16, 0.08], landDotMix: 0.0, dotGlow: 0.15,
    fog: [0.56, 0.68, 0.82], fillCol: [0, 0, 0], edgeScale: 1.0, sun: 1.0,
  },
  amiga: {
    name: 'AMIGA OCS', lineGlow: 0.4, minW: 1.35, noTerrainLines: true, fillMix: 0.0, levels: 5, lineInt: 0.9, lineAdd: 0.0, bloom: 0.25, ocs: true, scan: 0.6,
    zen: [0.13, 0.26, 0.67], hor: [0.60, 0.73, 0.93], gnd: [0.55, 0.62, 0.68],
    sea: [0.13, 0.27, 0.60], seaFar: [0.35, 0.50, 0.78], grid: [0.5, 0.7, 1.0], gridA: 0.0,
    dots: 1.0, seaDot: [0.8, 0.87, 1.0], landDot: [0.13, 0.2, 0.07], landDotMix: 0.0, dotGlow: 0.0,
    fog: [0.60, 0.73, 0.93], fillCol: [0, 0, 0], edgeScale: 1.0, sun: 0.6,
  },
  vector: {
    name: 'VECTOR', lineGlow: 0.75, fillMix: 0.94, levels: 0, lineInt: 1.1, lineAdd: 1.0, bloom: 1.1, ocs: false, scan: 0.5,
    zen: [0.0, 0.0, 0.02], hor: [0.02, 0.05, 0.10], gnd: [0.0, 0.02, 0.04],
    sea: [0.0, 0.015, 0.04], seaFar: [0.01, 0.04, 0.09], grid: [0.1, 0.6, 0.9], gridA: 0.35,
    dots: 1.0, seaDot: [0.35, 0.85, 1.0], landDot: [0.4, 1.0, 0.45], landDotMix: 1.0, dotGlow: 0.6,
    fog: [0.02, 0.05, 0.10], fillCol: [0.02, 0.05, 0.06], edgeScale: 1.25, sun: 0.0,
  },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    // a lost context (GPU reset, iOS reclaiming memory) takes every buffer, texture and
    // program with it: stop drawing and let the game decide what to tell the player
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; if (this.onLost) this.onLost(); });
    canvas.addEventListener('webglcontextrestored', () => { if (this.onRestored) this.onRestored(); });
    this.hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.progMesh = program(gl, MESH_VS, MESH_FS);
    this.progTerr = program(gl, TERR_VS, TERR_FS);
    this.progLine = program(gl, LINE_VS, LINE_FS);
    this.progSky = program(gl, FS_TRI_VS, SKY_FS);
    this.progSea = program(gl, SEA_VS, SEA_FS);
    this.progSFill = program(gl, SFILL_VS, SFILL_FS);
    this.progBright = program(gl, FS_TRI_VS, BRIGHT_FS);
    this.progDown = program(gl, FS_TRI_VS, DOWN_FS);
    this.progUp = program(gl, FS_TRI_VS, UP_FS);
    this.progComp = program(gl, FS_TRI_VS, COMP_FS);

    // line corner buffer
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    // sea quad
    this.seaVao = gl.createVertexArray();
    gl.bindVertexArray(this.seaVao);
    const sb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sb);
    // concentric rings so the huge plane interpolates well
    const seaV = [];
    const rs = [0, 0.002, 0.01, 0.04, 0.15, 0.4, 1.0];
    for (let r = 0; r < rs.length - 1; r++) {
      for (let i = 0; i < 32; i++) {
        const a0 = (i / 32) * Math.PI * 2, a1 = ((i + 1) / 32) * Math.PI * 2;
        const r0 = rs[r], r1 = rs[r + 1];
        const P = (rr, a) => [Math.cos(a) * rr, Math.sin(a) * rr];
        const p00 = P(r0, a0), p01 = P(r0, a1), p10 = P(r1, a0), p11 = P(r1, a1);
        seaV.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seaV), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.seaCount = seaV.length / 2;
    gl.bindVertexArray(null);
    this.emptyVao = gl.createVertexArray();

    // screen fill dynamic buffer
    this.sfillVao = gl.createVertexArray();
    this.sfillBuf = gl.createBuffer();
    gl.bindVertexArray(this.sfillVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sfillBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
    this.screenLines = this.createLines(null, 20000);

    this.style = STYLES.hybrid;
    this.far = 250000;
    this.near = 0.25;
    this.time = 0;
    this.flash = 0; this.flashCol = [1, 1, 1]; this.fade = 1;
    this.resize();
  }

  setStyle(name) { if (!STYLES[name]) name = 'hybrid'; this.style = STYLES[name]; this.styleName = name; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth || window.innerWidth, ch = this.canvas.clientHeight || window.innerHeight;
    let scale = dpr * (this.resScale || 1);
    const maxPix = 4.2e6 * (this.resScale || 1) ** 2;
    if (cw * ch * scale * scale > maxPix) scale = Math.sqrt(maxPix / (cw * ch));
    const w = Math.max(2, Math.round(cw * scale)), h = Math.max(2, Math.round(ch * scale));
    this.cssW = cw; this.cssH = ch; this.pxScale = scale;
    if (this.canvas.width === w && this.canvas.height === h && this.fb) return;
    this.canvas.width = w; this.canvas.height = h;
    this.W = w; this.H = h;
    this._makeTargets();
  }

  _tex(w, h, float) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb, w, h };
  }

  _makeTargets() {
    const gl = this.gl;
    const { W, H } = this;
    const del = (o) => { if (!o) return; if (o.t) gl.deleteTexture(o.t); if (o.fb) gl.deleteFramebuffer(o.fb); };
    if (this.msFb) { gl.deleteFramebuffer(this.msFb); gl.deleteRenderbuffer(this.msColor); gl.deleteRenderbuffer(this.msGlow); gl.deleteRenderbuffer(this.msDepth); }
    del(this.scene); del(this.glow); (this.blooms || []).forEach(del);
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    this.msFb = gl.createFramebuffer();
    this.msColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H);
    this.msGlow = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msGlow);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H);
    this.msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, this.msGlow);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    this.scene = this._tex(W, H, false);
    this.glow = this._tex(W, H, false);
    this.blooms = [];
    let w = W >> 1, h = H >> 1;
    for (let i = 0; i < 6 && w > 4 && h > 4; i++) { this.blooms.push(this._tex(w, h, this.hasFloat)); w >>= 1; h >>= 1; }
    this.fb = true;
  }

  // ------------------------------------------------------------ resources
  createMesh(verts) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    return { vao, buf: b, count: verts.length / 7 };
  }
  createLines(data, capacity = 0) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const n = data ? data.length / 11 : 0;
    if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    else gl.bufferData(gl.ARRAY_BUFFER, capacity * 44, gl.DYNAMIC_DRAW);
    const attr = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 44, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 3, 0); attr(2, 3, 12); attr(3, 4, 24); attr(4, 1, 40);
    gl.bindVertexArray(null);
    return { vao, buf: b, count: n, capacity: data ? n : capacity };
  }
  updateLines(obj, data, count) {
    const gl = this.gl;
    if (count > obj.capacity) count = obj.capacity;
    gl.bindBuffer(gl.ARRAY_BUFFER, obj.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 11);
    obj.count = count;
  }
  createTerrain(pos, mat, idx) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const m = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m);
    gl.bufferData(gl.ARRAY_BUFFER, mat, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length };
  }

  // ------------------------------------------------------------ frame
  // cam: {pos:[x,y,z] (double), q, fovy, shiftY}
  beginFrame(cam, sunDir, fogDen) {
    const gl = this.gl;
    this.resize();
    this.cam = cam;
    this.sun = sunDir;
    this.fogDen = fogDen;
    this.logC = 1 / Math.log2(this.far + 1);
    const aspect = this.W / this.H;
    this.proj = m4perspective(cam.fovy, aspect, this.near, this.far, cam.shiftY || 0);
    this.viewRot = m4viewRot(cam.q);
    this.vp = m4mul(this.proj, this.viewRot);
    this.invVP = m4invert(this.vp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFb);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    this.slCount = 0; this.sfCount = 0;
    this.lineQueue = [];
    this.drawCalls = 0;
  }

  _common(u) {
    const gl = this.gl, s = this.style;
    if (u.uLogC) gl.uniform1f(u.uLogC, this.logC);
    if (u.uFog) gl.uniform3fv(u.uFog, s.fog);
    if (u.uFogDen) gl.uniform1f(u.uFogDen, this.fogDen);
    if (u.uSun) gl.uniform3fv(u.uSun, this.sun);
    if (u.uVP) gl.uniformMatrix4fv(u.uVP, false, this.vp);
  }

  drawSky() {
    const gl = this.gl, s = this.style;
    const { p, u } = this.progSky;
    gl.useProgram(p);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.uniformMatrix4fv(u.uInvVP, false, this.invVP);
    gl.uniform3fv(u.uSun, this.sun);
    gl.uniform3fv(u.uZen, s.zen); gl.uniform3fv(u.uHor, s.hor); gl.uniform3fv(u.uGnd, s.gnd);
    gl.uniform1f(u.uSunAmt, s.sun);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawSea() {
    const gl = this.gl, s = this.style;
    const { p, u } = this.progSea;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.BLEND);
    this._common(u);
    gl.uniform3fv(u.uCam, this.cam.pos);
    gl.uniform1f(u.uR, 240000);
    gl.uniform3fv(u.uSea, s.sea); gl.uniform3fv(u.uSeaFar, s.seaFar);
    gl.uniform3fv(u.uGrid, s.grid); gl.uniform1f(u.uGridA, s.gridA);
    gl.uniform1f(u.uPx, this.pxScale);
    gl.uniform1f(u.uDots, this.dotsOn === false ? 0 : (s.dots || 0));
    gl.uniform3fv(u.uSeaDot, s.seaDot || [1, 1, 1]);
    gl.uniform1f(u.uDotGlow, s.dotGlow || 0);
    gl.bindVertexArray(this.seaVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.seaCount);
  }

  drawTerrain(t) {
    const gl = this.gl, s = this.style;
    const { p, u } = this.progTerr;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.BLEND);
    this._common(u);
    gl.uniform3fv(u.uCam, this.cam.pos);
    gl.uniform1f(u.uFillMix, s.fillMix);
    gl.uniform3fv(u.uFillCol, s.fillCol);
    gl.uniform1f(u.uLevels, s.levels);
    gl.uniform1f(u.uPx, this.pxScale);
    gl.uniform1f(u.uDots, this.dotsOn === false ? 0 : (s.dots || 0));
    gl.uniform3fv(u.uLandDot, s.landDot || [0, 0, 0]);
    gl.uniform1f(u.uLandDotMix, s.landDotMix || 0);
    gl.uniform1f(u.uDotGlow, s.dotGlow || 0);
    gl.bindVertexArray(t.vao);
    gl.drawElements(gl.TRIANGLES, t.count, gl.UNSIGNED_INT, 0);
    this.drawCalls++;
  }

  // model matrix relative to camera from quaternion + double-precision position
  rel(q, pos, s = 1) {
    const c = this.cam.pos;
    return m4fromQT(q, [pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]], s);
  }
  relWorld() { const c = this.cam.pos; const m = m4(); m[12] = -c[0]; m[13] = -c[1]; m[14] = -c[2]; return m; }

  drawMesh(mesh, model, glow = 1, alpha = false, tint = null) {
    if (!mesh || !mesh.count) return;
    const gl = this.gl, s = this.style;
    const { p, u } = this.progMesh;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.BLEND);
    this._common(u);
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniform1f(u.uFillMix, s.fillMix);
    gl.uniform3fv(u.uFillCol, s.fillCol);
    gl.uniform1f(u.uLevels, s.levels);
    gl.uniform1f(u.uGlow, glow);
    gl.uniform4fv(u.uTint, tint || [0, 0, 0, 0]);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    this.drawCalls++;
  }

  // lines: world-space vector lines. opts: {bias, intensity, add, wscale, always}
  drawLines(lines, model, opts = {}) {
    if (!lines || !lines.count) return;
    if (this.lineQueue) { this.lineQueue.push([lines, model, opts]); return; }
    this._drawLines(lines, model, opts);
  }
  flushLines() {
    const q = this.lineQueue;
    this.lineQueue = null;
    if (q) for (const [l, m, o] of q) this._drawLines(l, m, o);
  }
  _drawLines(lines, model, opts = {}) {
    if (!lines || !lines.count) return;
    const gl = this.gl, s = this.style;
    const inten = (opts.intensity ?? 1) * (opts.styleFree ? 1 : s.lineInt);
    if (inten <= 0) return;
    if (opts.terrain && s.noTerrainLines) return;
    const { p, u } = this.progLine;
    gl.useProgram(p);
    if (opts.always) gl.disable(gl.DEPTH_TEST); else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); }
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    const add = opts.add ?? s.lineAdd;
    if (add >= 0.99) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    this._common(u);
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniform2f(u.uRes, this.W, this.H);
    gl.uniform1f(u.uWScale, this.pxScale * (opts.wscale ?? 1) * (opts.styleFree ? 1 : (s.edgeScale || 1)));
    gl.uniform1f(u.uNear, this.near);
    gl.uniform1f(u.uDetailFar, opts.detailFar ?? 4000);
    gl.uniform1f(u.uMinW, opts.styleFree ? 0 : (s.minW || 0));
    gl.uniform1f(u.uBias, opts.bias ?? 0.0025);
    gl.uniform1f(u.uAdd, add);
    gl.uniform1f(u.uIntensity, inten);
    gl.uniform1f(u.uGlowK, (opts.glow ?? 1) * (opts.styleFree ? 1 : s.lineGlow));
    gl.bindVertexArray(lines.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lines.count);
    this.drawCalls++;
    gl.depthMask(true);
  }

  // ------------------------------------------------------------ screen-space 2D (HUD, panel)
  // coordinates in CSS pixels, origin top-left
  sline(x1, y1, x2, y2, c, w = 1.5) {
    if (!this.slData) this.slData = new Float32Array(20000 * 11);
    if (this.slCount >= 20000) return;
    const o = this.slCount * 11, d = this.slData;
    d[o] = x1; d[o + 1] = y1; d[o + 2] = 0; d[o + 3] = x2; d[o + 4] = y2; d[o + 5] = 0;
    d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = c[3] ?? 1; d[o + 10] = w;
    this.slCount++;
  }
  sfill(pts, c) {
    // convex polygon fan in CSS px
    if (!this.sfData) this.sfData = new Float32Array(60000 * 6);
    const d = this.sfData;
    for (let i = 1; i < pts.length - 1; i++) {
      for (const p of [pts[0], pts[i], pts[i + 1]]) {
        if (this.sfCount >= 60000) return;
        const o = this.sfCount * 6;
        d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = c[0]; d[o + 3] = c[1]; d[o + 4] = c[2]; d[o + 5] = c[3] ?? 1;
        this.sfCount++;
      }
    }
  }
  srect(x, y, w, h, c) { this.sfill([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c); }

  flushScreen() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    if (this.sfCount) {
      const { p, u } = this.progSFill;
      gl.useProgram(p);
      gl.uniform2f(u.uRes, this.cssW, this.cssH);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sfillBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.sfData.subarray(0, this.sfCount * 6), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(this.sfillVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.sfCount);
    }
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    if (this.slCount) {
      this.updateLines(this.screenLines, this.slData, this.slCount);
      const { p, u } = this.progLine;
      gl.useProgram(p);
      const ortho = m4ortho(0, this.cssW, this.cssH, 0);
      gl.uniformMatrix4fv(u.uModel, false, m4());
      gl.uniformMatrix4fv(u.uVP, false, ortho);
      gl.uniform2f(u.uRes, this.W, this.H);
      gl.uniform1f(u.uWScale, this.pxScale);
      gl.uniform1f(u.uNear, -10);
      gl.uniform1f(u.uDetailFar, 1e9);
      gl.uniform1f(u.uMinW, 0);
      gl.uniform1f(u.uBias, 0);
      gl.uniform1f(u.uAdd, 0.0);
      gl.uniform1f(u.uIntensity, 1);
      gl.uniform1f(u.uGlowK, this.screenGlow ?? 0.6);
      gl.uniform1f(u.uLogC, this.logC);
      gl.uniform1f(u.uFogDen, 0);
      gl.uniform3fv(u.uFog, [0, 0, 0]);
      gl.bindVertexArray(this.screenLines.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.screenLines.count);
    }
    this.slCount = 0; this.sfCount = 0;
    gl.depthMask(true);
  }

  // ------------------------------------------------------------ post
  _pass(prog, target, tex, texel, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.W, target ? target.h : this.H);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (prog.u.uTex) gl.uniform1i(prog.u.uTex, 0);
    if (prog.u.uTexel && texel) gl.uniform2f(prog.u.uTexel, texel[0], texel[1]);
    if (setup) setup(prog.u);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  endFrame() {
    const gl = this.gl, s = this.style;
    // resolve MSAA
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scene.fb);
    gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.glow.fb);
    gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // the multisampled colour and depth buffers are finished with: on tile-based GPUs
    // (Apple, Mali, Adreno) this lets the driver skip writing them back to memory
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.DEPTH_ATTACHMENT]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const B = this.blooms;
    this._pass(this.progBright, B[0], this.glow.t, [1 / this.W, 1 / this.H]);
    for (let i = 1; i < B.length; i++) this._pass(this.progDown, B[i], B[i - 1].t, [1 / B[i - 1].w, 1 / B[i - 1].h]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = B.length - 1; i > 0; i--) this._pass(this.progUp, B[i - 1], B[i].t, [1 / B[i].w, 1 / B[i].h]);
    gl.disable(gl.BLEND);
    this._pass(this.progComp, null, this.scene.t, null, (u) => {
      gl.uniform1i(u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, B[0].t);
      gl.uniform1i(u.uBloom, 1);
      gl.uniform1f(u.uBloomAmt, s.bloom);
      gl.uniform1f(u.uOCS, s.ocs ? 1 : 0);
      gl.uniform1f(u.uScan, this.scanlines ? s.scan : 0);
      gl.uniform2f(u.uRes, this.W, this.H);
      gl.uniform1f(u.uFlash, this.flash);
      gl.uniform3fv(u.uFlashCol, this.flashCol);
      gl.uniform1f(u.uFade, this.fade);
      gl.activeTexture(gl.TEXTURE0);
    });
  }

  // project a world-space point to CSS pixel coords (null if behind)
  project(p) {
    const c = this.cam.pos;
    const r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return this.projectRel(r);
  }
  projectRel(r) {
    const m = this.vp;
    const x = m[0] * r[0] + m[4] * r[1] + m[8] * r[2] + m[12];
    const y = m[1] * r[0] + m[5] * r[1] + m[9] * r[2] + m[13];
    const w = m[3] * r[0] + m[7] * r[1] + m[11] * r[2] + m[15];
    if (w <= 0.01) return null;
    return [(x / w * 0.5 + 0.5) * this.cssW, (1 - (y / w * 0.5 + 0.5)) * this.cssH, w];
  }
  // project a direction (camera-relative, at infinity)
  projectDir(d) { return this.projectRel([d[0] * 1e4, d[1] * 1e4, d[2] * 1e4]); }
}
