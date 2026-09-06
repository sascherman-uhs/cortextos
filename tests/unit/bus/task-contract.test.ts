/**
 * OS-02 acceptance scenarios (plan §11) for the native task store and the
 * shared transition contract.
 *
 * These are not unit tests of convenience. Each `describe` block below is one
 * row of the plan's independent-testing matrix, and the assertion is the
 * "required observable result" that row states.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createTask,
  claimTask,
  claimTaskWithLease,
  completeTask,
  transitionTask,
  canonicalStateOf,
  findTaskFile,
} from '../../../src/bus/task';
import {
  readTaskEvents,
  reportRun,
  acquireLease,
  mutateTask,
  VersionConflictError,
  FencedError,
  LeaseHeldError,
} from '../../../src/bus/task-store';
import {
  checkTransition,
  guardTransition,
  effectiveMode,
  enforcementMode,
  toCanonical,
  toNative,
  loadContract,
  ContractViolation,
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

describe('OS-02 task contract', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-os02-'));
    paths = makePaths(testDir);
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.AGENTIC_OS_TASK_CONTRACT;
    delete process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS;
  });

  // -------------------------------------------------------------------------
  describe('the shared fixture drives both languages', () => {
    it('every recorded case in the fixture behaves as recorded', () => {
      const contract = loadContract() as unknown as { cases?: never };
      // The generated module strips `cases`; read them from the fixture itself
      // so this test exercises the same table the Python half asserts against.
      const fixture = JSON.parse(
        readFileSync(join(__dirname, '../../fixtures/task-transition-contract.json'), 'utf-8'),
      );
      expect(fixture.cases.length).toBeGreaterThan(15);
      for (const c of fixture.cases) {
        const r = checkTransition(c.from, c.to, c.item, c.evidence, c.context);
        expect({ name: c.name, ok: r.ok, error: r.error ?? null })
          .toEqual({ name: c.name, ok: c.ok, error: c.ok ? (r.error ?? null) : c.error });
        if (c.noop) expect(r.noop).toBe(true);
        if (c.grandfathered) {
          expect({ name: c.name, grandfathered: r.grandfathered, waived: r.waived })
            .toEqual({ name: c.name, grandfathered: true, waived: c.waived });
        }
      }
      expect(contract).toBeDefined();
    });

    it('maps native statuses both ways without inventing a happy state', () => {
      expect(toCanonical('cortexos_tasks', 'pending')).toBe('backlog');
      expect(toCanonical('cortexos_tasks', 'blocked')).toBe('waiting');
      // An unknown status must not become pending or done.
      expect(toCanonical('cortexos_tasks', 'wat')).toBe('waiting');
      expect(toNative('cortexos_tasks', 'done')).toBe('completed');
      expect(toNative('cortexos_tasks', 'verify')).toBe('in_progress');
    });
  });

  // -------------------------------------------------------------------------
  describe('§11 concurrent claim', () => {
    it('only one of two simultaneous claimers wins; the loser is told who holds it', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Concurrent claim');
      const first = claimTaskWithLease(paths, id, 'worker-a');
      expect(first.fenceToken).toBe(1);

      expect(() => claimTask(paths, id, 'worker-b')).toThrow(/already claimed by worker-a/);

      const task = JSON.parse(readFileSync(findTaskFile(paths, id)!, 'utf-8'));
      expect(task.lease_owner).toBe('worker-a');
      expect(task.assigned_to).toBe('worker-a');
    });

    it('the same worker re-claiming is idempotent, because workers retry', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Re-claim');
      claimTask(paths, id, 'worker-a');
      expect(() => claimTask(paths, id, 'worker-a')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('§11 old worker resumes after lease transfer', () => {
    it('fencing prevents the stale worker mutating after a reclaim', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Fenced');
      const file = findTaskFile(paths, id)!;

      const stale = acquireLease(paths, file, id, 'worker-a', 1);
      expect(stale.fenceToken).toBe(1);

      // The lease expires and worker-b legitimately takes over.
      const fresh = acquireLease(paths, file, id, 'worker-b', 900, () => Date.now() + 5_000);
      expect(fresh.fenceToken).toBe(2);

      // worker-a wakes up believing it still owns the task.
      expect(() => reportRun(paths, file, id, stale.fenceToken, 'succeeded', { actor: 'worker-a' }))
        .toThrow(FencedError);

      // worker-b's own report is accepted.
      expect(() => reportRun(paths, file, id, fresh.fenceToken, 'succeeded', {
        actor: 'worker-b', evidence: { artifact: 'out.txt' },
      })).not.toThrow();
    });

    it('a live lease held by someone else cannot be stolen', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Live lease');
      const file = findTaskFile(paths, id)!;
      acquireLease(paths, file, id, 'worker-a', 900);
      expect(() => acquireLease(paths, file, id, 'worker-b', 900)).toThrow(LeaseHeldError);
    });

    it('a reclaim carries the previous attempt checkpoint forward, so work resumes', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Resume');
      const file = findTaskFile(paths, id)!;
      const first = acquireLease(paths, file, id, 'worker-a', 1);
      reportRun(paths, file, id, first.fenceToken, 'started', {
        actor: 'worker-a', checkpoint: { step: 3, created_products: ['p1', 'p2'] },
      });

      const second = acquireLease(paths, file, id, 'worker-b', 900, () => Date.now() + 5_000);
      expect(second.checkpoint).toEqual({ step: 3, created_products: ['p1', 'p2'] });
    });
  });

  // -------------------------------------------------------------------------
  describe('§11 human edits a task while an agent acts', () => {
    it('a write against a stale version is a conflict, not an overwrite', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Contended');
      const file = findTaskFile(paths, id)!;

      // The agent reads version 1 and goes off to do something.
      const agentSawVersion = 1;

      // Meanwhile a human edits the task.
      mutateTask(paths, file, id, { actor: 'scott', event: 'edit' }, (t) => { t.title = 'Retitled by Scott'; });

      // The agent comes back and writes against what it read.
      expect(() =>
        transitionTask(paths, id, 'completed', { actor: 'agent', expectedVersion: agentSawVersion }),
      ).toThrow(VersionConflictError);

      const task = JSON.parse(readFileSync(file, 'utf-8'));
      expect(task.title).toBe('Retitled by Scott');
      expect(task.status).toBe('pending');
    });

    it('the conflict carries the current record so a UI can show and refresh', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Show me');
      const file = findTaskFile(paths, id)!;
      mutateTask(paths, file, id, { actor: 'scott', event: 'edit' }, (t) => { t.priority = 'urgent'; });
      try {
        transitionTask(paths, id, 'blocked', { actor: 'agent', expectedVersion: 1 });
        throw new Error('should have conflicted');
      } catch (err) {
        expect(err).toBeInstanceOf(VersionConflictError);
        const e = err as VersionConflictError;
        expect(e.currentVersion).toBe(2);
        expect(e.current.priority).toBe('urgent');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('§11 agent claims success without proof', () => {
    it('stays in verify and says why, instead of reading as done', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Prove it', {
        contract: {
          outcome: 'ship the thing',
          agentRoleId: 'backend',
          acceptanceCriteria: ['tests pass'],
          impactClass: 'code',
        },
      });
      const file = findTaskFile(paths, id)!;
      // Work has to be under way before it can be finished: backlog -> verify is
      // not a move the contract has, and markVerify now refuses it rather than
      // writing first and validating second.
      claimTask(paths, id, 'agent-a');

      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'enforced';
      expect(() => completeTask(paths, id, 'I did it, trust me')).toThrow(/remains in verify/);

      expect(canonicalStateOf(paths, id)).toBe('verify');
      const events = readTaskEvents(paths, file, id);
      const incomplete = events.find((e) => e.event === 'verify:incomplete');
      expect(incomplete).toBeDefined();
      expect(incomplete!.payload!.error).toBe('acceptance_checks_incomplete');
    });

    it('completes once the acceptance checks pass and an independent verifier signs off', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Prove it properly', {
        contract: {
          outcome: 'ship the thing',
          agentRoleId: 'backend',
          acceptanceCriteria: ['tests pass'],
          impactClass: 'code',
        },
      });
      claimTask(paths, id, 'agent-a');
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'enforced';
      completeTask(paths, id, 'done', {
        actor: 'agent-a',
        evidence: {
          artifact: 'pr/42',
          acceptance_results: [{ check: 'tests pass', passed: true }],
          verifier: 'agent-b',
        },
      });
      expect(canonicalStateOf(paths, id)).toBe('done');
    });

    it('the author cannot verify their own code change', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Self-verify', {
        contract: {
          outcome: 'ship', agentRoleId: 'backend',
          acceptanceCriteria: ['tests pass'], impactClass: 'code',
        },
      });
      claimTask(paths, id, 'alice');
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'enforced';
      expect(() =>
        completeTask(paths, id, 'done', {
          actor: 'alice',
          evidence: {
            artifact: 'pr/42',
            acceptance_results: [{ check: 'tests pass', passed: true }],
            verifier: 'alice',
          },
        }),
      ).toThrow(/verifier_is_author/);
      expect(canonicalStateOf(paths, id)).toBe('verify');
    });
  });

  // -------------------------------------------------------------------------
  describe('shadow vs enforced', () => {
    it('shadow logs the violation and lets the write through', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Shadow', {
        contract: { outcome: 'x', agentRoleId: 'backend', acceptanceCriteria: ['c'], impactClass: 'code' },
      });
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (m: string) => warnings.push(String(m));
      try {
        completeTask(paths, id, 'no proof at all');
      } finally {
        console.warn = original;
      }
      expect(canonicalStateOf(paths, id)).toBe('done');
      expect(warnings.join('\n')).toMatch(/task-contract:shadow/);
    });

    it('a flag typo fails open to shadow rather than blocking every writer', () => {
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'ENFORCE'; // not "enforced"
      expect(enforcementMode('cortexos_tasks')).toBe('shadow');
    });

    it('a background writer throws only when the source is enforced', () => {
      const item = { outcome: 'x' };
      const opts = { log: () => {}, origin: 'writer' as const };
      expect(() => guardTransition('cortexos_tasks', 'backlog', 'ready', item, {}, {}, opts))
        .not.toThrow();
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'enforced';
      expect(() => guardTransition('cortexos_tasks', 'backlog', 'ready', item, {}, {}, opts))
        .toThrow(ContractViolation);
    });

    it('an interactive caller is enforced even while the source is in shadow', () => {
      // The defect this closes: a human clicking Complete on the board produced
      // a [task-contract:shadow] log line and an HTTP 200. The shadow flag is a
      // migration window for background writers; it was never a licence for a
      // UI to write a transition the contract refuses.
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'shadow';
      const item = { outcome: 'x' };
      expect(enforcementMode('cortexos_tasks')).toBe('shadow');
      expect(effectiveMode('cortexos_tasks', 'writer')).toBe('shadow');
      expect(effectiveMode('cortexos_tasks', 'interactive')).toBe('enforced');
      expect(() =>
        guardTransition('cortexos_tasks', 'backlog', 'done', item, {}, {}, { log: () => {}, origin: 'interactive' }),
      ).toThrow(ContractViolation);
    });

    it('a caller that declares no origin fails closed to enforced', () => {
      // Nothing in-process may inherit the writer's window by omission. The bus
      // library passes 'writer' explicitly because it IS the writer surface;
      // any new caller that forgets gets the strict path.
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'shadow';
      expect(effectiveMode('cortexos_tasks')).toBe('enforced');
      expect(() =>
        guardTransition('cortexos_tasks', 'backlog', 'done', { outcome: 'x' }, {}, {}, { log: () => {} }),
      ).toThrow(ContractViolation);
    });

    it('a refusal names the legal moves, so the board can say what IS possible', () => {
      try {
        guardTransition('cortexos_tasks', 'backlog', 'done', { outcome: 'x' }, {}, {}, { log: () => {}, origin: 'interactive' });
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(ContractViolation);
        expect((err as ContractViolation).legalTransitions).toEqual([
          'ready', 'waiting', 'cancelled', 'failed_terminal',
        ]);
      }
    });

    it('a completion a human clicks is refused before anything is written', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'UI complete', {
        contract: { outcome: 'x', agentRoleId: 'backend', acceptanceCriteria: ['c'], impactClass: 'code' },
      });
      process.env.AGENTIC_OS_TASK_CONTRACT__CORTEXOS_TASKS = 'shadow';
      expect(() => completeTask(paths, id, 'clicked complete', { origin: 'interactive' }))
        .toThrow(ContractViolation);
      // Unchanged: the refused move left no half-applied write behind.
      expect(canonicalStateOf(paths, id)).toBe('backlog');
    });
  });

  // -------------------------------------------------------------------------
  describe('§11 duplicate dispatch and the event journal', () => {
    it('every accepted mutation produces exactly one journal entry at a new version', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Journal');
      const file = findTaskFile(paths, id)!;
      claimTask(paths, id, 'worker-a');
      transitionTask(paths, id, 'blocked', { actor: 'worker-a' });

      const events = readTaskEvents(paths, file, id);
      const versions = events.map((e) => e.version);
      expect(events[0].event).toBe('created');
      expect(new Set(versions).size).toBe(versions.length); // no two events at one version
      expect(versions).toEqual([...versions].sort((a, b) => a - b)); // monotonic
      expect(events.map((e) => e.event)).toContain('claim');
      expect(events.map((e) => e.event)).toContain('status:blocked');
    });

    it('a failed attempt stays attached to the task and never disappears', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Keep failures');
      const file = findTaskFile(paths, id)!;
      const grant = acquireLease(paths, file, id, 'worker-a');
      reportRun(paths, file, id, grant.fenceToken, 'failed', {
        actor: 'worker-a', evidence: { error: 'provider timeout' },
      });
      transitionTask(paths, id, 'blocked', { actor: 'worker-a' });

      const events = readTaskEvents(paths, file, id);
      expect(events.map((e) => e.event)).toContain('run:failed');
      expect(canonicalStateOf(paths, id)).toBe('waiting');
    });
  });

  // -------------------------------------------------------------------------
  describe('§3 obligations and terminal states', () => {
    it('an obligation can never be dead-lettered into failed_terminal', () => {
      const r = checkTransition('waiting', 'failed_terminal', { type: 'obligation', outcome: 'x' },
        { reason: 'gave up', disposition: 'dropped' });
      expect(r).toMatchObject({ ok: false, error: 'obligation_cannot_fail_terminal' });
    });

    it('cancellation is a distinct terminal state that needs a reason and an actor', () => {
      expect(checkTransition('doing', 'cancelled', { outcome: 'x' }, { reason: 'dupe' }))
        .toMatchObject({ ok: false, error: 'missing_actor' });
      expect(checkTransition('doing', 'cancelled', { outcome: 'x' }, { reason: 'dupe', actor: 'scott' }).ok)
        .toBe(true);
    });

    it('reaching a terminal state releases the lease', () => {
      const id = createTask(paths, 'alice', 'TestOrg', 'Release', {
        contract: { outcome: 'x', agentRoleId: 'backend', acceptanceCriteria: [] },
      });
      claimTask(paths, id, 'worker-a');
      completeTask(paths, id, 'done', { evidence: { artifact: 'a', verifier: 'v', acceptance_results: [] } });
      const task = JSON.parse(readFileSync(findTaskFile(paths, id)!, 'utf-8'));
      expect(task.lease_owner).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('legacy migration parity', () => {
    it('a task file written before the contract still reads and still transitions', () => {
      // Exactly the shape createTask produced before OS-02: no version, no
      // fence, no canonical_state, no identities.
      const legacy = {
        id: 'task_1700000000_11111111',
        title: 'Legacy task',
        description: '',
        type: 'agent',
        needs_approval: false,
        status: 'in_progress',
        assigned_to: 'bob',
        created_by: 'alice',
        org: 'TestOrg',
        priority: 'normal',
        project: '',
        kpi_key: null,
        created_at: '2025-11-14T00:00:00Z',
        updated_at: '2025-11-14T00:00:00Z',
        completed_at: null,
        due_date: null,
        archived: false,
      };
      const file = join(paths.taskDir, `${legacy.id}.json`);
      require('fs').mkdirSync(paths.taskDir, { recursive: true });
      writeFileSync(file, JSON.stringify(legacy));

      // Reads at the defaults readMeta supplies, not as an error.
      expect(canonicalStateOf(paths, legacy.id)).toBe('doing');

      transitionTask(paths, legacy.id, 'blocked', { actor: 'scott' });
      const after = JSON.parse(readFileSync(file, 'utf-8'));
      expect(after.version).toBe(2); // legacy read as 1, bumped once
      expect(after.status).toBe('blocked');
      expect(after.canonical_state).toBe('waiting');
      // Untouched legacy fields survive verbatim.
      expect(after.created_at).toBe('2025-11-14T00:00:00Z');
      expect(after.created_by).toBe('alice');
    });

    it('a legacy completion is not retroactively claimed as verified done', () => {
      const legacy = {
        id: 'task_1700000000_22222222',
        title: 'Legacy completed', description: '', type: 'agent', needs_approval: false,
        status: 'completed', assigned_to: 'bob', created_by: 'alice', org: 'TestOrg',
        priority: 'normal', project: '', kpi_key: null,
        created_at: '2025-11-14T00:00:00Z', updated_at: '2025-11-14T00:00:00Z',
        completed_at: '2025-11-14T01:00:00Z', due_date: null, archived: false,
      };
      require('fs').mkdirSync(paths.taskDir, { recursive: true });
      writeFileSync(join(paths.taskDir, `${legacy.id}.json`), JSON.stringify(legacy));
      const task = JSON.parse(readFileSync(join(paths.taskDir, `${legacy.id}.json`), 'utf-8'));
      // The board must be able to tell a historical completion from a verified
      // one, and the only honest answer for a legacy row is "no evidence".
      expect(task.evidence_recorded).toBeUndefined();
      expect(canonicalStateOf(paths, legacy.id)).toBe('done');
    });
  });
});
