import Link from 'next/link';

import { getOrgs } from '@/lib/config';
import {
  getPersonTasksEnvelope,
  getTasksEnvelope,
  getTasksCompletedTodayEnvelope,
} from '@/lib/data/tasks';
import { getActionItems } from '@/lib/data/action-items';
import { personDisplay, type PersonKey } from '@/lib/data/task-projection';

import { NeedsYouLane } from '@/components/queue/needs-you-lane';
import { TaskStripLane } from '@/components/queue/task-strip-lane';
import { RecurringLane } from '@/components/queue/recurring-lane';
import { RecoveryLane } from '@/components/queue/recovery-lane';
import { DegradedBanner } from '@/components/queue/degraded-banner';

export const dynamic = 'force-dynamic';

const PEOPLE: PersonKey[] = ['scott', 'angelic', 'raquel'];

function isPerson(v: unknown): v is PersonKey {
  return typeof v === 'string' && (PEOPLE as string[]).includes(v);
}

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

  // Ownership filter. Named people are resolved through the shared person map,
  // so ?owner=scott returns the rows Supabase assigns to 'scott' as well as the
  // legacy 'human'/'user' aliases — which is exactly what the old "human"
  // filter was meant to do and never did.
  const owner = isPerson(params.owner) ? params.owner : null;

  const [actionItems, doingEnv, todoEnv, doneEnv, ownerEnv] = await Promise.all([
    getActionItems(orgFilter),
    Promise.resolve(getTasksEnvelope({ status: 'in_progress', org: orgFilter })),
    Promise.resolve(getTasksEnvelope({ status: 'pending', org: orgFilter })),
    Promise.resolve(getTasksCompletedTodayEnvelope(orgFilter)),
    Promise.resolve(owner ? getPersonTasksEnvelope(owner, orgFilter) : null),
  ]);

  const {
    humanTasks,
    approvals,
    blockedTasks,
    staleAgents,
    blockedSkillRuns,
    recoveryTasks,
    unassignedTasks,
    degradedSources,
  } = actionItems;

  const degraded = degradedSources.length > 0;

  // When an owner filter is active, the lanes narrow to that person's work.
  const ownerRows = ownerEnv?.data ?? [];
  const ownerIds = owner ? new Set(ownerRows.map((t) => t.id)) : null;
  const scope = <T extends { id: string }>(rows: T[]) =>
    ownerIds ? rows.filter((r) => ownerIds.has(r.id)) : rows;

  const doing = scope(doingEnv.data);
  const todo = scope(todoEnv.data);
  const done = scope(doneEnv.data);
  const recovery = scope(recoveryTasks);
  const needsPerson = owner ? scope(humanTasks) : humanTasks;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Queue</h1>
        <p className="text-sm text-muted-foreground">
          {org ? `Organization: ${org}` : 'All organizations'} — everything blocked,
          failed, in flight, queued, done, and recurring, in one place.
        </p>
      </div>

      <DegradedBanner sources={degradedSources} />

      <nav aria-label="Owner filter" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Owner:</span>
        <Link
          href={org ? `/queue?org=${org}` : '/queue'}
          data-testid="owner-filter-all"
          className={`rounded-md px-2 py-1 transition-colors ${
            owner ? 'text-muted-foreground hover:bg-muted' : 'bg-muted font-medium'
          }`}
        >
          Everyone
        </Link>
        {PEOPLE.map((p) => (
          <Link
            key={p}
            href={`/queue?owner=${p}${org ? `&org=${org}` : ''}`}
            data-testid={`owner-filter-${p}`}
            className={`rounded-md px-2 py-1 transition-colors ${
              owner === p ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {personDisplay(p)}
          </Link>
        ))}
      </nav>

      <NeedsYouLane
        humanTasks={needsPerson}
        approvals={owner ? [] : approvals}
        blockedTasks={blockedTasks}
        staleAgents={owner ? [] : staleAgents}
        blockedSkillRuns={owner ? [] : blockedSkillRuns}
        degraded={degraded}
        ownerLabel={owner ? personDisplay(owner) : null}
      />

      <RecoveryLane
        title="Recovery — blocked & failed"
        items={recovery}
        grouped
        degraded={degraded}
        emptyLabel="Nothing blocked or failed."
      />

      {!owner && (
        <RecoveryLane
          title="Unassigned recovery"
          items={unassignedTasks}
          degraded={degraded}
          emptyLabel="Every open task has a routable owner."
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TaskStripLane
          title="Doing"
          tasks={doing}
          totalCount={doing.length}
          href="/tasks?status=in_progress"
          dateField="updated_at"
          emptyLabel={
            degraded
              ? 'Unknown — a data source could not be read.'
              : 'Nothing in progress right now.'
          }
        />
        <TaskStripLane
          title="To Do"
          tasks={todo}
          totalCount={todo.length}
          href="/tasks?status=pending"
          dateField="created_at"
          emptyLabel={
            degraded ? 'Unknown — a data source could not be read.' : 'Queue is empty.'
          }
        />
      </div>

      <TaskStripLane
        title="Done Today"
        tasks={done}
        totalCount={done.length}
        href="/tasks?status=completed&date=today"
        dateField="completed_at"
        maxVisible={8}
        emptyLabel="Nothing completed yet today — see Tasks for full history."
      />

      <div id="recurring">
        <RecurringLane />
      </div>
    </div>
  );
}
