import { getOrgs } from '@/lib/config';
import { getTasks, getTasksCompletedToday } from '@/lib/data/tasks';
import { getActionItems } from '@/lib/data/action-items';

import { NeedsYouLane } from '@/components/queue/needs-you-lane';
import { TaskStripLane } from '@/components/queue/task-strip-lane';
import { RecurringLane } from '@/components/queue/recurring-lane';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : '';
  const orgFilter = org || undefined;

  const [actionItems, doing, todo, done] = await Promise.all([
    getActionItems(orgFilter),
    Promise.resolve(getTasks({ status: 'in_progress', org: orgFilter })),
    Promise.resolve(getTasks({ status: 'pending', org: orgFilter })),
    Promise.resolve(getTasksCompletedToday(orgFilter)),
  ]);

  const { humanTasks, blockedTasks, approvals, staleAgents } = actionItems;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Queue</h1>
        <p className="text-sm text-muted-foreground">
          {org ? `Organization: ${org}` : 'All organizations'} — everything blocked, in
          flight, queued, done, and recurring, in one place.
        </p>
      </div>

      <NeedsYouLane
        humanTasks={humanTasks}
        approvals={approvals}
        blockedTasks={blockedTasks}
        staleAgents={staleAgents}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TaskStripLane
          title="Doing"
          tasks={doing}
          totalCount={doing.length}
          href="/tasks?status=in_progress"
          dateField="updated_at"
          emptyLabel="Nothing in progress right now."
        />
        <TaskStripLane
          title="To Do"
          tasks={todo}
          totalCount={todo.length}
          href="/tasks?status=pending"
          dateField="created_at"
          emptyLabel="Queue is empty."
        />
      </div>

      <TaskStripLane
        title="Done Today"
        tasks={done}
        totalCount={done.length}
        href="/tasks?status=completed"
        dateField="completed_at"
        maxVisible={8}
        emptyLabel="Nothing completed yet today — see Tasks for full history."
      />

      <RecurringLane />
    </div>
  );
}
