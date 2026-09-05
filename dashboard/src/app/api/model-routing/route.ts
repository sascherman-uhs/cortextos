/**
 * GET /api/model-routing — registry summary + recent events/attempts (contract §7).
 *
 * Returns entries/tiers/roles/agents/activation for the Fleet page. `auth_source`
 * is an env-key NAME or login-file id only; no credential values are read here.
 */

import { NextRequest } from 'next/server';
import {
  getModelRoutingAdapter,
  getRoutingEvents,
  getRoutingSummary,
  isRoutingError,
} from '@/lib/model-routing';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? '25');
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 200) : 25;

  const backend = getModelRoutingAdapter().kind;

  let summary;
  try {
    summary = await getRoutingSummary();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'routing service unavailable', backend },
      { status: 503 },
    );
  }
  if (isRoutingError(summary)) {
    return Response.json({ ...summary, backend }, { status: 503 });
  }

  let events: unknown[] = [];
  let attempts: unknown[] = [];
  try {
    const ev = await getRoutingEvents(limit);
    if (!isRoutingError(ev)) {
      events = ev.events;
      attempts = ev.attempts;
    }
  } catch {
    // Events are supplementary — a summary without them is still useful.
  }

  return Response.json({
    backend,
    /** false when the backend can only read the registry file (display-only). */
    mutable: backend === 'service' || backend === 'cli',
    registry: summary,
    events,
    attempts,
  });
}
