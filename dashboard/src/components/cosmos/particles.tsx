'use client';

// === JARVIS MOD #29 — Cosmos starfield, rebuilt as two parallax layers.
// (2026-07-06) A near layer (larger, brighter, faster drift) and a far layer
// (small, dim, slow) so the field has depth. Cool white with a teal tint to sit
// in the Trillion palette. `count` (perf-driven) is split across the two layers.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
// === JARVIS MOD #70: frozen scene clock ===
import { sceneTime } from './reduced-motion';
// === JARVIS MOD #78: shared soft-dot alpha map — points were square ===
import { getSoftDotTexture } from './dot-texture';
// === END JARVIS MOD #70 ===

interface StarLayerProps {
  count: number;
  rMin: number;
  rMax: number;
  size: number;
  opacity: number;
  drift: number;
  color: string;
  seed: number;
  // === JARVIS MOD #74: per-layer twinkle. Both layers previously held a
  // constant opacity, so "dual starfield" was only true geometrically — on
  // screen it read as one flat field. Each layer now breathes on its OWN
  // rhythm and phase, which is what makes the depth legible. ===
  twinkleHz?: number;
  twinklePhase?: number;
  twinkleDepth?: number;
  // === END JARVIS MOD #74 ===
}

function StarLayer({
  count,
  rMin,
  rMax,
  size,
  opacity,
  drift,
  color,
  seed,
  twinkleHz = 0,
  twinklePhase = 0,
  twinkleDepth = 0,
}: StarLayerProps) {
  const ref = useRef<THREE.Points>(null);
  const matRef = useRef<THREE.PointsMaterial>(null);
  const dot = useMemo(() => getSoftDotTexture(), []); // MOD #78

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
    const t = sceneTime(state.clock.elapsedTime); // MOD #70
    if (ref.current) ref.current.rotation.y = t * drift;
    // MOD #74: twinkle (frozen too — sceneTime feeds it).
    if (matRef.current && twinkleDepth > 0) {
      matRef.current.opacity =
        opacity + Math.sin(t * twinkleHz * Math.PI * 2 + twinklePhase) * twinkleDepth;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        ref={matRef}
        color={color}
        size={size}
        sizeAttenuation
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        // MOD #78: without this every star is a hard-edged square.
        map={dot ?? undefined}
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
  // MOD #74: dust motes scale with the perf budget like everything else.
  const motes = Math.max(8, Math.round(count * 0.012));
  return (
    <>
      <StarLayer
        count={near}
        rMin={7}
        rMax={16}
        size={0.06}
        opacity={0.82}
        drift={0.018}
        color="#d9fbff"
        seed={3}
        twinkleHz={0.33}
        twinkleDepth={0.16}
      />
      <StarLayer
        count={far}
        rMin={16}
        rMax={30}
        size={0.035}
        opacity={0.46}
        drift={0.008}
        color="#7fd6d0"
        seed={11}
        twinkleHz={0.19}
        twinklePhase={2.1}
        twinkleDepth={0.12}
      />
      {/* MOD #74: dust motes — a near, sparse, slow layer of larger soft
          points. They pass in front of the orb and give the empty space
          between camera and scene something to parallax against. */}
      <StarLayer
        count={motes}
        rMin={3.2}
        rMax={6.5}
        size={0.16}
        opacity={0.16}
        drift={0.004}
        color="#bfe9e4"
        seed={23}
        twinkleHz={0.11}
        twinklePhase={0.7}
        twinkleDepth={0.07}
      />
    </>
  );
}
// === END JARVIS MOD #29 ===
