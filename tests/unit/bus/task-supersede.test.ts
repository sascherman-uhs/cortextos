/**
 * fix8 — work that is over must not still be sitting in an inbox as an
 * instruction.
 *
 * fix7 covered the DELETED task: no record, so every message naming it is a
 * pointer into nothing. This suite covers the case that is actually happening
 * on the live fleet, and is worse: the task still exists, and it is finished or
 * cancelled. `cortextos bus update-task <id> cancelled` moved the record and
 * left the original assignment message UNACKED in the assignee's inbox, so the
 * next inbox check handed an agent an instruction to do work a person had
 * cancelled — and every check the agent could make agreed the task was real.
 *
 * The mechanism under test is SUPERSEDE, not delete. Plan §4 makes task history
 * append-only and forbids silently cancelling an obligation; a message is
 * somebody's statement, and unlinking it would be that same silent edit. So the
 * file is rewritten into a notice carrying the terminal state, the actor, the
 * reason and the verbatim original text, then moved to
 * `superseded/<agent>/` — out of every directory `checkInbox`,
 * `recoverStaleInflight` and `ackInbox` read, and into one a person can grep.
 *
 * What each test here pins down:
 *   1. cancelling supersedes the unacked assignment
 *   2. an inbox read does not surface it as actionable
 *   3. the record of it having been sent survives, verbatim
 *   4. inflight is covered too, so the five-minute recovery cannot resurrect it
 *   5. unrelated mail is untouched — this is targeted, not a purge
 *   6. done and failed_terminal are covered, non-terminal moves are not
 *   7. archive and compact leave no live pointer either
 *   8. a superseded file re-injected into an inbox is still not delivered
 *   9. the kill switch actually switches it off
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, cleanupTaskFixtures } from '../../helpers/task-fixture';
import { updateTask, completeTask, archiveTasks, compactTasks } from '../../../src/bus/task';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import { findMessagesReferencing } from '../../../src/bus/task-delete';
import { supersedeEnabled } from '../../../src/bus/inbox-supersede';
import { readTaskEvents } from '../../../src/bus/task-store';
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

/** Every superseded file for one agent, parsed. */
function supersededFor(ctxRoot: string, agent: string): Record<string, unknown>[] {
  const dir = join(ctxRoot, 'superseded', agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>);
}

describe('fix8 — a terminal transition supersedes the pointers to that work', () => {
  let ctxRoot: string;
  let paths: BusPaths;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-fix8-'));
    paths = makePaths(ctxRoot, 'alice');
    mkdirSync(paths.taskDir, { recursive: true });
    delete process.env.CTX_INBOX_SUPERSEDE;
  });
  afterEach(() => {
    cleanupTaskFixtures();
    delete process.env.CTX_INBOX_SUPERSEDE;
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('cancelling a task supersedes its unacked assignment, and an inbox read does not surface it', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-1 cancel', { assignee: 'bob' });
    const bobPaths = makePaths(ctxRoot, 'bob');
    const original = `Task assigned: [normal] ZZTEST-fix8-1 cancel (id: ${id})`;
    sendMessage(paths, 'alice', 'bob', 'normal', original);

    expect(findMessagesReferencing(paths, id).length).toBe(1);

    updateTask(paths, id, 'cancelled', { actor: 'scott', reason: 'the client pulled the listing' });

    // 1 + 2. Nothing actionable is left, and the agent's own read agrees.
    expect(findMessagesReferencing(paths, id).length).toBe(0);
    expect(checkInbox(bobPaths)).toEqual([]);
    expect(readdirSync(bobPaths.inflight).filter((f) => f.endsWith('.json'))).toEqual([]);

    // 3. The record of it having been sent survives — verbatim, and with the
    // terminal state, the actor and the reason attached.
    const kept = supersededFor(ctxRoot, 'bob');
    expect(kept.length).toBe(1);
    const sup = kept[0].superseded as Record<string, unknown>;
    expect(sup.task_id).toBe(id);
    expect(sup.cause).toBe('cancelled');
    expect(sup.actor).toBe('scott');
    expect(sup.reason).toBe('the client pulled the listing');
    expect(sup.original_text).toBe(original);

    // The text an agent would read is a notice, not an instruction, and does
    // not restate the request.
    expect(String(kept[0].text)).toMatch(/^SUPERSEDED — no action required\./);
    expect(String(kept[0].text)).toContain('cancelled by scott');
    expect(String(kept[0].text)).not.toContain('Task assigned');

    // And the sweep is on the task's own append-only journal, so it is visible
    // to a person reconstructing what happened.
    const swept = readTaskEvents(paths, join(paths.taskDir, `${id}.json`), id)
      .filter((e) => e.event === 'messages_superseded');
    expect(swept.length).toBe(1);
    expect(swept[0].payload?.count).toBe(1);
  });

  it('covers an unacked INFLIGHT message, which recovery would otherwise put back', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-2 inflight', { assignee: 'bob' });
    const bobPaths = makePaths(ctxRoot, 'bob');
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: ZZTEST-fix8-2 (id: ${id})`);

    // Bob reads it once and never acks: it now sits in inflight, and
    // recoverStaleInflight puts it back in the inbox after five minutes.
    expect(checkInbox(bobPaths).length).toBe(1);
    expect(readdirSync(bobPaths.inflight).filter((f) => f.endsWith('.json')).length).toBe(1);

    updateTask(paths, id, 'cancelled', { actor: 'scott', reason: 'no longer needed' });

    expect(readdirSync(bobPaths.inflight).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(findMessagesReferencing(paths, id).length).toBe(0);
    expect(supersededFor(ctxRoot, 'bob').length).toBe(1);
  });

  it('leaves unrelated mail, acked mail and other tasks alone', () => {
    const kept = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-3 survivor', { assignee: 'bob' });
    const doomed = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-3 cancelled', { assignee: 'bob' });
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${kept})`);
    sendMessage(paths, 'alice', 'bob', 'low', 'An unrelated message that must survive');
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${doomed})`);

    updateTask(paths, doomed, 'cancelled', { actor: 'scott' });

    const bobInbox = readdirSync(join(ctxRoot, 'inbox', 'bob')).filter((f) => f.endsWith('.json'));
    expect(bobInbox.length).toBe(2);
    const texts = bobInbox.map((f) =>
      JSON.parse(readFileSync(join(ctxRoot, 'inbox', 'bob', f), 'utf-8')).text as string,
    );
    expect(texts.some((t) => t.includes(kept))).toBe(true);
    expect(texts.some((t) => t.includes('unrelated message'))).toBe(true);
    expect(texts.some((t) => t.includes(doomed))).toBe(false);
  });

  it('covers done and failed_terminal, and leaves a non-terminal move alone', () => {
    const running = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-4 running', { assignee: 'bob' });
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${running})`);
    updateTask(paths, running, 'in_progress', { actor: 'bob' });
    // Still live work: the pointer is still a true instruction and must stay.
    expect(findMessagesReferencing(paths, running).length).toBe(1);

    const finished = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-4 finished', { assignee: 'bob' });
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${finished})`);
    completeTask(paths, finished, 'shipped');
    expect(findMessagesReferencing(paths, finished).length).toBe(0);
    expect((supersededFor(ctxRoot, 'bob').find(
      (m) => (m.superseded as Record<string, unknown>).task_id === finished,
    )!.superseded as Record<string, unknown>).cause).toBe('done');

    const abandoned = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-4 abandoned', { assignee: 'bob' });
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${abandoned})`);
    // failed_terminal's native word is 'blocked' — the native vocabulary is
    // coarser than the canonical one, which is why canonicalState exists.
    updateTask(paths, abandoned, 'blocked', {
      actor: 'scott',
      canonicalState: 'failed_terminal',
      reason: 'the vendor never delivered',
    });
    expect(findMessagesReferencing(paths, abandoned).length).toBe(0);
  });

  it('archiveTasks leaves no live pointer', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-5 archive', { assignee: 'bob' });
    completeTask(paths, id, 'shipped');

    // Backdate completion past the seven-day archive window, and send the
    // pointer AFTER the terminal sweep so only archiving can catch it.
    const file = join(paths.taskDir, `${id}.json`);
    const task = JSON.parse(readFileSync(file, 'utf-8'));
    task.completed_at = new Date(Date.now() - 30 * 86400_000).toISOString();
    writeFileSync(file, JSON.stringify(task));
    sendMessage(paths, 'dashboard', 'bob', 'normal', `Task status updated to completed: [${id}]`);
    expect(findMessagesReferencing(paths, id).length).toBe(1);

    const report = archiveTasks(paths);
    expect(report.archived).toBe(1);
    expect(findMessagesReferencing(paths, id).length).toBe(0);
    expect(supersededFor(ctxRoot, 'bob').some(
      (m) => (m.superseded as Record<string, unknown>).cause === 'archived',
    )).toBe(true);
  });

  it('compactTasks leaves no live pointer, and keeps the audit log it is meant to keep', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-6 compact', { assignee: 'bob' });
    completeTask(paths, id, 'shipped');

    const file = join(paths.taskDir, `${id}.json`);
    const task = JSON.parse(readFileSync(file, 'utf-8'));
    task.completed_at = new Date(Date.now() - 90 * 86400_000).toISOString();
    writeFileSync(file, JSON.stringify(task));
    sendMessage(paths, 'dashboard', 'bob', 'normal', `Task status updated to completed: [${id}]`);
    expect(findMessagesReferencing(paths, id).length).toBe(1);

    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived.map((a) => a.id)).toContain(id);
    expect(existsSync(file)).toBe(false);
    expect(findMessagesReferencing(paths, id).length).toBe(0);
    // Compaction preserves the audit log on purpose — superseding the pointers
    // must not have quietly turned it into a delete.
    expect(existsSync(join(paths.taskDir, 'audit', `${id}.jsonl`))).toBe(true);
  });

  it('will not deliver a superseded message that is put back into an inbox by hand', () => {
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-7 reinjected', { assignee: 'bob' });
    const bobPaths = makePaths(ctxRoot, 'bob');
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${id})`);
    updateTask(paths, id, 'cancelled', { actor: 'scott' });

    const supDir = join(ctxRoot, 'superseded', 'bob');
    const name = readdirSync(supDir).find((f) => f.endsWith('.json'))!;
    const restored = JSON.parse(readFileSync(join(supDir, name), 'utf-8'));
    // A restore from backup: the file goes back where it came from.
    writeFileSync(join(ctxRoot, 'inbox', 'bob', name), JSON.stringify(restored));

    expect(checkInbox(bobPaths)).toEqual([]);
    // It went straight back to superseded/, still carrying the ORIGINAL text
    // rather than the notice the first pass wrote over it.
    const kept = supersededFor(ctxRoot, 'bob');
    expect(kept.length).toBe(1);
    expect(String((kept[0].superseded as Record<string, unknown>).original_text)).toContain('Task assigned');
  });

  it('the kill switch turns it off, and the pointer stays exactly where it was', () => {
    expect(supersedeEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(supersedeEnabled({ CTX_INBOX_SUPERSEDE: '0' } as NodeJS.ProcessEnv)).toBe(false);

    process.env.CTX_INBOX_SUPERSEDE = '0';
    const id = createTask(paths, 'alice', ORG, 'ZZTEST-fix8-8 flag off', { assignee: 'bob' });
    sendMessage(paths, 'alice', 'bob', 'normal', `Task assigned: (id: ${id})`);
    updateTask(paths, id, 'cancelled', { actor: 'scott' });

    expect(findMessagesReferencing(paths, id).length).toBe(1);
    expect(existsSync(join(ctxRoot, 'superseded'))).toBe(false);
  });
});
