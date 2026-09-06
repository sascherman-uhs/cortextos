'use client';

/**
 * UHS Blocked & Unfinished Skill Runs card
 *
 * Lives in components/uhs/ — never overwritten by upstream merges.
 * Read-only. Fetches /api/uhs/skill-runs (blocked + in_progress rows from the
 * uhs-jarvis `skill_runs` table, oldest-updated first) and surfaces stalled
 * work: step progress, outstanding steps, and each blocker.
 */

import { useEffect, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  IconRefresh,
  IconAlertTriangle,
  IconLoader2,
  IconCircleCheck,
  IconHandStop,
  IconRotateClockwise,
} from '@tabler/icons-react';
import { TimeAgo } from '@/components/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillStep {
  n: string | number;
  label: string;
  status: string;
  note?: string;
}

export interface SkillBlocker {
  item: string;
  reason?: string;
  needs?: string;
  kind?: string;
  retryable?: boolean;
  since?: string;
}

export interface SkillRun {
  id: number;
  skill: string;
  subject: string;
  status: string;
  agent: string | null;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  steps: SkillStep[] | null;
  blockers: SkillBlocker[] | null;
  meta: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DONE_STEP_STATUSES = new Set(['done', 'complete', 'completed', 'skipped']);

function isOutstanding(step: SkillStep): boolean {
  return !DONE_STEP_STATUSES.has((step.status ?? '').toLowerCase());
}

function stepProgress(steps: SkillStep[] | null): { done: number; total: number } {
  if (!steps || steps.length === 0) return { done: 0, total: 0 };
  const done = steps.filter((s) => !isOutstanding(s)).length;
  return { done, total: steps.length };
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'blocked') {
    return <IconAlertTriangle size={16} className="text-destructive shrink-0" />;
  }
  // in_progress
  return (
    <IconLoader2 size={16} className="text-blue-500 shrink-0 animate-spin" />
  );
}

// ---------------------------------------------------------------------------
// Run row
// ---------------------------------------------------------------------------

function SkillRunRow({ run }: { run: SkillRun }) {
  const { done, total } = stepProgress(run.steps);
  const outstanding = (run.steps ?? []).filter(isOutstanding);
  const blockers = run.blockers ?? [];

  return (
    <div className="rounded-lg ring-1 ring-foreground/10 p-3 space-y-2">
      {/* Header line */}
      <div className="flex items-start gap-2">
        <StatusIcon status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">
              {run.skill}
              <span className="text-muted-foreground"> / {run.subject}</span>
            </span>
            {total > 0 && (
              <Badge variant="outline" className="tabular-nums">
                {done}/{total}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {run.agent ? `${run.agent} · ` : ''}
            {run.updated_at && (
              <>
                updated <TimeAgo date={run.updated_at} />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Outstanding steps */}
      {outstanding.length > 0 && (
        <div className="pl-6 space-y-0.5">
          {outstanding.map((s, i) => (
            <div
              key={`${run.id}-step-${s.n}-${i}`}
              className="flex items-baseline gap-1.5 text-xs text-muted-foreground"
            >
              <span className="tabular-nums text-foreground/50 shrink-0">
                {s.n}.
              </span>
              <span className="truncate">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="pl-6 space-y-1">
          {blockers.map((b, i) => (
            <div
              key={`${run.id}-blocker-${i}`}
              className="flex items-start gap-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{b.item}</span>
                {b.reason ? (
                  <span className="text-muted-foreground"> — {b.reason}</span>
                ) : null}
              </div>
              {b.retryable ? (
                <Badge
                  variant="outline"
                  className="shrink-0 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-transparent"
                >
                  <IconRotateClockwise size={12} />
                  auto-retry
                </Badge>
              ) : (
                <Badge variant="destructive" className="shrink-0">
                  <IconHandStop size={12} />
                  needs you
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function SkillRunsCard() {
  const [runs, setRuns] = useState<SkillRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Depending on pathname (not just mount) re-fires this fetch on route
  // re-entry, including browser back/forward, in case this component
  // instance persists across a soft navigation instead of remounting.
  const pathname = usePathname();

  const load = useCallback(async () => {
    // Explicit reset on every call (mount, poll, manual Refresh click, or
    // route re-entry) so a stuck "Loading…"/stale-error state can never
    // survive a call to load() — the Refresh button must always visibly do
    // something (bug: 2026-09-03 round 2).
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/uhs/skill-runs', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load, pathname]);

  const blockedCount = runs.filter((r) => r.status === 'blocked').length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Blocked &amp; Unfinished Skill Runs
        </CardTitle>
        <div className="flex items-center gap-2">
          {blockedCount > 0 && (
            <Badge variant="destructive">{blockedCount} blocked</Badge>
          )}
          <button
            type="button"
            onClick={load}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            aria-label="Refresh skill runs"
          >
            <IconRefresh size={14} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading && runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <IconAlertTriangle size={14} />
            <span>Could not load skill runs: {error}</span>
          </div>
        ) : runs.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <IconCircleCheck size={16} className="text-green-500" />
            <span>All skill runs complete — nothing stalled.</span>
          </div>
        ) : (
          runs.map((run) => <SkillRunRow key={run.id} run={run} />)
        )}
      </CardContent>
    </Card>
  );
}
