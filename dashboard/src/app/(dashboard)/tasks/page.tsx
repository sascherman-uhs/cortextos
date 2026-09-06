'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useOrg } from '@/hooks/use-org';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { IconLayoutKanban, IconList, IconChecklist, IconRepeat } from '@tabler/icons-react';
import { TaskListTable } from '@/components/tasks/task-list-table';
import { TaskDetailSheet, type StatusChangeResult } from '@/components/tasks/task-detail-sheet';
import { moveOutcome } from '@/lib/tasks/move-result';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { TaskFilters } from '@/components/tasks/task-filters';
// UHS MOD #7 — recurring tasks tab (components/uhs/ never overwritten by upstream)
import { RecurringTasksTab } from '@/components/uhs/recurring-tasks-tab';
import { getTaskNumber } from '@/components/uhs/task-number-badge';
// UHS MOD #11 — drag-to-agent routing board (Task #889 / L6-01)
import { AgentRoutingBoard } from '@/components/uhs/agent-routing-board';
import type { Task, TaskStatus } from '@/lib/types';

type ViewMode = 'kanban' | 'list';

const DEFAULT_FILTERS = {
  org: 'all',
  agent: 'all',
  priority: 'all',
  project: 'all',
  status: 'all',
  date: undefined as 'today' | undefined,
};

export default function TasksPage() {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();

  // Deep-link support: /tasks?tab=recurring, /tasks?agent=human, /tasks?status=blocked,
  // /tasks?status=completed&date=today (used by the Overview ActionRequired card and
  // the Queue page's lanes). A status=completed deep link defaults to List view since
  // the Board's Completed column is a separate, unfiltered fetch (pre-existing,
  // unrelated quirk — see completedToday below) that would otherwise look wrong.
  const [view, setView] = useState<ViewMode>(
    searchParams.get('status') === 'completed' ? 'list' : 'kanban'
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedToday, setCompletedToday] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<'tasks' | 'recurring'>(
    searchParams.get('tab') === 'recurring' ? 'recurring' : 'tasks'
  );
  const [filters, setFilters] = useState(() => ({
    ...DEFAULT_FILTERS,
    agent: searchParams.get('agent') ?? DEFAULT_FILTERS.agent,
    status: searchParams.get('status') ?? DEFAULT_FILTERS.status,
    date: searchParams.get('date') === 'today' ? ('today' as const) : DEFAULT_FILTERS.date,
  }));
  // UHS MOD #7 — search is client-side only; isolated from filters so typing
  // never re-creates fetchTasks or triggers setLoading (no API round-trip).
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** A move that did not take: a version conflict, or an outright failure.
   *  Shown rather than swallowed — a silent failure looks exactly like success. */
  const [conflict, setConflict] = useState<string | null>(null);

  // Derive unique values for filter dropdowns
  const allTasks = tasks;
  const agents = [...new Set(allTasks.map((t) => t.assignee).filter(Boolean) as string[])];
  const projects = [...new Set(allTasks.map((t) => t.project).filter(Boolean) as string[])];
  const orgs = [...new Set(allTasks.map((t) => t.org))];

  const fetchTasks = useCallback(async () => {
    const params = new URLSearchParams();
    const effectiveOrg = currentOrg !== 'all' ? currentOrg : (filters.org !== 'all' ? filters.org : '');
    if (effectiveOrg) params.set('org', effectiveOrg);
    if (filters.agent !== 'all') params.set('agent', filters.agent);
    if (filters.priority !== 'all') params.set('priority', filters.priority);
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.project !== 'all') params.set('project', filters.project);
    if (filters.date === 'today') params.set('date', 'today');

    try {
      // Build completed params with same filters (except status/date — the
      // Board's Completed column is intentionally an unscoped "all completed"
      // view today; date scoping only applies to the primary tasks fetch).
      const completedParams = new URLSearchParams(params);
      completedParams.delete('date');
      completedParams.set('status', 'completed');
      completedParams.delete('status'); // remove any existing non-completed status
      completedParams.set('status', 'completed');

      const [tasksRes, completedRes] = await Promise.all([
        fetch(`/api/tasks?${params.toString()}`),
        fetch(`/api/tasks?${completedParams.toString()}`),
      ]);

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setTasks(data);
      }
      if (completedRes.ok) {
        const data: Task[] = await completedRes.json();
        setCompletedToday(data);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [currentOrg, filters]);

  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [fetchTasks]);

  // Keep the open sheet pointed at the row the last fetch returned. Without
  // this the sheet keeps the snapshot it was opened with, so after a conflict
  // refresh a retry would send the same stale version and conflict again.
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = [...tasks, ...completedToday].find((t) => t.id === selectedTask.id);
    if (fresh && fresh !== selectedTask) setSelectedTask(fresh);
  }, [tasks, completedToday, selectedTask]);

  function handleFilterChange(key: string, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function handleClearFilters() {
    setFilters(DEFAULT_FILTERS);
    setSearchQuery('');
  }

  function handleTaskClick(task: Task) {
    setSelectedTask(task);
    setSheetOpen(true);
  }

  async function handleStatusChange(
    taskId: string,
    status: TaskStatus,
    note?: string,
  ): Promise<StatusChangeResult> {
    setConflict(null);
    try {
      // OS-02: send the version this view was rendered from, so a change made
      // while the board was open comes back as a conflict instead of silently
      // overwriting whoever got there first.
      const current = [...tasks, ...completedToday].find((t) => t.id === taskId) as
        | (Task & { version?: number })
        | undefined;
      // Fail closed. A move with no version is a blind write — it would land on
      // top of whatever changed since this list was fetched. Refresh and ask
      // the person to try again rather than posting without the field.
      if (typeof current?.version !== 'number') {
        const message =
          'This task was listed without a version, so the move was not sent — '
          + 'sending it could overwrite a change made since this page loaded. '
          + 'The list has been refreshed; try again.';
        setConflict(message);
        fetchTasks();
        return { ok: false, message };
      }
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note, expectedVersion: current.version }),
      });

      if (res.ok) {
        setSheetOpen(false);
        setSelectedTask(null);
        fetchTasks();
        return { ok: true };
      }

      const data = await res.json().catch(() => ({}));
      // A failed move used to fail silently, which is indistinguishable from a
      // move that worked. Say so — and when the work contract refused it (422),
      // show the sentence that names the legal moves rather than an error code.
      const outcome = moveOutcome(res.status, data);
      setConflict(outcome.message ?? null);
      if (res.status === 409) {
        // The record moved underneath this view. Re-read it, and leave the
        // sheet OPEN carrying the message: closing it dropped the refusal into
        // a banner behind the dialog, where nobody saw it, and left the person
        // with no way to retry against the record that now exists.
        fetchTasks();
      }
      return outcome;
    } catch {
      const message = 'Could not reach the server. This task was not moved.';
      setConflict(message);
      return { ok: false, message };
    }
  }

  async function handleDelete(taskId: string) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (res.ok) {
        setSheetOpen(false);
        setSelectedTask(null);
        fetchTasks();
      }
    } catch {
      // Silently fail
    }
  }

  // UHS MOD #7 — client-side search by task number or title
  function matchesSearch(task: Task, query: string): boolean {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    // Match "#720" or "720" against task number
    const numQuery = q.replace(/^#/, '');
    const taskNum = getTaskNumber(task.id);
    if (taskNum && taskNum === numQuery) return true;
    // Match against title
    return task.title.toLowerCase().includes(q);
  }

  // Filter tasks for display (non-completed for kanban columns, all for list)
  const displayTasks = (view === 'kanban'
    ? tasks.filter((t) => t.status !== 'completed')
    : tasks
  ).filter((t) => matchesSearch(t, searchQuery));

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <div className="space-y-4">
          <div className="h-10 w-full rounded-lg bg-muted/30 animate-pulse" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-64 rounded-xl bg-muted/30 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* UHS MOD #7 — top-level tabs: One-time tasks vs Recurring tasks */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'tasks' | 'recurring')} className="w-full">
        {/* Header — title + tab switcher + view controls on same row */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Tasks</h1>
            <TabsList className="h-8">
              <TabsTrigger value="tasks" className="text-xs px-3 h-7">
                <IconChecklist className="size-3.5 mr-1.5" />
                One-time
              </TabsTrigger>
              <TabsTrigger value="recurring" className="text-xs px-3 h-7">
                <IconRepeat className="size-3.5 mr-1.5" />
                Recurring
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border bg-muted/30 p-0.5">
              <Button
                variant={view === 'kanban' ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setView('kanban')}
              >
                <IconLayoutKanban className="size-3.5" />
                Board
              </Button>
              <Button
                variant={view === 'list' ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setView('list')}
              >
                <IconList className="size-3.5" />
                List
              </Button>
            </div>
            <CreateTaskDialog
              agents={agents}
              projects={projects}
              onCreated={fetchTasks}
            />
          </div>
        </div>

        {/* A move that did not take. Dismissible, and announced to assistive
            technology so it is not a purely visual signal. */}
        {conflict && (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="tasks-conflict-alert"
            className="sticky top-2 z-40 mx-4 mb-2 flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 shadow-sm backdrop-blur dark:text-amber-200"
          >
            <span>{conflict}</span>
            <button
              type="button"
              onClick={() => setConflict(null)}
              className="shrink-0 underline underline-offset-2"
              aria-label="Dismiss"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* One-time tasks tab */}
        <TabsContent value="tasks" className="mt-0 space-y-4">
          {/* Filters */}
          <TaskFilters
            orgs={orgs}
            agents={agents}
            projects={projects}
            filters={filters}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onChange={handleFilterChange}
            onClearAll={handleClearFilters}
          />

          {/* Content */}
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <IconChecklist size={48} className="text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium mb-1">No tasks yet</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-sm">
                Create your first task to start tracking work across your agents.
              </p>
              <CreateTaskDialog
                agents={agents}
                projects={projects}
                onCreated={fetchTasks}
              />
            </div>
          ) : displayTasks.length === 0 && searchQuery ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <IconChecklist size={48} className="text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium mb-1">No tasks match &ldquo;{searchQuery}&rdquo;</h3>
              <p className="text-sm text-muted-foreground">
                Try searching by task number (e.g. #720) or a word in the title.
              </p>
            </div>
          ) : view === 'kanban' ? (
            // UHS MOD #11 — routing board adds the drag-to-agent rail on top of
            // the standard kanban; falls back to plain board behavior visually.
            <AgentRoutingBoard
              tasks={displayTasks}
              completedTodayTasks={completedToday}
              onTaskClick={handleTaskClick}
              onRouted={fetchTasks}
            />
          ) : (
            <TaskListTable tasks={displayTasks} onTaskClick={handleTaskClick} />
          )}
        </TabsContent>

        {/* Recurring tasks tab */}
        <TabsContent value="recurring" className="mt-0">
          <RecurringTasksTab />
        </TabsContent>
      </Tabs>

      {/* Task detail sheet */}
      <TaskDetailSheet
        task={selectedTask}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onStatusChange={handleStatusChange}
        onDelete={handleDelete}
        onEdit={() => { setSheetOpen(false); setSelectedTask(null); fetchTasks(); }}
      />
    </div>
  );
}
