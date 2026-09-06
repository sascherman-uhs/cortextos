import Link from 'next/link';
import { IconChevronRight } from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeAgo } from '@/components/shared';
import type { Task } from '@/lib/types';

interface TaskStripLaneProps {
  title: string;
  tasks: Task[];
  totalCount: number;
  href: string;
  dateField: 'created_at' | 'updated_at' | 'completed_at';
  maxVisible?: number;
  emptyLabel: string;
}

export function TaskStripLane({
  title,
  tasks,
  totalCount,
  href,
  dateField,
  maxVisible = 6,
  emptyLabel,
}: TaskStripLaneProps) {
  const visible = tasks.slice(0, maxVisible);
  const overflow = totalCount - visible.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
        <div className="flex items-center gap-2">
          {totalCount > 0 && <Badge variant="secondary">{totalCount}</Badge>}
          <Link
            href={href}
            className="flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all
            <IconChevronRight size={14} />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-1">{emptyLabel}</p>
        ) : (
          <div className="space-y-0.5">
            {visible.map((task) => {
              const date = task[dateField] ?? task.created_at;
              return (
                <div
                  key={task.id}
                  className="flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5"
                >
                  <span className="text-sm truncate min-w-0 flex-1">{task.title}</span>
                  <span className="text-xs text-muted-foreground shrink-0 truncate max-w-[9rem]">
                    {task.assignee ?? task.project ?? task.org}
                  </span>
                  {date && (
                    <TimeAgo date={date} className="text-xs text-muted-foreground shrink-0" />
                  )}
                </div>
              );
            })}
            {overflow > 0 && (
              <p className="px-2.5 pt-1 text-xs text-muted-foreground">
                +{overflow} more
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
