// === OS-08 — the improvement loop, read by the dashboard ===
//
// New file; never overwritten by upstream merges.
//
// What this surfaces is a claim Scott has every right to disbelieve: "the agents are
// getting better." A list of retained wins would be advertising. So the read model here
// is built around the rows that make the claim checkable:
//
//   * REJECTED and REVERTED improvements are first-class and are never filtered out. A
//     loop that has never rejected anything has not been reviewing anything.
//   * An improvement is only `measured` when a named verifier who is NOT its author
//     recorded a before and an after. `verifiedIndependently` is computed here so the UI
//     can say so rather than implying it.
//   * Kaizen cycle counters stay as five separate numbers. "Sent to 11 agents" was the
//     shape of the 2026-08-31 outage being reported as a good week; accepted-out-of-
//     eligible is the honest form.
//
// Supabase unreachable is UNKNOWN, not empty. `degraded` carries the reason, because an
// improvements page that renders a confident empty state during an outage is exactly the
// false all-clear this package exists to prevent.
// === END header ===

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

/** Pipeline states, in the order the plan lays them out. */
export const IMPROVEMENT_STATES = [
  'problem',
  'proposed',
  'reviewed',
  'built',
  'released',
  'measured',
  'retained',
  'rejected',
  'reverted',
] as const;

export type ImprovementState = (typeof IMPROVEMENT_STATES)[number];

/** States that stopped short of a retained change. Shown, never hidden. */
export const NEGATIVE_STATES: ImprovementState[] = ['rejected', 'reverted'];

export const STATE_LABEL: Record<ImprovementState, string> = {
  problem: 'Problem',
  proposed: 'Proposed',
  reviewed: 'Reviewed',
  built: 'Built & tested',
  released: 'Released',
  measured: 'Measured',
  retained: 'Retained',
  rejected: 'Rejected',
  reverted: 'Reverted',
};

export interface Measurement {
  metric?: string;
  before?: number | string | null;
  after?: number | string | null;
  delta?: number | string | null;
  verdict?: string | null;
  verified_by?: string | null;
}

export interface ImprovementEvent {
  id: number;
  improvement_id: number;
  at: string;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  evidence: Record<string, unknown>;
}

export interface Improvement {
  id: number;
  cycle_id: string | null;
  role: string | null;
  title: string;
  problem: string;
  problem_fingerprint: string;
  baseline: Record<string, unknown> | null;
  hypothesis: string;
  target_metric: string;
  evaluation_cases: unknown[];
  change_scope: Record<string, unknown> | null;
  reviewer: string | null;
  verifier: string | null;
  author: string;
  risk_class: string;
  authority_required: string | null;
  rollback_method: string;
  observation_window: string;
  stop_condition: string;
  state: ImprovementState;
  measurement: Measurement | null;
  created_at: string;
  updated_at: string;
}

export interface KaizenCycle {
  cycle_id: string;
  business_date: string;
  status: string;
  intended: number;
  eligible: number;
  attempted: number;
  accepted: number;
  measured: number;
  excluded: { agent: string; reason: string }[];
  dispatch_evidence: Record<string, unknown>;
}

export interface ImprovementsView {
  improvements: Improvement[];
  events: Record<number, ImprovementEvent[]>;
  cycles: KaizenCycle[];
  /** Non-null when a source did not answer. Never rendered as "nothing to report". */
  degraded: string | null;
}

// ---------------------------------------------------------------------------

async function supa(
  path: string,
  warnings: string[],
): Promise<Record<string, unknown>[] | null> {
  if (!SUPA_URL || !SUPA_KEY) {
    warnings.push('Supabase is not configured for this dashboard');
    return null;
  }
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      warnings.push(`Supabase returned ${res.status} for ${path.split('?')[0]}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>[];
  } catch (err) {
    warnings.push(
      `Supabase unreachable for ${path.split('?')[0]}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * An improvement's result was certified by someone other than its author.
 *
 * Computed rather than stored so the UI cannot show a verified badge for a row whose
 * verifier field happens to hold the author's name. Self-certification is the failure
 * mode this whole loop is designed around.
 */
export function verifiedIndependently(i: Improvement): boolean {
  const verifier = i.measurement?.verified_by ?? i.verifier;
  return Boolean(verifier) && verifier !== i.author;
}

/** True when a cycle fired and reached nobody — the 2026-08-31 shape. */
export function reachedNobody(c: KaizenCycle): boolean {
  return c.eligible > 0 && c.accepted === 0;
}

/**
 * Honest one-liner for a cycle. Deliberately never "sent to N": send success is not
 * worker acceptance and neither is a measured improvement.
 */
export function cycleSummary(c: KaizenCycle): string {
  return (
    `${c.accepted}/${c.eligible} roles accepted · ` +
    `${c.attempted} attempted · ${c.measured} measured`
  );
}

/** Group by pipeline state, preserving the plan's column order. */
export function byState(
  improvements: Improvement[],
): { state: ImprovementState; label: string; items: Improvement[] }[] {
  return IMPROVEMENT_STATES.map((state) => ({
    state,
    label: STATE_LABEL[state],
    items: improvements.filter((i) => i.state === state),
  }));
}

/**
 * Retained versus everything that did not survive.
 *
 * Both halves are returned. A page that shows only the numerator of this fraction is
 * making an unfalsifiable claim.
 */
export function outcomeTally(improvements: Improvement[]): {
  retained: number;
  reverted: number;
  rejected: number;
  inFlight: number;
} {
  const count = (s: ImprovementState) =>
    improvements.filter((i) => i.state === s).length;
  return {
    retained: count('retained'),
    reverted: count('reverted'),
    rejected: count('rejected'),
    inFlight: improvements.filter(
      (i) => !['retained', 'reverted', 'rejected'].includes(i.state),
    ).length,
  };
}

// ---------------------------------------------------------------------------

export async function getImprovementsView(limit = 50): Promise<ImprovementsView> {
  const warnings: string[] = [];
  const [rawImprovements, rawCycles] = await Promise.all([
    supa(`improvements?order=updated_at.desc&limit=${limit}`, warnings),
    supa('kaizen_cycles?order=business_date.desc&limit=8', warnings),
  ]);

  const improvements = (rawImprovements ?? []) as unknown as Improvement[];
  const events: Record<number, ImprovementEvent[]> = {};
  if (improvements.length > 0) {
    const ids = improvements.map((i) => i.id).join(',');
    const rows = (await supa(
      `improvement_events?improvement_id=in.(${ids})&order=at.asc`,
      warnings,
    )) as unknown as ImprovementEvent[] | null;
    for (const e of rows ?? []) {
      (events[e.improvement_id] ??= []).push(e);
    }
  }

  return {
    improvements,
    events,
    cycles: (rawCycles ?? []) as unknown as KaizenCycle[],
    degraded: warnings.length > 0 ? warnings.join('; ') : null,
  };
}
