'use client';

// UHS MOD #11 — Drag-to-agent task routing (Task #889 / L6-01).
// Wraps the standard KanbanBoard in a DndContext and adds a rail of agent
// drop-zones. Dragging a task card onto an agent PUTs the new assignee to
// /api/tasks/[id], which persists assigned_to AND fires the agent wakeup —
// so adding a task and routing it no longer requires Scott as the router.
// Lives in components/uhs/ (never overwritten by upstream merges).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { IconRoute, IconGripVertical } from '@tabler/icons-react';
import { KanbanBoard } from '@/components/tasks/kanban-board';
import { TaskCard } from '@/components/tasks/task-card';
import { HealthDot } from '@/components/shared';
import { useToast, ToastProvider } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { Task } from '@/lib/types';
import type { HealthStatus } from '@/lib/types';

interface AgentInfo {
  name: string;
  org?: string;
  health?: HealthStatus;
}

const AGENT_DROP_PREFIX = 'agent:';

interface AgentRoutingBoardProps {
  tasks: Task[];
  completedTodayTasks: Task[];
  onTaskClick: (task: Task) => void;
  /** Called after a successful route so the parent can refetch. */
  onRouted: () => void;
}

// ---------------------------------------------------------------------------
// Draggable wrapper around the standard TaskCard. With a 6px activation
// distance, a plain click still fires onClick (opens the detail sheet) — only
// a deliberate drag starts the DnD gesture.
// ---------------------------------------------------------------------------
function DraggableTaskCard({
  task,
  onClick,
}: {
  task: Task;
  onClick: (task: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { assignee: task.assignee },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'relative touch-none',
        isDragging && 'opacity-40',
      )}
    >
      {/* Grip affordance — signals the card is draggable */}
      <IconGripVertical
        className="pointer-events-none absolute right-1 top-1 size-3.5 text-muted-foreground/30"
        aria-hidden
      />
      <TaskCard task={task} onClick={onClick} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single agent drop-zone in the routing rail.
// ---------------------------------------------------------------------------
function AgentDropZone({ agent }: { agent: AgentInfo }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${AGENT_DROP_PREFIX}${agent.name}`,
    data: { agent: agent.name },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
        isOver
          ? 'border-amber-500 bg-amber-500/15 ring-1 ring-amber-500'
          : 'border-foreground/10 bg-muted/30 hover:bg-muted/50',
      )}
      title={`Drop a task here to route it to ${agent.name}`}
    >
      <HealthDot status={agent.health ?? 'down'} />
      <span className="font-medium">{agent.name}</span>
    </div>
  );
}

function AgentRoutingBoardInner({
  tasks,
  completedTodayTasks,
  onTaskClick,
  onRouted,
}: AgentRoutingBoardProps) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [routing, setRouting] = useState(false);

  // 6px activation distance — clicks still open the task sheet.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AgentInfo[]) => {
        if (!cancelled && Array.isArray(data)) setAgents(data);
      })
      .catch(() => { /* rail just won't render — drag is a no-op */ });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fast lookup of task by drag id for messaging.
  const taskById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of [...tasks, ...completedTodayTasks]) m.set(t.id, t);
    return m;
  }, [tasks, completedTodayTasks]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const overId = String(over.id);
      if (!overId.startsWith(AGENT_DROP_PREFIX)) return;
      const agentName = overId.slice(AGENT_DROP_PREFIX.length);

      const taskId = String(active.id);
      const task = taskById.get(taskId);
      // No-op if already assigned to this agent.
      if (task?.assignee === agentName) return;

      setRouting(true);
      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignee: agentName }),
        });
        if (res.ok) {
          toast({
            message: `Routed to ${agentName} — agent notified.`,
            variant: 'success',
          });
          onRouted();
        } else {
          const err = await res.json().catch(() => ({}));
          toast({
            message: err?.error ?? `Could not assign to ${agentName}.`,
            variant: 'error',
          });
        }
      } catch {
        toast({
          message: 'Network error while assigning the task.',
          variant: 'error',
        });
      } finally {
        setRouting(false);
      }
    },
    [taskById, toast, onRouted],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragEnd={handleDragEnd}
    >
      {/* Agent routing rail */}
      {agents.length > 0 && (
        <div className="mb-4 rounded-xl border border-dashed border-foreground/10 bg-card/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <IconRoute className="size-3.5" />
            Drag a task onto an agent to route it
            {routing && (
              <span className="animate-pulse text-amber-400">routing…</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {agents.map((agent) => (
              <AgentDropZone key={agent.name} agent={agent} />
            ))}
          </div>
        </div>
      )}

      <KanbanBoard
        tasks={tasks}
        completedTodayTasks={completedTodayTasks}
        onTaskClick={onTaskClick}
        renderCard={(task) => (
          <DraggableTaskCard task={task} onClick={onTaskClick} />
        )}
      />
    </DndContext>
  );
}

// The dashboard layout does not mount a global ToastProvider, so provide a
// local one (same pattern as the workflows detail page).
export function AgentRoutingBoard(props: AgentRoutingBoardProps) {
  return (
    <ToastProvider>
      <AgentRoutingBoardInner {...props} />
    </ToastProvider>
  );
}
