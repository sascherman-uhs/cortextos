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

const BG_VERT = /* glsl */ `
varying vec3 vPos;
void main(){
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BG_FRAG = /* glsl */ `
uniform vec3 uLow;
uniform vec3 uMid;
uniform vec3 uHigh;
uniform float uTime;
varying vec3 vPos;
void main(){
  vec3 dir = normalize(vPos);
  float t = dir.y * 0.5 + 0.5;                 // vertical gradient
  vec3 col = mix(uLow, uMid, smoothstep(0.0, 0.6, t));
  col = mix(col, uHigh, smoothstep(0.55, 1.0, t));
  // Soft drifting cloud banding (cheap trig, no noise texture).
  float cloud =
    sin(dir.x * 3.0 + uTime * 0.05) *
    cos(dir.y * 2.0 - uTime * 0.03) *
    sin(dir.z * 2.5 + uTime * 0.04);
  col += uHigh * (cloud * 0.5 + 0.5) * 0.08;
  gl_FragColor = vec4(col, 1.0);
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
    material.uniforms.uTime.value = state.clock.elapsedTime;
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
