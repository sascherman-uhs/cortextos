/**
 * The only way a test should put a task on disk.
 *
 * A task is not one file (see `src/bus/task-delete.ts`): it also writes an
 * audit log, an event journal, a claim lock, possibly a deliverables tree, and
 * — the dangerous part — inbox messages in real agents' queues that name its
 * id. Every fixture helper in this effort cleaned up by unlinking the task JSON
 * and nothing else, which is how thirteen unacked "Task status updated to
 * in_progress: [task_…]" messages ended up sitting in live inboxes pointing at
 * tasks that no longer existed.
 *
 * So fixtures do not clean up by remembering. They create through `createTask`
 * here, which records the id, and tear down through `cleanupTaskFixtures`,
 * which routes every recorded id through the same `deleteTask` the CLI uses —
 * `force` because a fixture is junk by definition, `missingOk` because a test
 * is entitled to have already archived, compacted or removed the record itself.
 *
 * A test whose whole CTX root is a tempdir it rmSync's is already complete by
 * construction for the FILES, but not for the discipline: routing it here means
 * a fixture that later grows a real-root variant cannot regress, and it is the
 * single place to extend when a task learns to write somewhere new.
 */

import { createTask as busCreateTask } from '../../src/bus/task.js';
import { deleteTask } from '../../src/bus/task-delete.js';
import { atomicWriteSync, ensureDir } from '../../src/utils/atomic.js';
import { join } from 'path';
import type { BusPaths, Priority } from '../../src/types/index.js';

type CreateOptions = Parameters<typeof busCreateTask>[4];

const registry: { paths: BusPaths; taskId: string }[] = [];

/** Record an id created some other way (a raw JSON write, a CLI subprocess) so
 *  it is torn down with everything else. */
export function registerTaskFixture(paths: BusPaths, taskId: string): string {
  registry.push({ paths, taskId });
  return taskId;
}

/** `src/bus/task.ts`'s createTask, with the id registered for teardown. */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: CreateOptions = {},
): string {
  return registerTaskFixture(paths, busCreateTask(paths, agentName, org, title, options));
}

/** Write a raw task record — for the legacy/tampered shapes `createTask` will
 *  not produce — and register it for teardown. */
export function seedTaskFile(
  paths: BusPaths,
  task: Record<string, unknown> & { id: string },
  taskDir: string = paths.taskDir,
): string {
  ensureDir(taskDir);
  atomicWriteSync(join(taskDir, `${task.id}.json`), JSON.stringify(task));
  return registerTaskFixture({ ...paths, taskDir }, task.id);
}

/**
 * Remove every task a fixture created, and every remnant of it. Safe to call
 * from `afterEach` in a suite that created none.
 */
export function cleanupTaskFixtures(): void {
  while (registry.length) {
    const { paths, taskId } = registry.pop()!;
    try {
      deleteTask(paths, taskId, {
        actor: 'test-fixture',
        reason: 'ZZTEST fixture teardown',
        force: true,
        missingOk: true,
      });
    } catch {
      // A tempdir that has already been rmSync'd is the common case; there is
      // nothing left to sweep and nothing to report.
    }
  }
}

export type { Priority };
