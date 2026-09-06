/**
 * Removing a task and everything that still points at it.
 *
 * A task is not one file. Creating one writes into six places under
 * `$CTX_ROOT`, and three of them tell an agent to go and do something:
 *
 *   1. `orgs/<org>/tasks/<id>.json`          — the record itself
 *   2. `orgs/<org>/tasks/audit/<id>.jsonl`   — best-effort audit log (task.ts)
 *   3. `orgs/<org>/task-events/<id>.jsonl`   — the append-only journal (task-store.ts)
 *   4. `orgs/<org>/tasks/.claims/<id>.claim` — the claim lock (claimTask)
 *   5. `orgs/<org>/tasks/archive/<id>.json`  — where archiveTasks moves it
 *   6. `inbox/<agent>/*.json` + `inflight/<agent>/*.json` — messages naming the id
 *
 * Deleting only (1) was the defect this module closes. The messages are the
 * dangerous half: an unacked "Task status updated to in_progress: [task_…]"
 * sitting in a live agent's inbox is an instruction to act on a task that no
 * longer exists, and a stale inflight message is recovered back INTO the inbox
 * five minutes later, so both halves have to go.
 *
 * What this module deliberately does NOT do:
 *
 *  - It is not a way to make work disappear. The work contract (plan §4) says
 *    an obligation is never silently cancelled and task history is append-only.
 *    So a delete is REFUSED for an obligation, and refused for any task that is
 *    not already in a terminal state; the caller is told to cancel it instead.
 *    `force` exists for genuine junk (fixtures, tests, a malformed record) and
 *    records who forced it and why.
 *  - It does not rewrite `orgs/<org>/analytics/events/…`. Those are dated,
 *    shared, append-only observability files that many tasks write into; a
 *    completion event is a historical fact, not an instruction, and surgically
 *    rewriting shared journals to erase an id is exactly the silent history
 *    edit the contract forbids.
 *  - It does not touch `processed/<agent>/` — an acked message has already been
 *    acted on and moved out of the actionable path.
 *
 * The tombstone (`orgs/<org>/deleted-tasks.jsonl`) is written BEFORE anything
 * is removed, and never into the file being deleted: a crash halfway through
 * still leaves a durable record of who deleted what, why, and whether the
 * refusal was forced.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, rmSync, appendFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import type { BusPaths } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';
import { validateTaskId } from '../utils/validate.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { withTaskLock, readMeta, eventDirForTaskFile } from './task-store.js';
import { loadContract, toCanonical } from './task-contract.js';

/** A delete the contract will not allow without `force`. */
export class TaskDeletionRefused extends Error {
  constructor(
    readonly taskId: string,
    readonly why: string,
    readonly instead: string,
  ) {
    super(`${why}\n${instead}`);
    this.name = 'TaskDeletionRefused';
  }
}

export interface DeleteTaskOptions {
  /** Who is deleting. Recorded in the tombstone; never a blank string. */
  actor: string;
  /** Why. Required — an unexplained deletion is indistinguishable from a bug. */
  reason: string;
  /** Override the obligation / non-terminal refusal. Recorded as forced. */
  force?: boolean;
  /**
   * Sweep the remnants even when the record itself is already gone.
   *
   * Needed by fixtures and by cleanup after `compactTasks`, which removes the
   * task JSON on purpose and deliberately keeps the audit log: without this the
   * remaining journal, claim and inbox pointers would be unreachable, because
   * the only handle on them is an id whose file no longer exists. Implies
   * `force` for the missing record — there is nothing left to judge.
   */
  missingOk?: boolean;
}

export interface DeletedMessage {
  /** Absolute path of the message file that was removed. */
  path: string;
  /** The agent whose inbox it sat in. */
  agent: string;
  /** inbox (unread) or inflight (read but never acked — recovered after 5 min). */
  queue: 'inbox' | 'inflight';
  /** The message's own id, so the tombstone can be reconciled against a log. */
  messageId: string | null;
}

export interface DeleteTaskReport {
  taskId: string;
  org: string | null;
  forced: boolean;
  canonicalState: string;
  workType: string;
  /** Every path removed, in removal order. */
  removed: string[];
  /** The actionable messages that were pointing at this task. */
  messages: DeletedMessage[];
  /** Where the tombstone was appended. */
  tombstone: string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The org that owns a task file, read off its path rather than off the
 *  caller's environment — a cross-org delete must journal under the org that
 *  actually holds the record. */
export function orgForTaskFile(taskFile: string): string | null {
  const m = taskFile.match(/[\\/]orgs[\\/]([^\\/]+)[\\/]tasks[\\/]/);
  return m ? m[1] : null;
}

/** Append-only deletion log for the org that owned the task. Deliberately NOT
 *  inside `tasks/`, so it survives anything that clears the task tree. */
export function deletionLogFor(paths: BusPaths, taskFile: string): string {
  const org = orgForTaskFile(taskFile);
  return org
    ? join(paths.ctxRoot, 'orgs', org, 'deleted-tasks.jsonl')
    : join(dirname(taskFile), '..', 'deleted-tasks.jsonl');
}

/** Resolve the record: the live file first, then the archived copy, then a
 *  cross-org scan. Returns null when nothing anywhere holds this id. */
function resolveTaskFile(paths: BusPaths, taskId: string): string | null {
  const candidates = [
    join(paths.taskDir, `${taskId}.json`),
    join(paths.taskDir, 'archive', `${taskId}.json`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;

  const orgsRoot = join(paths.ctxRoot, 'orgs');
  let entries: string[];
  try {
    entries = readdirSync(orgsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const org of entries) {
    for (const rel of [[`${taskId}.json`], ['archive', `${taskId}.json`]]) {
      const c = join(orgsRoot, org, 'tasks', ...rel);
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * Every message in an actionable queue whose content names this task id.
 *
 * Matched on the raw file text rather than on `text` alone: a message can carry
 * the id in `reply_to` or in a payload field, and a pointer is a pointer
 * wherever it sits. `inflight` counts as actionable because an unacked inflight
 * message is moved back into the inbox by `recoverStaleInflight` after five
 * minutes — dropping only the inbox half would let the ghost come back.
 */
export function findMessagesReferencing(paths: BusPaths, taskId: string): DeletedMessage[] {
  validateTaskId(taskId);
  const found: DeletedMessage[] = [];

  for (const queue of ['inbox', 'inflight'] as const) {
    const root = join(paths.ctxRoot, queue);
    let agents: string[];
    try {
      agents = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const agent of agents) {
      const dir = join(root, agent);
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(dir, file);
        let raw: string;
        try {
          raw = readFileSync(path, 'utf-8');
        } catch {
          continue;
        }
        if (!raw.includes(taskId)) continue;
        let messageId: string | null = null;
        try {
          messageId = (JSON.parse(raw) as { id?: string }).id ?? null;
        } catch {
          /* a corrupt message that still names the task is still a pointer */
        }
        found.push({ path, agent, queue, messageId });
      }
    }
  }
  return found;
}

/**
 * Delete a task and every actionable remnant of it.
 *
 * @throws TaskDeletionRefused when the contract says this task must be
 *         cancelled rather than deleted and `force` was not passed.
 * @throws Error when the task cannot be found.
 */
export function deleteTask(
  paths: BusPaths,
  taskId: string,
  opts: DeleteTaskOptions,
): DeleteTaskReport {
  validateTaskId(taskId);
  const actor = (opts.actor ?? '').trim();
  const reason = (opts.reason ?? '').trim();
  if (!actor) throw new Error('delete-task requires an actor: an unattributed deletion is a bug report with no author.');
  if (!reason) throw new Error('delete-task requires a reason: --reason "<why>".');

  const resolvedFile = resolveTaskFile(paths, taskId);
  if (!resolvedFile && !opts.missingOk) {
    throw new Error(`Task ${taskId} not found under ${paths.ctxRoot}.`);
  }
  // With `missingOk` and no record, the remnants are still addressed relative
  // to the caller's own task directory — that is the only org we know of.
  const taskFile = resolvedFile ?? join(paths.taskDir, `${taskId}.json`);
  const recordExists = resolvedFile !== null;

  let task: Record<string, unknown> = {};
  try {
    if (recordExists) task = JSON.parse(readFileSync(taskFile, 'utf-8')) as Record<string, unknown>;
  } catch {
    // An unreadable record is exactly the junk `--force` is for; it has no
    // contract fields to judge, so it can only be removed forcibly.
    if (!opts.force) {
      throw new TaskDeletionRefused(
        taskId,
        `Task ${taskId} is unreadable, so its contract state cannot be checked.`,
        `Re-run with --force if you have confirmed it is junk.`,
      );
    }
  }

  const meta = readMeta(task);
  const canonicalState = meta.canonical_state ?? toCanonical('cortexos_tasks', task.status as string);
  const workType = meta.work_type ?? 'work';
  const terminal = loadContract().terminal_states;

  if (!opts.force && recordExists) {
    if (workType === 'obligation') {
      throw new TaskDeletionRefused(
        taskId,
        `Task ${taskId} is an obligation. An obligation is never silently removed — it keeps its owner and its due date until somebody resolves or cancels it.`,
        `Cancel it instead: cortextos bus update-task ${taskId} cancelled --actor <person> (add --reason on the cancel), or re-run with --force if this record is genuinely junk.`,
      );
    }
    if (!terminal.includes(canonicalState)) {
      throw new TaskDeletionRefused(
        taskId,
        `Task ${taskId} is in '${canonicalState}', which is not a terminal state. Deleting live work makes an obligation vanish with no reason and no actor.`,
        `Cancel it instead: cortextos bus update-task ${taskId} cancelled --actor <person>, or re-run with --force if this record is genuinely junk.`,
      );
    }
  }

  const org = orgForTaskFile(taskFile);
  const taskDir = basename(dirname(taskFile)) === 'archive' ? dirname(dirname(taskFile)) : dirname(taskFile);

  const targets = [
    taskFile,
    join(taskDir, 'audit', `${taskId}.jsonl`),
    join(eventDirForTaskFile(paths, join(taskDir, `${taskId}.json`)), `${taskId}.jsonl`),
    join(taskDir, '.claims', `${taskId}.claim`),
    join(taskDir, 'archive', `${taskId}.json`),
    join(taskDir, `${taskId}.json`),
  ].filter((p, i, all) => all.indexOf(p) === i);

  // Per-task deliverables tree: `orgs/<org>/deliverables/<agent>/<task_id>/`.
  // Named by the task id and meaningless without it, so it goes with the task.
  const deliverableDirs: string[] = [];
  try {
    const delivRoot = org ? join(paths.ctxRoot, 'orgs', org, 'deliverables') : paths.deliverablesDir;
    for (const entry of readdirSync(delivRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const d = join(delivRoot, entry.name, taskId);
      if (existsSync(d)) deliverableDirs.push(d);
    }
  } catch { /* no deliverables tree */ }

  const messages = findMessagesReferencing(paths, taskId);

  // Nothing here at all: a `missingOk` sweep for a task that left no trace is a
  // no-op, and writing a tombstone for it would turn repeated fixture cleanup
  // into a log of deletions that never happened.
  const existingTargets = targets.filter((p) => existsSync(p));
  if (!recordExists && existingTargets.length === 0 && deliverableDirs.length === 0 && messages.length === 0) {
    return {
      taskId,
      org,
      forced: opts.force === true,
      canonicalState: 'absent',
      workType,
      removed: [],
      messages: [],
      tombstone: '',
    };
  }

  // Tombstone FIRST. If the process dies halfway through the removals, the
  // durable record of who did this and why is already on disk — and it is not
  // in any of the files about to be removed.
  const tombstone = deletionLogFor(paths, taskFile);
  ensureDir(dirname(tombstone));
  appendFileSync(
    tombstone,
    JSON.stringify({
      ts: nowIso(),
      event: 'task_deleted',
      task_id: taskId,
      org,
      actor,
      reason,
      forced: opts.force === true,
      record_existed: recordExists,
      canonical_state: recordExists ? canonicalState : 'absent',
      work_type: workType,
      title: (task.title as string) ?? null,
      version: meta.version,
      removed_paths: [...targets, ...deliverableDirs],
      removed_messages: messages.map((m) => ({ agent: m.agent, queue: m.queue, id: m.messageId, path: m.path })),
    }) + '\n',
    { encoding: 'utf-8', mode: 0o600 },
  );

  const removed: string[] = [];

  // The task file goes under the same lock every other mutation takes, so a
  // concurrent writer cannot be midway through a read-modify-write when the
  // record disappears underneath it.
  withTaskLock(join(taskDir, `${taskId}.json`), () => {
    for (const p of targets) {
      try {
        if (!existsSync(p)) continue;
        rmSync(p, { force: true });
        removed.push(p);
      } catch { /* a target we cannot remove is reported by its absence from `removed` */ }
    }
  });

  for (const d of deliverableDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
      removed.push(d);
    } catch { /* reported by absence */ }
  }

  // Messages, per agent, under that inbox's own mutex so a concurrent
  // checkInbox is not renaming the file we are unlinking. A contended lock is
  // not a reason to leave a ghost instruction in place: the sweep proceeds,
  // and the worst case is a rename that loses a race it would have lost anyway.
  const byAgent = new Map<string, DeletedMessage[]>();
  for (const m of messages) {
    const key = m.agent;
    byAgent.set(key, [...(byAgent.get(key) ?? []), m]);
  }
  const swept: DeletedMessage[] = [];
  for (const [agent, list] of byAgent) {
    const inboxDir = join(paths.ctxRoot, 'inbox', agent);
    const locked = acquireLock(inboxDir);
    try {
      for (const m of list) {
        try {
          if (!existsSync(m.path)) continue;
          unlinkSync(m.path);
          removed.push(m.path);
          swept.push(m);
        } catch { /* reported by absence */ }
      }
    } finally {
      if (locked) releaseLock(inboxDir);
    }
  }

  return {
    taskId,
    org,
    forced: opts.force === true,
    canonicalState,
    workType,
    removed,
    messages: swept,
    tombstone,
  };
}
