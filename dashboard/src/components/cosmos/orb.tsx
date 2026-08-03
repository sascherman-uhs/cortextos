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
// === JARVIS MOD #57: shared smoothing helpers (nothing snaps) ===
import { approach, approachAsym } from './motion';
// === END JARVIS MOD #57 ===

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
  // === JARVIS MOD #57 — three glow layers (2026-08-03).
  // The spec calls for wide atmospheric bloom + medium halo + bright inner core,
  // all additive, wrapping the fresnel-rimmed wireframe. Previously ONE shell,
  // which read flat and let the orb's silhouette die into the nebula. ===
  const bloomMat = useMemo(() => createGlowMaterial(rim, { power: 2.6, strength: 0.032 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const haloMat = useMemo(() => createGlowMaterial(rim, { power: 3.2, strength: 0.26 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const coreMat = useMemo(
    () => createGlowMaterial(color, { power: 2.4, strength: 0.16, core: 1, side: THREE.FrontSide }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Asymmetric voice-brightness envelope: leaps on syllables, releases slowly.
  const voiceBright = useRef(brightness);
  // === END JARVIS MOD #57 ===

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    // Guard against tab-resume delta spikes (a 30s delta would still snap).
    const dt = Math.min(delta, 0.1);

    // === JARVIS MOD #57: fast attack (~60ms half-life), slow decay (~380ms),
    // plus the spec's ~4s idle sine so the orb is never static even at rest. ===
    voiceBright.current = approachAsym(voiceBright.current, brightness, 0.06, 0.38, dt);
    const idlePulse = 1 + Math.sin((t * Math.PI * 2) / 4) * 0.045;
    const vb = voiceBright.current * idlePulse;
    // === END JARVIS MOD #57 ===

    // Drive orb shader uniforms from live props.
    orbMat.uniforms.uTime.value = t;
    orbMat.uniforms.uAmp.value = amplitude * 3.7; // scale idle(0.035) → visible roil
    orbMat.uniforms.uBrightness.value = vb;
    (orbMat.uniforms.uColor.value as THREE.Color).set(color);
    (orbMat.uniforms.uRimColor.value as THREE.Color).set(rim);
    // === JARVIS MOD #57: all three layers track live color + the eased envelope ===
    (bloomMat.uniforms.uColor.value as THREE.Color).set(rim);
    (haloMat.uniforms.uColor.value as THREE.Color).set(rim);
    (coreMat.uniforms.uColor.value as THREE.Color).set(color);
    bloomMat.uniforms.uStrength.value = 0.032 * vb;
    haloMat.uniforms.uStrength.value = 0.26 * vb;
    coreMat.uniforms.uStrength.value = 0.16 * vb;
    // === END JARVIS MOD #57 ===

    // Slow two-axis tumble.
    if (groupRef.current) {
      groupRef.current.rotation.y = t * 0.12;
      groupRef.current.rotation.x = t * 0.05;
    }

    // Ease ring strength so processing enter/exit is smooth.
    smoothRing.current = approach(smoothRing.current, ringStrength, 0.22, dt);
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

      {/* === JARVIS MOD #57: three additive glow layers, outer → inner.
          Low-perf drops the bloom + core but KEEPS the halo — the mobile hero
          orb reads as a bare wireframe without it (MOD #59). === */}
      <mesh material={haloMat}>
        <icosahedronGeometry args={[1.92, showGlow ? 5 : 3]} />
      </mesh>
      {showGlow && (
        <>
          {/* Wide atmospheric bloom. detail 5, not 3 — at this radius a coarse
              icosahedron showed its own facet silhouette through the gradient. */}
          <mesh material={bloomMat}>
            <icosahedronGeometry args={[2.45, 5]} />
          </mesh>
          {/* Bright inner core (front-side, center-bright) — deliberately faint:
              it lifts the orb's centre, it does not fill it. */}
          <mesh material={coreMat}>
            <icosahedronGeometry args={[1.15, 4]} />
          </mesh>
        </>
      )}
      {/* === END JARVIS MOD #57 === */}

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
