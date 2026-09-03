// cortextOS Dashboard - Server-side blocked/unfinished skill runs
//
// Same Supabase query shape as /api/uhs/skill-runs (the endpoint SkillRunsCard
// fetches client-side), reused here so getActionItems() — the shared "needs
// attention" source of truth for both Overview and Queue — can roll skill-run
// blockers into its item list/count without a second, drifting definition of
// "blocked". See action-items.ts.

import type { SkillRun } from '@/components/uhs/skill-runs-card';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

export async function getBlockedSkillRuns(): Promise<SkillRun[]> {
  if (!SUPA_URL || !SUPA_KEY) return [];

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
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[data/skill-runs] getBlockedSkillRuns error:', err);
    return [];
  }
}
