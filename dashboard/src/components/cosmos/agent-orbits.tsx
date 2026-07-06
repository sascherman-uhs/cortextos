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
// Preserved seams (do not regress): polls /api/agents every 10s (visibility
// aware); publishes window.__cosmosStats.orbitAgents = N and .orbitPositions
// (live screen coords) for the E2E suite; clicking opens the frosted-glass panel
// with /api/uhs/agent-tail log lines; data-testids agent-orbit-panel(-log).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_ACCENTS, hashIndex, GREEN, RED, TEAL, CYAN } from './palette';

// Status → halo color (Trillion palette): online green, stale teal, down red.
const COLOR_OK = GREEN;
const COLOR_IDLE = TEAL;
const COLOR_DOWN = RED;

type Health = 'healthy' | 'stale' | 'down' | string;

interface AgentApi {
  name: string;
  org?: string;
  health?: Health;
  status?: string;
  lastHeartbeat?: string;
  currentTask?: string;
}

export interface OrbitAgent extends AgentApi {
  color: string; // status/halo color
  accent: string; // per-agent avatar accent
}

function healthColor(health?: Health): string {
  if (health === 'healthy') return COLOR_OK;
  if (health === 'stale') return COLOR_IDLE;
  return COLOR_DOWN; // 'down' or unknown
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
// Visibility-aware 10s poll of /api/agents (client-side fetch, authed session).
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
  radius: number;
  angle0: number;
  speed: number;
  yTilt: number;
  tiltAxis: number; // ring tilt orientation (radians)
  phase: number; // breathing phase offset
  selected: boolean;
  lowPerf: boolean;
  onSelect: (a: OrbitAgent) => void;
}

function AgentNode({
  agent,
  radius,
  angle0,
  speed,
  yTilt,
  tiltAxis,
  phase,
  selected,
  lowPerf,
  onSelect,
}: AgentNodeProps) {
  const groupRef = useRef<THREE.Group>(null);
  const avatarRef = useRef<THREE.Sprite>(null);
  const haloRef = useRef<THREE.Sprite>(null);
  const pingRef = useRef<THREE.Mesh>(null);
  const pingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const [labelDim, setLabelDim] = useState(false);
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

  const avatarTex = useMemo(
    () => makeAvatarTexture(agent.name, agent.accent),
    [agent.name, agent.accent],
  );
  const glow = useMemo(() => makeGlowTexture(), []);
  const haloColor = useMemo(() => new THREE.Color(agent.color), [agent.color]);

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.getElapsedTime();
    const angle = angle0 + t * speed;

    // Tilted elliptical path: build in-plane then rotate the plane about X.
    const ex = Math.cos(angle) * radius;
    const ez = Math.sin(angle) * radius * 0.72; // ellipse
    const ca = Math.cos(tiltAxis);
    const sa = Math.sin(tiltAxis);
    const x = ex * ca - ez * sa;
    const zr = ex * sa + ez * ca;
    const y = yTilt + Math.sin(angle) * radius * 0.28;
    groupRef.current.position.set(x, y, zr);

    // Depth fade: agents on the far side of the orb recede (dim + shrink) so
    // they sink into the sphere instead of blooming white over the bright core.
    const depthFade = zr >= 0 ? 1 : Math.max(0.32, 1 + zr / 4);

    // Out-of-phase breathing.
    const breathe = 1 + Math.sin(t * 1.6 + phase) * 0.09;
    const base = (selected ? 0.62 : hovered ? 0.56 : 0.46) * (0.6 + 0.4 * depthFade);
    if (avatarRef.current) {
      avatarRef.current.scale.setScalar(base * breathe);
      const am = avatarRef.current.material as THREE.SpriteMaterial;
      am.opacity = 0.35 + 0.65 * depthFade;
    }
    if (haloRef.current) {
      const pulse = agent.health === 'healthy' ? 0.8 + Math.sin(t * 3 + phase) * 0.2 : 0.6;
      haloRef.current.scale.setScalar(base * breathe * 2.1);
      const m = haloRef.current.material as THREE.SpriteMaterial;
      m.opacity = (selected ? 0.9 : 0.6) * pulse * depthFade;
      m.color.copy(haloColor);
    }

    // Label recedes when the agent is on the far side of the orb.
    const behind = zr < -0.2;
    if (behind !== labelDim) setLabelDim(behind);

    // Sonar ping animation.
    if (pingRef.current && pingMatRef.current) {
      if (pingStart.current >= 0) {
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

    // Debug seam: publish each node's live screen position (E2E deterministic click).
    projected.current.copy(groupRef.current.position).project(camera);
    const sx = (projected.current.x * 0.5 + 0.5) * size.width;
    const sy = (-projected.current.y * 0.5 + 0.5) * size.height;
    const stats = (window.__cosmosStats = window.__cosmosStats ?? {});
    stats.orbitPositions = stats.orbitPositions ?? {};
    stats.orbitPositions[agent.name] = { x: sx, y: sy, z: projected.current.z };
  });

  const showLabel = hovered || selected;

  return (
    <group ref={groupRef}>
      {/* Halo (status color) */}
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

      {/* Sonar ping ring (status change) */}
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
            className="pointer-events-none select-none whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] transition-opacity"
            style={{
              background: 'rgba(5,11,20,0.72)',
              color: '#e7fbff',
              border: `1px solid ${CYAN}55`,
              opacity: labelDim ? 0.35 : 1,
            }}
          >
            {agent.name}
          </div>
        </Html>
      )}
    </group>
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
  // Distribute agents across up to 2 rings, each with its own tilt.
  const layout = useMemo(() => {
    const inner = agents.slice(0, Math.ceil(agents.length / 2));
    const outer = agents.slice(Math.ceil(agents.length / 2));
    const place = (
      list: OrbitAgent[],
      radius: number,
      speed: number,
      yTilt: number,
      tiltAxis: number,
    ) =>
      list.map((agent, i) => ({
        agent,
        radius,
        speed,
        yTilt,
        tiltAxis,
        angle0: (i / Math.max(list.length, 1)) * Math.PI * 2,
        phase: (i / Math.max(list.length, 1)) * Math.PI * 2,
      }));
    return [
      ...place(inner, 2.6, 0.12, 0.2, 0.35),
      ...place(outer, 3.7, -0.08, -0.2, -0.5),
    ];
  }, [agents]);

  return (
    <>
      {layout.map((item) => (
        <AgentNode
          key={item.agent.name}
          agent={item.agent}
          radius={item.radius}
          angle0={item.angle0}
          speed={item.speed}
          yTilt={item.yTilt}
          tiltAxis={item.tiltAxis}
          phase={item.phase}
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
  const agents = useAgentPoll(10_000);
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
// === END JARVIS MOD #22 / #29 ===
