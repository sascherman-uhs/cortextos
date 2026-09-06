/**
 * OS-02: the dashboard's shared transition service.
 *
 * Plan §11 rows exercised here:
 *  - "Human edits task/approval while agent acts — source-version conflict"
 *  - "Authorization/deployment boundaries — no client sends/publish/financial
 *     or protected-config changes inferred from a Kanban move"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveTarget,
  canMove,
  parseContractRefusal,
  interactiveLegalityRefusal,
  contractRefusal,
} from '../task-transition';
import { sourceForTaskId, toCanonical, toNative, isAllowedMove } from '../data/transition-contract';

describe('OS-02 dashboard transition service', () => {
  describe('routing', () => {
    it('sends supa_ ids to the Supabase store and everything else to the native one', () => {
      expect(sourceForTaskId('supa_1853')).toBe('jarvis_tasks');
      expect(sourceForTaskId('task_1700000000_abcd')).toBe('cortexos_tasks');
    });
  });

  describe('target resolution', () => {
    it('accepts a canonical lane and returns the word the store speaks', () => {
      expect(resolveTarget('cortexos_tasks', 'done')).toEqual({ canonical: 'done', native: 'completed' });
      expect(resolveTarget('jarvis_tasks', 'waiting')).toEqual({ canonical: 'waiting', native: 'blocked' });
    });

    it('accepts a native status and reports the lane it lands in', () => {
      expect(resolveTarget('cortexos_tasks', 'in_progress')).toEqual({
        canonical: 'doing', native: 'in_progress',
      });
    });

    it('refuses a status it cannot map rather than silently parking the task', () => {
      // An unmapped native status projects onto `waiting`. Accepting that would
      // quietly move a task into a lane the caller never asked for.
      expect(resolveTarget('cortexos_tasks', 'yolo')).toBeNull();
      expect(resolveTarget('jarvis_tasks', 'not_a_state')).toBeNull();
    });
  });

  describe('a Kanban move is a request, not a grant of authority', () => {
    it('cannot jump straight from backlog to done', () => {
      expect(canMove('cortexos_tasks', 'pending', 'done')).toBe(false);
      expect(isAllowedMove('backlog', 'done')).toBe(false);
    });

    it('cannot reopen a terminal state by dragging it', () => {
      expect(isAllowedMove('done', 'doing')).toBe(false);
      expect(isAllowedMove('cancelled', 'ready')).toBe(false);
    });

    it('permits the ordinary board moves', () => {
      expect(isAllowedMove('ready', 'doing')).toBe(true);
      expect(isAllowedMove('doing', 'verify')).toBe(true);
      expect(isAllowedMove('verify', 'done')).toBe(true);
      expect(isAllowedMove('waiting', 'ready')).toBe(true);
    });

    it('lets a failed_terminal item be reopened into waiting, but no further', () => {
      // Failures stay visible and recoverable; they do not become done by a drag.
      expect(isAllowedMove('failed_terminal', 'waiting')).toBe(true);
      expect(isAllowedMove('failed_terminal', 'done')).toBe(false);
    });
  });

  describe('Supabase branch', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_KEY = 'test-key';
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
    });

    async function callTransition(args: Parameters<typeof import('../task-transition').transitionTask>[0]) {
      const { transitionTask } = await import('../task-transition');
      return transitionTask(args);
    }

    it('a version conflict comes back as a 409 carrying the current record', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/rest/v1/tasks?id=eq.')) {
          return new Response(JSON.stringify([{ id: 7, status: 'blocked', version: 4 }]), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            ok: false, error: 'version_conflict', current_version: 4,
            current: { id: 7, status: 'blocked', version: 4 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const out = await callTransition({
        taskId: 'supa_7', to: 'done', actor: 'dashboard', expectedVersion: 1,
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.status).toBe(409);
      expect(out.error).toBe('version_conflict');
      // The current record must come back, so the UI can show and refresh
      // rather than retrying blind over someone else's change.
      expect((out as { current: Record<string, unknown> }).current.status).toBe('blocked');
    });

    it('a missing task is a 404, not a silent success', async () => {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
      const out = await callTransition({ taskId: 'supa_999', to: 'done', actor: 'dashboard' });
      expect(out).toMatchObject({ ok: false, status: 404, error: 'task_not_found' });
    });

    it('an unmappable target never reaches the store', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const out = await callTransition({ taskId: 'supa_7', to: 'nonsense', actor: 'dashboard' });
      expect(out).toMatchObject({ ok: false, status: 400, error: 'unmappable_target_state' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a successful transition reports the new version and lane', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/rest/v1/tasks?id=eq.')) {
          return new Response(JSON.stringify([{ id: 7, status: 'in_progress', version: 3 }]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, version: 4 }), { status: 200 });
      }) as unknown as typeof fetch;

      const out = await callTransition({
        taskId: 'supa_7', to: 'done', actor: 'dashboard', expectedVersion: 3,
        evidence: { artifact: 'x', verifier: 'v' },
      });
      expect(out).toMatchObject({ ok: true, version: 4, canonicalState: 'done', nativeStatus: 'completed' });
    });

    it('an unreachable store is reported, never treated as done', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const out = await callTransition({ taskId: 'supa_7', to: 'done', actor: 'dashboard' });
      expect(out).toMatchObject({ ok: false, error: 'supabase_unreachable' });
    });
  });

  describe('an interactive move is enforced regardless of the shadow flag', () => {
    // The defect: the board applied a contract-violating move, the bus logged
    // "[task-contract:shadow] cortexos_tasks: backlog -> done violates
    // illegal_transition" and exited 0, and the API answered 200. Nothing
    // refused, and the UI showed nothing.

    it('refuses backlog -> done before the store is touched', () => {
      const refusal = interactiveLegalityRefusal('backlog', 'done');
      expect(refusal).not.toBeNull();
      expect(refusal!.status).toBe(422);
      expect(refusal!.violation).toBe('illegal_transition');
      // The message must tell the person what they CAN do.
      expect(refusal!.legalTransitions).toEqual(['ready', 'waiting', 'cancelled', 'failed_terminal']);
      expect(refusal!.message).toMatch(/Legal moves from "backlog": ready, waiting, cancelled, failed terminal/);
    });

    it('still allows the two-step completion path for work under way', () => {
      // doing -> done is not a single contract hop; it is doing -> verify ->
      // done, and each leg costs its own proof at the store boundary.
      expect(interactiveLegalityRefusal('doing', 'verify')).toBeNull();
      expect(interactiveLegalityRefusal('doing', 'done')).toBeNull();
      expect(interactiveLegalityRefusal('waiting', 'done')).toBeNull();
    });

    it('refuses to reopen a terminal record', () => {
      const refusal = interactiveLegalityRefusal('done', 'doing');
      expect(refusal!.status).toBe(422);
      expect(refusal!.legalTransitions).toEqual([]);
      expect(refusal!.message).toMatch(/terminal state/);
    });

    it('a Supabase-backed task is refused before the compare-and-set RPC runs', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        if (String(url).includes('/rest/v1/tasks?id=eq.')) {
          return new Response(JSON.stringify([{ id: 7, status: 'pending', version: 2 }]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, version: 3 }), { status: 200 });
      }) as unknown as typeof fetch;

      const { transitionTask } = await import('../task-transition');
      const out = await transitionTask({
        taskId: 'supa_7', to: 'done', actor: 'scott', expectedVersion: 2,
      });

      expect(out).toMatchObject({ ok: false, status: 422, error: 'contract_violation' });
      // The RPC is a compare-and-set, not a validator: it must never be reached
      // with a move the contract refuses.
      expect(calls.some((c) => c.includes('rpc/task_transition'))).toBe(false);
    });

    it('reads the bus CLI refusal into the one shape the board renders', () => {
      const stderr = [
        'CONTRACT_REFUSED ' + JSON.stringify({
          source: 'cortexos_tasks', from: 'verify', to: 'done',
          error: 'acceptance_checks_incomplete',
          detail: 'no recorded result for acceptance check: tests pass',
          legal_transitions: ['done', 'doing', 'waiting', 'cancelled'],
        }),
        '[cortexos_tasks] verify -> done refused: acceptance_checks_incomplete',
      ].join('\n');

      const parsed = parseContractRefusal(stderr);
      expect(parsed).not.toBeNull();
      expect(parsed!.status).toBe(422);
      expect(parsed!.violation).toBe('acceptance_checks_incomplete');
      expect(parsed!.message).toMatch(/no recorded result for acceptance check: tests pass/);
    });

    it('leaves an ordinary failure alone rather than dressing it as a refusal', () => {
      expect(parseContractRefusal('bash: node: command not found')).toBeNull();
      expect(parseContractRefusal('')).toBeNull();
    });

    it('names the rule, not an error code, in what the person reads', () => {
      const r = contractRefusal('verify', 'done', 'missing_verifier', 'Verify -> Done requires a named verifier');
      expect(r.message).toMatch(/refused by the work contract/);
      expect(r.message).toMatch(/requires a named verifier/);
    });
  });

  describe('state mapping is a projection, never an enum rewrite', () => {
    it('keeps each store in its own vocabulary', () => {
      // The same lane maps to different native words per store, which is the
      // whole reason the mapping is data rather than a rename.
      expect(toNative('cortexos_tasks', 'failed_terminal')).toBe('blocked');
      expect(toNative('jarvis_tasks', 'failed_terminal')).toBe('failed');
    });

    it('never coerces an unknown status into a happy state', () => {
      expect(toCanonical('jarvis_tasks', 'something_new')).toBe('waiting');
      expect(toCanonical('cortexos_tasks', '')).toBe('waiting');
    });
  });
});
