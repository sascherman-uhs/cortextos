import Link from 'next/link';
import { getBriefingSnapshot, currentBusinessDate } from '@/lib/uhs/briefing';
import { SnapshotView } from '@/components/briefing/snapshot-view';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// /briefing — the morning briefing snapshot for a business date.
//
// Slice 1 renders Scott's view only. The data model is person-aware (snapshots carry
// per-person facets and an allowed-persons list) so that Raquel's and Angelic's views in
// OS-04b are a filter over the SAME record rather than a second composer. Until then,
// Vera and Vivienne remain retained separate composers and their content is explicitly
// not described as reconciled to this snapshot.
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

  const result = await getBriefingSnapshot(businessDate, 'scott');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Morning briefing</h1>
          <p className="text-sm text-muted-foreground">
            One snapshot per business date. Immutable once published — a correction is a
            new version, never a quiet edit.
          </p>
        </div>
        <Link
          href="/queue"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Open the Queue →
        </Link>
      </div>

      <SnapshotView result={result} />
    </div>
  );
}
