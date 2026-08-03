'use client';

// === JARVIS MOD #29 — Cosmos nebula background + glow pool (2026-07-06) ===
// A large back-side sphere painted with a deep-space gradient (dark teal →
// indigo → purple) plus soft procedural cloud banding, and a separate additive
// "glow pool" disc that sits beneath/behind the orb and takes the orb's live
// color. Both are cheap (no per-fragment simplex) so they stay fast on mobile.

import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { SPACE, SPACE_2, INDIGO, PURPLE } from './palette';
// === JARVIS MOD #70: frozen scene clock ===
import { sceneTime } from './reduced-motion';
// === END JARVIS MOD #70 ===

const BG_VERT = /* glsl */ `
varying vec3 vPos;
void main(){
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// === JARVIS MOD #74 (2026-08-03): richer nebula. The old backdrop was one
// vertical gradient plus a single trig band, which the critic read as a flat
// single-layer field. Now THREE cloud layers at different scales, speeds and
// directions, in two different hues, so the background has parallax and never
// repeats visibly. Still pure trig — no noise texture, no extra draw call. ===
const BG_FRAG = /* glsl */ `
uniform vec3 uLow;
uniform vec3 uMid;
uniform vec3 uHigh;
uniform vec3 uAlt;
uniform float uTime;
varying vec3 vPos;

// One drifting cloud band. Returns 0..1.
float band(vec3 d, float scale, float speed, vec3 dir){
  float v =
    sin(d.x * scale + uTime * speed * dir.x) *
    cos(d.y * scale * 0.72 - uTime * speed * dir.y) *
    sin(d.z * scale * 0.9 + uTime * speed * dir.z);
  return v * 0.5 + 0.5;
}

void main(){
  vec3 dir = normalize(vPos);
  float t = dir.y * 0.5 + 0.5;                 // vertical gradient
  vec3 col = mix(uLow, uMid, smoothstep(0.0, 0.6, t));
  col = mix(col, uHigh, smoothstep(0.55, 1.0, t));

  // Layer 1 — broad, slowest, the "sheet" the others sit in front of.
  float c1 = band(dir, 1.7, 0.035, vec3(1.0, 0.6, 0.8));
  // Layer 2 — mid scale, opposite drift, in the alternate hue.
  float c2 = band(dir, 3.4, 0.062, vec3(-0.7, 1.0, -0.5));
  // Layer 3 — fine, fastest, low amplitude: the detail that sells the parallax.
  float c3 = band(dir, 6.1, 0.11, vec3(0.4, -0.9, 1.0));

  col += uHigh * c1 * 0.085;
  col += uAlt  * c2 * 0.055;
  col += uHigh * c3 * 0.022;
  // Clouds thin out toward the bottom of the sphere so the orb reads clean.
  gl_FragColor = vec4(mix(col, col * 0.86, smoothstep(0.45, 0.0, t)), 1.0);
}
`;

export function NebulaBackground() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uLow: { value: new THREE.Color(SPACE) },
          uMid: { value: new THREE.Color(SPACE_2) },
          uHigh: { value: new THREE.Color(INDIGO).lerp(new THREE.Color(PURPLE), 0.4) },
          // MOD #74: second cloud hue — a teal-green so the field isn't
          // monochrome indigo (spec: green/magenta/blue cloud layers).
          uAlt: { value: new THREE.Color('#1f6f6a') },
          uTime: { value: 0 },
        },
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    [],
  );

  useFrame((state) => {
    material.uniforms.uTime.value = sceneTime(state.clock.elapsedTime); // MOD #70
  });

  return (
    <mesh material={material}>
      <sphereGeometry args={[40, 32, 32]} />
    </mesh>
  );
}

const POOL_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const POOL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying vec2 vUv;
void main(){
  float d = distance(vUv, vec2(0.5));
  float a = smoothstep(0.5, 0.0, d);       // radial falloff
  gl_FragColor = vec4(uColor, a * a * uStrength);
}
`;

export function GlowPool({ color }: { color: string }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          // MOD #57: 0.42 → 0.15. With the orb's new three-layer glow stacked on
          // top, the old pool strength washed the whole frame — and a wide gold
          // pool over the navy nebula reads BROWN, not gold. The orb's own halo
          // now carries the warm accent; the pool only seats the orb in space.
          uStrength: { value: 0.15 },
        },
        vertexShader: POOL_VERT,
        fragmentShader: POOL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useFrame(() => {
    (material.uniforms.uColor.value as THREE.Color).set(color);
  });

  // Sits just behind the orb, facing the camera.
  return (
    <mesh position={[0, -0.2, -1.5]} material={material}>
      <planeGeometry args={[9, 9]} />
    </mesh>
  );
}
// === END JARVIS MOD #29 ===
