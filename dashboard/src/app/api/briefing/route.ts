import { NextRequest } from 'next/server';
import {
  getBriefingSnapshot,
  currentBusinessDate,
  snapshotAgeMinutes,
} from '@/lib/uhs/briefing';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/briefing?date=YYYY-MM-DD&person=scott
//
// The latest published snapshot for a business date. New file, never overwritten by
// upstream. Reads Supabase, and falls back to the local file uhsJARVIS writes when
// Supabase is down — labelling which one it served, because a fallback snapshot is
// degraded by definition and must not read as a healthy one.
//
// 404 when the date has no snapshot. Deliberately NOT "here's yesterday's" — a briefing
// silently showing the wrong day is worse than a briefing that is honestly absent.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get('date');
  const person = searchParams.get('person') ?? 'scott';

  if (dateParam && !DATE_RE.test(dateParam)) {
    return Response.json(
      { error: 'date must be YYYY-MM-DD (a Pacific business date)' },
      { status: 400 },
    );
  }
  const businessDate = dateParam ?? currentBusinessDate();

  try {
    const result = await getBriefingSnapshot(businessDate, person);

    if (!result.snapshot) {
      return Response.json(
        {
          business_date: businessDate,
          person,
          origin: result.origin,
          snapshot: null,
          warnings: result.warnings,
          message:
            result.origin === 'none'
              ? `No briefing snapshot exists for ${businessDate}. That is a missing briefing, not an empty one.`
              : `No permitted view of the ${businessDate} snapshot for "${person}".`,
        },
        { status: 404 },
      );
    }

    const snapshot = result.snapshot;
    return Response.json({
      business_date: businessDate,
      person,
      origin: result.origin,
      warnings: result.warnings,
      freshness: {
        age_minutes: snapshotAgeMinutes(snapshot),
        snapshot_cutoff: snapshot.snapshot_cutoff,
        published_ui_at: snapshot.published_ui_at,
        missed_deadline: snapshot.missed_deadline,
      },
      degraded: snapshot.degraded,
      degraded_reasons: snapshot.degraded_reasons,
      snapshot,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/briefing] GET error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
