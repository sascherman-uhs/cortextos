'use client';

// === JARVIS MOD #29 — Cosmos orb shader material (2026-07-06) ===
// Custom GLSL for the centerpiece orb: layered 3D simplex-noise displacement so
// the surface "breathes"/roils at rest, plus a fresnel rim so silhouette edges
// glow brighter than the center (energy-field look). Exposed as plain
// THREE.ShaderMaterial factories (no drei extend/JSX-tag typing) to keep
// `tsc --noEmit` clean and avoid runtime unknown-element errors.
//
// Classic Ashima/Gustavson simplex noise (public domain) is inlined so no npm
// dependency is added.

import * as THREE from 'three';

const SIMPLEX_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const ORB_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uFreq;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying float vDisp;
${SIMPLEX_GLSL}
void main(){
  vec3 p = position;
  // Two drifting octaves of noise displace the surface along its normal.
  float n1 = snoise(normalize(position) * uFreq + uTime * 0.25);
  float n2 = snoise(normalize(position) * uFreq * 2.1 + uTime * 0.4);
  float disp = (n1 + 0.5 * n2) * uAmp;
  vDisp = disp;
  p += normal * disp;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormalW = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const ORB_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform float uBrightness;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying float vDisp;
void main(){
  float fres = pow(1.0 - clamp(dot(vViewDir, vNormalW), 0.0, 1.0), 2.0);
  // Silhouette edges read as a bright energy rim; interior is dimmer/cooler.
  vec3 col = mix(uColor * 0.65, uRimColor * 1.4, fres);
  col += uRimColor * max(vDisp, 0.0) * 1.4;
  float a = (0.28 + fres * 0.72) * uBrightness;
  gl_FragColor = vec4(col * uBrightness, a);
}
`;

const GLOW_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vViewDir;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalW = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

// === JARVIS MOD #57 (2026-08-03): uPower makes the falloff a parameter so ONE
// factory can produce all three spec'd layers — a wide soft atmospheric bloom
// (low power = broad), a medium halo, and a tight bright inner core. uCore
// flips the profile: 0 = brightest at the silhouette rim (shells), 1 =
// brightest at the center (the core layer). ===
const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
uniform float uPower;
uniform float uCore;
varying vec3 vNormalW;
varying vec3 vViewDir;
void main(){
  float facing = clamp(dot(vViewDir, vNormalW), 0.0, 1.0);
  float rim = pow(1.0 - facing, uPower);
  float core = pow(facing, uPower);
  float a = mix(rim, core, uCore);
  gl_FragColor = vec4(uColor, a * uStrength);
}
`;
// === END JARVIS MOD #57 ===

export interface OrbUniforms {
  uTime: { value: number };
  uAmp: { value: number };
  uFreq: { value: number };
  uColor: { value: THREE.Color };
  uRimColor: { value: THREE.Color };
  uBrightness: { value: number };
}

/** Wireframe icosahedron shader material with noise displacement + fresnel rim. */
export function createOrbMaterial(color: string, rim: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAmp: { value: 0.12 },
      uFreq: { value: 1.6 },
      uColor: { value: new THREE.Color(color) },
      uRimColor: { value: new THREE.Color(rim) },
      uBrightness: { value: 1 },
    },
    vertexShader: ORB_VERT,
    fragmentShader: ORB_FRAG,
    wireframe: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// === JARVIS MOD #57: glow-layer options (2026-08-03) ===
export interface GlowOptions {
  /** Falloff exponent — lower = broader/softer, higher = tighter. */
  power?: number;
  /** Base opacity multiplier (also driven per-frame from voice brightness). */
  strength?: number;
  /** 0 = rim-bright shell, 1 = center-bright core. */
  core?: number;
  /** Core layers render front-side; shells render back-side. */
  side?: THREE.Side;
}

/** Translucent additive glow layer around the orb (bloom / halo / core). */
export function createGlowMaterial(
  color: string,
  { power = 3, strength = 0.55, core = 0, side = THREE.BackSide }: GlowOptions = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
      uPower: { value: power },
      uCore: { value: core },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    side,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
// === END JARVIS MOD #57 ===
// === END JARVIS MOD #29 ===
