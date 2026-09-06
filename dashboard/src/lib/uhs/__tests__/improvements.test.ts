/**
 * dashboard/src/lib/uhs/__tests__/improvements.test.ts — OS-08
 *
 * The read model for the improvement loop. What is under test is mostly the loop's
 * honesty: that a self-certified result is not shown as verified, that a cycle which
 * reached nobody is flagged rather than summarised as activity, and that a source
 * outage reads as unknown rather than as an empty loop.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';

const {
  byState,
  cycleSummary,
  getImprovementsView,
  outcomeTally,
  reachedNobody,
  verifiedIndependently,
  IMPROVEMENT_STATES,
  NEGATIVE_STATES,
} = await import('@/lib/uhs/improvements');

type Any = Record<string, unknown>;

function improvement(over: Any = {}): Any {
  return {
    id: 1,
    cycle_id: 'kaizen-2026-W36',
    role: 'revenue_ops',
    title: 'Kaizen reaches zero agents',
    problem: 'the weekly cycle reached 0 of 11',
    problem_fingerprint: 'abc',
    baseline: { metric: 'kaizen_roles_accepted', value: 0 },
    hypothesis: 'the priority argument is wrong',
    target_metric: 'kaizen_roles_accepted',
    evaluation_cases: ['all roles accepted'],
    change_scope: {},
    reviewer: 'os10',
    verifier: null,
    author: 'os08',
    risk_class: 'internal',
    authority_required: null,
    rollback_method: 'revert the commit',
    observation_window: 'one cycle',
    stop_condition: 'still zero',
    state: 'measured',
    measurement: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-05T00:00:00Z',
    ...over,
  };
}

function cycle(over: Any = {}): Any {
  return {
    cycle_id: 'kaizen-2026-W36',
    business_date: '2026-08-31',
    status: 'delivered',
    intended: 11,
    eligible: 11,
    attempted: 11,
    accepted: 11,
    measured: 1,
    excluded: [],
    dispatch_evidence: {},
    ...over,
  };
}

describe('independent verification', () => {
  it('a result certified by its own author is not verified', () => {
    const i = improvement({
      measurement: { metric: 'm', before: 0, after: 1, verified_by: 'os08' },
    }) as never;
    expect(verifiedIndependently(i)).toBe(false);
  });

  it('a result certified by anyone else is verified', () => {
    const i = improvement({
      measurement: { metric: 'm', before: 0, after: 1, verified_by: 'os10' },
    }) as never;
    expect(verifiedIndependently(i)).toBe(true);
  });

  it('no verifier at all is not verified', () => {
    expect(verifiedIndependently(improvement() as never)).toBe(false);
  });
});

describe('cycle honesty', () => {
  it('flags a cycle that fired and reached nobody', () => {
    expect(reachedNobody(cycle({ accepted: 0 }) as never)).toBe(true);
  });

  it('a cycle with no eligible roles is not a zero-reach alarm', () => {
    expect(reachedNobody(cycle({ eligible: 0, accepted: 0 }) as never)).toBe(false);
  });

  it('summarises as accepted-out-of-eligible, never as "sent to N"', () => {
    const s = cycleSummary(cycle({ accepted: 0, eligible: 11, attempted: 11 }) as never);
    expect(s).toContain('0/11 roles accepted');
    expect(s).not.toContain('sent to');
  });

  it('keeps measured separate from accepted', () => {
    const s = cycleSummary(cycle({ accepted: 11, measured: 0 }) as never);
    expect(s).toContain('11/11 roles accepted');
    expect(s).toContain('0 measured');
  });
});

describe('grouping and tally', () => {
  it('rejected and reverted are first-class states, never dropped', () => {
    expect(IMPROVEMENT_STATES).toContain('rejected');
    expect(IMPROVEMENT_STATES).toContain('reverted');
    expect(NEGATIVE_STATES).toEqual(['rejected', 'reverted']);
  });

  it('groups every improvement into exactly one state column', () => {
    const items = [
      improvement({ id: 1, state: 'retained' }),
      improvement({ id: 2, state: 'reverted' }),
      improvement({ id: 3, state: 'proposed' }),
    ] as never[];
    const cols = byState(items);
    expect(cols.flatMap((c) => c.items).length).toBe(3);
    expect(cols.find((c) => c.state === 'reverted')!.items).toHaveLength(1);
  });

  it('counts what did not survive alongside what did', () => {
    const t = outcomeTally([
      improvement({ id: 1, state: 'retained' }),
      improvement({ id: 2, state: 'reverted' }),
      improvement({ id: 3, state: 'rejected' }),
      improvement({ id: 4, state: 'built' }),
    ] as never[]);
    expect(t).toEqual({ retained: 1, reverted: 1, rejected: 1, inFlight: 1 });
  });
});

describe('getImprovementsView', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string) => { ok: boolean; body?: unknown; status?: number }) {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const r = handler(String(url));
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: async () => r.body ?? [],
      } as Response;
    }) as never;
  }

  it('loads improvements, their events and the cycles', async () => {
    mockFetch((url) => {
      if (url.includes('/improvements?')) return { ok: true, body: [improvement()] };
      if (url.includes('/improvement_events')) {
        return {
          ok: true,
          body: [{ id: 9, improvement_id: 1, at: '2026-09-01T00:00:00Z', from_state: null, to_state: 'problem', actor: 'os08', reason: null, evidence: {} }],
        };
      }
      if (url.includes('/kaizen_cycles')) return { ok: true, body: [cycle()] };
      return { ok: true, body: [] };
    });
    const view = await getImprovementsView();
    expect(view.improvements).toHaveLength(1);
    expect(view.events[1]).toHaveLength(1);
    expect(view.cycles).toHaveLength(1);
    expect(view.degraded).toBeNull();
  });

  it('an outage is degraded, not an empty loop', async () => {
    mockFetch((url) =>
      url.includes('/improvements?') ? { ok: false, status: 503 } : { ok: true, body: [cycle()] },
    );
    const view = await getImprovementsView();
    expect(view.improvements).toEqual([]);
    expect(view.degraded).toContain('503');
    // The half that DID load is still served rather than thrown away.
    expect(view.cycles).toHaveLength(1);
  });

  it('a thrown fetch is reported, not swallowed', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    const view = await getImprovementsView();
    expect(view.degraded).toContain('ECONNREFUSED');
  });

  it('skips the events query when there are no improvements to attach them to', async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return { ok: true, body: [] };
    });
    await getImprovementsView();
    expect(seen.some((u) => u.includes('improvement_events'))).toBe(false);
  });
});
