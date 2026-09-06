import { auth } from '@/lib/auth';
import { getImprovementsView } from '@/lib/uhs/improvements';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/improvements?limit=N
//
// The read side of the self-improvement loop. New file, never overwritten upstream.
//
// Two deliberate refusals:
//
//   1. It never drops rejected or reverted rows. They are the evidence that the loop
//      reviews anything at all, and a caller that wants only wins can filter client-side
//      where the omission is visible.
//   2. It never reports a source outage as an empty loop. `degraded` is carried through
//      to the response and the status stays 200 with the partial data labelled, because
//      a 500 would hide the cycle counters that DID load.
// ---------------------------------------------------------------------------

const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.name) {
    return Response.json({ error: 'sign in to read the improvement loop' }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get('limit');
  const parsed = raw === null ? 50 : Number.parseInt(raw, 10);
  if (raw !== null && (!Number.isFinite(parsed) || parsed < 1)) {
    return Response.json({ error: `limit must be a positive integer, got ${raw}` }, { status: 400 });
  }
  const limit = Math.min(parsed, MAX_LIMIT);

  const view = await getImprovementsView(limit);
  return Response.json({
    improvements: view.improvements,
    events: view.events,
    cycles: view.cycles,
    degraded: view.degraded,
    limit,
  });
}
