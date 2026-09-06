/**
 * fix5 — the legacy path, dashboard half.
 *
 * The board was made unusable by enforcing required fields on 1,863 records
 * that predate the contract. These tests cover the boundary that owns the
 * Supabase store: it has no validator on the far side, so the Ready gate has to
 * live here, and it has to be the SAME gate the core validator applies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkReady,
  resolveInteractivePath,
  missingContractFields,
  isContractNative,
} from '../data/transition-contract';
import { supabaseContractItem, fieldPatch } from '../task-transition';

const realFetch = globalThis.fetch;

describe('fix5 dashboard — legacy work can move, new work cannot cheat', () => {
  // -------------------------------------------------------------------------
  describe('the gate here is the gate the core validator applies', () => {
    it('replays the shared fixture cases that land on Ready', () => {
      // The one guard against this copy of the rules drifting from the core
      // one: both are judged by the same recorded table.
      // Found relative to this file rather than the working directory, which
      // differs between `npm test` in dashboard/ and a run from the repo root.
      const fixture = JSON.parse(
        readFileSync(join(__dirname, '../../../../tests/fixtures/task-transition-contract.json'), 'utf-8'),
      ) as { cases: Record<string, never>[] };
      const readyCases = fixture.cases.filter((c) => c.to === 'ready');
      expect(readyCases.length).toBeGreaterThan(5);
      for (const c of readyCases as unknown as {
        name: string; item: Record<string, unknown>; ok: boolean; error?: string;
        context?: { unsatisfied_dependencies?: string[]; grandfather?: { actor?: string; reason?: string } };
      }[]) {
        const r = checkReady(c.item, {
          unsatisfiedDependencies: c.context?.unsatisfied_dependencies,
          grandfather: c.context?.grandfather,
        });
        expect({ name: c.name, ok: r.ok, error: r.error ?? null })
          .toEqual({ name: c.name, ok: c.ok, error: c.ok ? (r.error ?? null) : c.error });
      }
    });

    it('identifies legacy structurally, not by any date', () => {
      expect(isContractNative({ contract_version: 1 })).toBe(true);
      expect(isContractNative({})).toBe(false);
      expect(missingContractFields({ outcome: 'x', agent_role_id: 'backend' }))
        .toEqual(['acceptance_criteria']);
    });

    it('routes Start through Ready rather than inventing an edge', () => {
      expect(resolveInteractivePath('backlog', 'doing')).toEqual(['ready', 'doing']);
      expect(resolveInteractivePath('backlog', 'verify')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the record the gate judges', () => {
    it('reads the payload title as the outcome, the way the native store does', () => {
      const item = supabaseContractItem({ payload: { title: 'Renew the contract' } });
      expect(item.outcome).toBe('Renew the contract');
    });

    it('folds in the fields being supplied, so the gate judges the record as it will stand', () => {
      const item = supabaseContractItem(
        { payload: { title: 't' } },
        { acceptanceCriteria: ['signed PDF filed'], humanAccountableId: 'scott' },
      );
      expect(checkReady(item).ok).toBe(true);
    });

    it('writes only the contract fields, never a general task edit', () => {
      expect(fieldPatch({ outcome: '  ', acceptanceCriteria: ['', ' '] })).toBeNull();
      expect(fieldPatch({ outcome: 'o', acceptanceCriteria: ['c'] }))
        .toEqual({ outcome: 'o', acceptance_criteria: ['c'] });
    });
  });

  // -------------------------------------------------------------------------
  describe('against the store', () => {
    beforeEach(() => {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_KEY = 'test-key';
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
    });

    /** A backfilled row: version and source_ref from OS-02, and nothing the
     *  contract asks for, because nothing ever asked this row for it. */
    const legacyRow = {
      id: 7, status: 'pending', version: 3, payload: { title: 'Renew the Colanthe contract' },
      acceptance_criteria: null, human_accountable_id: null, agent_role_id: null,
      contract_version: null, evidence_recorded: false,
    };

    function mockStore(rows: Record<string, unknown>, calls: { url: string; body: Record<string, unknown> }[]) {
      let version = Number(rows.version);
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/rest/v1/tasks?id=eq.')) {
          return new Response(JSON.stringify([rows]), { status: 200 });
        }
        calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
        version += 1;
        return new Response(JSON.stringify({ ok: true, version }), { status: 200 });
      }) as unknown as typeof fetch;
    }

    // transitionTask now REFUSES a request with no expectedVersion rather than
    // substituting the current version — a versionless write is a blind write.
    // These tests are about the store's behaviour, not about concurrency, so
    // the helper supplies the fixture's version unless the test states one.
    async function callTransition(args: Parameters<typeof import('../task-transition').transitionTask>[0]) {
      const { transitionTask } = await import('../task-transition');
      return transitionTask({ expectedVersion: 1, ...args });
    }

    it('refuses Start on a legacy row with what is missing, before writing anything', async () => {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      mockStore(legacyRow, calls);

      const out = await callTransition({ taskId: 'supa_7', to: 'doing', actor: 'scott' });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.status).toBe(422);
      const refusal = out as unknown as { missing: string[]; legacy: boolean; waivable: boolean; message: string; remedies: string[] };
      expect(refusal.missing).toEqual(['owner', 'acceptance_criteria']);
      expect(refusal.legacy).toBe(true);
      expect(refusal.waivable).toBe(true);
      expect(refusal.remedies).toEqual(['supply_fields', 'grandfather']);
      // The person is told what is missing, not just which edge is illegal.
      expect(refusal.message).toContain('missing owner and acceptance_criteria');
      expect(calls).toHaveLength(0);
    });

    it('supplying the fields moves it through Ready to Doing, in audited legs', async () => {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      mockStore(legacyRow, calls);

      const out = await callTransition({
        taskId: 'supa_7', to: 'doing', actor: 'scott',
        fields: { acceptanceCriteria: ['signed PDF filed'], humanAccountableId: 'scott' },
      });

      expect(out).toMatchObject({ ok: true, canonicalState: 'doing', nativeStatus: 'in_progress' });
      expect(calls).toHaveLength(2);
      // Leg one carries the upgrade and says which canonical state it reached,
      // because 'pending' alone cannot tell backlog from ready.
      expect(calls[0].url).toContain('task_transition_v2');
      expect(calls[0].body.p_canonical_to).toBe('ready');
      expect(calls[0].body.p_fields).toMatchObject({ acceptance_criteria: ['signed PDF filed'] });
      // Leg two is an ordinary move: the record is contract work now.
      expect(calls[1].url).toContain('rpc/task_transition');
      expect(calls[1].url).not.toContain('_v2');
      expect(calls[1].body.p_new_status).toBe('in_progress');
      expect(calls[1].body.p_expected_version).toBe(4);
    });

    it('a waiver is written with the actor, the reason and the gaps', async () => {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      mockStore(legacyRow, calls);

      await callTransition({
        taskId: 'supa_7', to: 'doing', actor: 'scott',
        grandfather: { actor: 'scott', reason: 'backfilled 2024 row; original ask is lost' },
      });

      const waiver = calls[0].body.p_grandfather as Record<string, unknown>;
      expect(waiver.actor).toBe('scott');
      expect(waiver.reason).toMatch(/backfilled/);
      expect(waiver.waived).toEqual(['owner', 'acceptance_criteria']);
      expect(waiver.was_missing).toEqual(['owner', 'acceptance_criteria']);
    });

    it('refuses a waiver on a row created under the contract, and writes nothing', async () => {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      mockStore({ ...legacyRow, contract_version: 1, human_accountable_id: 'scott' }, calls);

      const out = await callTransition({
        taskId: 'supa_7', to: 'doing', actor: 'scott',
        grandfather: { actor: 'scott', reason: 'in a hurry' },
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.status).toBe(422);
      expect((out as unknown as { detail: string }).detail).toMatch(/created under the work contract/);
      expect(calls).toHaveLength(0);
    });

    it('a waiver with no reason is refused as a waiver, not as a missing field', async () => {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      mockStore(legacyRow, calls);
      const out = await callTransition({
        taskId: 'supa_7', to: 'doing', actor: 'scott', grandfather: { actor: 'scott', reason: '' },
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect((out as unknown as { violation: string }).violation).toBe('missing_grandfather_reason');
      expect(calls).toHaveLength(0);
    });

    it('says which migration is missing rather than half-writing the legacy path', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/rest/v1/tasks?id=eq.')) {
          return new Response(JSON.stringify([legacyRow]), { status: 200 });
        }
        return new Response('function does not exist', { status: 404 });
      }) as unknown as typeof fetch;

      const out = await callTransition({
        taskId: 'supa_7', to: 'doing', actor: 'scott',
        grandfather: { actor: 'scott', reason: 'legacy row' },
      });
      expect(out).toMatchObject({ ok: false, error: 'legacy_path_unavailable' });
      expect((out as unknown as { detail: string }).detail).toContain('005_legacy_grandfather.sql');
    });
  });
});
