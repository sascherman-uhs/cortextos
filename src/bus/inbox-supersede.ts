/**
 * Superseding the inbox pointers that outlive the work they point at.
 *
 * fix7 closed the case where a task is DELETED: its record is gone, so every
 * message naming it is a pointer into nothing and gets swept. This module
 * closes the harder and more common case — the task is still there, and it is
 * over.
 *
 * The live defect: `cortextos bus update-task <id> cancelled` moved the record
 * to `cancelled` and left the original assignment message sitting UNACKED in
 * the assignee's inbox. Nothing in the codebase removed or amended it; the only
 * mover was `ackInbox`, which the RECEIVING agent drives. So the next time that
 * agent checked its inbox it read "Task assigned: [high] <title> (id: task_…)"
 * and started on work a person had cancelled. That is worse than a pointer to a
 * deleted task, because the record still exists: every check the agent might
 * make agrees the task is real.
 *
 * Why supersede rather than delete
 * --------------------------------
 * Plan §4 says task history is append-only and an obligation may never be
 * silently cancelled. A message is somebody's statement — an agent's, or a
 * person's — and quietly unlinking it would be the same silent edit under a
 * different name. So the file is not destroyed. It is REWRITTEN into a notice
 * and MOVED to `$CTX_ROOT/superseded/<agent>/`, keeping its original filename,
 * its full original text and its original signature under a `superseded` block
 * that names the terminal state, the actor and the reason.
 *
 * The move is what makes it non-actionable, and it is deliberately the whole
 * mechanism rather than a filter bolted onto a read:
 *
 *   - `checkInbox` reads `inbox/<agent>` only, so a superseded message is never
 *     returned as work.
 *   - `recoverStaleInflight` reads `inflight/<agent>` only, so it cannot drag
 *     one back into the inbox five minutes later.
 *   - `ackInbox` scans `inflight/<agent>` only, so nothing changes for the
 *     messages an agent is legitimately holding.
 *   - `superseded/` is a sibling of `processed/`: greppable, readable, and it
 *     keeps the message's own filename, so a human can see exactly what was
 *     sent, to whom, and what happened to it.
 *
 * `checkInbox` ALSO refuses to deliver a message carrying the `superseded`
 * marker, and moves it here. That is belt and braces for the case where a file
 * is copied back into an inbox by hand or by a restore.
 *
 * What this deliberately does NOT touch: `processed/` (already acted on),
 * `logs/` (agent stdout — nothing reads it as an instruction), the analytics
 * journals, and the task's own event journal. Those are history.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import type { BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { validateTaskId } from '../utils/validate.js';
import { findMessagesReferencing, type DeletedMessage } from './task-delete.js';

/**
 * The kill switch.
 *
 * ON by default. The argument for that, stated where the code lives rather than
 * only in a report: an agent holding an instruction to do cancelled work is
 * itself a live hazard, and the conservative-looking default — leave it off —
 * is the option that keeps the hazard running. The operation is additive and
 * reversible: no message content is destroyed, the file keeps its name, and
 * putting one back is a `mv`. It fires only for a task id that has just reached
 * a terminal state in this same process, so it can never wander into unrelated
 * mail.
 *
 * Set `CTX_INBOX_SUPERSEDE=0` (or `false`/`off`/`no`) to turn it off without a
 * redeploy. Read at call time, never cached, so flipping it takes effect on the
 * next transition.
 */
export function supersedeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CTX_INBOX_SUPERSEDE ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** Why a pointer stopped being live. Terminal canonical states, plus the two
 *  bulk operations that move or unlink a record without transitioning it. */
export type SupersedeCause =
  | 'done'
  | 'cancelled'
  | 'failed_terminal'
  | 'archived'
  | 'compacted'
  | 'deleted';

export interface SupersedeRequest {
  taskId: string;
  cause: SupersedeCause;
  /** Who or what ended the work. Never blank — an unattributed supersede is
   *  indistinguishable from a bug. */
  actor: string;
  reason?: string | null;
  /** The task's title, so the notice reads as a sentence about real work. */
  title?: string | null;
}

export interface SupersededMessage extends DeletedMessage {
  /** Where the message now lives. */
  movedTo: string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Past-tense words for the notice, so it reads as English rather than an enum. */
const CAUSE_WORDS: Record<SupersedeCause, string> = {
  done: 'completed',
  cancelled: 'cancelled',
  failed_terminal: 'abandoned',
  archived: 'archived',
  compacted: 'compacted out of the active task list',
  deleted: 'deleted',
};

/**
 * The text an agent sees if it ever looks at the superseded file.
 *
 * Contains no instruction and no restatement of the original request: the
 * original text is preserved verbatim in `superseded.original_text`, where a
 * person can read it and a prompt is not going to trip over it.
 */
export function supersedeNotice(req: SupersedeRequest, at: string): string {
  const what = req.title ? `"${req.title}" (${req.taskId})` : req.taskId;
  const why = req.reason ? ` Reason: ${req.reason}` : '';
  return (
    `SUPERSEDED — no action required. This message asked for work on task ${what}, `
    + `which was ${CAUSE_WORDS[req.cause]} by ${req.actor} on ${at}.${why} `
    + `The original text is kept in this file under "superseded.original_text".`
  );
}

/** Where superseded mail for one agent lives. */
export function supersededDirFor(paths: BusPaths, agent: string): string {
  return join(paths.ctxRoot, 'superseded', agent);
}

/**
 * Rewrite one message file into a superseded notice at `destDir`, and remove
 * the original. Exported for the `checkInbox` guard, which has a message file
 * but no task context.
 *
 * A message whose JSON will not parse is still a pointer, so it is moved
 * unchanged rather than left in the queue: there is nothing to rewrite, and
 * leaving it behind is the failure mode this module exists to remove.
 */
export function supersedeMessageFile(
  path: string,
  destDir: string,
  block: Record<string, unknown>,
  notice: string,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const dest = join(destDir, basename(path));
  ensureDir(destDir);

  let payload: string;
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    const superseded = {
      ...block,
      at: block.at ?? nowIso(),
      // A second pass (a restored file that already carries the marker) must
      // not overwrite the true original with the notice the first pass wrote.
      original_text: block.original_text ?? msg.text ?? null,
      // The HMAC covers the ORIGINAL text, so it cannot stay at the top level
      // once the text is a notice: a signature that does not verify the body it
      // sits on is a lie about provenance. Kept here so the original is still
      // verifiable, and dropped from the message so nothing can re-admit this
      // file as a signed instruction.
      ...(block.original_sig === undefined && msg.sig !== undefined
        ? { original_sig: msg.sig }
        : {}),
    };
    delete msg.sig;
    payload = JSON.stringify({ ...msg, text: notice, superseded });
  } catch {
    payload = raw;
  }

  atomicWriteSync(dest, payload);
  try {
    unlinkSync(path);
  } catch {
    // The rewrite landed; a source we cannot unlink is reported by the caller
    // finding it again on the next sweep, which is idempotent.
  }
  return dest;
}

/**
 * Supersede every actionable message pointing at a task whose work is over.
 *
 * Idempotent: a second call finds nothing, because the first moved the files
 * out of the queues it searches. Returns what it moved, so the caller can
 * journal it — a sweep nobody can see is how the original defect stayed
 * invisible for so long.
 */
export function supersedeMessagesForTask(
  paths: BusPaths,
  req: SupersedeRequest,
): SupersededMessage[] {
  validateTaskId(req.taskId);
  if (!supersedeEnabled()) return [];

  const actor = (req.actor ?? '').trim() || 'unknown';
  const at = nowIso();
  const notice = supersedeNotice({ ...req, actor }, at);
  const block: Record<string, unknown> = {
    task_id: req.taskId,
    cause: req.cause,
    actor,
    reason: req.reason ?? null,
    title: req.title ?? null,
    at,
  };

  const pointers = findMessagesReferencing(paths, req.taskId);
  if (pointers.length === 0) return [];

  // Grouped by agent so each inbox's own mutex is taken once. A contended lock
  // is not a reason to leave a live instruction in place: the sweep proceeds,
  // and the worst case is losing a rename race it would have lost anyway.
  const byAgent = new Map<string, DeletedMessage[]>();
  for (const p of pointers) byAgent.set(p.agent, [...(byAgent.get(p.agent) ?? []), p]);

  const moved: SupersededMessage[] = [];
  for (const [agent, list] of byAgent) {
    const inboxDir = join(paths.ctxRoot, 'inbox', agent);
    const locked = acquireLock(inboxDir);
    try {
      const destDir = supersededDirFor(paths, agent);
      for (const m of list) {
        if (!existsSync(m.path)) continue;
        const dest = supersedeMessageFile(m.path, destDir, block, notice);
        if (dest) moved.push({ ...m, movedTo: dest });
      }
    } finally {
      if (locked) releaseLock(inboxDir);
    }
  }
  return moved;
}
