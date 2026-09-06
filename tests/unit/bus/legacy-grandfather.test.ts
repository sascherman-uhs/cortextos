/**
 * fix5 — the legacy path through the work contract.
 *
 * The regression this covers: interactive enforcement was switched on while
 * 1,863 backfilled tasks carried none of the contract's required fields, so a
 * person could open the board, click Start on real work, and be told only that
 * "backlog -> doing is not in the contract".
 *
 * Every test below is one half of the fix — a legacy record can move, new work
 * still cannot cheat, and nothing bought entry to the working states also buys
 * a Done without proof.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transitionTask, completeTask, canonicalStateOf, findTaskFile } from '../../../src/bus/task';
// Task fixtures go through tests/helpers/task-fixture.ts: it registers every id
// it creates and tears it down through the same deleteTask the CLI uses, so a
// fixture can never again leave an audit log, an event journal or an unacked
// inbox message pointing at a task that no longer exists.
import { createTask, seedTaskFile, cleanupTaskFixtures } from '../../helpers/task-fixture';
import { readTaskEvents } from '../../../src/bus/task-store';
import {
  checkTransition,
  isContractNative,
  isLegacyItem,
  missingContractFields,
  resolveInteractivePath,
  loadContract,
} from '../../../src/bus/task-contract';
import type { BusPaths } from '../../../src/types';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox', 'paul'),
    inflight: join(dir, 'inflight', 'paul'),
    processed: join(dir, 'processed', 'paul'),
    logDir: join(dir, 'logs', 'paul'),
    stateDir: join(dir, 'state', 'paul'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
    deliverablesDir: join(dir, 'deliverables'),
  } as BusPaths;
}

/** A task file in exactly the shape that predates OS-02: no contract_version,
 *  no outcome, no acceptance criteria, no identities. This is what all 1,863
 *  backfilled rows look like to the contract. */
function writeLegacyTask(paths: BusPaths, id: string, status = 'pending') {
  mkdirSync(paths.taskDir, { recursive: true });
  seedTaskFile(paths, ({
      id, title: 'Renew the Colanthe contract', description: '', type: 'agent',
      needs_approval: false, status, assigned_to: 'bob', created_by: 'alice',
      org: 'TestOrg', priority: 'normal', project: '', kpi_key: null,
      created_at: '2025-11-14T00:00:00Z', updated_at: '2025-11-14T00:00:00Z',
      completed_at: null, due_date: null, archived: false,
    }),
  );
  return join(paths.taskDir, `${id}.json`);
}

const readTask = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));

describe('fix5 — legacy work has a documented way forward', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-fix5-'));
    paths = makePaths(testDir);
    process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'enforced';
  });
  afterEach(() => {
    cleanupTaskFixtures();
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS;
  });

  // -------------------------------------------------------------------------
  describe('legacy is identified structurally, never by date', () => {
    it('a record without the contract stamp and missing fields is legacy', () => {
      expect(isLegacyItem({ outcome: 'x' })).toBe(true);
      expect(missingContractFields({ outcome: 'x' })).toEqual(['owner', 'acceptance_criteria']);
    });

    it('a record created under the contract is never legacy, however incomplete', () => {
      const item = { outcome: 'x', contract_version: 1 };
      expect(isContractNative(item)).toBe(true);
      expect(isLegacyItem(item)).toBe(false);
    });

    it('a pre-contract record that happens to be complete is not legacy either', () => {
      // It does not need the legacy path: it passes the gate on the merits.
      expect(isLegacyItem({ outcome: 'x', agent_role_id: 'backend', acceptance_criteria: ['c'] }))
        .toBe(false);
    });

    it('createTask stamps the contract version on every new native task', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'New work');
      const task = readTask(findTaskFile(paths, id)!);
      expect(task.contract_version).toBe(loadContract().contract_version);
    });
  });

  // -------------------------------------------------------------------------
  describe('the gesture a person actually makes', () => {
    it('Start on a backlog card resolves to the legs the contract does allow', () => {
      expect(resolveInteractivePath('backlog', 'doing')).toEqual(['ready', 'doing']);
      expect(resolveInteractivePath('doing', 'verify')).toEqual(['verify']);
    });

    it('no chain invents an edge the state graph does not have', () => {
      expect(resolveInteractivePath('backlog', 'done')).toBeNull();
      expect(resolveInteractivePath('done', 'doing')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the refusal a person sees before either path is taken', () => {
    it('names the missing fields and says they can be supplied or waived', () => {
      const r = checkTransition('backlog', 'ready', { outcome: 'Renew it', agent_role_id: 'backend' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('missing_acceptance_criteria');
      expect(r.missing).toEqual(['acceptance_criteria']);
      expect(r.legacy).toBe(true);
      expect(r.waivable).toBe(true);
    });

    it('tells new work that its gaps are not waivable', () => {
      const r = checkTransition(
        'backlog', 'ready',
        { outcome: 'x', agent_role_id: 'backend', contract_version: 1 },
        {}, { grandfather: { actor: 'scott', reason: 'later' } },
      );
      expect(r.ok).toBe(false);
      expect(r.waivable).toBe(false);
      expect(r.detail).toMatch(/created under the work contract/);
    });
  });

  // -------------------------------------------------------------------------
  describe('path 1 — the person supplies what is missing', () => {
    it('the task moves, keeps the fields, and stops being legacy', () => {
      const id = 'task_1700000000_44444444';
      const file = writeLegacyTask(paths, id);

      transitionTask(paths, id, 'pending', {
        actor: 'scott',
        origin: 'interactive',
        canonicalState: 'ready',
        fields: {
          outcome: 'Contract renewed and countersigned',
          acceptanceCriteria: ['signed PDF in the deal folder', 'renewal date in the calendar'],
          humanAccountableId: 'scott',
        },
      });

      const task = readTask(file);
      expect(task.outcome).toBe('Contract renewed and countersigned');
      expect(task.acceptance_criteria).toHaveLength(2);
      expect(task.human_accountable_id).toBe('scott');
      expect(task.contract_version).toBe(loadContract().contract_version);
      expect(isLegacyItem(task)).toBe(false);

      // Second leg now passes on the merits, with no waiver anywhere.
      transitionTask(paths, id, 'in_progress', { actor: 'scott', origin: 'interactive' });
      expect(canonicalStateOf(paths, id)).toBe('doing');
    });

    it('records what was supplied, by whom, in the append-only journal', () => {
      const id = 'task_1700000000_55555555';
      writeLegacyTask(paths, id);
      transitionTask(paths, id, 'pending', {
        actor: 'scott', origin: 'interactive', canonicalState: 'ready',
        fields: { outcome: 'o', acceptanceCriteria: ['c'], humanAccountableId: 'scott' },
      });
      const events = readTaskEvents(paths, findTaskFile(paths, id)!, id);
      const upgrade = events.find((e) => e.event === 'legacy_upgraded');
      expect(upgrade).toBeDefined();
      expect(upgrade!.actor).toBe('scott');
      expect(upgrade!.payload!.supplied).toEqual(['outcome', 'acceptance_criteria', 'human_accountable_id']);
      // Not `outcome`: the native store reads a task's title as its outcome by
      // default, the same as it does at creation. Only genuinely absent fields
      // are reported, so a person is never asked to retype the title.
      expect(upgrade!.payload!.was_missing).toEqual(['owner', 'acceptance_criteria']);
      // The move and its authorisation share a version: neither can exist alone.
      expect(upgrade!.version).toBe(events.find((e) => e.event === 'status:ready')!.version);
    });
  });

  // -------------------------------------------------------------------------
  describe('path 2 — the person waives what is missing', () => {
    it('moves the task and marks it, with actor, reason and the gaps recorded', () => {
      const id = 'task_1700000000_66666666';
      const file = writeLegacyTask(paths, id);

      transitionTask(paths, id, 'pending', {
        actor: 'scott', origin: 'interactive', canonicalState: 'ready',
        grandfather: { actor: 'scott', reason: 'backfilled 2024 task; the original ask is lost' },
      });

      const task = readTask(file);
      expect(task.legacy_grandfathered).toBe(true);
      expect(task.legacy_grandfather.actor).toBe('scott');
      expect(task.legacy_grandfather.reason).toMatch(/backfilled/);
      expect(task.legacy_grandfather.waived).toEqual(['owner', 'acceptance_criteria']);
      expect(task.legacy_grandfather.was_missing).toEqual(['owner', 'acceptance_criteria']);

      const events = readTaskEvents(paths, file, id);
      expect(events.map((e) => e.event)).toContain('legacy_grandfathered');
    });

    it('a waiver without a reason is refused, not quietly accepted', () => {
      const id = 'task_1700000000_77777777';
      writeLegacyTask(paths, id);
      expect(() =>
        transitionTask(paths, id, 'pending', {
          actor: 'scott', origin: 'interactive', canonicalState: 'ready',
          grandfather: { actor: 'scott' },
        }),
      ).toThrow(/missing_grandfather_reason/);
    });

    it('a waiver cannot advance work created under the contract', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'New work, unfinished', {
        contract: { outcome: 'x', agentRoleId: 'backend' },
      });
      expect(() =>
        transitionTask(paths, id, 'pending', {
          actor: 'scott', origin: 'interactive', canonicalState: 'ready',
          grandfather: { actor: 'scott', reason: 'in a hurry' },
        }),
      ).toThrow(/missing_acceptance_criteria/);
      expect(canonicalStateOf(paths, id)).toBe('backlog');
    });

    it('a waiver cannot buy an illegal transition', () => {
      const id = 'task_1700000000_88888888';
      writeLegacyTask(paths, id);
      expect(() =>
        transitionTask(paths, id, 'completed', {
          actor: 'scott', origin: 'interactive',
          grandfather: { actor: 'scott', reason: 'just this once' },
        }),
      ).toThrow(/illegal_transition/);
    });
  });

  // -------------------------------------------------------------------------
  describe('§12 — grandfathering never reaches the proof gate', () => {
    it('a waived task still cannot be completed without an artifact', () => {
      const id = 'task_1700000000_99999999';
      writeLegacyTask(paths, id, 'in_progress');
      expect(() =>
        completeTask(paths, id, '', { actor: 'scott', origin: 'interactive', evidence: { verifier: 'scott' } }),
      ).toThrow(/missing_evidence/);
    });

    it('an empty acceptance list is not a passed acceptance list', () => {
      const r = checkTransition(
        'verify', 'done',
        { outcome: 'x', acceptance_criteria: [], author: 'agent-a' },
        { verifier: 'scott' },
      );
      expect(r).toMatchObject({ ok: false, error: 'missing_evidence' });
    });

    it('with an artifact and an independent verifier it completes normally', () => {
      const r = checkTransition(
        'verify', 'done',
        { outcome: 'x', acceptance_criteria: [], author: 'agent-a', impact_class: 'code' },
        { artifact: 'output/2026-09-05/renewal.pdf', verifier: 'scott' },
      );
      expect(r.ok).toBe(true);
    });
  });
});
