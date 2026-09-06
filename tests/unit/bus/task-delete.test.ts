/**
 * fix7 — deleting a task must not leave an actionable trail.
 *
 * The defect: removing `orgs/<org>/tasks/<id>.json` left the audit log, the
 * event journal, the claim lock, the deliverables tree, and — the part that
 * actually hurt — unacked messages in live agents' inboxes saying "Task status
 * updated to in_progress: [task_…]" about a task that no longer existed. An
 * agent checking its inbox would act on a ghost.
 *
 * What "nothing actionable" means here, stated explicitly so the assertion is
 * honest about what it excludes:
 *
 *   ACTIONABLE (must be gone): the task record, its audit log, its event
 *   journal, its claim lock, its deliverables tree, and any inbox/ or inflight/
 *   message naming the id. Inflight counts because `recoverStaleInflight` moves
 *   an unacked inflight message back INTO the inbox after five minutes.
 *
 *   HISTORICAL (may retain the id, and does so on purpose):
 *     - `logs/<agent>/*` — agent stdout. Nothing reads it back as an instruction.
 *     - `processed/<agent>/*` — messages already acked; acting on them is done.
 *     - `orgs/<org>/analytics/events/…` — dated, shared, append-only
 *       observability files that many tasks write into. Rewriting them to erase
 *       an id would be a silent edit of history, which the contract forbids.
 *     - `orgs/<org>/deleted-tasks.jsonl` — the tombstone. It names the id by
 *       design: it is the durable record of who deleted it and why.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
// This file deliberately imports createTask straight from the bus rather than
// through tests/helpers/task-fixture.ts: it is the suite that PROVES the trail
// is swept, so it has to build the trail with the unwrapped call and tear it
// down through deleteTask explicitly. The guard test at the bottom keeps that
// exemption to this one file.
import { createTask, updateTask, completeTask } from '../../../src/bus/task';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import { saveOutput } from '../../../src/bus/save-output';
import { deleteTask, TaskDeletionRefused, findMessagesReferencing } from '../../../src/bus/task-delete';
import type { BusPaths } from '../../../src/types';

const ORG = 'uhs';

function makePaths(ctxRoot: string, agent: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(ctxRoot, 'orgs', ORG, 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', ORG, 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', ORG, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', ORG, 'deliverables'),
    heartbeatDir: join(ctxRoot, 'state'),
  } as BusPaths;
}

/** Every file under `root`, as paths relative to it. */
function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else out.push(relative(root, p));
    }
  }
  return out;
}

/** The grep the verifier would run: every path under CTX_ROOT whose name or
 *  contents mention the id, minus the explicitly historical stores. */
function actionableMentions(ctxRoot: string, taskId: string): string[] {
  const historical = [
    /^logs[\\/]/,
    /^processed[\\/]/,
    new RegExp(`^orgs[\\\\/][^\\\\/]+[\\\\/]analytics[\\\\/]`),
    new RegExp(`^orgs[\\\\/][^\\\\/]+[\\\\/]deleted-tasks\\.jsonl$`),
    // fix8 — `superseded/<agent>/` joins this list for the same reason
    // `processed/` is on it: nothing reads it back as an instruction. A message
    // lands there only after it has been rewritten into a notice and moved out
    // of every queue `checkInbox`, `recoverStaleInflight` and `ackInbox` scan.
    // It keeps the id on purpose — it is the record that the pointer was sent.
    /^superseded[\\/]/,
  ];
  return walk(ctxRoot).filter((rel) => {
    if (historical.some((re) => re.test(rel))) return false;
    if (rel.includes(taskId)) return true;
    try { return readFileSync(join(ctxRoot, rel), 'utf-8').includes(taskId); } catch { return false; }
  });
}

describe('fix7 — delete-task leaves no actionable remnant', () => {
  let ctxRoot: string;
  let paths: BusPaths;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-fix7-'));
    paths = makePaths(ctxRoot, 'alice');
    mkdirSync(paths.taskDir, { recursive: true });
  });
  afterEach(() => rmSync(ctxRoot, { recursive: true, force: true }));

  it('sweeps the record, the audit log, the journal, the deliverables and every unacked message', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix7-1 full trail', { assignee: 'bob' });

    // The trail a real task leaves. These are the exact shapes the dashboard
    // and the CLI produce today.
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: [normal] ZZTEST-fix7-1 (id: ${id})`);
    sendMessage(paths, 'dashboard', 'alice', 'normal', `Task status updated to in_progress: [${id}] ZZTEST-fix7-1`);
    sendMessage(paths, 'alice', 'bob', 'low', 'An unrelated message that must survive');

    updateTask(paths, id, 'in_progress');
    const src = join(ctxRoot, 'deliverable.txt');
    writeFileSync(src, 'evidence');
    saveOutput(paths, { sourcePath: src, taskId: id });
    expect(findMessagesReferencing(paths, id).length).toBe(2);

    completeTask(paths, id, 'done');

    // fix8 changed WHEN these pointers exist, not whether delete sweeps them:
    // reaching a terminal state supersedes the two that were already sitting
    // in inboxes. Pointers sent AFTER the work ended — the dashboard's own
    // completion notice is exactly this shape — are still there for the delete
    // to sweep, which is what the rest of this test is about.
    expect(findMessagesReferencing(paths, id).length).toBe(0);
    sendMessage(paths, 'dashboard', 'bob', 'normal', `Task status updated to completed: [${id}] ZZTEST-fix7-1`);
    sendMessage(paths, 'dashboard', 'alice', 'normal', `Human task completed by user: [${id}] ZZTEST-fix7-1`);

    // Pre-condition: the trail really is spread across the stores.
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
    expect(existsSync(join(paths.taskDir, 'audit', `${id}.jsonl`))).toBe(true);
    expect(existsSync(join(ctxRoot, 'orgs', ORG, 'task-events', `${id}.jsonl`))).toBe(true);
    expect(existsSync(join(paths.deliverablesDir, 'bob', id))).toBe(true);
    expect(findMessagesReferencing(paths, id).length).toBe(2);

    const report = deleteTask(paths, id, { actor: 'scott', reason: 'ZZTEST-fix7-1 cleanup' });

    expect(report.messages.length).toBe(2);
    expect(report.messages.map((m) => m.queue).sort()).toEqual(['inbox', 'inbox']);

    // The grep. Nothing actionable anywhere under CTX_ROOT.
    expect(actionableMentions(ctxRoot, id)).toEqual([]);

    // The unrelated message is untouched — the sweep is targeted, not a purge.
    const bobInbox = readdirSync(join(ctxRoot, 'inbox', 'bob'));
    expect(bobInbox.length).toBe(1);
    expect(readFileSync(join(ctxRoot, 'inbox', 'bob', bobInbox[0]), 'utf-8'))
      .toContain('An unrelated message that must survive');

    // The tombstone is durable, outside the deleted tree, and names the actor.
    const tomb = JSON.parse(readFileSync(report.tombstone, 'utf-8').trim());
    expect(tomb.task_id).toBe(id);
    expect(tomb.actor).toBe('scott');
    expect(tomb.reason).toBe('ZZTEST-fix7-1 cleanup');
    expect(tomb.forced).toBe(false);
  });

  it('sweeps an unacked INFLIGHT message too — it is recovered into the inbox after five minutes', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix7-2 inflight', { assignee: 'bob' });
    const bobPaths = makePaths(ctxRoot, 'bob');
    completeTask(paths, id, 'done');

    // The notice the dashboard sends AFTER the transition, which fix8's
    // terminal-state sweep has already run past.
    sendMessage(paths, 'dashboard', 'bob', 'normal', `Task status updated to completed: [${id}]`);

    // Bob reads his inbox: the message moves to inflight and is never acked.
    expect(checkInbox(bobPaths).length).toBe(1);
    expect(readdirSync(bobPaths.inflight).filter((f: string) => f.endsWith('.json')).length).toBe(1);

    const report = deleteTask(paths, id, { actor: 'scott', reason: 'ZZTEST-fix7-2 cleanup' });

    expect(report.messages.map((m) => m.queue)).toEqual(['inflight']);
    expect(actionableMentions(ctxRoot, id)).toEqual([]);
  });

  it('refuses to delete live work and names the command that is correct instead', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix7-3 live work', { assignee: 'bob' });
    updateTask(paths, id, 'in_progress');

    expect(() => deleteTask(paths, id, { actor: 'scott', reason: 'tidying' }))
      .toThrow(TaskDeletionRefused);
    try {
      deleteTask(paths, id, { actor: 'scott', reason: 'tidying' });
    } catch (err) {
      expect((err as Error).message).toMatch(/not a terminal state/);
      expect((err as Error).message).toMatch(/cortextos bus update-task .* cancelled/);
    }
    // Refused means untouched.
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);

    deleteTask(paths, id, { actor: 'scott', reason: 'ZZTEST-fix7-3 junk', force: true });
    expect(actionableMentions(ctxRoot, id)).toEqual([]);
  });

  it('refuses to delete an obligation even when it is terminal, unless forced', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix7-4 obligation', {
      assignee: 'bob',
      contract: { workType: 'obligation' },
    });
    completeTask(paths, id, 'done');

    expect(() => deleteTask(paths, id, { actor: 'scott', reason: 'tidying' }))
      .toThrow(/is an obligation/);

    const report = deleteTask(paths, id, { actor: 'scott', reason: 'ZZTEST-fix7-4 junk', force: true });
    expect(report.forced).toBe(true);
    const tomb = JSON.parse(readFileSync(report.tombstone, 'utf-8').trim().split('\n').pop()!);
    expect(tomb.forced).toBe(true);
    expect(tomb.actor).toBe('scott');
    expect(tomb.work_type).toBe('obligation');
    expect(actionableMentions(ctxRoot, id)).toEqual([]);
  });

  it('will not delete without an actor or a reason', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix7-5 unattributed');
    completeTask(paths, id, 'done');
    expect(() => deleteTask(paths, id, { actor: '', reason: 'x' })).toThrow(/requires an actor/);
    expect(() => deleteTask(paths, id, { actor: 'scott', reason: '  ' })).toThrow(/requires a reason/);
    deleteTask(paths, id, { actor: 'scott', reason: 'ZZTEST-fix7-5 cleanup' });
  });

  it('missingOk sweeps the remnants of a record that is already gone (compactTasks keeps the audit log)', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix7-6 remnants', { assignee: 'bob' });
    sendMessage(paths, 'dashboard', 'alice', 'normal', `Task status updated to blocked: [${id}]`);
    completeTask(paths, id, 'done');
    // Simulate compaction: the record goes, the audit log stays by design.
    rmSync(join(paths.taskDir, `${id}.json`));

    expect(() => deleteTask(paths, id, { actor: 'scott', reason: 'x' })).toThrow(/not found/);
    const report = deleteTask(paths, id, { actor: 'scott', reason: 'ZZTEST-fix7-6 cleanup', missingOk: true });
    expect(report.removed.length).toBeGreaterThan(0);
    expect(actionableMentions(ctxRoot, id)).toEqual([]);
  });
});

/**
 * The construction guarantee, enforced rather than documented.
 *
 * Cleanup that depends on remembering is how the ghost messages happened. A new
 * test that reaches past the fixture helper for `createTask` gets one more
 * chance to forget, so the import itself is what fails.
 */
describe('fix7 — task fixtures cannot go around the helper', () => {
  it('no test file imports createTask straight from src/bus/task', () => {
    const testsRoot = join(__dirname, '..', '..');
    const offenders = walk(testsRoot)
      .filter((rel) => /\.(test|spec)\.tsx?$/.test(rel))
      .filter((rel) => rel !== join('unit', 'bus', 'task-delete.test.ts'))
      .filter((rel) => {
        const src = readFileSync(join(testsRoot, rel), 'utf-8');
        return /createTask[^\n]*(from|require\()[^\n]*bus\/task['"]/.test(src)
          || /\{[^}]*\bcreateTask\b[^}]*\}\s*=\s*require\(['"][^'"]*bus\/task['"]\)/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
