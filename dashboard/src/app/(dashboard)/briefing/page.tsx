import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getBriefingSnapshot, currentBusinessDate } from '@/lib/uhs/briefing';
import {
  canViewPerson,
  defaultPersonFor,
  viewerPersons,
  PERSON_LABEL,
  PERSON_AGENT,
} from '@/lib/uhs/briefing-acl';
import { SnapshotView } from '@/components/briefing/snapshot-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// /briefing — one business date, one snapshot, rendered for one person.
//
// OS-04b: Raquel's and Angelic's mornings are filtered views of the SAME record Scott
// reads, not separate compositions. The switcher below only offers people this viewer is
// authorized for, and the filtering itself happens server-side in getBriefingSnapshot —
// switching person re-requests the page rather than revealing something already sent.
//
// Scott can see the personas' business scope because he runs the business. He cannot see
// Angelic's inbox: that facet is stamped angelic-only and is filtered out for him here
// exactly as it is in the Telegram document.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function BriefingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const dateParam = typeof params.date === 'string' ? params.date : undefined;
  const businessDate =
    dateParam && DATE_RE.test(dateParam) ? dateParam : currentBusinessDate();

  const session = await auth();
  const username = session?.user?.name ?? null;
  const allowed = viewerPersons(username);

  if (allowed.length === 0) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-base">No briefing view for this account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            This account is not mapped to a briefing person, so there is nothing it is
            authorized to read. That is a configuration gap, not a missing briefing.
          </p>
          <p className="text-muted-foreground text-xs">
            Map it in BRIEFING_VIEWERS. Access is never defaulted.
          </p>
        </CardContent>
      </Card>
    );
  }

  const requested = typeof params.person === 'string' ? params.person : undefined;
  const person =
    requested && canViewPerson(username, requested) ? requested : defaultPersonFor(username)!;
  const deniedRequest = Boolean(requested && requested !== person);

  const result = await getBriefingSnapshot(businessDate, person);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Morning briefing</h1>
          <p className="text-sm text-muted-foreground">
            One snapshot per business date, filtered to one person. Immutable once
            published — a correction is a new version, never a quiet edit.
          </p>
        </div>
        <Link href="/queue" className="text-sm text-muted-foreground hover:text-foreground">
          Open the Queue →
        </Link>
      </div>

      {allowed.length > 1 && (
        <nav className="flex flex-wrap items-center gap-2" aria-label="Briefing person">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Viewing as
          </span>
          {allowed.map((p) => {
            const active = p === person;
            return (
              <Link
                key={p}
                href={`/briefing?person=${p}&date=${businessDate}`}
                aria-current={active ? 'page' : undefined}
                className={
                  'rounded-full border px-3 py-1 text-sm transition-colors ' +
                  (active
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground')
                }
              >
                {PERSON_LABEL[p]}
                <span className="ml-1 text-xs opacity-70">· {PERSON_AGENT[p]}</span>
              </Link>
            );
          })}
        </nav>
      )}

      {deniedRequest && (
        <Card className="border-destructive">
          <CardContent className="pt-4 text-sm">
            You are not authorized to view {requested}&apos;s briefing. Showing {person}
            &apos;s instead — and saying so, rather than quietly substituting it.
          </CardContent>
        </Card>
      )}

      <SnapshotView result={result} />
    </div>
  );
}
