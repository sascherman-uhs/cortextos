'use client';

// === JARVIS MOD #29 — Cosmos starfield, rebuilt as two parallax layers.
// (2026-07-06) A near layer (larger, brighter, faster drift) and a far layer
// (small, dim, slow) so the field has depth. Cool white with a teal tint to sit
// in the Trillion palette. `count` (perf-driven) is split across the two layers.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface StarLayerProps {
  count: number;
  rMin: number;
  rMax: number;
  size: number;
  opacity: number;
  drift: number;
  color: string;
  seed: number;
}

function StarLayer({ count, rMin, rMax, size, opacity, drift, color, seed }: StarLayerProps) {
  const ref = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    let s = seed * 1013 + 1;
    const rand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = rMin + rand() * (rMax - rMin);
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count, rMin, rMax, seed]);

  useFrame((state) => {
    if (ref.current) ref.current.rotation.y = state.clock.elapsedTime * drift;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={size}
        sizeAttenuation
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

interface ParticlesProps {
  /** Total star count (perf mode reduces this). Split ~60/40 near/far. */
  count: number;
}

export function Particles({ count }: ParticlesProps) {
  const near = Math.round(count * 0.4);
  const far = count - near;
  return (
    <>
      <StarLayer
        count={near}
        rMin={7}
        rMax={16}
        size={0.06}
        opacity={0.9}
        drift={0.018}
        color="#d9fbff"
        seed={3}
      />
      <StarLayer
        count={far}
        rMin={16}
        rMax={30}
        size={0.035}
        opacity={0.5}
        drift={0.008}
        color="#7fd6d0"
        seed={11}
      />
    </>
  );
}
// === END JARVIS MOD #29 ===
