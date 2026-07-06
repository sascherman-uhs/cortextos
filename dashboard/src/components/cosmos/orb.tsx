'use client';

// === JARVIS MOD #29 — Cosmos orb, rebuilt to the Trillion "cosmic orb" spec.
// (2026-07-06) Finely-subdivided wireframe icosahedron displaced by layered
// simplex noise (orb-shader.ts) with a fresnel rim, wrapped in an additive glow
// shell, holding a sparse internal node-web, and — while processing — encircled
// by tilted rotating "helix" rings. All state expressed via color/brightness/
// amplitude uniforms fed from the voice loop. Perf-aware via props.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createOrbMaterial, createGlowMaterial } from './orb-shader';
import { NodeWeb } from './node-web';
import { TEAL, MINT } from './palette';

interface OrbProps {
  /** Surface displacement amplitude (idle breathing → live mic/TTS amplitude). */
  amplitude?: number;
  /** Core color. */
  color?: string;
  /** Rim/edge glow color. */
  rim?: string;
  /** Overall brightness (state-driven: idle dim, speaking bright). */
  brightness?: number;
  /** 0..1 strength of the processing helix rings. */
  ringStrength?: number;
  /** Icosahedron subdivision (low-perf mode passes fewer). */
  detail?: number;
  /** Glow shell on/off (off in low-perf mode). */
  showGlow?: boolean;
  /** Internal node-web node count (0 disables). */
  internalNodes?: number;
}

export function Orb({
  amplitude = 0.035,
  color = TEAL,
  rim = MINT,
  brightness = 1,
  ringStrength = 0,
  detail = 6,
  showGlow = true,
  internalNodes = 24,
}: OrbProps) {
  const groupRef = useRef<THREE.Group>(null);
  const ring1Ref = useRef<THREE.Mesh>(null);
  const ring2Ref = useRef<THREE.Mesh>(null);
  const ring1Mat = useRef<THREE.MeshBasicMaterial>(null);
  const ring2Mat = useRef<THREE.MeshBasicMaterial>(null);
  const smoothRing = useRef(0);

  const orbMat = useMemo(() => createOrbMaterial(color, rim), []); // eslint-disable-line react-hooks/exhaustive-deps
  const glowMat = useMemo(() => createGlowMaterial(rim), []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;

    // Drive orb shader uniforms from live props.
    orbMat.uniforms.uTime.value = t;
    orbMat.uniforms.uAmp.value = amplitude * 3.7; // scale idle(0.035) → visible roil
    orbMat.uniforms.uBrightness.value = brightness;
    (orbMat.uniforms.uColor.value as THREE.Color).set(color);
    (orbMat.uniforms.uRimColor.value as THREE.Color).set(rim);
    (glowMat.uniforms.uColor.value as THREE.Color).set(rim);
    glowMat.uniforms.uStrength.value = 0.45 * brightness;

    // Slow two-axis tumble.
    if (groupRef.current) {
      groupRef.current.rotation.y = t * 0.12;
      groupRef.current.rotation.x = t * 0.05;
    }

    // Ease ring strength so processing enter/exit is smooth.
    smoothRing.current += (ringStrength - smoothRing.current) * Math.min(delta * 3, 1);
    const rs = smoothRing.current;
    if (ring1Ref.current && ring2Ref.current) {
      ring1Ref.current.rotation.z = t * 0.9;
      ring1Ref.current.rotation.x = Math.PI / 2.4;
      ring2Ref.current.rotation.z = -t * 0.7;
      ring2Ref.current.rotation.x = Math.PI / 3.2;
      const grow = 1 + rs * 0.15 + Math.sin(t * 2) * 0.02 * rs;
      ring1Ref.current.scale.setScalar(grow);
      ring2Ref.current.scale.setScalar(grow * 1.12);
      ring1Ref.current.visible = rs > 0.01;
      ring2Ref.current.visible = rs > 0.01;
    }
    if (ring1Mat.current) ring1Mat.current.opacity = rs * 0.8;
    if (ring2Mat.current) ring2Mat.current.opacity = rs * 0.55;
  });

  return (
    <group ref={groupRef}>
      {/* Wireframe displaced orb */}
      <mesh material={orbMat}>
        <icosahedronGeometry args={[1.55, detail]} />
      </mesh>

      {/* Additive glow shell */}
      {showGlow && (
        <mesh material={glowMat}>
          <icosahedronGeometry args={[1.85, 3]} />
        </mesh>
      )}

      {/* Sparse internal node-web (tumbles with the orb) */}
      {internalNodes > 0 && (
        <NodeWeb
          nodeCount={internalNodes}
          clusters={4}
          radiusMin={0.3}
          radiusMax={1.1}
          linkDist={0.9}
          nodeSize={0.028}
          nodeOpacity={0.5}
          lineColor={rim}
          lineOpacity={0.16}
          driftSpeed={0.05}
          seed={7}
        />
      )}

      {/* Processing "helix" rings — tilted, counter-rotating, fade in on demand */}
      <mesh ref={ring1Ref} visible={false}>
        <torusGeometry args={[2.1, 0.022, 10, 140]} />
        <meshBasicMaterial
          ref={ring1Mat}
          color={rim}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={ring2Ref} visible={false}>
        <torusGeometry args={[2.1, 0.022, 10, 140]} />
        <meshBasicMaterial
          ref={ring2Mat}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
// === END JARVIS MOD #29 ===
