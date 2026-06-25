'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { IconLayoutKanban, IconList, IconChecklist, IconRepeat } from '@tabler/icons-react';
import { KanbanBoard } from '@/components/tasks/kanban-board';
import { TaskListTable } from '@/components/tasks/task-list-table';
import { TaskDetailSheet } from '@/components/tasks/task-detail-sheet';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { TaskFilters } from '@/components/tasks/task-filters';
// UHS MOD #7 — recurring tasks tab (components/uhs/ never overwritten by upstream)
import { RecurringTasksTab } from '@/components/uhs/recurring-tasks-tab';
import { getTaskNumber } from '@/components/uhs/task-number-badge';
import type { Task, TaskStatus } from '@/lib/types';

type ViewMode = 'kanban' | 'list';

const DEFAULT_FILTERS = {
  org: 'all',
  agent: 'all',
  priority: 'all',
  project: 'all',
  status: 'all',
};

export default function TasksPage() {
  const { currentOrg } = useOrg();

  const [view, setView] = useState<ViewMode>('kanban');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedToday, setCompletedToday] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  // UHS MOD #7 — search is client-side only; isolated from filters so typing
  // never re-creates fetchTasks or triggers setLoading (no API round-trip).
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

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

    try {
      // Build completed params with same filters (except status)
      const completedParams = new URLSearchParams(params);
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

  async function handleStatusChange(taskId: string, status: TaskStatus, note?: string) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      });

      if (res.ok) {
        setSheetOpen(false);
        setSelectedTask(null);
        fetchTasks();
      }
    } catch {
      // Silently fail
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
      <Tabs defaultValue="tasks" className="w-full">
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
            <KanbanBoard
              tasks={displayTasks}
              completedTodayTasks={completedToday}
              onTaskClick={handleTaskClick}
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
