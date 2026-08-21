import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { Task } from '@/lib/types';

export interface OriginBadgeProps {
  task: Pick<Task, 'id' | 'source_file'>;
  className?: string;
}

export function OriginBadge({ task, className }: OriginBadgeProps) {
  const isBacklog = task.id.startsWith('supa_') || Boolean(task.source_file?.startsWith('supabase://'));

  if (!isBacklog) {
    return null;
  }

  return (
    <Badge
      variant="outline"
      className={cn('gap-1 border-dashed text-[10px] uppercase tracking-wide text-muted-foreground', className)}
    >
      Backlog
    </Badge>
  );
}
