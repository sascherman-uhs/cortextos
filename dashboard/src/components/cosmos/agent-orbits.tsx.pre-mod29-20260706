'use client';

// === JARVIS MOD #22 — Cosmos Tier 4: agent orbit visualization (2026-07-03) ===
// New file (cosmos is ours). Renders each fleet agent as a small sphere orbiting
// the central orb, distributed across 1-2 rings, slowly rotating. Color encodes
// health with UHS-palette-compatible tones. Clicking a sphere opens a
// frosted-glass side panel with the agent's name/status/runtime + last stdout
// lines (from /api/uhs/agent-tail). Polls /api/agents every 10s, visibility-aware
// (same discipline as MOD #17's useVisibleStatusPoll). Publishes
// window.__cosmosStats.orbitAgents = N for the E2E assertion.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

// UHS-palette health tones (per plan): ok green, idle gold, down red.
const COLOR_OK = '#7FA56F';
const COLOR_IDLE = '#CFB383';
const COLOR_DOWN = '#B0533B';

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
  color: string;
}

function healthColor(health?: Health): string {
  if (health === 'healthy') return COLOR_OK;
  if (health === 'stale') return COLOR_IDLE;
  return COLOR_DOWN; // 'down' or unknown
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
        data.map((a) => ({ ...a, color: healthColor(a.health) })),
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
// A single orbiting agent sphere (rendered inside the Canvas).
// ---------------------------------------------------------------------------
interface AgentSphereProps {
  agent: OrbitAgent;
  radius: number;
  angle0: number; // starting angle (radians)
  speed: number; // radians per second
  yTilt: number; // vertical offset for the ring
  selected: boolean;
  onSelect: (a: OrbitAgent) => void;
}

function AgentSphere({
  agent,
  radius,
  angle0,
  speed,
  yTilt,
  selected,
  onSelect,
}: AgentSphereProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const { camera, size } = useThree();
  const projected = useRef(new THREE.Vector3());

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.getElapsedTime();
    const angle = angle0 + t * speed;
    groupRef.current.position.set(
      Math.cos(angle) * radius,
      yTilt + Math.sin(angle) * radius * 0.35, // slightly elliptical, tilted ring
      Math.sin(angle) * radius,
    );
    // Debug seam: publish each sphere's live screen position so E2E tests can
    // click a moving target deterministically. Cheap (one project() per frame).
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
      <mesh
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
        scale={selected ? 1.5 : hovered ? 1.25 : 1}
      >
        <sphereGeometry args={[0.16, 24, 24]} />
        <meshStandardMaterial
          color={agent.color}
          emissive={agent.color}
          emissiveIntensity={selected ? 0.9 : 0.5}
          roughness={0.4}
        />
      </mesh>
      {showLabel && (
        <Html position={[0, 0.34, 0]} center distanceFactor={8} zIndexRange={[10, 0]}>
          <div
            className="pointer-events-none select-none whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px]"
            style={{
              background: 'rgba(45,41,40,0.7)',
              color: '#EDE8DF',
              border: '1px solid rgba(207,179,131,0.35)',
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
// The full orbit system (Canvas child) + a DOM overlay side panel (portal'd via
// the parent, see AgentOrbits below which splits Canvas vs DOM).
// ---------------------------------------------------------------------------
interface OrbitSystemProps {
  agents: OrbitAgent[];
  selectedName: string | null;
  onSelect: (a: OrbitAgent) => void;
}

export function OrbitSystem({ agents, selectedName, onSelect }: OrbitSystemProps) {
  // Distribute agents across up to 2 rings. Inner ring first, then outer.
  const layout = useMemo(() => {
    const inner = agents.slice(0, Math.ceil(agents.length / 2));
    const outer = agents.slice(Math.ceil(agents.length / 2));
    const place = (
      list: OrbitAgent[],
      radius: number,
      speed: number,
      yTilt: number,
    ) =>
      list.map((agent, i) => ({
        agent,
        radius,
        speed,
        yTilt,
        angle0: (i / Math.max(list.length, 1)) * Math.PI * 2,
      }));
    return [
      ...place(inner, 2.4, 0.12, 0.15),
      ...place(outer, 3.5, -0.08, -0.15), // outer ring counter-rotates, slower
    ];
  }, [agents]);

  return (
    <>
      {layout.map((item) => (
        <AgentSphere
          key={item.agent.name}
          agent={item.agent}
          radius={item.radius}
          angle0={item.angle0}
          speed={item.speed}
          yTilt={item.yTilt}
          selected={selectedName === item.agent.name}
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
      className="pointer-events-auto absolute right-6 top-1/2 z-20 w-80 -translate-y-1/2 rounded-2xl border border-white/10 p-5 text-[#EDE8DF] shadow-2xl backdrop-blur-xl"
      style={{ background: 'rgba(45,41,40,0.55)' }}
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
          <span className="text-xs text-[#CFB383]">{healthLabel}</span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full px-2 text-[#CFB383] transition hover:bg-white/10"
        >
          ✕
        </button>
      </div>

      <dl className="mb-3 space-y-1 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-[#CFB383]/80">Org</dt>
          <dd className="truncate font-mono">{agent.org || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-[#CFB383]/80">Last heartbeat</dt>
          <dd className="truncate">{runtime}</dd>
        </div>
        {agent.currentTask ? (
          <div className="flex justify-between gap-3">
            <dt className="text-[#CFB383]/80">Task</dt>
            <dd className="truncate" title={agent.currentTask}>
              {agent.currentTask}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="text-xs">
        <div className="mb-1 font-medium text-[#CFB383]">Recent output</div>
        <pre
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-[#EDE8DF]/90"
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
// Public: split component. The 3D orbit system must render inside <Canvas>;
// the DOM panel must render outside it. So this file exports OrbitSystem (Canvas
// child) and AgentOrbitsOverlay (DOM). A thin hook shares agent state + selection.
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
// === END JARVIS MOD #22 ===
