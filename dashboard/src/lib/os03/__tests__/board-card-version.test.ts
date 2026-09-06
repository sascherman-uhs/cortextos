/**
 * Fix6 / defect D2 (L1) — the board card must carry the version it was
 * rendered from, so the one move path can echo it back as expectedVersion.
 *
 * Reproduced before the fix: the board rendered a card from version 1, an
 * out-of-band change took the record to version 6, and the board's move still
 * applied — the record became version 7 and the concurrent change was lost,
 * because BoardCard had no version to send.
 */

import { describe, it, expect } from 'vitest';
import { toBoardCard } from '../work-board';
import { projectTask } from '@/lib/data/task-projection';
import type { ProjectedTask } from '@/lib/data/tasks';
import type { Task } from '@/lib/types';

function row(over: Partial<Task> & { id: string; status: string }): ProjectedTask {
  const base: Task = {
    title: 'ZZTEST card',
    priority: 'normal',
    org: 'uhs',
    needs_approval: false,
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  };
  return {
    ...base,
    projection: projectTask({ status: base.status, assignee: base.assignee, title: base.title }),
  };
}

describe('toBoardCard', () => {
  it('carries the row version onto the card', () => {
    expect(toBoardCard(row({ id: 'supa_1', status: 'pending', version: 6 })).version).toBe(6);
  });

  it('keeps version 0 rather than treating it as absent', () => {
    expect(toBoardCard(row({ id: 'supa_2', status: 'pending', version: 0 })).version).toBe(0);
  });

  it('reports null — not a guess — when the row reached the board without one', () => {
    expect(toBoardCard(row({ id: 'supa_3', status: 'pending' })).version).toBeNull();
  });

  it('reports null for a non-numeric version rather than sending it as-is', () => {
    const bad = row({ id: 'supa_4', status: 'pending' });
    (bad as unknown as { version: unknown }).version = 'seven';
    expect(toBoardCard(bad).version).toBeNull();
  });
});
