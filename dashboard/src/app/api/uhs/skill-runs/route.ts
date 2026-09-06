import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// UHS Skill Runs API
// Lives at /api/uhs/skill-runs — new file, never overwritten by upstream.
//
// Surfaces stalled work: skill_runs rows that are blocked or in_progress,
// oldest-updated first (most stale at top). Read-only.
// Reuses the same Supabase (uhs-jarvis) PostgREST access pattern as
// /api/uhs/recurring-tasks — SUPABASE_URL / SUPABASE_KEY.
// ---------------------------------------------------------------------------

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

function supaHeaders() {
  return {
    apikey: SUPA_KEY ?? '',
    Authorization: `Bearer ${SUPA_KEY ?? ''}`,
    'Content-Type': 'application/json',
  };
}

function isConfigured(): boolean {
  return !!(SUPA_URL && SUPA_KEY);
}

// ---------------------------------------------------------------------------
// GET /api/uhs/skill-runs
// Returns skill_runs where status in ('blocked','in_progress'),
// ordered by updated_at asc (most stale first).
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest) {
  if (!isConfigured()) {
    return Response.json(
      { error: 'SUPABASE_URL / SUPABASE_KEY not configured' },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/skill_runs` +
        `?status=in.(blocked,in_progress)` +
        `&select=id,skill,subject,status,agent,started_at,updated_at,completed_at,steps,blockers,meta` +
        `&order=updated_at.asc`,
      { headers: supaHeaders(), cache: 'no-store' },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`skill_runs fetch failed: ${err}`);
    }

    const rows = await res.json();
    return Response.json(rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/uhs/skill-runs] GET error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
