/**
 * Fix6 / D2 — optimistic concurrency reaches the native store.
 *
 * The dashboard read a version, sent it to the transition service, and the
 * service dropped it at the CLI boundary: `bus update-task` had no
 * --expected-version option, so update-task.sh silently discarded it and every
 * native task move from the dashboard was a blind write. The compare-and-set
 * in task-store.ts existed and was never reached from a UI.
 *
 * Reproduced against a real task file: with the flag missing, a move made from
 * a stale read landed. These tests hold the plumbing in place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transitionTask } from '../../../src/bus/task';
// Task fixtures go through tests/helpers/task-fixture.ts: it registers every id
// it creates and tears it down through the same deleteTask the CLI uses, so a
// fixture can never again leave an audit log, an event journal or an unacked
// inbox message pointing at a task that no longer exists.
import { createTask, cleanupTaskFixtures } from '../../helpers/task-fixture';
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

describe('native transitions and the version the caller read', () => {
  let testDir: string;
  let paths: BusPaths;
  let id: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-fix6-'));
    paths = makePaths(testDir);
    mkdirSync(paths.taskDir, { recursive: true });
    id = createTask(paths, 'alice', 'TestOrg', 'ZZTEST-fix6 version probe', {
      assignee: 'bob',
      priority: 'low',
    });
  });
  afterEach(() => { cleanupTaskFixtures(); rmSync(testDir, { recursive: true, force: true }); });

  const read = () => JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));

  it('refuses a move made against a version the record no longer has', () => {
    expect(read().version).toBe(1);
    expect(() =>
      transitionTask(paths, id, 'blocked', {
        actor: 'scott',
        canonicalState: 'waiting',
        expectedVersion: 99,
      }),
    ).toThrow(/version conflict/i);
    // Nothing was written. This is the whole point.
    expect(read().status).toBe('pending');
    expect(read().version).toBe(1);
  });

  it('applies a move made against the current version', () => {
    transitionTask(paths, id, 'blocked', {
      actor: 'scott',
      canonicalState: 'waiting',
      expectedVersion: 1,
    });
    expect(read().status).toBe('blocked');
    expect(read().canonical_state).toBe('waiting');
    expect(read().version).toBe(2);
  });

  it('refuses the SECOND move made from the same stale read', () => {
    transitionTask(paths, id, 'blocked', {
      actor: 'scott', canonicalState: 'waiting', expectedVersion: 1,
    });
    // A second person still holding version 1 must not overwrite the first.
    expect(() =>
      transitionTask(paths, id, 'pending', {
        actor: 'angelic', canonicalState: 'backlog', expectedVersion: 1,
      }),
    ).toThrow(/version conflict/i);
    expect(read().status).toBe('blocked');
  });
});
