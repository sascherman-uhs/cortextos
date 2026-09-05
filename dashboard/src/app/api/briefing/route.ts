import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getBriefingSnapshot,
  currentBusinessDate,
  snapshotAgeMinutes,
} from '@/lib/uhs/briefing';
import {
  canViewPerson,
  defaultPersonFor,
  isPerson,
  viewerPersons,
} from '@/lib/uhs/briefing-acl';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/briefing?date=YYYY-MM-DD&person=scott|raquel|angelic
//
// The latest published snapshot for a business date, filtered to what the signed-in
// viewer may see. New file, never overwritten by upstream.
//
// TWO access questions, both answered here on the server (OS-04b):
//
//   1. May this viewer look at this PERSON at all? Answered from the session against the
//      viewer map. Asking for a person you are not is a 403, not an empty page — a
//      silent empty result would hide a misconfiguration until someone assumed the
//      briefing was simply quiet that morning.
//   2. Which FACETS may that person see? Answered by the visible_to stamp the composer
//      wrote into each facet. Angelic's inbox is angelic-only and stays invisible to
//      Scott here exactly as it does in the Python renderer.
//
// Reads Supabase, and falls back to the local file uhsJARVIS writes when Supabase is
// down — labelling which one it served, because a fallback snapshot is degraded by
// definition and must not read as a healthy one.
//
// 404 when the date has no snapshot. Deliberately NOT "here's yesterday's" — a briefing
// silently showing the wrong day is worse than a briefing that is honestly absent.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get('date');
  const requestedPerson = searchParams.get('person');

  const session = await auth();
  const username = session?.user?.name ?? null;
  if (!username) {
    return Response.json({ error: 'sign in to read the briefing' }, { status: 401 });
  }

  const allowed = viewerPersons(username);
  if (allowed.length === 0) {
    return Response.json(
      {
        error:
          'this account is not mapped to a briefing person. Add it to BRIEFING_VIEWERS ' +
          'rather than assuming a default view.',
      },
      { status: 403 },
    );
  }

  if (requestedPerson && !isPerson(requestedPerson)) {
    return Response.json(
      { error: `unknown person "${requestedPerson}"`, permitted_persons: allowed },
      { status: 400 },
    );
  }
  if (requestedPerson && !canViewPerson(username, requestedPerson)) {
    return Response.json(
      {
        error: `you are not authorized to view ${requestedPerson}'s briefing`,
        permitted_persons: allowed,
      },
      { status: 403 },
    );
  }
  const person = requestedPerson ?? defaultPersonFor(username)!;

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
          permitted_persons: allowed,
          origin: result.origin,
          snapshot: null,
          warnings: result.warnings,
          message:
            result.origin === 'none'
              ? `No briefing snapshot exists for ${businessDate}. That is a missing briefing, not an empty one.`
              : `The ${businessDate} snapshot carries nothing visible to "${person}".`,
        },
        { status: 404 },
      );
    }

    const snapshot = result.snapshot;
    return Response.json({
      business_date: businessDate,
      person,
      permitted_persons: allowed,
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
