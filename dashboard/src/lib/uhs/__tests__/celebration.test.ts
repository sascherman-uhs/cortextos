// === JARVIS MOD #94 tests — revenue celebration detector + tiers + replay ===
import { describe, expect, it } from 'vitest';
import {
  appendManual,
  CELEBRATED_CAP,
  detect,
  emptyState,
  formatAmount,
  MAX_REPLAY,
  parseAmount,
  parseState,
  planReplay,
  pruneEvents,
  tierFor,
  type CelebrationEvent,
  type CelebrationState,
  type ProjectRow,
} from '../celebration';

const NOW = new Date('2026-08-03T18:00:00.000Z');

function row(id: string, status: string, price: number | null, address = `${id} St`): ProjectRow {
  return { id, status, staging_price: price, property_address: address };
}

/** A seeded baseline holding exactly the given ids. */
function seeded(ids: string[], seq = 1): CelebrationState {
  return {
    version: 1,
    seededAt: '2026-08-01T00:00:00.000Z',
    seq,
    won: [...ids],
    celebrated: [...ids],
    events: [],
  };
}

describe('tierFor — scaled to the amount', () => {
  it('maps the three bands at their boundaries', () => {
    expect(tierFor(2999)).toBe('shimmer');
    expect(tierFor(3000)).toBe('burst');
    expect(tierFor(8000)).toBe('burst');
    expect(tierFor(8001)).toBe('supernova');
  });

  it('tiers the real probed contract values', () => {
    expect(tierFor(3375)).toBe('burst'); // 10248 Gibson Isle
    expect(tierFor(5245)).toBe('burst'); // 2801 Colanthe
    expect(tierFor(10000)).toBe('supernova'); // 2837 Turtle Head Peak
    expect(tierFor(19855)).toBe('supernova'); // 3844 Glasgow Green
  });

  it('treats an unknown amount as the smallest tier, never as zero', () => {
    expect(tierFor(null)).toBe('shimmer');
    expect(tierFor(undefined)).toBe('shimmer');
    expect(tierFor(Number.NaN)).toBe('shimmer');
    expect(formatAmount(null)).toBe('amount pending');
    expect(formatAmount(null)).not.toContain('0');
  });

  it('formats whole dollars', () => {
    expect(formatAmount(19855)).toBe('$19,855');
    expect(formatAmount(3375.4)).toBe('$3,375');
  });
});

describe('parseAmount', () => {
  it('accepts numbers and numeric strings, rejects non-positive and junk', () => {
    expect(parseAmount(10000)).toBe(10000);
    expect(parseAmount('6775')).toBe(6775);
    expect(parseAmount(0)).toBeNull();
    expect(parseAmount(-5)).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
});

describe('detect — first run seeds, never fires', () => {
  it('records the baseline and emits nothing', () => {
    const rows = [row('a', 'STAGED', 5000), row('b', 'CONTRACTED', 12000)];
    const res = detect(emptyState(), rows, NOW);
    expect(res.seeded).toBe(true);
    expect(res.fired).toEqual([]);
    expect(res.state.won.sort()).toEqual(['a', 'b']);
    expect(res.state.celebrated.sort()).toEqual(['a', 'b']);
    expect(res.state.seededAt).toBe(NOW.toISOString());
  });

  it('a seeded baseline does not celebrate the deals it seeded on the next poll', () => {
    const rows = [row('a', 'STAGED', 5000), row('b', 'CONTRACTED', 12000)];
    const first = detect(emptyState(), rows, NOW);
    const second = detect(first.state, rows, NOW);
    expect(second.fired).toEqual([]);
  });
});

describe('detect — transition detection', () => {
  it('fires when a project enters the open-contract set', () => {
    const before = seeded(['a']);
    const res = detect(
      before,
      [row('a', 'STAGED', 5000), row('b', 'CONTRACTED', 10000, '2837 Turtle Head Peak Dr')],
      NOW,
    );
    expect(res.fired).toHaveLength(1);
    expect(res.fired[0]).toMatchObject({
      kind: 'contract_won',
      projectId: 'b',
      label: '2837 Turtle Head Peak Dr',
      amount: 10000,
      tier: 'supernova',
      source: 'detector',
    });
  });

  it('does NOT fire on a status move WITHIN the open set (CONTRACTED → STAGED)', () => {
    const before = seeded(['a']);
    const res = detect(before, [row('a', 'STAGED', 5000)], NOW);
    expect(res.fired).toEqual([]);
  });

  it('does NOT fire on a price change alone — an amendment is not a new win', () => {
    const before = seeded(['a']);
    const res = detect(before, [row('a', 'STAGED', 99999)], NOW);
    expect(res.fired).toEqual([]);
  });

  it('does NOT fire for a terminal status (the newest updated_at row at probe time was NOTICE_GIVEN→DESTAGED churn)', () => {
    const before = seeded(['a']);
    const res = detect(before, [row('a', 'STAGED', 5000), row('z', 'DESTAGED', 8000)], NOW);
    expect(res.fired).toEqual([]);
    expect(res.state.won).not.toContain('z');
  });

  it('ignores INQUIRY and CANCELLED rows', () => {
    const before = seeded(['a']);
    const res = detect(
      before,
      [row('a', 'STAGED', 5000), row('i', 'INQUIRY', 4000), row('c', 'CANCELLED', 4000)],
      NOW,
    );
    expect(res.fired).toEqual([]);
  });

  it('never fires twice for the same project, even if it leaves and re-enters', () => {
    const before = seeded(['a']);
    const won = detect(before, [row('a', 'STAGED', 5000), row('b', 'CONTRACTED', 4000)], NOW);
    expect(won.fired).toHaveLength(1);

    const left = detect(won.state, [row('a', 'STAGED', 5000), row('b', 'DESTAGED', 4000)], NOW);
    expect(left.fired).toEqual([]);

    const back = detect(left.state, [row('a', 'STAGED', 5000), row('b', 'STAGED', 4000)], NOW);
    expect(back.fired).toEqual([]);
  });

  it('assigns monotonic, non-repeating ids across polls', () => {
    const s0 = seeded([]);
    const p1 = detect(s0, [row('a', 'CONTRACTED', 4000)], NOW);
    const p2 = detect(p1.state, [row('a', 'CONTRACTED', 4000), row('b', 'CONTRACTED', 4000)], NOW);
    expect(p1.fired[0].id).toBe('cel-1');
    expect(p2.fired[0].id).toBe('cel-2');
    expect(p2.state.seq).toBe(3);
  });

  it('fires several at once when a batch of wins lands between polls', () => {
    const res = detect(
      seeded(['a']),
      [row('a', 'STAGED', 1000), row('b', 'CONTRACTED', 2000), row('c', 'CONTRACTED', 9000)],
      NOW,
    );
    expect(res.fired.map((e) => e.projectId).sort()).toEqual(['b', 'c']);
    expect(res.fired.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('celebrates a signed contract with no price yet, labelled not zeroed', () => {
    const res = detect(seeded([]), [row('b', 'CONTRACTED', null)], NOW);
    expect(res.fired[0].amount).toBeNull();
    expect(res.fired[0].tier).toBe('shimmer');
  });

  it('falls back to a neutral label when the address is blank', () => {
    const res = detect(seeded([]), [row('b', 'CONTRACTED', 4000, '   ')], NOW);
    expect(res.fired[0].label).toBe('New contract');
  });

  it('caps the celebrated ledger', () => {
    const many = Array.from({ length: CELEBRATED_CAP + 10 }, (_, i) => `p${i}`);
    const res = detect(emptyState(), many.map((id) => row(id, 'STAGED', 100)), NOW);
    expect(res.state.celebrated).toHaveLength(CELEBRATED_CAP);
  });
});

describe('appendManual — the deliberate lane', () => {
  it('shares the id sequence with the detector and marks the source', () => {
    const base = seeded(['a'], 5);
    const { state, event } = appendManual(
      base,
      { kind: 'contract_won', projectId: 'a', label: '1 Test St', amount: 4000, tier: 'burst', test: true },
      NOW,
    );
    expect(event.id).toBe('cel-5');
    expect(event.source).toBe('manual');
    expect(event.test).toBe(true);
    expect(state.seq).toBe(6);
  });

  it('does not mark the project celebrated — a manual event must not suppress the real transition', () => {
    const base = seeded([], 1);
    const { state } = appendManual(
      base,
      { kind: 'contract_won', projectId: 'b', label: 'x', amount: 1, tier: 'shimmer' },
      NOW,
    );
    expect(state.celebrated).not.toContain('b');
    const later = detect(state, [{ id: 'b', status: 'CONTRACTED', staging_price: 9000, property_address: 'x' }], NOW);
    expect(later.fired).toHaveLength(1);
  });
});

describe('pruneEvents', () => {
  it('drops events past the retention window and sorts by seq', () => {
    const mk = (seq: number, at: string): CelebrationEvent => ({
      id: `cel-${seq}`, seq, at, kind: 'contract_won', projectId: `p${seq}`,
      label: 'x', amount: 1, tier: 'shimmer', source: 'detector',
    });
    const kept = pruneEvents(
      [mk(3, '2026-08-02T00:00:00Z'), mk(1, '2026-07-01T00:00:00Z'), mk(2, '2026-07-30T00:00:00Z')],
      NOW,
    );
    expect(kept.map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe('planReplay — dedupe and cap', () => {
  const events: CelebrationEvent[] = [1, 2, 3, 4, 5].map((seq) => ({
    id: `cel-${seq}`, seq, at: '2026-08-02T00:00:00Z', kind: 'contract_won',
    projectId: `p${seq}`, label: 'x', amount: 5000, tier: 'burst', source: 'detector',
  }));

  it('replays nothing when everything has been seen', () => {
    const plan = planReplay(events, 5);
    expect(plan.play).toEqual([]);
    expect(plan.nextSeen).toBe(5);
  });

  it('replays only unseen events, oldest first', () => {
    const plan = planReplay(events, 3);
    expect(plan.play.map((e) => e.seq)).toEqual([4, 5]);
    expect(plan.skipped).toBe(0);
  });

  it('caps at MAX_REPLAY and reports the remainder rather than dropping it silently', () => {
    const plan = planReplay(events, 0);
    expect(plan.play.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(plan.play).toHaveLength(MAX_REPLAY);
    expect(plan.skipped).toBe(2);
  });

  it('advances past skipped events so they never replay on the next reconnect', () => {
    const plan = planReplay(events, 0);
    expect(plan.nextSeen).toBe(5);
    expect(planReplay(events, plan.nextSeen).play).toEqual([]);
  });

  it('holds the marker when the feed is empty (pruned away, nothing to infer)', () => {
    expect(planReplay([], 9).nextSeen).toBe(9);
    expect(planReplay([], 9).play).toEqual([]);
  });

  it('recovers when the server sequence RESTARTS — never swallows real events forever', () => {
    // The server's state file was lost, so seq began again at 1. A client
    // holding lastSeen=20 must not filter every future celebration out.
    const plan = planReplay(events, 20);
    expect(plan.play.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(plan.skipped).toBe(2);
    expect(plan.nextSeen).toBe(5);
    // And it settles: the next poll on the new sequence replays nothing.
    expect(planReplay(events, plan.nextSeen).play).toEqual([]);
  });
});

describe('parseState — a corrupt file degrades, it does not crash', () => {
  it('returns a fresh (unseeded) state for junk', () => {
    expect(parseState(null).seededAt).toBeNull();
    expect(parseState('nonsense').seq).toBe(1);
    expect(parseState({ seq: -4, won: ['a', 7] }).won).toEqual(['a']);
  });

  it('round-trips a real state', () => {
    const s = seeded(['a', 'b'], 12);
    expect(parseState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('an unreadable file re-seeds rather than firing for every open contract', () => {
    // The dangerous failure mode: state lost -> looks like 23 brand-new wins.
    const res = detect(parseState(undefined), [row('a', 'STAGED', 5000), row('b', 'STAGED', 9000)], NOW);
    expect(res.fired).toEqual([]);
    expect(res.seeded).toBe(true);
  });
});
