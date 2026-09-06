/**
 * Worker process for tests/integration/concurrent-task-mutations.test.ts.
 *
 * Reads a single JSON-encoded action off argv[2] and performs exactly one
 * task-bus operation against the tmpdir BusPaths the action carries, then
 * exits. Spawned via `tsx` so it runs the real src/bus/task.ts code path
 * (lock file, version bump, journal write) under genuine OS-level process
 * concurrency — the only way to reproduce the read-modify-write race the
 * unlocked `addSymmetricEdge` / `archiveTasks` used to have. A same-process
 * sequential call can never hit that race: each call already reads a fresh
 * file before the fix existed too, so the loss only shows up when two
 * processes' reads and writes genuinely interleave.
 */
import { createTask, archiveTasks, updateTask } from '../../../src/bus/task';
import type { BusPaths, TaskStatus } from '../../../src/types/index';

type Action =
  | { kind: 'add-block'; paths: BusPaths; peerId: string; title: string }
  | { kind: 'archive'; paths: BusPaths }
  | { kind: 'update'; paths: BusPaths; id: string; status: TaskStatus };

const action = JSON.parse(process.argv[2]) as Action;

try {
  if (action.kind === 'add-block') {
    const id = createTask(action.paths, 'worker', 'acme', action.title, {
      blockedBy: [action.peerId],
    });
    process.stdout.write(JSON.stringify({ ok: true, id }));
  } else if (action.kind === 'archive') {
    const report = archiveTasks(action.paths);
    process.stdout.write(JSON.stringify({ ok: true, report }));
  } else {
    updateTask(action.paths, action.id, action.status);
    process.stdout.write(JSON.stringify({ ok: true }));
  }
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
}
