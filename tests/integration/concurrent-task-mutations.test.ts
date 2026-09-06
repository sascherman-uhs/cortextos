/**
 * 2026-09-06 CortexOS V4 safety review — addSymmetricEdge / archiveTasks bypass.
 *
 * src/bus/task.ts has ONE canonical versioned/locked/journaled write path
 * (`transitionTask` -> `mutateTask`, via `withTaskLock`). Before this fix,
 * `addSymmetricEdge` and `archiveTasks` wrote directly to task JSON files with
 * a bare `atomicWriteSync` — no lock, no version bump, no journal entry. Two
 * writers racing on the same peer task (two `createTask` calls both declaring
 * it as a blocker) could each read the file before either write landed; the
 * second write would silently clobber the first, dropping one of the two
 * symmetric edges with no trace anywhere. `archiveTasks` had the same
 * unlocked read/mutate/write, plus a rename executed AFTER the unlocked
 * write, widening the window for a concurrent `transitionTask` to race the
 * move.
 *
 * These tests reproduce the races with REAL separate processes (spawned via
 * tsx against the worker at ./_workers/task-race-worker.ts), because a
 * same-process sequential call can never exhibit a read-modify-write race —
 * every call already reads a fresh file at its own start; the loss only
 * shows up when two processes' reads and writes genuinely interleave. This
 * mirrors the existing precedent in
 * tests/integration/concurrent-cron-mutations.test.ts for the same class of
 * bug in bus/crons.ts.
 *
 * All paths are explicit tmpdir BusPaths passed straight into the worker —
 * this does NOT go through the CLI's env/homedir resolution, so it can never
 * touch the real ~/.cortextos production task store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { archiveTasks } from '../../src/bus/task';
import { readTaskEvents } from '../../src/bus/task-store';
// Task fixtures go through tests/helpers/task-fixture.ts (fix7): it registers
// every id it creates and tears it down through the same deleteTask the CLI
// uses, so a fixture can never leave an audit log, an event journal, or an
// unacked inbox message pointing at a task that no longer exists.
import { createTask, cleanupTaskFixtures } from '../helpers/task-fixture';
import type { BusPaths } from '../../src/types/index';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const WORKER = join(__dirname, '_workers', 'task-race-worker.ts');

async function runWorker(action: Record<string, unknown>): Promise<{ ok: boolean; [k: string]: unknown }> {
  try {
    const { stdout } = await execFileAsync(TSX_BIN, [WORKER, JSON.stringify(action)]);
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return { ok: false, error: String(err) };
  }
}

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox', 'worker'),
    inflight: join(dir, 'inflight', 'worker'),
    processed: join(dir, 'processed', 'worker'),
    logDir: join(dir, 'logs', 'worker'),
    stateDir: join(dir, 'state', 'worker'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
    deliverablesDir: join(dir, 'deliverables'),
  };
}

describe('concurrent addSymmetricEdge — real process race on the same peer', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-edge-race-'));
    paths = makePaths(testDir);
    mkdirSync(paths.taskDir, { recursive: true });
  });

  afterEach(() => { cleanupTaskFixtures(); rmSync(testDir, { recursive: true, force: true }); });

  it('N concurrent creators declaring the same peer as a blocker: every symmetric edge survives', async () => {
    const peerId = createTask(paths, 'seed', 'acme', 'ZZTEST-peer', { assignee: 'boris' });

    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runWorker({ kind: 'add-block', paths, peerId, title: `ZZTEST-blocker-${i}` }),
      ),
    );
    for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);
    const newIds = results.map((r) => r.id as string);
    expect(new Set(newIds).size).toBe(N); // all distinct task ids were created

    const peerOnDisk = JSON.parse(readFileSync(join(paths.taskDir, `${peerId}.json`), 'utf-8'));
    // Every one of the N concurrent writers' edges must be present — none lost.
    for (const id of newIds) {
      expect(peerOnDisk.blocks, `missing edge for ${id}`).toContain(id);
    }
    expect(peerOnDisk.blocks.length).toBe(N);
    // No duplicate edges either.
    expect(new Set(peerOnDisk.blocks).size).toBe(N);
    // Went through the real lock+version+journal path: version bumped once
    // per successful write (1 at creation + N edge writes).
    expect(peerOnDisk.version).toBe(1 + N);

    const events = readTaskEvents(paths, join(paths.taskDir, `${peerId}.json`), peerId);
    expect(events.filter((e) => e.event === 'edge_added').length).toBe(N);
  }, 30_000);
});

describe('archiveTasks — locking and version/journal discipline', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-archive-lock-'));
    paths = makePaths(testDir);
    mkdirSync(paths.taskDir, { recursive: true });
  });

  afterEach(() => { cleanupTaskFixtures(); rmSync(testDir, { recursive: true, force: true }); });

  function backdateCompleted(id: string, daysAgo: number): void {
    const p = join(paths.taskDir, `${id}.json`);
    const task = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    task.status = 'completed';
    task.completed_at = ts;
    task.updated_at = ts;
    writeFileSync(p, JSON.stringify(task));
  }

  it('archiving a task bumps its version and writes an "archived" journal entry under the same lock as the move', async () => {
    const id = createTask(paths, 'seed', 'acme', 'ZZTEST-old-done', { assignee: 'boris' });
    const before = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    backdateCompleted(id, 10);

    const report = archiveTasks(paths);
    expect(report.archived).toBe(1);

    const archivedPath = join(paths.taskDir, 'archive', `${id}.json`);
    expect(existsSync(archivedPath)).toBe(true);
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);

    const archived = JSON.parse(readFileSync(archivedPath, 'utf-8'));
    expect(archived.archived).toBe(true);
    expect(archived.version).toBe(before.version + 1);

    const events = readTaskEvents(paths, join(paths.taskDir, `${id}.json`), id);
    const archivedEvents = events.filter((e) => e.event === 'archived');
    expect(archivedEvents.length).toBe(1);
    expect(archivedEvents[0].version).toBe(archived.version);
    expect(archivedEvents[0].actor).toBe('archive-tasks');
  });

  it('two concurrent real-process archive-tasks runs never double-move or corrupt the file — exactly one wins, versions stay consistent', async () => {
    const id = createTask(paths, 'seed', 'acme', 'ZZTEST-race-archive', { assignee: 'boris' });
    const before = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    backdateCompleted(id, 10);

    const [a, b] = await Promise.all([
      runWorker({ kind: 'archive', paths }),
      runWorker({ kind: 'archive', paths }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // Exactly one archived count of 1 across both runs — the other must see
    // nothing left to archive (file already moved), never a double-archive.
    const archivedCounts = [a, b].map((r) => (r.report as { archived: number }).archived);
    expect(archivedCounts.reduce((x, y) => x + y, 0)).toBe(1);

    const archivedPath = join(paths.taskDir, 'archive', `${id}.json`);
    expect(existsSync(archivedPath)).toBe(true);
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);

    const archived = JSON.parse(readFileSync(archivedPath, 'utf-8'));
    expect(archived.archived).toBe(true);
    expect(archived.version).toBe(before.version + 1); // exactly one version bump, not two
    expect(readdirSync(join(paths.taskDir, 'archive'))).toEqual([`${id}.json`]);
  }, 30_000);

  it('a concurrent status transition racing an archive is serialized, not silently clobbered: it either lands before the move or fails loudly after it', async () => {
    const id = createTask(paths, 'seed', 'acme', 'ZZTEST-race-transition', { assignee: 'boris' });
    backdateCompleted(id, 10);

    const [archiveResult, updateResult] = await Promise.all([
      runWorker({ kind: 'archive', paths }),
      runWorker({ kind: 'update', paths, id, status: 'blocked' }),
    ]);

    expect(archiveResult.ok).toBe(true);

    const liveExists = existsSync(join(paths.taskDir, `${id}.json`));
    const archivedExists = existsSync(join(paths.taskDir, 'archive', `${id}.json`));
    // The task must end up in exactly one place, never both and never neither.
    expect(liveExists !== archivedExists).toBe(true);

    if (updateResult.ok) {
      // The transition won the race and landed BEFORE the archive moved the
      // file — archive then saw the updated task and moved it correctly.
      expect(archivedExists).toBe(true);
      const archived = JSON.parse(readFileSync(join(paths.taskDir, 'archive', `${id}.json`), 'utf-8'));
      expect(archived.status).toBe('blocked');
    } else {
      // The archive won and moved the file out from under the transition —
      // the transition must fail LOUDLY (a thrown/reported error), never
      // silently no-op or corrupt the moved file.
      expect(String(updateResult.error)).toBeTruthy();
      expect(archivedExists).toBe(true);
      const archived = JSON.parse(readFileSync(join(paths.taskDir, 'archive', `${id}.json`), 'utf-8'));
      expect(archived.status).toBe('completed');
      expect(archived.archived).toBe(true);
    }
  }, 30_000);
});
