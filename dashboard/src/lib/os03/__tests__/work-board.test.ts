/**
 * OS-03 — work board model.
 *
 * These tests pin the behaviours the board exists to guarantee, all of which
 * are things a Kanban normally gets wrong:
 *
 *   * an empty Ready column says WHY it is empty, because in Slice 1 no source
 *     status projects onto Ready and "nothing is ready" would be a lie;
 *   * a failed attempt stays attached to its parent card;
 *   * cancellation is a state of its own, not a synonym for done;
 *   * a completion with no recorded evidence carries the contract's own
 *     "historical, evidence not recorded" wording;
 *   * an illegal move is refused WITH a reason, and Done is refused always.
 */

import { describe, it, expect } from 'vitest';
import {
  BOARD_COLUMNS,
  buildBoard,
  checkMove,
  columnUnpopulatedReason,
  legacyCompletionLabel,
  moveTargets,
  toBoardCard,
} from '../work-board';
import { projectTask } from '@/lib/data/task-projection';
import type { ProjectedTask } from '@/lib/data/tasks';
import type { Task } from '@/lib/types';

function task(over: Partial<Task> & { id: string; status: string }): ProjectedTask {
  const base: Task = {
    id: over.id,
    title: over.title ?? `Task ${over.id}`,
    description: over.description,
    status: over.status,
    priority: over.priority ?? 'normal',
    assignee: over.assignee,
    org: over.org ?? 'uhs',
    project: over.project,
    needs_approval: over.needs_approval ?? false,
    created_at: over.created_at ?? '2026-09-01T00:00:00Z',
    updated_at: over.updated_at ?? '2026-09-04T00:00:00Z',
    completed_at: over.completed_at,
    notes: over.notes,
  };
  return {
    ...base,
    projection: projectTask({
      status: base.status,
      assignee: base.assignee,
      needs_approval: base.needs_approval,
      title: base.title,
      project: base.project,
    }),
  };
}

describe('columns', () => {
  it('has the five plan columns in order, with Waiting kept beside them', () => {
    expect(BOARD_COLUMNS).toEqual(['backlog', 'ready', 'doing', 'verify', 'done']);
  });

  it('explains why Ready and Verify cannot be populated by the current sources', () => {
    // No native status in either store maps onto ready or verify. An empty
    // column here must not read as "no work is ready".
    expect(columnUnpopulatedReason('ready')).toMatch(/No source status projects onto Ready/);
    expect(columnUnpopulatedReason('verify')).toMatch(/No source status projects onto Verify/);
  });

  it('does not invent a reason for a column the sources do populate', () => {
    expect(columnUnpopulatedReason('backlog')).toBeNull();
    expect(columnUnpopulatedReason('doing')).toBeNull();
    expect(columnUnpopulatedReason('done')).toBeNull();
  });

  it('routes rows to the column their native status projects onto', () => {
    const board = buildBoard([
      task({ id: 'a', status: 'pending' }),
      task({ id: 'b', status: 'in_progress' }),
      task({ id: 'c', status: 'completed', completed_at: '2026-09-05T01:00:00Z' }),
    ]);
    expect(board.laneCounts.backlog).toBe(1);
    expect(board.laneCounts.doing).toBe(1);
    expect(board.laneCounts.done).toBe(1);
    expect(board.columns.find((c) => c.state === 'ready')!.unpopulatedReason).toBeTruthy();
  });
});

describe('waiting lane', () => {
  const rows = [
    task({ id: 'supa_1', status: 'blocked', assignee: 'scott' }),   // human
    task({ id: 'supa_2', status: 'failed', assignee: 'jarvis-mls' }),
    task({ id: 'supa_3', status: 'blocked', assignee: 'jarvis-mls' }),
  ];

  it('holds every non-terminal waiting row and groups it by subtype', () => {
    const board = buildBoard(rows);
    expect(board.waiting.total).toBe(3);
    const human = board.waiting.groups.find((g) => g.subtype === 'human')!;
    expect(human.count).toBe(1);
    // Every subtype is present as a group even at zero, so a subtype with no
    // rows is visibly zero rather than absent.
    expect(board.waiting.groups.map((g) => g.subtype)).toEqual([
      'human', 'retry', 'dependency', 'external', 'unclassified',
    ]);
  });

  it('filters to one subtype without changing the total it reports', () => {
    const board = buildBoard(rows, { filters: { waitingSubtype: 'human' } });
    expect(board.waiting.cards).toHaveLength(1);
    expect(board.waiting.total).toBe(3);
  });
});

describe('cards', () => {
  it('keeps a failed attempt attached to its parent card', () => {
    const card = toBoardCard(task({ id: 'supa_9', status: 'failed', notes: 'browser bridge died' }));
    expect(card.attempts.some((a) => a.status === 'failed')).toBe(true);
    expect(card.attempts.find((a) => a.status === 'failed')!.detail).toBe('browser bridge died');
    // And it stays on the board rather than disappearing into history.
    expect(buildBoard([task({ id: 'supa_9', status: 'failed' })]).waiting.total).toBe(1);
  });

  it('labels a completion with no recorded evidence in the contract\'s own words', () => {
    const card = toBoardCard(task({ id: 'x', status: 'completed', completed_at: '2026-09-05T00:00:00Z' }));
    expect(card.evidence).toBe('not_recorded');
    expect(card.evidenceLabel).toBe(legacyCompletionLabel());
    expect(card.evidenceLabel).not.toMatch(/verified/i);
  });

  it('records evidence when the record actually carries some', () => {
    const card = toBoardCard(
      task({ id: 'y', status: 'completed', completed_at: '2026-09-05T00:00:00Z', notes: 'PR #12 merged' }),
    );
    expect(card.evidence).toBe('recorded');
  });

  it('prints no due time rather than inventing one', () => {
    expect(toBoardCard(task({ id: 'z', status: 'pending' })).dueAt).toBeNull();
  });

  it('keeps the accountable agent and the accountable human separate', () => {
    const agentCard = toBoardCard(task({ id: 'a1', status: 'pending', assignee: 'jarvis-mls' }));
    expect(agentCard.accountableAgent).toBe('jarvis-mls');
    expect(agentCard.accountableHuman).toBeNull();

    const humanCard = toBoardCard(task({ id: 'h1', status: 'pending', assignee: 'scott' }));
    expect(humanCard.accountableAgent).toBeNull();
    expect(humanCard.accountableHuman).toBe('Scott Ascherman');
  });

  it('always carries the native status alongside the projected lane', () => {
    const card = toBoardCard(task({ id: 'supa_5', status: 'failed' }));
    expect(card.nativeStatus).toBe('failed');
    expect(card.state).toBe('waiting');
  });
});

describe('terminal states', () => {
  it('keeps cancellation distinct from done', () => {
    const board = buildBoard([
      task({ id: 'c1', status: 'cancelled' }),
      task({ id: 'd1', status: 'completed' }),
    ]);
    expect(board.cancelled).toHaveLength(1);
    expect(board.laneCounts.done).toBe(1);
    expect(board.columns.find((c) => c.state === 'done')!.cards.map((c) => c.id)).toEqual(['d1']);
  });
});

describe('moves', () => {
  const backlog = { state: 'backlog' as const, source: 'jarvis_tasks' as const };
  const doing = { state: 'doing' as const, source: 'jarvis_tasks' as const };
  const done = { state: 'done' as const, source: 'jarvis_tasks' as const };

  it('never lets a board move mark work Done', () => {
    const check = checkMove({ state: 'verify', source: 'jarvis_tasks' }, 'done');
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/independent verifier/i);
    expect(moveTargets({ state: 'verify', source: 'jarvis_tasks' })).not.toContain('done');
  });

  it('refuses an illegal transition and says which moves ARE legal', () => {
    const check = checkMove(backlog, 'doing');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('not a permitted transition');
    expect(check.reason).toContain('Ready');
  });

  it('refuses to move out of a terminal state, and says why', () => {
    const check = checkMove(done, 'doing');
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/terminal state/);
  });

  it('refuses a no-op instead of pretending it succeeded', () => {
    expect(checkMove(doing, 'doing').allowed).toBe(false);
  });

  it('allows a legal move but still lists what the server will check', () => {
    const check = checkMove(backlog, 'ready');
    expect(check.allowed).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.serverWillCheck.join(' ')).toMatch(/acceptance_criteria/);
    expect(check.serverWillCheck.join(' ')).toMatch(/Dependencies satisfied/);
  });
});

describe('degraded sources', () => {
  it('marks the board degraded so empty lanes cannot read as all clear', () => {
    const board = buildBoard([], { degraded: true });
    expect(board.degraded).toBe(true);
    expect(board.totalCards).toBe(0);
  });
});
