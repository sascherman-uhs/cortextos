'use client';

/**
 * UHS Recurring Tasks Tab + Recurring Panel
 *
 * Lives in components/uhs/ — never overwritten by upstream merges.
 * Imported by tasks/page.tsx (tab) and task-detail-sheet.tsx (inline panel).
 */

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  IconRefresh,
  IconPlayerPause,
  IconPlayerPlay,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react';
import { TimeAgo } from '@/components/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecurringRun {
  id: number;
  type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface RecurringTask {
  id: number;
  name: string;
  type: string;
  agent: string;
  schedule: string;
  priority: number;
  enabled: boolean;
  last_run: string | null;
  last_result: unknown;
  created_at: string;
  payload: {
    description?: string;
    overnight_approved?: boolean;
    validation?: string;
    [key: string]: unknown;
  };
  recent_runs: RecurringRun[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scheduleLabel(schedule: string): string {
  if (schedule === 'nightly') return 'Nightly';
  if (schedule.startsWith('weekly:')) return `Weekly · ${schedule.slice(7).toUpperCase()}`;
  if (schedule.startsWith('monthly:')) return `Monthly · ${schedule.slice(8)}`;
  if (schedule.startsWith('after:')) return `After ${schedule.slice(6)} event`;
  return schedule;
}

function scheduleColor(schedule: string): string {
  if (schedule === 'nightly') return 'bg-blue-500/10 text-blue-600 dark:text-blue-400';
  if (schedule.startsWith('weekly:')) return 'bg-purple-500/10 text-purple-600 dark:text-purple-400';
  if (schedule.startsWith('after:')) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'bg-muted text-muted-foreground';
}

function RunStatusIcon({ run }: { run: RecurringRun }) {
  if (run.status === 'completed' && !run.error) {
    return <IconCheck size={12} className="text-green-500 shrink-0" />;
  }
  if (run.status === 'completed' && run.error) {
    return <IconAlertTriangle size={12} className="text-amber-500 shrink-0" />;
  }
  if (run.status === 'pending' || run.status === 'in_progress') {
    return <IconClock size={12} className="text-blue-500 shrink-0 animate-pulse" />;
  }
  return <IconX size={12} className="text-destructive shrink-0" />;
}

// ---------------------------------------------------------------------------
// RecurringPanel — inline panel for task-detail-sheet
// Shows when a task's payload has a recurring_task_id
// ---------------------------------------------------------------------------

interface RecurringPanelProps {
  recurringTaskId: number;
  recentRuns: RecurringRun[];
  schedule: string;
  recurringName: string;
  enabled: boolean;
}

export function RecurringPanel({
  recurringTaskId,
  recentRuns,
  schedule,
  recurringName,
  enabled,
}: RecurringPanelProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <IconRefresh size={13} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">Recurring Task</span>
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${scheduleColor(schedule)}`}>
          {scheduleLabel(schedule)}
        </span>
        {!enabled && (
          <span className="rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            Paused
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          Schedule #{recurringTaskId}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        This is a run of the <strong>{recurringName}</strong> recurring schedule.
      </p>
      {recentRuns.length > 0 && (
        <div className="space-y-1 mt-2">
          <p className="text-xs text-muted-foreground font-medium">Recent runs</p>
          {recentRuns.map((run) => (
            <div key={run.id} className="flex items-center gap-2 text-xs">
              <RunStatusIcon run={run} />
              <span className="font-mono text-muted-foreground">#{run.id}</span>
              <span className="capitalize text-muted-foreground">{run.status}</span>
              <TimeAgo date={run.created_at} className="text-xs text-muted-foreground ml-auto" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RecurringTaskCard — one card in the full Recurring tab
// ---------------------------------------------------------------------------

function RecurringTaskCard({
  task,
  onToggle,
  onSaveDescription,
  onDelete,
}: {
  task: RecurringTask;
  onToggle: (id: number, enabled: boolean) => void;
  onSaveDescription: (id: number, description: string, overnightApproved: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDesc, setEditDesc] = useState(task.payload.description ?? '');
  const [editOvernight, setEditOvernight] = useState(task.payload.overnight_approved ?? false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');

  const lastRun = task.recent_runs[0];
  const lastRunOk = lastRun && lastRun.status === 'completed' && !lastRun.error;
  const lastRunFailed = lastRun && (lastRun.status === 'failed' || (lastRun.error && lastRun.status !== 'completed'));

  async function handleToggle() {
    setToggling(true);
    try {
      onToggle(task.id, !task.enabled);
    } finally {
      setToggling(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      onSaveDescription(task.id, editDesc, editOvernight);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleteState('deleting');
    try {
      const res = await fetch(`/api/uhs/recurring-tasks?id=${task.id}`, { method: 'DELETE' });
      if (res.ok) {
        onDelete(task.id);
      } else {
        setDeleteState('confirm'); // stay in confirm on error so user can retry
      }
    } catch {
      setDeleteState('confirm');
    }
  }

  return (
    <Card className={`transition-colors ${!task.enabled ? 'opacity-60' : ''}`}>
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-start gap-2">
          {/* Expand chevron */}
          <button
            onClick={() => setExpanded((e) => !e)}
            className="mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
          </button>

          {/* Title + badges */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[10px] font-semibold text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">
                RT-{task.id}
              </span>
              <span className="font-medium text-sm truncate">{task.name}</span>
              <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${scheduleColor(task.schedule)}`}>
                {scheduleLabel(task.schedule)}
              </span>
              {!task.enabled && (
                <Badge variant="outline" className="text-destructive border-destructive/30 text-[10px] h-4">
                  Paused
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span>Agent: <span className="font-mono">{task.agent}</span></span>
              {task.last_run && (
                <span className="flex items-center gap-1">
                  Last run: <TimeAgo date={task.last_run} className="text-xs" />
                  {lastRunOk && <IconCheck size={11} className="text-green-500" />}
                  {lastRunFailed && <IconAlertTriangle size={11} className="text-amber-500" />}
                </span>
              )}
              {!task.last_run && <span className="italic">Never run</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              title={task.enabled ? 'Pause' : 'Resume'}
              disabled={toggling}
              onClick={handleToggle}
              className={task.enabled ? 'text-muted-foreground hover:text-destructive' : 'text-muted-foreground hover:text-green-500'}
            >
              {task.enabled ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Edit instructions"
              onClick={() => { setEditing((e) => !e); setExpanded(true); }}
            >
              <IconPencil size={14} />
            </Button>
            {deleteState === 'idle' && (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Delete this recurring task"
                onClick={() => { setDeleteState('confirm'); setExpanded(true); }}
                className="text-muted-foreground hover:text-destructive"
              >
                <IconTrash size={14} />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      {/* Expanded section */}
      {expanded && (
        <CardContent className="pt-0 pb-3 px-4">
          <Separator className="mb-3" />

          {/* Delete confirm banner */}
          {(deleteState === 'confirm' || deleteState === 'deleting') && (
            <div className="mb-3 flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              <IconTrash size={14} className="text-destructive shrink-0" />
              <span className="flex-1 text-destructive font-medium">
                Delete this recurring task permanently?
              </span>
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-xs"
                disabled={deleteState === 'deleting'}
                onClick={handleDelete}
              >
                {deleteState === 'deleting' ? 'Deleting…' : 'Delete'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={deleteState === 'deleting'}
                onClick={() => setDeleteState('idle')}
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Description / edit */}
          {editing ? (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Instructions / Description</Label>
                <Textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  rows={4}
                  placeholder="Describe what this task should do..."
                  className="text-sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  id={`overnight-${task.id}`}
                  type="checkbox"
                  checked={editOvernight}
                  onChange={(e) => setEditOvernight(e.target.checked)}
                  className="h-3.5 w-3.5 rounded"
                />
                <Label htmlFor={`overnight-${task.id}`} className="text-xs cursor-pointer">
                  Overnight approved (runs autonomously)
                </Label>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            task.payload.description && (
              <p className="text-xs text-muted-foreground whitespace-pre-wrap mb-3">
                {task.payload.description}
              </p>
            )
          )}

          {/* Recent runs */}
          {task.recent_runs.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Recent runs</p>
              {task.recent_runs.map((run) => (
                <div key={run.id} className="flex items-start gap-2 text-xs">
                  <RunStatusIcon run={run} />
                  <span className="font-mono text-muted-foreground shrink-0">#{run.id}</span>
                  <span className={`capitalize shrink-0 ${run.status === 'completed' && !run.error ? 'text-green-600 dark:text-green-400' : run.status === 'pending' ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}`}>
                    {run.status}
                  </span>
                  {run.error && (
                    <span className="text-amber-600 dark:text-amber-400 truncate flex-1" title={run.error}>
                      {run.error.slice(0, 80)}
                    </span>
                  )}
                  <TimeAgo date={run.created_at} className="text-xs text-muted-foreground ml-auto shrink-0" />
                </div>
              ))}
            </div>
          )}
          {task.recent_runs.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No runs recorded yet.</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// RecurringTasksTab — full tab shown in tasks/page.tsx
// ---------------------------------------------------------------------------

export function RecurringTasksTab() {
  const [tasks, setTasks] = useState<RecurringTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/uhs/recurring-tasks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load recurring tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  async function handleToggle(id: number, enabled: boolean) {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, enabled } : t)));
    try {
      const res = await fetch(`/api/uhs/recurring-tasks?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        // Revert
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, enabled: !enabled } : t)));
      }
    } catch {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, enabled: !enabled } : t)));
    }
  }

  async function handleSaveDescription(id: number, description: string, overnight_approved: boolean) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, payload: { ...t.payload, description, overnight_approved } }
          : t,
      ),
    );
    try {
      await fetch(`/api/uhs/recurring-tasks?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, overnight_approved }),
      });
    } catch { /* non-fatal — optimistic update already applied */ }
  }

  function handleDelete(id: number) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  if (loading) {
    return (
      <div className="space-y-2 mt-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 rounded-xl bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}{' '}
        <button onClick={fetchTasks} className="underline ml-2">Retry</button>
      </div>
    );
  }

  const active = tasks.filter((t) => t.enabled);
  const paused = tasks.filter((t) => !t.enabled);

  return (
    <div className="space-y-4 mt-2">
      {/* Summary row */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span><strong className="text-foreground">{active.length}</strong> active</span>
        {paused.length > 0 && (
          <span><strong className="text-foreground">{paused.length}</strong> paused</span>
        )}
        <button onClick={fetchTasks} className="ml-auto flex items-center gap-1 hover:text-foreground transition-colors text-xs">
          <IconRefresh size={12} />
          Refresh
        </button>
      </div>

      {/* Active schedules */}
      {active.length > 0 && (
        <div className="space-y-2">
          {active.map((t) => (
            <RecurringTaskCard
              key={t.id}
              task={t}
              onToggle={handleToggle}
              onSaveDescription={handleSaveDescription}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Paused schedules */}
      {paused.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Paused</p>
          {paused.map((t) => (
            <RecurringTaskCard
              key={t.id}
              task={t}
              onToggle={handleToggle}
              onSaveDescription={handleSaveDescription}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {tasks.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No recurring tasks defined yet.
        </p>
      )}
    </div>
  );
}
