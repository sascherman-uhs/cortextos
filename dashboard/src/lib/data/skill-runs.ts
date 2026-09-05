// cortextOS Dashboard - Server-side blocked/unfinished skill runs
//
// Same Supabase query shape as /api/uhs/skill-runs (the endpoint SkillRunsCard
// fetches client-side), reused here so getActionItems() — the shared "needs
// attention" source of truth for both Overview and Queue — can roll skill-run
// blockers into its item list/count without a second, drifting definition of
// "blocked". See action-items.ts.

import type { SkillRun } from '@/components/uhs/skill-runs-card';
import { envelope, unavailable, type SourceEnvelope } from './source-health';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const SKILL_RUNS_SOURCE = 'supabase://skill_runs';

/**
 * Blocked/unfinished skill runs, with source health attached.
 *
 * Every early return here used to be a bare `[]`, so an unset key, a 500 from
 * PostgREST and a genuinely clear ledger were indistinguishable to the caller —
 * and all three rendered as "all clear". They are now distinguishable.
 */
export async function getBlockedSkillRunsEnvelope(): Promise<SourceEnvelope<SkillRun[]>> {
  if (!SUPA_URL || !SUPA_KEY) {
    return unavailable(
      [] as SkillRun[],
      SKILL_RUNS_SOURCE,
      'SUPABASE_URL/SUPABASE_KEY not configured — skill-run blockers cannot be read',
    );
  }

  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/skill_runs` +
        `?status=in.(blocked,in_progress)` +
        `&select=id,skill,subject,status,agent,started_at,updated_at,completed_at,steps,blockers,meta` +
        `&order=updated_at.asc`,
      {
        headers: {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      return unavailable(
        [] as SkillRun[],
        SKILL_RUNS_SOURCE,
        `HTTP ${res.status} from skill_runs`,
      );
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) {
      return unavailable([] as SkillRun[], SKILL_RUNS_SOURCE, 'skill_runs response was not a list');
    }
    const newest = rows.reduce<string | null>((acc: string | null, r: SkillRun) => {
      const u = r.updated_at ?? r.started_at ?? null;
      return u && (!acc || u > acc) ? u : acc;
    }, null);
    return envelope(rows as SkillRun[], SKILL_RUNS_SOURCE, { source_updated_at: newest });
  } catch (err) {
    console.error('[data/skill-runs] getBlockedSkillRuns error:', err);
    return unavailable([] as SkillRun[], SKILL_RUNS_SOURCE, err);
  }
}

/** Back-compat wrapper. Prefer getBlockedSkillRunsEnvelope(). */
export async function getBlockedSkillRuns(): Promise<SkillRun[]> {
  return (await getBlockedSkillRunsEnvelope()).data;
}
