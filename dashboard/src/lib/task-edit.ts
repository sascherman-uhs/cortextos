/**
 * OS-02 field editing for CortexOS native tasks.
 *
 * Editing a task's title, description, assignee or priority is not a state
 * transition, but it is still a mutation of the owning store and must obey the
 * same rules: take the lock, re-read inside it, check the version the caller
 * decided on, bump it, and append to the event journal. A human edit landing
 * while an agent is acting on the task must be a visible conflict, not a
 * last-writer-wins race (plan §11: "Human edits task/approval while agent acts").
 *
 * The dashboard's PUT route previously did readFile → mutate → rename with
 * none of that, which is why it is the one writer in the inventory marked as
 * able to silently defeat the contract.
 */

import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 3_000;

export interface EditRequest {
  taskId: string;
  org: string;
  actor: string;
  expectedVersion?: number;
  fields: Record<string, unknown>;
}

export type EditResult =
  | { ok: true; version: number; title: string; previousAssignee?: string }
  | { ok: false; status: 409; error: 'version_conflict'; current: Record<string, unknown>; currentVersion: number }
  | { ok: false; status: 404 | 423 | 500; error: string; detail?: string };

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function taskFilePath(taskId: string, org: string): string {
  const ctxRoot = getCTXRoot();
  const dir = org ? path.join(ctxRoot, 'orgs', org, 'tasks') : path.join(ctxRoot, 'tasks');
  return path.join(dir, `${taskId}.json`);
}

/** Same lock discipline as the core bus: O_EXCL, with a stale-lock breaker so a
 *  crashed writer cannot wedge a task permanently. */
function withLock<T>(file: string, fn: () => T): T | { locked: true } {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\t${nowIso()}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
      break;
    } catch {
      let age = LOCK_STALE_MS + 1;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* treat as stale */ }
      if (age > LOCK_STALE_MS) {
        try { fs.unlinkSync(lockPath); } catch { /* someone else broke it */ }
        continue;
      }
      if (Date.now() > deadline) return { locked: true };
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}

export function editTaskFields(req: EditRequest): EditResult {
  const file = taskFilePath(req.taskId, req.org);
  if (!fs.existsSync(file)) return { ok: false, status: 404, error: 'task_not_found' };

  const outcome = withLock(file, (): EditResult => {
    let task: Record<string, unknown>;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      return { ok: false, status: 500, error: 'task_unreadable', detail: String(err) };
    }

    const currentVersion = typeof task.version === 'number' && task.version > 0 ? task.version : 1;
    if (req.expectedVersion !== undefined && req.expectedVersion !== currentVersion) {
      return { ok: false, status: 409, error: 'version_conflict', current: task, currentVersion };
    }

    const previousAssignee = task.assigned_to as string | undefined;
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.fields)) {
      if (v === undefined) continue;
      if (task[k] !== v) changed[k] = v;
      task[k] = v;
    }

    const nextVersion = currentVersion + 1;
    task.version = nextVersion;
    task.updated_at = nowIso();

    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);

    // Journal the edit into the same append-only log the bus writes, so a human
    // edit is part of the task's history rather than an unexplained change in
    // the record an agent was mid-way through acting on.
    try {
      const eventsDir = req.org
        ? path.join(getCTXRoot(), 'orgs', req.org, 'task-events')
        : path.join(getCTXRoot(), 'task-events');
      fs.mkdirSync(eventsDir, { recursive: true });
      fs.appendFileSync(
        path.join(eventsDir, `${req.taskId}.jsonl`),
        JSON.stringify({
          ts: nowIso(), version: nextVersion, event: 'edit', actor: req.actor, payload: { changed },
        }) + '\n',
        { encoding: 'utf-8', mode: 0o600 },
      );
    } catch { /* the edit is persisted; a journal failure must not undo it */ }

    return { ok: true, version: nextVersion, title: String(task.title ?? ''), previousAssignee };
  });

  if ('locked' in outcome) {
    return { ok: false, status: 423, error: 'task_locked', detail: 'another writer holds this task; retry shortly' };
  }
  return outcome;
}
