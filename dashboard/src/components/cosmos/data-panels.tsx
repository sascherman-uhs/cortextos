'use client';

// === JARVIS MOD #22 — Cosmos Tier 5: floating data panels (2026-07-03) ===
// New file (cosmos is ours). Frosted-glass stat cards positioned around the
// edges of the Cosmos scene: Active Stagings, Pending Tasks, Fleet Uptime,
// Telegram Today, MLS New Listings. Refreshes /api/uhs/cosmos-stats every 60s
// (visibility-aware). Each metric degrades to "—" when the API reports it
// unavailable (derive-from-owned-data rule — never fabricate). UHS palette.

import { useCallback, useEffect, useState } from 'react';
// === JARVIS MOD #56: cool chrome tokens (no gold outside the listening state) ===
import { COOL_TEXT, COOL_DIM, COOL_LINE } from './palette';
// === END JARVIS MOD #56 ===

type Metric<T> = { ok: true; value: T } | { ok: false; unavailable: string };

interface CosmosStats {
  pendingTasks: Metric<number>;
  activeStagings: Metric<number>;
  mlsNewToday: Metric<number>;
  fleetUptime: Metric<{ seconds: number; label: string }>;
  telegramToday: Metric<number>;
  generatedAt: string;
}

function metricText<T>(m: Metric<T> | undefined, fmt: (v: T) => string): string {
  if (!m || !m.ok) return '—';
  return fmt(m.value);
}

function useCosmosStats(intervalMs: number): CosmosStats | null {
  const [stats, setStats] = useState<CosmosStats | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/uhs/cosmos-stats', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as CosmosStats;
      setStats(data);
    } catch {
      // keep last good frame
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
    else void load();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);

  return stats;
}

// === JARVIS MOD #38 — client-side voice metrics (2026-07-07) ===
// Fast-lane hit rate + response-latency p50 live in window.__cosmosStats (written
// by use-voice's fastReplies/escalations counters and use-tts's recordLatencySample).
// They are runtime-only, per-session, and never hit the server — so this panel reads
// them directly rather than through /api/uhs/cosmos-stats. Poll at 1s (cheap, local).
interface VoiceMetrics {
  p50Ms: number;
  hitPct: number | null; // null until at least one [Cosmos] turn resolves
  samples: number;
}

function useVoiceMetrics(intervalMs: number): VoiceMetrics {
  const [m, setM] = useState<VoiceMetrics>({ p50Ms: 0, hitPct: null, samples: 0 });
  useEffect(() => {
    const read = () => {
      const s = typeof window !== 'undefined' ? window.__cosmosStats : undefined;
      const fast = s?.fastReplies ?? 0;
      const esc = s?.escalations ?? 0;
      const total = fast + esc;
      setM({
        p50Ms: s?.voiceLatency?.p50 ?? 0,
        hitPct: total > 0 ? Math.round((fast / total) * 100) : null,
        samples: s?.voiceLatency?.n ?? 0,
      });
    };
    read();
    const t = setInterval(read, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return m;
}
// === END JARVIS MOD #38 ===

interface StatCardProps {
  label: string;
  value: string;
  position: string; // tailwind positioning classes
  testId: string;
  hint?: string;
}

// === JARVIS MOD #56: stat chrome de-warmed. These tiles carried UHS gold
// labels and a gold text-shadow at every state, which put permanent warm
// accents all over an otherwise cool scene and stole the "listening" moment. ===
// === JARVIS MOD #59: desktop keeps the absolutely-positioned cards; on a phone
// the five tiles used to stack down the left edge ON TOP of the orb (critic
// defect #7 — the hero was buried). Below md they render once, in a compact
// horizontally-scrollable strip pinned under the header instead. ===
function StatCard({ label, value, position, testId, hint }: StatCardProps) {
  return (
    <div
      data-testid={testId}
      className={`pointer-events-auto absolute z-10 hidden min-w-[9rem] rounded-2xl border px-4 py-3 backdrop-blur-xl md:block ${position}`}
      style={{ background: 'rgba(16,26,34,0.55)', borderColor: COOL_LINE }}
      title={hint}
    >
      <div
        className="text-[10px] uppercase tracking-[0.18em]"
        style={{ color: COOL_DIM }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-light [text-shadow:0_0_16px_rgba(94,234,212,0.22)]"
        style={{ color: COOL_TEXT }}
        data-testid={`${testId}-value`}
      >
        {value}
      </div>
    </div>
  );
}

/** MOD #59: the mobile counterpart — one compact, swipeable chip per metric. */
function StatChip({ label, value, testId, hint }: Omit<StatCardProps, 'position'>) {
  return (
    <div
      data-testid={`${testId}-chip`}
      className="pointer-events-auto shrink-0 snap-start rounded-xl border px-3 py-1.5 backdrop-blur-xl"
      style={{ background: 'rgba(16,26,34,0.55)', borderColor: COOL_LINE }}
      title={hint}
    >
      <div
        className="text-[9px] uppercase tracking-[0.16em] whitespace-nowrap"
        style={{ color: COOL_DIM }}
      >
        {label}
      </div>
      <div
        className="text-base font-light leading-tight"
        style={{ color: COOL_TEXT }}
        data-testid={`${testId}-chip-value`}
      >
        {value}
      </div>
    </div>
  );
}

export function DataPanels() {
  const stats = useCosmosStats(60_000);
  const voice = useVoiceMetrics(1_000);

  // One list, rendered twice: absolute cards on desktop, a strip on mobile.
  const metrics: Omit<StatCardProps, 'position'>[] = [
    {
      testId: 'panel-active-stagings',
      label: 'Active Stagings',
      value: metricText(stats?.activeStagings, (v) => String(v)),
      hint:
        stats?.activeStagings && !stats.activeStagings.ok
          ? stats.activeStagings.unavailable
          : undefined,
    },
    {
      testId: 'panel-pending-tasks',
      label: 'Pending Tasks',
      value: metricText(stats?.pendingTasks, (v) => String(v)),
      hint:
        stats?.pendingTasks && !stats.pendingTasks.ok ? stats.pendingTasks.unavailable : undefined,
    },
    {
      testId: 'panel-fleet-uptime',
      label: 'Fleet Uptime',
      value: metricText(stats?.fleetUptime, (v) => v.label),
      hint: stats?.fleetUptime && !stats.fleetUptime.ok ? stats.fleetUptime.unavailable : undefined,
    },
    {
      testId: 'panel-telegram-today',
      label: 'Telegram Today',
      value: metricText(stats?.telegramToday, (v) => String(v)),
      hint:
        stats?.telegramToday && !stats.telegramToday.ok
          ? stats.telegramToday.unavailable
          : undefined,
    },
    {
      testId: 'panel-mls-new',
      label: 'MLS New Today',
      value: metricText(stats?.mlsNewToday, (v) => String(v)),
      hint: stats?.mlsNewToday && !stats.mlsNewToday.ok ? stats.mlsNewToday.unavailable : undefined,
    },
    {
      testId: 'panel-voice-latency',
      label: voice.hitPct === null ? 'Voice Reply' : `Voice · ${voice.hitPct}% fast`,
      value: voice.samples > 0 ? `${(voice.p50Ms / 1000).toFixed(1)}s` : '—',
      hint:
        voice.samples > 0
          ? `p50 of ${voice.samples} spoken turns (user-stopped → first audible). ${voice.hitPct ?? 0}% answered by the fast lane.`
          : 'No spoken turns yet this session.',
    },
  ];

  return (
    <>
      {/* MOD #59: mobile strip — scrolls horizontally, never covers the orb */}
      <div
        data-testid="panel-strip-mobile"
        className="pointer-events-auto fixed inset-x-0 z-10 flex snap-x gap-2 overflow-x-auto px-3 pb-1 md:hidden"
        style={{
          top: 'calc(3.25rem + env(safe-area-inset-top))',
          scrollbarWidth: 'none',
        }}
      >
        {metrics.map((m) => (
          <StatChip key={m.testId} {...m} />
        ))}
      </div>

      {/* Desktop: the original absolutely-positioned cards, unchanged layout */}
      <StatCard {...metrics[0]} position="left-6 top-24" />
      <StatCard {...metrics[1]} position="left-6 top-48" />
      <StatCard {...metrics[5]} position="left-6 top-72" />
      <StatCard {...metrics[2]} position="right-6 top-24" />
      <StatCard {...metrics[3]} position="right-6 top-48" />
      <StatCard {...metrics[4]} position="bottom-8 left-1/2 -translate-x-1/2" />
    </>
  );
}
// === END JARVIS MOD #22 ===
