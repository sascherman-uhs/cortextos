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
// === JARVIS MOD #70: frozen scene clock for prefers-reduced-motion ===
import { sceneTime, sceneDelta, sceneHalfLife } from './reduced-motion';
// === END JARVIS MOD #57/#70 ===

// MOD #72: allocated once — these are lerp targets read every frame.
const BLOOM_TINT = new THREE.Color('#4c4fa8');
const CORE_TINT = new THREE.Color('#ffffff');

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
  // === JARVIS MOD #72 (2026-08-03): the three layers must READ as three.
  // Wave-2 tuned the beige wash out by flattening everything toward zero, which
  // left one soft gradient — the critic's zoomed crops couldn't find a second
  // layer, let alone a third. Depth comes from CONTRAST between the layers, not
  // total brightness: a TIGHT bright core (small solid angle, so it costs
  // almost no total light), a medium halo at a clearly different radius, and a
  // wide bloom faint enough that it never tints the nebula. ===
  const bloomMat = useMemo(() => createGlowMaterial(rim, { power: 1.4, strength: 0.04 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const haloMat = useMemo(() => createGlowMaterial(rim, { power: 2.4, strength: 0.2 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const coreMat = useMemo(
    () => createGlowMaterial(color, { power: 5.0, strength: 0.62, core: 1, side: THREE.FrontSide }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Layer tints (module-level constants would re-allocate per frame otherwise).
  // Asymmetric voice-brightness envelope: leaps on syllables, releases slowly.
  const voiceBright = useRef(brightness);
  // === END JARVIS MOD #57 ===

  useFrame((state, delta) => {
    // MOD #70: both frozen while prefers-reduced-motion is on, so any frame
    // that does get drawn is identical to the last one.
    const t = sceneTime(state.clock.elapsedTime);
    const dt = sceneDelta(delta); // also guards tab-resume delta spikes

    // === JARVIS MOD #57: fast attack (~60ms half-life), slow decay (~380ms),
    // plus the spec's ~4s idle sine so the orb is never static even at rest. ===
    voiceBright.current = approachAsym(
      voiceBright.current,
      brightness,
      sceneHalfLife(0.06),
      sceneHalfLife(0.38),
      dt,
    );
    const idlePulse = 1 + Math.sin((t * Math.PI * 2) / 4) * 0.045;
    const vb = voiceBright.current * idlePulse;
    // === END JARVIS MOD #57 ===

    // Drive orb shader uniforms from live props.
    orbMat.uniforms.uTime.value = t;
    orbMat.uniforms.uAmp.value = amplitude * 4.6; // MOD #73: 3.7 → 4.6, visible roil
    orbMat.uniforms.uBrightness.value = vb;
    (orbMat.uniforms.uColor.value as THREE.Color).set(color);
    (orbMat.uniforms.uRimColor.value as THREE.Color).set(rim);
    // === JARVIS MOD #57: all three layers track live color + the eased envelope ===
    // MOD #72: bloom is tinted hard toward the nebula indigo and the core
    // toward white — three layers that differ in radius, falloff AND hue read
    // as three; three that differ only in radius blend into one gradient.
    // The heavy indigo lerp also keeps the widest layer COOL at every state:
    // a wide surface that follows the gold rim is exactly what produced the
    // wave-2 beige wash, so the warm accent stays on the core + halo only.
    (bloomMat.uniforms.uColor.value as THREE.Color).set(rim).lerp(BLOOM_TINT, 0.72);
    (haloMat.uniforms.uColor.value as THREE.Color).set(rim);
    (coreMat.uniforms.uColor.value as THREE.Color).set(color).lerp(CORE_TINT, 0.3);
    bloomMat.uniforms.uStrength.value = 0.04 * vb;
    haloMat.uniforms.uStrength.value = 0.22 * vb;
    coreMat.uniforms.uStrength.value = 0.62 * vb;
    // === END JARVIS MOD #57 ===

    // Slow two-axis tumble.
    // === JARVIS MOD #73 (2026-08-03): the icosahedron read as RIGID. The noise
    // displacement was real but sampled in OBJECT space, so the deformation
    // rotated WITH the mesh — a fixed shape spinning, which is exactly what
    // "rigid" looks like. Fixed by evolving the noise field faster (orb-shader)
    // and adding the spec's 6s scale breath on top, which is deformation the
    // tumble cannot disguise. ===
    if (groupRef.current) {
      groupRef.current.rotation.y = t * 0.12;
      groupRef.current.rotation.x = t * 0.05;
      const breath = 1 + Math.sin((t * Math.PI * 2) / 6) * 0.04; // spec: 6s, 1→1.04
      groupRef.current.scale.setScalar(breath);
    }

    // Ease ring strength so processing enter/exit is smooth.
    smoothRing.current = approach(smoothRing.current, ringStrength, sceneHalfLife(0.22), dt);
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
        <icosahedronGeometry args={[2.25, showGlow ? 5 : 3]} />
      </mesh>
      {showGlow && (
        <>
          {/* Wide atmospheric bloom. detail 5, not 3 — at this radius a coarse
              icosahedron showed its own facet silhouette through the gradient. */}
          <mesh material={bloomMat}>
            <icosahedronGeometry args={[3.6, 5]} />
          </mesh>
          {/* Bright inner core (front-side, center-bright). Tight radius +
              high falloff power = a small hot centre, not a filled ball. */}
          <mesh material={coreMat}>
            <icosahedronGeometry args={[1.12, 4]} />
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
