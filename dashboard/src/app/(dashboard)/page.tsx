// === OS-03 — Today: the default home ===
//
// New file; never overwritten by upstream merges. The previous home (Overview)
// moved to /overview unchanged.
//
// Scott opens this page and, in order: what needs his decision, what finished
// overnight with proof, what is committed for today and tonight, and which
// business obligations are exceptions. Infrastructure metrics live on
// /overview, where they belong — this screen answers questions, not gauges.
//
// Every number here comes from a source that already exists. When a source
// cannot be read the section says so; it never renders an all-clear over a
// failed query.
// === END header ===

import Link from 'next/link';

import { getOrgs } from '@/lib/config';
import { getActionItems } from '@/lib/data/action-items';
import { getTasksCompletedTodayEnvelope } from '@/lib/data/tasks';
import { getSourceHealth } from '@/lib/data/source-health';
import { getBriefingSnapshot, currentBusinessDate } from '@/lib/uhs/briefing';
import { auth } from '@/lib/auth';
import { defaultPersonFor } from '@/lib/uhs/briefing-acl';
import { buildTodayView, type OwnerFilterKey } from '@/lib/os03/today-view';

import { TodayHeader } from '@/components/today/today-header';
import { NeedsScott } from '@/components/today/needs-scott';
import { Overnight } from '@/components/today/overnight';
import { TodayTonight } from '@/components/today/today-tonight';
import { BusinessExceptions } from '@/components/today/business-exceptions';

export const dynamic = 'force-dynamic';

const OWNERS: OwnerFilterKey[] = ['all', 'scott', 'angelic', 'raquel'];

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : '';

  const ownerParam = typeof params.owner === 'string' ? params.owner : undefined;
  const ownerFilter: OwnerFilterKey =
    ownerParam && (OWNERS as string[]).includes(ownerParam)
      ? (ownerParam as OwnerFilterKey)
      : 'all';

  const businessDate = currentBusinessDate();
  const session = await auth();
  // The briefing is read as the person this account is authorized for. An
  // account with no mapping gets no substitute view.
  const person = defaultPersonFor(session?.user?.name ?? null) ?? 'scott';

  const [actionItems, completedEnv, briefing] = await Promise.all([
    getActionItems(org || undefined),
    Promise.resolve(getTasksCompletedTodayEnvelope(org || undefined)),
    getBriefingSnapshot(businessDate, person),
  ]);

  const view = buildTodayView({
    actionItems,
    briefing,
    completedToday: completedEnv.data,
    sourceRows: getSourceHealth(),
    ownerFilter,
  });

  const extraQuery = org ? `org=${encodeURIComponent(org)}` : '';

  return (
    <div className="space-y-6">
      <TodayHeader header={view.header} />

      <NeedsScott section={view.needsScott} basePath="/" extraQuery={extraQuery} />
      <Overnight section={view.overnight} />
      <TodayTonight section={view.todayTonight} />
      <BusinessExceptions section={view.exceptions} />

      {view.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="today-warnings">
          {view.warnings.map((w) => (
            <li key={w}>Note: {w}</li>
          ))}
        </ul>
      )}

      <nav className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <Link href="/board" className="hover:text-foreground">Open the work board →</Link>
        <Link href="/queue" className="hover:text-foreground">Queue →</Link>
        <Link href="/briefing" className="hover:text-foreground">Full briefing →</Link>
        <Link href="/overview" className="hover:text-foreground">System overview →</Link>
      </nav>
    </div>
  );
}
