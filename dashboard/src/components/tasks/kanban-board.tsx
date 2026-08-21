'use client';

import type { ReactNode } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/shared';
import { TaskCard } from './task-card';
import type { Task, TaskStatus } from '@/lib/types';

interface KanbanColumn {
  status: TaskStatus;
  label: string;
  tasks: Task[];
}

interface KanbanBoardProps {
  tasks: Task[];
  completedTodayTasks: Task[];
  onTaskClick: (task: Task) => void;
  // UHS MOD #11 — optional card renderer so the drag-to-agent routing board can
  // inject draggable cards. Defaults to the standard TaskCard (upstream behavior).
  renderCard?: (task: Task) => ReactNode;
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 5,
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    const rankDiff = (PRIORITY_RANK[b.priority] ?? 2) - (PRIORITY_RANK[a.priority] ?? 2);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export function KanbanBoard({ tasks, completedTodayTasks, onTaskClick, renderCard }: KanbanBoardProps) {
  const columns: KanbanColumn[] = [
    {
      status: 'pending',
      label: 'Pending',
      tasks: sortTasks(tasks.filter((t) => t.status === 'pending')),
    },
    {
      status: 'in_progress',
      label: 'In Progress',
      tasks: sortTasks(tasks.filter((t) => t.status === 'in_progress')),
    },
    {
      status: 'blocked',
      label: 'Blocked',
      tasks: sortTasks(tasks.filter((t) => t.status === 'blocked')),
    },
    {
      status: 'completed',
      label: 'Completed',
      tasks: sortTasks(completedTodayTasks),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {columns.map((col) => (
        <div key={col.status} className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <StatusBadge status={col.status} />
              <span className="text-xs text-muted-foreground">
                {col.tasks.length}
              </span>
            </div>
          </div>
          <ScrollArea className="h-[calc(100vh-280px)] min-h-[300px]">
            <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
              {col.tasks.length === 0 ? (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                  No tasks
                </p>
              ) : (
                col.tasks.map((task) =>
                  // UHS MOD #11 — use injected renderer when provided
                  renderCard ? (
                    <div key={task.id}>{renderCard(task)}</div>
                  ) : (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onClick={onTaskClick}
                    />
                  ),
                )
              )}
            </div>
          </ScrollArea>
        </div>
      ))}
    </div>
  );
}
