// === OS-03 — the work board route ===
// New file; never overwritten by upstream merges.
//
// The board reads the SAME projected rows the Queue reads, so the two screens
// cannot disagree about what state a task is in. Rows are fetched on the
// server; every move goes back through the canonical transition endpoint.
// === END header ===

import Link from 'next/link';

import { getOrgs } from '@/lib/config';
import { getProjectedTasks } from '@/lib/data/tasks';
import { getActionItems } from '@/lib/data/action-items';
import { DegradedBanner } from '@/components/queue/degraded-banner';
import { WorkBoard } from '@/components/board/work-board';

export const dynamic = 'force-dynamic';

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : '';
  const taskParam = typeof params.task === 'string' ? params.task : null;

  const [env, actionItems] = await Promise.all([
    Promise.resolve(getProjectedTasks({ org: org || undefined })),
    getActionItems(org || undefined),
  ]);

  const degraded = actionItems.degradedSources.length > 0 || env.status !== 'fresh';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Work board</h1>
          <p className="text-sm text-muted-foreground">
            {org ? `Organization: ${org}` : 'All organizations'} — Backlog through Done, with
            everything that is waiting kept in sight.
          </p>
        </div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Today
        </Link>
      </div>

      <DegradedBanner sources={actionItems.degradedSources} />

      <WorkBoard tasks={env.data} degraded={degraded} initialTaskId={taskParam} />
    </div>
  );
}
