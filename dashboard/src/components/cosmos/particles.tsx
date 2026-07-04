'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Points } from 'three';

const UHS_GOLD = '#CFB383';

interface ParticlesProps {
  /** Number of points in the starfield. Perf mode reduces this. */
  count: number;
}

export function Particles({ count }: ParticlesProps) {
  const pointsRef = useRef<Points>(null);

  // Procedural nebula/starfield: points scattered in a spherical shell so the
  // orb sits inside a drifting cloud rather than a flat plane.
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 6 + Math.random() * 16;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    const pts = pointsRef.current;
    if (!pts) return;
    // Slow drift so the field feels alive without distracting.
    pts.rotation.y = state.clock.elapsedTime * 0.015;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={UHS_GOLD}
        size={0.05}
        sizeAttenuation
        transparent
        opacity={0.7}
      />
    </points>
  );
}
