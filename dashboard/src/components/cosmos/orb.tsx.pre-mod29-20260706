'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';

const UHS_GOLD = '#CFB383';

interface OrbProps {
  /**
   * Voice/state-driven breathing amplitude. Tier 2 will feed live voice
   * amplitude here; for Tier 1 it is a gentle idle default.
   */
  amplitude?: number;
  /** Wireframe color. Tier 2 will shift this by agent state. */
  color?: string;
}

export function Orb({ amplitude = 0.035, color = UHS_GOLD }: OrbProps) {
  const meshRef = useRef<Mesh>(null);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    // Slow breathing: scale oscillates around 1 by ±amplitude.
    const breathe = 1 + Math.sin(t * 0.8) * amplitude;
    mesh.scale.setScalar(breathe);
    // Subtle slow rotation on two axes.
    mesh.rotation.y = t * 0.12;
    mesh.rotation.x = t * 0.05;
  });

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1.6, 4]} />
      <meshBasicMaterial color={color} wireframe transparent opacity={0.85} />
    </mesh>
  );
}
