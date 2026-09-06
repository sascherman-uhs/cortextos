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
import { readFileSync } from 'fs';
import { join } from 'path';
import { offeredActions, PATCHABLE_NATIVE } from '../offered-actions';
import { toCanonical, resolveInteractivePath } from '@/lib/data/transition-contract';

/**
 * The contract read straight off disk, NOT through the module under test.
 * The whole point of this file is that the buttons cannot drift away from the
 * rules, so the expectation has to be derived from the rules independently —
 * asserting the helper agrees with itself would prove nothing.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../../../../../tests/fixtures/task-transition-contract.json'), 'utf-8'),
) as {
  allowed_transitions: Record<string, string[]>;
  interactive_paths?: Record<string, Record<string, string[]>>;
  canonical_to_native: Record<string, Record<string, string>>;
  native_to_canonical: Record<string, Record<string, string>>;
};

const STATES = [
  'backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal',
] as const;

/** What the sheet SHOULD offer, worked out from the fixture alone. */
function expectedTargets(source: 'cortexos_tasks' | 'jarvis_tasks', from: string): string[] {
  const direct = FIXTURE.allowed_transitions[from] ?? [];
  const gestures = Object.keys(FIXTURE.interactive_paths?.[from] ?? {});
  const reachable = new Set([...direct, ...gestures]);
  return STATES.filter((to) => {
    if (!reachable.has(to)) return false;
    const native = FIXTURE.canonical_to_native[source]?.[to];
    if (!native) return false;
    // Only what PATCH accepts, and only when the native word means the state
    // the button claims — cortexos spells both waiting and failed_terminal
    // 'blocked', so one of them cannot be offered honestly.
    if (!(PATCHABLE_NATIVE as readonly string[]).includes(native)) return false;
    return FIXTURE.native_to_canonical[source]?.[native] === to;
  });
}

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

  // The anti-drift test. If the contract's state graph changes, this fails
  // until the UI follows it — which is the failure mode that produced Retry
  // and Cancel buttons on failed work that the server had always refused.
  it('offers exactly the contract-legal, endpoint-expressible moves for every state', () => {
    for (const source of ['cortexos_tasks', 'jarvis_tasks'] as const) {
      for (const from of STATES) {
        expect(
          offeredActions(source, from).map((a) => a.to),
          `${source} from ${from}`,
        ).toEqual(expectedTargets(source, from));
      }
    }
  });

  it('the independent expectation is not vacuous — it does constrain something', () => {
    expect(expectedTargets('jarvis_tasks', 'failed_terminal')).toEqual(['waiting']);
    expect(expectedTargets('cortexos_tasks', 'done')).toEqual([]);
    expect(expectedTargets('cortexos_tasks', 'backlog').length).toBeGreaterThan(0);
  });
});
