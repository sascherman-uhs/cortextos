'use client';

// === JARVIS MOD #22 — Cosmos Tier 4: agent orbit visualization (2026-07-03) ===
// === JARVIS MOD #29 — rebuilt visuals to the Trillion "cosmic orb" spec.
// (2026-07-06) Each fleet agent is now a glowing billboard with a procedurally
// generated avatar disc (radial gradient in a per-agent accent + the agent's
// initial, drawn to an offscreen canvas — no image assets), orbiting on a tilted
// elliptical path, breathing out of phase. Status is encoded by a colored halo:
// green pulse = online, red = down, teal = stale. A sonar-ping ring expands from
// an agent when its health status changes. Name labels track the sphere and
// dim/recede when the agent passes behind the orb.
//
// === JARVIS MOD #37 — dispatch choreography + avatar art + live activity ===
// (2026-07-07, Trillion cosmic-orb-ui Tier 5 parity)
//  - "Working" detection: currentTask present OR stdout activity < 60s
//    (lastActivityMs, new field from /api/agents). Poll tightened 10s → 3s.
//  - Dispatch: when an agent flips idle → working, a luminous beam races from
//    the orb out to the agent in its accent color, the agent flares, and a
//    sonar ring expands at the peak. Nothing snaps — all envelopes eased.
//  - Working: faster, brighter halo pulse; agent eases OUT of orbit toward a
//    dock slot near the right-side panel (in quickly), and drifts back to its
//    orbit slowly when the task finishes.
//  - Avatar art: real portrait PNGs from /agents/<name>.png composited into
//    the avatar disc (letter-disc renders first and remains the fallback).
//    GATED behind AVATAR_ART_ENABLED until Scott approves the art set.
//  - Seam: window.__cosmosStats.orbitWorking = { [name]: boolean } (MERGED).
//
// Preserved seams (do not regress): polls /api/agents (visibility aware);
// publishes window.__cosmosStats.orbitAgents = N and .orbitPositions (live
// screen coords) for the E2E suite; clicking opens the frosted-glass panel
// with /api/uhs/agent-tail log lines; data-testids agent-orbit-panel(-log).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_ACCENTS, hashIndex, GREEN, RED, TEAL, CYAN } from './palette';
// === JARVIS MOD #58/#55: frustum fit + one easing curve ===
import { approach, EASE, DUR_BASE } from './motion';
import {
  cameraZForAspect,
  worldYAtScreenFrac,
  PORTRAIT_BAND_TOP,
  PORTRAIT_BAND_BOTTOM,
} from './framing';
// === JARVIS MOD #70: frozen scene clock ===
import { sceneTime, sceneDelta, sceneHalfLife, isReducedMotion } from './reduced-motion';
// === END JARVIS MOD #70 ===
// === END JARVIS MOD #58/#55 ===

// === JARVIS MOD #58 — orbit framing (2026-08-03) ===
// Radii were hardcoded (2.6 / 3.7) against a 16:10 desktop frame, so on any
// narrower viewport the agents swung outside the frustum and cropped at the
// window edge (critic defects #5/#6 — visible in the baseline desktop AND
// mobile shots). Radii are now derived from the live camera + viewport so the
// worst-case agent (nearest the camera, at max |x|) always lands inside a safe
// margin, at every aspect ratio.

/** World-space padding for the avatar sprite + its label. */
const ORBIT_MARGIN = 0.58;
/** Max forward-z reached by a tilted ellipse, as a fraction of the x radius. */
const ORBIT_DEPTH_K = 0.78;
/** Design radii — the fit only ever shrinks these, never inflates them. */
const DESIGN_RX_OUTER = 3.7;
/** Below this fitted radius a second ring would sit inside the orb — use one. */
const SINGLE_RING_BELOW = 3.0;

interface OrbitFit {
  rxMax: number;
  ryMax: number;
  /** 1 or 2 rings, depending on how much horizontal room there is. */
  rings: 1 | 2;
  // === JARVIS MOD #71: portrait vertical band that dodges the DOM chrome ===
  /** Y the orbit system is centred on (0 on desktop). */
  yCenter: number;
  /** Max vertical amplitude that keeps agents inside the band. */
  ryBand: number;
  // === END JARVIS MOD #71 ===
}

function useOrbitFit(): OrbitFit {
  const { camera, size } = useThree();
  return useMemo(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.height > 0 ? size.width / size.height : 1;
    const fov = cam.fov ?? 55;
    const tanH = Math.tan((fov * Math.PI) / 360);
    // Derived, NOT read off camera.position.z — the dolly effect in scene.tsx
    // lands after this render, so reading the live camera would use last
    // frame's distance on every resize.
    const camZ = cameraZForAspect(fov, aspect);
    // Nearest-to-camera worst case: distance shrinks to (camZ - depthK*rx), so
    // solve rx + margin <= k * (camZ - depthK*rx) for rx.
    const solve = (k: number) => (camZ * k - ORBIT_MARGIN) / (1 + ORBIT_DEPTH_K * k);
    const rxMax = Math.max(0.8, solve(tanH * aspect));
    const ryMax = Math.max(0.8, solve(tanH));
    const rings: 1 | 2 = rxMax < SINGLE_RING_BELOW ? 1 : 2;

    // === JARVIS MOD #71: on portrait, fit to the band between the stat strip
    // and the wordmark instead of to the raw frustum — the frustum contains DOM
    // chrome the scene can't see, which is how agents ended up clipping through
    // the wordmark's letters. Desktop keeps the symmetric, centred orbit. ===
    let yCenter = 0;
    let ryBand = ryMax;
    if (rings === 1) {
      const top = worldYAtScreenFrac(fov, camZ, PORTRAIT_BAND_TOP);
      const bottom = worldYAtScreenFrac(fov, camZ, PORTRAIT_BAND_BOTTOM);
      yCenter = (top + bottom) / 2;
      ryBand = Math.max(0.6, (top - bottom) / 2 - ORBIT_MARGIN);
    }
    // === END JARVIS MOD #71 ===

    return { rxMax, ryMax, rings, yCenter, ryBand };
  }, [camera, size]);
}

/** Live screen positions of every label, so neighbours can avoid each other. */
type LabelRegistry = Map<string, { x: number; y: number; shown: boolean; order: number }>;
/** Screen-space box within which two labels are considered to collide. */
const LABEL_COLLIDE_X = 96;
const LABEL_COLLIDE_Y = 22;
// === END JARVIS MOD #58 ===

// Status → halo color (Trillion palette): online green, stale teal, down red.
const COLOR_OK = GREEN;
const COLOR_IDLE = TEAL;
const COLOR_DOWN = RED;

// MOD #37: avatar art set enabled 2026-07-07 (Scott "continue" go-ahead;
// jarvis-accounting regenerated glyph-free for series consistency).
// PNGs staged in public/agents/; letter-disc fallback for any missing file.
const AVATAR_ART_ENABLED = true;

// MOD #37: stdout activity fresher than this = "working right now".
const ACTIVITY_WORKING_MS = 60_000;

type Health = 'healthy' | 'stale' | 'down' | string;

interface AgentApi {
  name: string;
  org?: string;
  health?: Health;
  status?: string;
  lastHeartbeat?: string;
  currentTask?: string;
  lastActivityMs?: number; // MOD #37
}

export interface OrbitAgent extends AgentApi {
  color: string; // status/halo color
  accent: string; // per-agent avatar accent
  working: boolean; // MOD #37: actively doing something right now
}

function healthColor(health?: Health): string {
  if (health === 'healthy') return COLOR_OK;
  if (health === 'stale') return COLOR_IDLE;
  return COLOR_DOWN; // 'down' or unknown
}

function isWorking(a: AgentApi): boolean {
  if (a.currentTask) return true;
  return a.lastActivityMs !== undefined && a.lastActivityMs < ACTIVITY_WORKING_MS;
}

// ---------------------------------------------------------------------------
// Offscreen-canvas texture helpers (module-cached; browser-only).
// ---------------------------------------------------------------------------
const avatarCache = new Map<string, THREE.CanvasTexture>();
let glowTex: THREE.CanvasTexture | null = null;

function agentInitial(name: string): string {
  const base = name.replace(/^jarvis-/i, '').replace(/[^a-z0-9]/gi, '');
  return (base[0] || name[0] || '?').toUpperCase();
}

function makeAvatarTexture(name: string, accent: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const key = `${name}|${accent}`;
  const cached = avatarCache.get(key);
  if (cached) return cached;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const c = new THREE.Color(accent);
  const light = c.clone().lerp(new THREE.Color('#ffffff'), 0.55).getStyle();
  const dark = c.clone().lerp(new THREE.Color('#04121a'), 0.55).getStyle();
  // Radial gradient disc.
  const g = ctx.createRadialGradient(s * 0.42, s * 0.4, s * 0.05, s * 0.5, s * 0.5, s * 0.5);
  g.addColorStop(0, light);
  g.addColorStop(0.55, c.getStyle());
  g.addColorStop(1, dark);
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  // Rim.
  ctx.lineWidth = 4;
  ctx.strokeStyle = light;
  ctx.stroke();
  // Initial.
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `600 ${s * 0.5}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(agentInitial(name), s / 2, s / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  avatarCache.set(key, tex);

  // MOD #37: asynchronously composite the real avatar portrait into the SAME
  // canvas once it loads — texture identity is stable so no React state is
  // touched; the letter disc simply becomes the portrait on the next frame.
  // Missing/failed PNG = silent no-op (letter disc remains the fallback).
  if (AVATAR_ART_ENABLED) {
    const img = new Image();
    img.onload = () => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 0, 0, s, s);
      ctx.restore();
      // Re-stroke the accent rim over the portrait edge.
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = light;
      ctx.stroke();
      tex.needsUpdate = true;
    };
    img.src = `/agents/${encodeURIComponent(name)}.png`;
  }

  return tex;
}

function makeGlowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (glowTex) return glowTex;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}

// ---------------------------------------------------------------------------
// Visibility-aware poll of /api/agents (client-side fetch, authed session).
// MOD #37: 3s cadence (was 10s) so dispatch choreography reacts while you watch.
// ---------------------------------------------------------------------------
function useAgentPoll(intervalMs: number): OrbitAgent[] {
  const [agents, setAgents] = useState<OrbitAgent[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agents', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as AgentApi[];
      if (!Array.isArray(data)) return;
      setAgents(
        data.map((a) => ({
          ...a,
          color: healthColor(a.health),
          accent: AGENT_ACCENTS[hashIndex(a.name, AGENT_ACCENTS.length)],
          working: isWorking(a),
        })),
      );
    } catch {
      // Transient fetch failure — keep the last good frame.
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      void load();
      timer = setInterval(() => void load(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) start();
    else void load(); // one load even if starting hidden, so panels aren't empty
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);

  return agents;
}

// ---------------------------------------------------------------------------
// A single orbiting agent (billboard avatar + halo + label), inside the Canvas.
// ---------------------------------------------------------------------------
interface AgentNodeProps {
  agent: OrbitAgent;
  // === JARVIS MOD #58: explicit per-axis radii (was one `radius` + fixed
  // 0.72/0.28 ratios), so a portrait viewport can use its vertical room. ===
  rx: number;
  ry: number;
  rz: number;
  dockX: number;
  /** MOD #71: world-Y the whole orbit system is centred on. */
  yOffset: number;
  /** MOD #71: half-height available to dock slots. */
  dockYSpan: number;
  labels: React.RefObject<LabelRegistry>;
  order: number;
  // === END JARVIS MOD #58 ===
  angle0: number;
  speed: number;
  yTilt: number;
  tiltAxis: number; // ring tilt orientation (radians)
  phase: number; // breathing phase offset
  dockSlot: number; // MOD #37: stable slot index for the dock position
  selected: boolean;
  lowPerf: boolean;
  onSelect: (a: OrbitAgent) => void;
}

// MOD #37: dispatch beam timing (seconds).
const BEAM_DURATION = 2.4;
// MOD #79: dock slots per column.
const DOCK_ROWS = 4;

function AgentNode({
  agent,
  rx,
  ry,
  rz,
  dockX,
  yOffset,
  dockYSpan,
  labels,
  order,
  angle0,
  speed,
  yTilt,
  tiltAxis,
  phase,
  dockSlot,
  selected,
  lowPerf,
  onSelect,
}: AgentNodeProps) {
  const groupRef = useRef<THREE.Group>(null);
  const avatarRef = useRef<THREE.Sprite>(null);
  const haloRef = useRef<THREE.Sprite>(null);
  const pingRef = useRef<THREE.Mesh>(null);
  const pingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  // MOD #37: beam is a sibling of the group (parented at the orbit-system
  // origin = the orb's center) so it can stretch orb → agent in local space.
  const beamRef = useRef<THREE.Mesh>(null);
  const beamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const [labelDim, setLabelDim] = useState(false);
  // MOD #58: true when this label is stepping aside for a neighbour's.
  // MOD #79: 0 = clear; N = this label steps aside past N neighbours.
  const [labelYield, setLabelYield] = useState(0);
  const { camera, size } = useThree();
  const projected = useRef(new THREE.Vector3());

  // Sonar-ping bookkeeping: remember last health; when it changes, start a ping.
  const prevHealth = useRef(agent.health);
  const pingStart = useRef<number>(-1);
  useEffect(() => {
    if (prevHealth.current !== undefined && prevHealth.current !== agent.health) {
      pingStart.current = performance.now();
    }
    prevHealth.current = agent.health;
  }, [agent.health]);

  // MOD #37: dispatch bookkeeping — idle → working starts the beam + flare,
  // and fires the same sonar ping used for health changes.
  const prevWorking = useRef(agent.working);
  const dispatchStart = useRef<number>(-1);
  const dockBlend = useRef(0); // 0 = on orbit, 1 = docked
  useEffect(() => {
    if (!prevWorking.current && agent.working) {
      dispatchStart.current = performance.now();
      pingStart.current = performance.now();
    }
    prevWorking.current = agent.working;
  }, [agent.working]);

  const avatarTex = useMemo(
    () => makeAvatarTexture(agent.name, agent.accent),
    [agent.name, agent.accent],
  );
  const glow = useMemo(() => makeGlowTexture(), []);
  const haloColor = useMemo(() => new THREE.Color(agent.color), [agent.color]);
  const accentColor = useMemo(() => new THREE.Color(agent.accent), [agent.accent]);

  // MOD #37: dock anchor — right side, toward the frosted panel, staggered per
  // slot so simultaneous workers don't overlap. Kept forward of the orb (z>0).
  // MOD #58: dock x is frustum-fitted too — the old hardcoded 3.4 parked
  // working agents off-screen on anything narrower than a desktop window.
  const dockPos = useMemo(
    () =>
      new THREE.Vector3(
        // MOD #79: a real 2D dock grid. Rows spread down the available band,
        // COLUMNS step inward in x. The old layout put every column at the same
        // x and separated them only in z, so eight simultaneous workers — which
        // is a normal fleet moment, not an edge case — piled into one blob.
        dockX - Math.floor(dockSlot / DOCK_ROWS) * 0.62,
        yOffset + dockYSpan * (1 - ((dockSlot % DOCK_ROWS) * 2) / (DOCK_ROWS - 1)),
        1.4,
      ),
    [dockSlot, dockX, yOffset, dockYSpan],
  );

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    // MOD #70: frozen while prefers-reduced-motion is on.
    const t = sceneTime(state.clock.getElapsedTime());
    const dt = sceneDelta(delta);
    const still = isReducedMotion();
    const angle = angle0 + t * speed;

    // MOD #58: tilted ellipse with independent per-axis radii, so a portrait
    // viewport spends its vertical room instead of cropping horizontally.
    const ex = Math.cos(angle) * rx;
    const ez = Math.sin(angle) * rz;
    const ca = Math.cos(tiltAxis);
    const sa = Math.sin(tiltAxis);
    const ox = ex * ca - ez * sa;
    const oz = ex * sa + ez * ca;
    const oy = yOffset + yTilt + Math.sin(angle) * ry; // MOD #71: band offset

    // MOD #37: docking — ease toward the dock anchor while working ("in
    // quickly"), drift back to orbit when done ("out slowly"). Nothing snaps.
    // MOD #55: frame-rate independent (was a raw per-frame lerp that ran ~2x
    // faster on a 120Hz display).
    // MOD #70: docking is decorative. Under reduced motion it would SNAP
    // (halfLife 0) every time a work flag flipped, which measured as 3.55%
    // frame-to-frame movement in an otherwise frozen scene. Hold at 0.
    if (!still) {
      dockBlend.current = approach(
        dockBlend.current,
        agent.working ? 1 : 0,
        agent.working ? 0.34 : 1.3,
        dt,
      );
    }
    const b = dockBlend.current;
    const x = ox * (1 - b) + dockPos.x * b;
    const y = oy * (1 - b) + dockPos.y * b;
    const zr = oz * (1 - b) + dockPos.z * b;
    groupRef.current.position.set(x, y, zr);

    // Depth fade: agents on the far side of the orb recede (dim + shrink) so
    // they sink into the sphere instead of blooming white over the bright core.
    const depthFade = zr >= 0 ? 1 : Math.max(0.32, 1 + zr / 4);

    // MOD #37: dispatch flare envelope — peaks mid-beam, eases back.
    let flare = 0;
    if (dispatchStart.current >= 0 && !still) {
      const dt = (performance.now() - dispatchStart.current) / 1000;
      if (dt > BEAM_DURATION) {
        dispatchStart.current = -1;
      } else {
        flare = Math.sin((dt / BEAM_DURATION) * Math.PI); // 0 → 1 → 0
      }
    }

    // Out-of-phase breathing (working agents breathe faster and bigger).
    const breatheHz = agent.working ? 2.6 : 1.6;
    const breathe = 1 + Math.sin(t * breatheHz + phase) * 0.09;
    const base =
      (selected ? 0.62 : hovered ? 0.56 : 0.46) * (0.6 + 0.4 * depthFade) * (1 + flare * 0.45);
    if (avatarRef.current) {
      avatarRef.current.scale.setScalar(base * breathe);
      const am = avatarRef.current.material as THREE.SpriteMaterial;
      am.opacity = 0.35 + 0.65 * depthFade;
    }
    if (haloRef.current) {
      // MOD #37: working = faster, brighter pulse tinted toward the accent.
      const pulse = agent.working
        ? 0.95 + Math.sin(t * 5 + phase) * 0.35
        : agent.health === 'healthy'
          ? 0.8 + Math.sin(t * 3 + phase) * 0.2
          : 0.6;
      haloRef.current.scale.setScalar(base * breathe * 2.1);
      const m = haloRef.current.material as THREE.SpriteMaterial;
      m.opacity = Math.min(1, ((selected ? 0.9 : 0.6) * pulse + flare * 0.5) * depthFade);
      m.color.copy(haloColor);
      if (agent.working) m.color.lerp(accentColor, 0.6);
    }

    // Label recedes when the agent is on the far side of the orb.
    const behind = zr < -0.2;
    if (behind !== labelDim) setLabelDim(behind);

    // Sonar ping animation. MOD #70: performance.now()-driven, so `still` has
    // to silence it explicitly — the frozen scene clock can't.
    if (pingRef.current && pingMatRef.current) {
      if (still) {
        pingRef.current.visible = false;
      } else if (pingStart.current >= 0) {
        const dt = (performance.now() - pingStart.current) / 1000;
        if (dt > 1.3) {
          pingStart.current = -1;
          pingRef.current.visible = false;
        } else {
          pingRef.current.visible = true;
          pingRef.current.lookAt(camera.position);
          pingRef.current.scale.setScalar(0.3 + dt * 2.4);
          pingMatRef.current.opacity = Math.max(0, 0.7 * (1 - dt / 1.3));
          pingMatRef.current.color.copy(haloColor);
        }
      } else {
        pingRef.current.visible = false;
      }
    }

    // MOD #37: dispatch beam — a thin glowing cylinder from the orb's center
    // (system origin) out to the agent, racing out then fading. The beam mesh
    // is a sibling of the agent group, so it lives in origin-space directly.
    if (beamRef.current && beamMatRef.current) {
      if (still) {
        beamRef.current.visible = false; // MOD #70
      } else if (dispatchStart.current >= 0) {
        const dt = (performance.now() - dispatchStart.current) / 1000;
        const p = Math.min(1, dt / (BEAM_DURATION * 0.4)); // race out in 40%
        const agentPos = groupRef.current.position;
        const len = agentPos.length() * p;
        if (len > 0.01) {
          beamRef.current.visible = true;
          // Cylinder default axis is Y; scale to length, midpoint placement.
          beamRef.current.scale.set(1, len, 1);
          beamRef.current.position.copy(agentPos).multiplyScalar(p * 0.5);
          beamRef.current.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            agentPos.clone().normalize(),
          );
          beamMatRef.current.color.copy(accentColor);
          // MOD #79: 0.75 → 0.34 — additive over the orb's glow saturated to white.
          beamMatRef.current.opacity = 0.34 * Math.sin(Math.min(1, dt / BEAM_DURATION) * Math.PI);
        }
      } else {
        beamRef.current.visible = false;
      }
    }

    // Debug seam: publish each node's live screen position (E2E deterministic click).
    projected.current.copy(groupRef.current.position).project(camera);
    const sx = (projected.current.x * 0.5 + 0.5) * size.width;
    const sy = (-projected.current.y * 0.5 + 0.5) * size.height;

    // === JARVIS MOD #58: label collision (critic defect #6 — two labels
    // overlapped into an unreadable smear in the baseline shot). Every node
    // publishes its label box; a node whose box overlaps a LOWER-ordered
    // neighbour's yields — offsets below and fades. Deterministic ordering
    // means exactly one of any pair yields, so they never both jump. ===
    const shown = hovered || selected || agent.working;
    const reg = labels.current;
    if (reg) {
      reg.set(agent.name, { x: sx, y: sy, shown, order });
      // MOD #79: COUNT the lower-ordered labels this one overlaps, don't just
      // flag the first. Every yielder used the same 22px offset, so six
      // simultaneous workers produced six labels stacked in one place.
      let collide = 0;
      if (shown) {
        for (const [name, other] of reg) {
          if (name === agent.name || !other.shown || other.order >= order) continue;
          if (
            Math.abs(other.x - sx) < LABEL_COLLIDE_X &&
            Math.abs(other.y - sy) < LABEL_COLLIDE_Y
          ) {
            collide += 1;
          }
        }
      }
      if (collide !== labelYield) setLabelYield(collide);
    }
    // === END JARVIS MOD #58 ===

    const stats = (window.__cosmosStats = window.__cosmosStats ?? {});
    stats.orbitPositions = stats.orbitPositions ?? {};
    stats.orbitPositions[agent.name] = { x: sx, y: sy, z: projected.current.z };
    // MOD #37 seam: live working flags (MERGE into the map, never reassign).
    stats.orbitWorking = stats.orbitWorking ?? {};
    stats.orbitWorking[agent.name] = agent.working;
  });

  const showLabel = hovered || selected || agent.working;

  return (
    <>
      {/* MOD #37: dispatch beam (origin-space sibling — NOT inside the moving group) */}
      {!lowPerf && (
        <mesh ref={beamRef} visible={false}>
          {/* MOD #79: tapered + thinner. A constant-radius 0.035 tube at
              0.75 additive opacity blew out to a hard white bar across the
              frame — the least cinematic thing in the scene. A filament that
              tapers toward the agent reads as energy, not as a UI stroke. */}
          <cylinderGeometry args={[0.008, 0.028, 1, 8, 1, true]} />
          <meshBasicMaterial
            ref={beamMatRef}
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}

      <group ref={groupRef}>
        {/* Halo (status color; accent-tinted while working) */}
        {!lowPerf && glow && (
          <sprite ref={haloRef}>
            <spriteMaterial
              map={glow}
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              opacity={0.6}
            />
          </sprite>
        )}

        {/* Avatar disc (billboard) — carries pointer interaction */}
        <sprite
          ref={avatarRef}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            document.body.style.cursor = 'pointer';
          }}
          onPointerOut={() => {
            setHovered(false);
            document.body.style.cursor = 'auto';
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(agent);
          }}
        >
          <spriteMaterial map={avatarTex ?? undefined} transparent depthWrite={false} />
        </sprite>

        {/* Sonar ping ring (status change / dispatch) */}
        {!lowPerf && (
          <mesh ref={pingRef} visible={false}>
            <ringGeometry args={[0.9, 1.0, 48]} />
            <meshBasicMaterial
              ref={pingMatRef}
              color={agent.color}
              transparent
              opacity={0}
              side={THREE.DoubleSide}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        )}

        {showLabel && (
          <Html position={[0, 0.42, 0]} center distanceFactor={8} zIndexRange={[10, 0]}>
            <div
              className="pointer-events-none select-none whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px]"
              style={{
                background: 'rgba(5,11,20,0.72)',
                color: '#e7fbff',
                border: `1px solid ${agent.working ? agent.accent : CYAN}55`,
                // MOD #58: behind-the-orb fade (kept) × collision yield (new).
                opacity: (labelDim ? 0.35 : 1) * (labelYield ? 0.3 : 1),
                transform: `translateY(${labelYield * 20}px)`,
                // MOD #55: the one shared easing curve.
                transition: `opacity ${DUR_BASE}ms ${EASE}, transform ${DUR_BASE}ms ${EASE}`,
              }}
            >
              {agent.name}
              {agent.working ? ' ⚡' : ''}
            </div>
          </Html>
        )}
      </group>
    </>
  );
}

// ---------------------------------------------------------------------------
// The full orbit system (Canvas child).
// ---------------------------------------------------------------------------
interface OrbitSystemProps {
  agents: OrbitAgent[];
  selectedName: string | null;
  lowPerf: boolean;
  onSelect: (a: OrbitAgent) => void;
}

export function OrbitSystem({ agents, selectedName, lowPerf, onSelect }: OrbitSystemProps) {
  // === JARVIS MOD #58: radii derived from the live frustum, not hardcoded ===
  const fit = useOrbitFit();
  const labels = useRef<LabelRegistry>(new Map());

  // Drop registry entries for agents that have left the fleet, so a stale box
  // can never make a live label yield forever.
  useEffect(() => {
    const live = new Set(agents.map((a) => a.name));
    for (const name of labels.current.keys()) {
      if (!live.has(name)) labels.current.delete(name);
    }
  }, [agents]);

  const layout = useMemo(() => {
    // MOD #70: angle0 is derived from array INDEX, so an /api/agents response in
    // a different order silently teleported the whole constellation. Sort by
    // name — a stable key — so a poll can only ever change an agent's state,
    // never its seat.
    const ordered = [...agents].sort((a, b) => a.name.localeCompare(b.name));
    const rxOuter = Math.min(DESIGN_RX_OUTER, fit.rxMax);
    // Vertical amplitude: normally a gentle 28% of rx, but on a tall/narrow
    // frame (where rx is squeezed) spend the spare vertical room instead.
    // MOD #71: ryBand is the binding constraint on portrait (it excludes the
    // wordmark); on desktop ryBand === ryMax so this is a no-op.
    const ryOuter = Math.min(
      fit.ryMax,
      fit.ryBand,
      Math.max(rxOuter * 0.28, fit.rings === 1 ? rxOuter * 1.4 : 0),
    );
    const single = fit.rings === 1;
    const split = single ? ordered.length : Math.ceil(ordered.length / 2);
    const inner = ordered.slice(0, split);
    const outer = ordered.slice(split);

    const place = (
      list: OrbitAgent[],
      rx: number,
      ry: number,
      speed: number,
      yTilt: number,
      tiltAxis: number,
      slotBase: number,
    ) =>
      list.map((agent, i) => ({
        agent,
        rx,
        ry,
        rz: rx * 0.72,
        speed,
        yTilt,
        tiltAxis,
        angle0: (i / Math.max(list.length, 1)) * Math.PI * 2,
        phase: (i / Math.max(list.length, 1)) * Math.PI * 2,
        dockSlot: slotBase + i, // MOD #37: stable per-agent dock slot
      }));

    // Single ring rides the outer radius; two rings keep the original 0.7 nest.
    return [
      ...place(
        inner,
        single ? rxOuter : rxOuter * 0.7,
        single ? ryOuter : ryOuter * 0.7,
        0.12,
        Math.min(0.2, fit.ryMax * 0.1),
        0.35,
        0,
      ),
      ...place(outer, rxOuter, ryOuter, -0.08, -Math.min(0.2, fit.ryMax * 0.1), -0.5, inner.length),
    ];
  }, [agents, fit]);

  // Docked agents park just inside the right edge of the visible frustum.
  const dockX = Math.min(3.4, fit.rxMax * 0.92);
  // MOD #71: and inside the same vertical band, so docking can't park an agent
  // on top of the wordmark either.
  const yOffset = fit.yCenter;
  const dockYSpan = Math.min(1.9, fit.ryBand);
  // === END JARVIS MOD #58 ===

  return (
    <>
      {layout.map((item, i) => (
        <AgentNode
          key={item.agent.name}
          agent={item.agent}
          rx={item.rx}
          ry={item.ry}
          rz={item.rz}
          dockX={dockX}
          yOffset={yOffset}
          dockYSpan={dockYSpan}
          labels={labels}
          order={i}
          angle0={item.angle0}
          speed={item.speed}
          yTilt={item.yTilt}
          tiltAxis={item.tiltAxis}
          phase={item.phase}
          dockSlot={item.dockSlot}
          selected={selectedName === item.agent.name}
          lowPerf={lowPerf}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Frosted-glass side panel (DOM overlay). Shows agent detail + live log tail.
// ---------------------------------------------------------------------------
function AgentPanel({
  agent,
  onClose,
}: {
  agent: OrbitAgent;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLines(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/uhs/agent-tail/${encodeURIComponent(agent.name)}?lines=6`,
          { cache: 'no-store' },
        );
        const data = (await res.json()) as { lines?: string[] };
        if (!cancelled) setLines(data.lines ?? []);
      } catch {
        if (!cancelled) setLines([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.name]);

  const healthLabel =
    agent.health === 'healthy'
      ? 'Online'
      : agent.health === 'stale'
        ? 'Stale'
        : 'Offline';

  const runtime = agent.lastHeartbeat
    ? new Date(agent.lastHeartbeat).toLocaleString()
    : '—';

  return (
    <div
      data-testid="agent-orbit-panel"
      className="pointer-events-auto absolute right-6 top-1/2 z-20 w-80 -translate-y-1/2 rounded-2xl border border-white/10 p-5 text-[#e7fbff] shadow-2xl backdrop-blur-xl"
      style={{ background: 'rgba(5,11,20,0.55)', borderColor: 'rgba(34,211,238,0.25)' }}
    >
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: agent.color }}
            />
            <span className="font-mono text-sm font-semibold">{agent.name}</span>
          </div>
          <span className="text-xs" style={{ color: CYAN }}>
            {healthLabel}
            {agent.working ? ' · Working' : ''}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full px-2 transition hover:bg-white/10"
          style={{ color: CYAN }}
        >
          ✕
        </button>
      </div>

      <dl className="mb-3 space-y-1 text-xs">
        <div className="flex justify-between gap-3">
          <dt style={{ color: `${TEAL}cc` }}>Org</dt>
          <dd className="truncate font-mono">{agent.org || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt style={{ color: `${TEAL}cc` }}>Last heartbeat</dt>
          <dd className="truncate">{runtime}</dd>
        </div>
        {agent.currentTask ? (
          <div className="flex justify-between gap-3">
            <dt style={{ color: `${TEAL}cc` }}>Task</dt>
            <dd className="truncate" title={agent.currentTask}>
              {agent.currentTask}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="text-xs">
        <div className="mb-1 font-medium" style={{ color: CYAN }}>
          Recent output
        </div>
        <pre
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-[#e7fbff]/90"
          data-testid="agent-orbit-panel-log"
        >
          {loading
            ? 'Loading…'
            : lines && lines.length > 0
              ? lines.join('\n')
              : 'No recent output.'}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public: split component. The 3D orbit system renders inside <Canvas>; the DOM
// panel renders outside it. A thin hook shares agent state + selection.
// ---------------------------------------------------------------------------
export function useAgentOrbits() {
  const agents = useAgentPoll(3_000); // MOD #37: was 10s — live choreography
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const selected = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName],
  );

  const onSelect = useCallback((a: OrbitAgent) => setSelectedName(a.name), []);
  const onClose = useCallback(() => setSelectedName(null), []);

  // Publish count for the E2E assertion (orbitAgents === agent count).
  useEffect(() => {
    window.__cosmosStats = {
      ...(window.__cosmosStats ?? {}),
      orbitAgents: agents.length,
    };
  }, [agents.length]);

  return { agents, selected, selectedName, onSelect, onClose };
}

export function AgentOrbitsOverlay({
  selected,
  onClose,
}: {
  selected: OrbitAgent | null;
  onClose: () => void;
}) {
  if (!selected) return null;
  return <AgentPanel agent={selected} onClose={onClose} />;
}
// === END JARVIS MOD #22 / #29 / #37 ===
