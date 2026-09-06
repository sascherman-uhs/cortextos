'use client';

import { useCallback, useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Orb } from './orb';
import { Particles } from './particles';
import { PerfToggle, readStoredPerfMode, type PerfMode } from './perf-toggle';
// === JARVIS MOD #20: voice loop wiring ===
import { VoicePanel } from './voice-panel';
import type { VoiceState } from './use-voice';
// === END JARVIS MOD #20 ===
// === JARVIS MOD #22: agent orbits (Tier 4) + data panels (Tier 5) ===
import { OrbitSystem, AgentOrbitsOverlay, useAgentOrbits } from './agent-orbits';
import { DataPanels } from './data-panels';
// === END JARVIS MOD #22 ===
// === JARVIS MOD #29: Trillion cosmic-orb scene layers + palette ===
import { NebulaBackground, GlowPool } from './nebula';
import { NodeWeb } from './node-web';
import { TEAL, CYAN, AQUA, MINT, PURPLE, SPACE, GOLD } from './palette';
// === END JARVIS MOD #29 ===
// === JARVIS MOD #58/#62: responsive framing + degradation ===
import { cameraZForAspect } from './framing';
import { prefersReducedMotion } from './motion';
// === JARVIS MOD #70: the frozen-clock switch the whole scene reads ===
import { setReducedMotion } from './reduced-motion';
// === END JARVIS MOD #70 ===
// === END JARVIS MOD #58/#62 ===

// === JARVIS MOD #29: deep-space background replaces UHS charcoal in this scene ===
const SPACE_BG = SPACE;

// High-perf star count; low mode uses ~1/4.
const HIGH_PARTICLES = 4000;
const LOW_PARTICLES = 1000;

// === JARVIS MOD #29: state → orb color/rim/brightness (Trillion palette).
// idle dim teal, listening bright cyan, processing teal→purple drift + helix,
// responding bright teal.
// === JARVIS MOD #107 (2026-08-09): the 'error' red-shift the MOD #29 note left
// as a hypothetical is now real, because the state is now real. The scene had NO
// visual vocabulary for failure — a dead voice engine rendered as the same calm
// teal as a healthy idle one, which is how a mute JARVIS on a phone looked
// perfectly fine for minutes at a time. Red is used NOWHERE else in this scene,
// so it cannot be confused with any working state. ===
const ERROR_CORE = '#E05A4A';
const ERROR_RIM = '#F2A99C';
// === JARVIS MOD #56 (2026-08-03): warm/cool inversion. The scene is cool at
// every state EXCEPT `listening`, which is the one warm moment — UHS gold. The
// orb, its glow pool, and the mic chrome all shift warm together, and nothing
// else in the scene is allowed to sit warm at rest (critic defect #3). ===
const STATE_CORE: Record<VoiceState, string> = {
  // === JARVIS MOD #36: open-mic states — dormant near-dark, wakeListening a
  // quiet ember (hot mic, waiting for its name), speaking brightest. ===
  dormant: TEAL,
  wakeListening: TEAL,
  idle: TEAL,
  listening: GOLD,
  processing: AQUA,
  responding: TEAL,
  speaking: CYAN,
  error: ERROR_CORE, // MOD #107
};
const STATE_RIM: Record<VoiceState, string> = {
  dormant: MINT,
  wakeListening: MINT,
  idle: MINT,
  listening: '#E0BE86', // gold rim — the warm accent, listening only
  processing: PURPLE,
  responding: MINT,
  speaking: MINT,
  error: ERROR_RIM, // MOD #107
};
// === END JARVIS MOD #56 ===
const STATE_BRIGHT: Record<VoiceState, number> = {
  dormant: 0.45,
  wakeListening: 0.6,
  idle: 0.72,
  listening: 0.92,
  processing: 0.95,
  responding: 1.18,
  speaking: 1.25,
  // MOD #107: dimmer than every working state — failure should read as the
  // system having gone out, not as another kind of activity.
  error: 0.5,
  // === END MOD #36 ===
};
// Idle breathing amplitude; live mic amplitude scales above this while speaking.
// MOD #73: 0.035 → 0.055. At the old value the displacement was measurable but
// not perceptible against the wireframe's own line density.
const IDLE_AMPLITUDE = 0.055;
// === END JARVIS MOD #29 ===

declare global {
  interface Window {
    // === JARVIS MOD #21: extended with tts fields (single source of truth) ===
    __cosmosStats?: {
      particles?: number;
      voiceState?: VoiceState;
      ttsPath?: 'elevenlabs' | 'say' | 'browser' | null;
      ttsMuted?: boolean;
      // === JARVIS MOD #22: agent count + live screen positions (debug seam) ===
      orbitAgents?: number;
      orbitPositions?: Record<string, { x: number; y: number; z: number }>;
      // === JARVIS MOD #37: live per-agent working flags (dispatch choreography seam) ===
      orbitWorking?: Record<string, boolean>;
      // === END JARVIS MOD #37 ===
      // === JARVIS MOD #24: per-sentence TTS queue seams (2026-07-05) ===
      // lastUserStopMs: performance.now() when the user's turn ended (set by
      //   use-voice.sendText). timeSinceUserStoppedTalkingMs: that → first audible.
      // ttsQueueDepth: segments still to play. cosmosBaseTurnId: active reply/turn id.
      lastUserStopMs?: number;
      timeSinceUserStoppedTalkingMs?: number;
      ttsQueueDepth?: number;
      cosmosBaseTurnId?: number;
      // === END JARVIS MOD #24 ===
      // === JARVIS MOD #25: eager, canonically-named turn seam. `baseTurnId` mirrors
      // `cosmosBaseTurnId` but is written at hook mount (initial 0) so the regression
      // suite sees the key before any TTS activity, and bumps on every user turn. ===
      baseTurnId?: number;
      // === END JARVIS MOD #25 ===
      // === JARVIS MOD #31: last playback-path failure (null = healthy) ===
      ttsLastError?: string | null;
      // === END JARVIS MOD #31 ===
      // === JARVIS MOD #36: open-mic / wake-gate / VAD seams (2026-07-07) ===
      openMic?: boolean;
      openMicError?: string | null;
      vadSpeechActive?: boolean;
      followUpUntilMs?: number;
      wakeGate?: {
        accepted: number;
        discarded: number;
        lastDecision?: string;
        lastUtterance?: string;
      };
      // === END JARVIS MOD #36 ===
      // === JARVIS MOD #39: mic-pipeline visibility (2026-07-08) ===
      // vadEnergy: live analyser avg (0..1); micCtxState: shared AudioContext
      // state ('suspended' = iOS gesture-gate → analyser reads zeros).
      vadEnergy?: number;
      micCtxState?: string;
      // === END JARVIS MOD #39 ===
      // === JARVIS MOD #38: sync fast-lane + latency-percentile seams (2026-07-07) ===
      // fastReplies: count of replies delivered synchronously in the POST response.
      // voiceLatency: session p50/p95 of user-stopped-talking → first audible (ms).
      fastReplies?: number;
      escalations?: number;
      voiceLatency?: { p50: number; p95: number; n: number };
      // === END JARVIS MOD #38 ===
      // === JARVIS MOD #70: reduced-motion seam (verification asserts on it) ===
      reducedMotion?: boolean;
      // === END JARVIS MOD #70 ===
      // === JARVIS MOD #107: the Realtime lanes' vitals, rendered by
      // voice-panel's MicDebugLine. These were already being WRITTEN by
      // use-realtime-voice (through a cast that bypassed this declaration) but
      // never declared, so nothing type-checked and the debug line could not
      // read them without inventing its own local shape. On a phone with no
      // console these four fields are the entire difference between
      // "connecting", "connected but silent", and "dead". ===
      voicePath?: 'legacy' | 'realtime' | 'realtime-el' | 'fastpath';
      rtcState?: string;
      dcState?: string;
      iceState?: string;
      rtcError?: string | null;
      reconnects?: number;
      /** Shared (gesture-unlocked) AudioContext state — MOD #25's singleton. */
      ctxState?: string;
      lastTurnLatency?: { path: string; firstAudioMs: number; transcriptMs?: number };
      // === END JARVIS MOD #107 ===
    };
    // === END JARVIS MOD #21 ===
    // === JARVIS MOD #36: micless wake-gate test seam (Playwright drives the
    // spoken-utterance path without a mic; assigned/removed by use-voice). ===
    __cosmosVoiceTest?: {
      utterance: (text: string) => void;
      agentReply: (text: string) => void;
    };
    // === END JARVIS MOD #36 ===
  }
}

// === JARVIS MOD #58 — responsive camera dolly (2026-08-03) ===
// The camera sat at a fixed z=6, framed for a 16:10 desktop window. On a
// portrait phone the horizontal frustum is a third as wide, so the orb
// overflowed the screen and the agent orbits were cropped entirely (critic
// defect #7). The dolly keeps the orb at a deliberate fraction of the viewport
// width at every aspect ratio; agent-orbits.tsx derives its radii from the same
// pure function, so the two can never disagree.
function ResponsiveFraming() {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.height > 0 ? size.width / size.height : 1;
    cam.position.z = cameraZForAspect(cam.fov ?? 55, aspect);
    cam.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}
// === END JARVIS MOD #58 ===

// === JARVIS MOD #62: force one repaint when `dep` changes (reduced-motion) ===
function RepaintOnChange({ dep, enabled }: { dep: string; enabled: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (enabled) invalidate();
  }, [dep, enabled, invalidate]);
  return null;
}
// === END JARVIS MOD #62 ===

export default function Scene() {
  // Start 'high' on both server and first client render to avoid a hydration
  // mismatch; reconcile to the persisted value after mount.
  const [mode, setMode] = useState<PerfMode>('high');

  useEffect(() => {
    // === JARVIS MOD #25 — mobile defaults to 'low' particles for perf/battery.
    // An explicit toggle (stored value) always wins on either device; only when
    // there is NO stored preference do we fall back to 'low' on a phone-sized
    // viewport and 'high' on desktop. Desktop-with-no-preference stays 'high',
    // so desktop behavior is byte-for-byte unchanged. ===
    const stored = readStoredPerfMode();
    if (stored) {
      setMode(stored);
    } else {
      const isMobile =
        typeof window !== 'undefined' &&
        window.matchMedia('(max-width: 767px)').matches;
      setMode(isMobile ? 'low' : 'high');
    }
    // === END JARVIS MOD #25 ===
  }, []);

  // === JARVIS MOD #20: live voice state + amplitude drive the orb ===
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceAmplitude, setVoiceAmplitude] = useState(0);

  const handleStateChange = useCallback((s: VoiceState) => setVoiceState(s), []);
  const handleAmplitudeChange = useCallback((a: number) => setVoiceAmplitude(a), []);
  // === END JARVIS MOD #20 ===

  // === JARVIS MOD #21: TTS playback amplitude drives orb breathing while speaking ===
  const [ttsAmplitude, setTtsAmplitude] = useState(0);
  const handleTtsAmplitudeChange = useCallback((a: number) => setTtsAmplitude(a), []);

  const orbColor = STATE_CORE[voiceState];
  const orbRim = STATE_RIM[voiceState];
  const orbBrightness = STATE_BRIGHT[voiceState];
  const ringStrength = voiceState === 'processing' ? 1 : 0;
  // Orb breathing:
  //   - listening → blend idle + live mic amplitude
  //   - responding + TTS audible → blend idle + playback amplitude
  //   - otherwise → idle breathing
  const orbAmplitude =
    voiceState === 'listening'
      ? IDLE_AMPLITUDE + voiceAmplitude * 0.18
      : ttsAmplitude > 0
        ? IDLE_AMPLITUDE + ttsAmplitude * 0.18
        : IDLE_AMPLITUDE;
  // === END JARVIS MOD #21 ===

  // === JARVIS MOD #22: agent orbit state (poll /api/agents, select → panel) ===
  const { agents, selected, selectedName, onSelect, onClose } = useAgentOrbits();
  // === END JARVIS MOD #22 ===

  // === JARVIS MOD #62 — graceful degradation (2026-08-03, rubric item 11) ===
  // Two render-budget switches on top of the existing mobile particle culling:
  //   hidden tab  → frameloop 'never' (a backgrounded /jarvis tab was still
  //                 driving a full WebGL loop, on a laptop, forever).
  //   reduced motion → frameloop 'demand'; the scene renders a still frame and
  //                 re-renders only when voice state actually changes, so the
  //                 orb still *reads* correctly without any idle animation.
  const [hidden, setHidden] = useState(false);
  const [reducedMotion, setReducedMotionState] = useState(false);
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    // MOD #70: set the module flag BEFORE the React state, so the very next
    // frame is already frozen rather than waiting on a re-render.
    const onMotion = () => {
      const v = prefersReducedMotion();
      setReducedMotion(v);
      setReducedMotionState(v);
      window.__cosmosStats = { ...(window.__cosmosStats ?? {}), reducedMotion: v };
    };
    onMotion();
    mq?.addEventListener?.('change', onMotion);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      mq?.removeEventListener?.('change', onMotion);
    };
  }, []);
  const frameloop: 'always' | 'demand' | 'never' = hidden
    ? 'never'
    : reducedMotion
      ? 'demand'
      : 'always';
  // === END JARVIS MOD #62 ===

  const lowPerf = mode === 'low';
  const particleCount = lowPerf ? LOW_PARTICLES : HIGH_PARTICLES;
  // Cap dpr in low mode; allow up to 2 in high mode for crisp wireframe.
  const dpr: [number, number] = lowPerf ? [1, 1] : [1, 2];

  // === JARVIS MOD #29: perf-driven scene budgets (mobile GPU must stay fluid) ===
  const webNodes = lowPerf ? 40 : 100;
  const webClusters = lowPerf ? 5 : 8;
  const orbDetail = lowPerf ? 3 : 6;
  const internalNodes = lowPerf ? 12 : 24;
  const showGlow = !lowPerf;
  // === END JARVIS MOD #29 ===

  useEffect(() => {
    // Debug global so tests can assert the active particle count.
    // === JARVIS MOD #21: MERGE (don't clobber ttsPath/ttsMuted written by useTts) ===
    window.__cosmosStats = {
      ...(window.__cosmosStats ?? {}),
      particles: particleCount,
      voiceState,
    };
    // === END JARVIS MOD #21 ===
  }, [particleCount, voiceState]);

  return (
    <div
      // === JARVIS MOD #55: scopes the shared easing curve + cosmos keyframes
      // (globals.css) to this scene only. ===
      data-cosmos=""
      className="relative h-screen w-screen overflow-hidden"
      style={{ background: SPACE_BG }}
    >
      <Canvas
        camera={{ position: [0, 0, 6], fov: 55 }}
        dpr={dpr}
        frameloop={frameloop}
        gl={{ antialias: mode === 'high' }}
        style={{ background: SPACE_BG }}
      >
        <ambientLight intensity={0.6} />
        {/* === JARVIS MOD #58: aspect-aware camera dolly === */}
        <ResponsiveFraming />
        {/* === JARVIS MOD #62: in reduced-motion ('demand') mode, a voice-state
            change must still repaint the still frame === */}
        <RepaintOnChange dep={`${voiceState}:${orbBrightness}`} enabled={reducedMotion} />
        {/* === JARVIS MOD #29: Trillion cosmic-orb layers === */}
        <NebulaBackground />
        <GlowPool color={orbRim} />
        <Particles count={particleCount} />
        {/* Distant glowing node-web behind the orb */}
        <NodeWeb
          nodeCount={webNodes}
          clusters={webClusters}
          radiusMin={5}
          radiusMax={13}
          linkDist={3.4}
          nodeSize={lowPerf ? 0.08 : 0.1}
          lineColor={CYAN}
          lineOpacity={0.16}
          driftSpeed={0.02}
          seed={1}
          pulse={!lowPerf}
        />
        {/* === JARVIS MOD #20/#29: voice state drives orb color/rim/brightness/rings === */}
        <Orb
          amplitude={orbAmplitude}
          color={orbColor}
          rim={orbRim}
          brightness={orbBrightness}
          ringStrength={ringStrength}
          detail={orbDetail}
          showGlow={showGlow}
          internalNodes={internalNodes}
        />
        {/* === JARVIS MOD #22/#29: agent avatar orbits (Tier 4) === */}
        <OrbitSystem
          agents={agents}
          selectedName={selectedName}
          lowPerf={lowPerf}
          onSelect={onSelect}
        />
        {/* === END JARVIS MOD #22 === */}
      </Canvas>

      {/* === JARVIS MOD #79 — vignette + floor grade (2026-08-03) ===
          The single cheapest thing separating "cinematic" from "HUD": a frame
          that falls off at the edges instead of holding one flat value corner
          to corner. Pure CSS over the canvas — no draw call, no GPU cost, and
          it cannot affect FPS or the perf toggle. Sits at z-[5]: above the
          canvas, below every panel (z-10/z-20), so no readable chrome is dimmed.
          Centred at 48% to match the orb, not the viewport. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[5]"
        style={{
          background:
            'radial-gradient(ellipse 78% 68% at 50% 48%, rgba(5,11,20,0) 40%, rgba(4,8,16,0.42) 78%, rgba(2,5,10,0.72) 100%)',
        }}
      />
      {/* A faint cool floor so the orb sits IN something rather than floating
          on a flat field — the same trick as a studio sweep. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-1/3"
        style={{
          background: 'linear-gradient(to top, rgba(6,20,28,0.5), rgba(6,20,28,0))',
        }}
      />
      {/* === END JARVIS MOD #79 === */}

      {/* JARVIS label under the orb.
          === JARVIS MOD #59: on a phone the orb is centred higher and the glass
          panel owns the lower third, so the wordmark tucks under the orb
          instead of colliding with the panel at bottom-18%. === */}
      <div // MOD #71: 65% matches PORTRAIT_BAND_BOTTOM (0.62) + clearance in framing.ts.
        // If you move this, move that constant with it.
        className="pointer-events-none absolute inset-x-0 top-[65%] flex justify-center md:top-auto md:bottom-[18%]">
        <span className="text-xl font-light tracking-[0.5em] text-[#5eead4] [text-shadow:0_0_20px_rgba(45,212,191,0.5)] md:text-2xl">
          JARVIS
        </span>
      </div>

      <PerfToggle mode={mode} onChange={setMode} />

      {/* === JARVIS MOD #20: voice loop panel (DOM overlay, outside Canvas) === */}
      <VoicePanel
        onStateChange={handleStateChange}
        onAmplitudeChange={handleAmplitudeChange}
        onTtsAmplitudeChange={handleTtsAmplitudeChange}
      />
      {/* === END JARVIS MOD #20 === */}

      {/* === JARVIS MOD #22: data panels (Tier 5) + orbit detail side panel === */}
      <DataPanels />
      <AgentOrbitsOverlay selected={selected} onClose={onClose} />
      {/* === END JARVIS MOD #22 === */}
    </div>
  );
}
