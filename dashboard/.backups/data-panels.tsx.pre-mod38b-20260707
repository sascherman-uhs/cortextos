'use client';

// === JARVIS MOD #22 — Cosmos Tier 5: floating data panels (2026-07-03) ===
// New file (cosmos is ours). Frosted-glass stat cards positioned around the
// edges of the Cosmos scene: Active Stagings, Pending Tasks, Fleet Uptime,
// Telegram Today, MLS New Listings. Refreshes /api/uhs/cosmos-stats every 60s
// (visibility-aware). Each metric degrades to "—" when the API reports it
// unavailable (derive-from-owned-data rule — never fabricate). UHS palette.

import { useCallback, useEffect, useState } from 'react';

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

interface StatCardProps {
  label: string;
  value: string;
  position: string; // tailwind positioning classes
  testId: string;
  hint?: string;
}

function StatCard({ label, value, position, testId, hint }: StatCardProps) {
  return (
    <div
      data-testid={testId}
      className={`pointer-events-auto absolute z-10 min-w-[9rem] rounded-2xl border border-white/10 px-4 py-3 backdrop-blur-xl ${position}`}
      style={{ background: 'rgba(45,41,40,0.5)' }}
      title={hint}
    >
      <div className="text-[10px] uppercase tracking-[0.18em] text-[#CFB383]">
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-light text-[#EDE8DF] [text-shadow:0_0_16px_rgba(207,179,131,0.25)]"
        data-testid={`${testId}-value`}
      >
        {value}
      </div>
    </div>
  );
}

export function DataPanels() {
  const stats = useCosmosStats(60_000);

  return (
    <>
      <StatCard
        testId="panel-active-stagings"
        label="Active Stagings"
        value={metricText(stats?.activeStagings, (v) => String(v))}
        position="left-6 top-24"
        hint={
          stats?.activeStagings && !stats.activeStagings.ok
            ? stats.activeStagings.unavailable
            : undefined
        }
      />
      <StatCard
        testId="panel-pending-tasks"
        label="Pending Tasks"
        value={metricText(stats?.pendingTasks, (v) => String(v))}
        position="left-6 top-48"
        hint={
          stats?.pendingTasks && !stats.pendingTasks.ok
            ? stats.pendingTasks.unavailable
            : undefined
        }
      />
      <StatCard
        testId="panel-fleet-uptime"
        label="Fleet Uptime"
        value={metricText(stats?.fleetUptime, (v) => v.label)}
        position="right-6 top-24"
        hint={
          stats?.fleetUptime && !stats.fleetUptime.ok
            ? stats.fleetUptime.unavailable
            : undefined
        }
      />
      <StatCard
        testId="panel-telegram-today"
        label="Telegram Today"
        value={metricText(stats?.telegramToday, (v) => String(v))}
        position="right-6 top-48"
        hint={
          stats?.telegramToday && !stats.telegramToday.ok
            ? stats.telegramToday.unavailable
            : undefined
        }
      />
      <StatCard
        testId="panel-mls-new"
        label="MLS New Today"
        value={metricText(stats?.mlsNewToday, (v) => String(v))}
        position="bottom-8 left-1/2 -translate-x-1/2"
        hint={
          stats?.mlsNewToday && !stats.mlsNewToday.ok
            ? stats.mlsNewToday.unavailable
            : undefined
        }
      />
    </>
  );
}
// === END JARVIS MOD #22 ===
