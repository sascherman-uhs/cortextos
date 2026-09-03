'use client';

/**
 * Queue page "Recurring" lane.
 *
 * Reuses the same data sources as the existing pieces rather than forking
 * new fetch logic: SkillRunsCard is embedded verbatim (blocked/unfinished
 * skill runs), and the recurring-jobs summary below hits the exact same
 * /api/uhs/recurring-tasks endpoint recurring-tasks-tab.tsx already uses —
 * just condensed into counts + a link to the full tab.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconChevronRight, IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { SkillRunsCard } from '@/components/uhs/skill-runs-card';
import type { RecurringTask } from '@/components/uhs/recurring-tasks-tab';

function RecurringJobsSummary() {
  const [tasks, setTasks] = useState<RecurringTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/uhs/recurring-tasks', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load recurring tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const active = tasks.filter((t) => t.enabled);
  const paused = tasks.filter((t) => !t.enabled);
  const recentlyFailed = active.filter((t) => {
    const last = t.recent_runs[0];
    return last && (last.status === 'failed' || (last.error && last.status !== 'completed'));
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Recurring Jobs
        </CardTitle>
        <Link
          href="/tasks?tab=recurring"
          className="flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View all
          <IconChevronRight size={14} />
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <IconAlertTriangle size={14} />
            <span>{error}</span>
            <button onClick={load} className="ml-auto">
              <IconRefresh size={14} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4 text-sm">
            <span><strong>{active.length}</strong> active</span>
            {paused.length > 0 && (
              <span className="text-muted-foreground"><strong className="text-foreground">{paused.length}</strong> paused</span>
            )}
            {recentlyFailed.length > 0 && (
              <Badge variant="destructive">{recentlyFailed.length} last run failed</Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RecurringLane() {
  return (
    <div className="space-y-4">
      <RecurringJobsSummary />
      <SkillRunsCard />
    </div>
  );
}
