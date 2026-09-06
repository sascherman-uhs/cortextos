/**
 * Fix6 / D11 — the sheet's buttons must be the contract's legal moves.
 *
 * Reproduced before the fix: a failed task's sheet offered Retry (pending) and
 * Cancel (cancelled). PATCH with {"status":"pending","expectedVersion":1}
 * returned 422 with legalTransitions ["waiting"] and the record unchanged.
 * Both offered buttons were illegal, and the one legal move was offered
 * nowhere, so failed work could not be acted on at all.
 */

import { describe, it, expect } from 'vitest';
import { offeredActions, PATCHABLE_NATIVE } from '../offered-actions';
import { toCanonical, resolveInteractivePath } from '@/lib/data/transition-contract';

describe('offeredActions', () => {
  it('offers exactly one move out of failed_terminal, and it is the legal one', () => {
    const actions = offeredActions('jarvis_tasks', 'failed_terminal');
    expect(actions.map((a) => a.to)).toEqual(['waiting']);
    expect(actions[0].status).toBe('blocked');
  });

  it('never offers the two moves that were measured as refused', () => {
    const actions = offeredActions('jarvis_tasks', 'failed_terminal');
    expect(actions.map((a) => a.status)).not.toContain('pending');
    expect(actions.map((a) => a.status)).not.toContain('cancelled');
  });

  it('says what the failed task becomes, so the move is not a mystery', () => {
    expect(offeredActions('cortexos_tasks', 'failed_terminal')[0].meaning).toContain('Waiting');
  });

  it('offers nothing from a terminal state the contract closes', () => {
    expect(offeredActions('cortexos_tasks', 'done')).toEqual([]);
    expect(offeredActions('cortexos_tasks', 'cancelled')).toEqual([]);
  });

  it('offers Start out of the backlog via the declared multi-leg path', () => {
    const actions = offeredActions('cortexos_tasks', 'backlog');
    const start = actions.find((a) => a.to === 'doing');
    expect(start).toBeDefined();
    expect(start!.label).toBe('Start');
    expect(start!.status).toBe('in_progress');
  });

  it('calls the same target Resume when the work is picked back up', () => {
    expect(offeredActions('cortexos_tasks', 'waiting').find((a) => a.to === 'doing')!.label)
      .toBe('Resume');
  });

  it('never offers a move the endpoint cannot express', () => {
    for (const source of ['cortexos_tasks', 'jarvis_tasks'] as const) {
      for (const from of ['backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal'] as const) {
        for (const action of offeredActions(source, from)) {
          expect(PATCHABLE_NATIVE).toContain(action.status);
          // The native word must mean the state the button claims. cortexos
          // maps waiting AND failed_terminal onto 'blocked', so an Abandon
          // button would silently perform a Block.
          expect(toCanonical(source, action.status)).toBe(action.to);
        }
      }
    }
  });

  it('never offers a move the contract has no route for', () => {
    for (const source of ['cortexos_tasks', 'jarvis_tasks'] as const) {
      for (const from of ['backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal'] as const) {
        for (const action of offeredActions(source, from)) {
          // Either a direct edge, or a multi-leg gesture the contract itself
          // declares. resolveInteractivePath returns null when there is neither.
          expect(resolveInteractivePath(from, action.to)).not.toBeNull();
        }
      }
    }
  });
});
