/**
 * OS-02 native task store — versioning, leases, fencing and the event journal.
 *
 * `src/bus/task.ts` owns the task JSON's shape and its dependency graph. This
 * module owns the accountability layer bolted onto it, kept separate so the
 * existing file can keep its signatures and every current caller keeps working:
 *
 *  - **Version.** Every accepted mutation bumps `version` by exactly one, under
 *    a lock. A writer that read version N and tries to write at N after someone
 *    else got there gets a conflict, not a silent overwrite.
 *  - **Lease + fence.** `acquireLease` hands out an expiring lease and a
 *    monotonic fence token. A worker that lost its lease is refused at every
 *    later mutation, however convinced it is of its own progress. The existing
 *    O_EXCL claim file had no expiry and no fence: a dead worker's claim was
 *    permanent, and a revived one could still write.
 *  - **Event journal.** Append-only JSONL under `CTX_ROOT/orgs/<org>/task-events/`.
 *    Separate from the older `tasks/audit/` log, which is explicitly best-effort
 *    observability. This one is the history: a failed attempt stays attached to
 *    its parent task and never disappears (plan §3).
 *
 * Locking is a POSIX `O_EXCL` lock file with a stale-lock breaker. It is not a
 * distributed lock and does not claim to be — it serialises the writers on one
 * host, which is exactly the failure this package saw.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import type { BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { validateTaskId } from '../utils/validate.js';
import { toCanonical, type CanonicalState } from './task-contract.js';

/** A lock older than this is presumed abandoned by a crashed process. */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 25;

/** Additive accountability fields. All optional: an untouched legacy task file
 *  stays valid, and `readMeta` supplies the defaults. */
export interface TaskContractMeta {
  version: number;
  fence_token: number;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  canonical_state?: CanonicalState;
  human_accountable_id?: string | null;
  agent_role_id?: string | null;
  outcome?: string | null;
  acceptance_criteria?: unknown[];
  dependency_ids?: string[];
  authorization_scope?: string | null;
  attempt_limit?: number | null;
  next_action_at?: string | null;
  not_before?: string | null;
  source_ref?: string | null;
  evidence_recorded?: boolean;
  impact_class?: string | null;
  work_type?: string | null;
  author?: string | null;
}

export interface TaskEvent {
  ts: string;
  /** The version this event PRODUCED. Replaying events by version rebuilds the task. */
  version: number;
  event: string;
  actor: string;
  payload?: Record<string, unknown>;
}

export class VersionConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly current: Record<string, unknown>,
  ) {
    super(`Task ${taskId} version conflict: expected ${expectedVersion}, current ${currentVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class FencedError extends Error {
  constructor(readonly taskId: string, readonly heldToken: number, readonly currentToken: number) {
    super(`Task ${taskId} fenced: holder token ${heldToken} is behind current ${currentToken}`);
    this.name = 'FencedError';
  }
}

export class LeaseHeldError extends Error {
  constructor(readonly taskId: string, readonly owner: string, readonly until: string) {
    super(`Task ${taskId} is leased to ${owner} until ${until}`);
    this.name = 'LeaseHeldError';
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Journal directory for the org that actually owns this task file. Derived
 *  from the file path so a cross-org mutation journals under the right org
 *  rather than the caller's. */
export function eventDirForTaskFile(paths: BusPaths, taskFile: string): string {
  const m = taskFile.match(/[\\/]orgs[\\/]([^\\/]+)[\\/]tasks[\\/]/);
  return m ? join(paths.ctxRoot, 'orgs', m[1], 'task-events') : join(dirname(taskFile), '..', 'task-events');
}

/**
 * Run `fn` while holding an exclusive lock on one task file.
 *
 * A lock left behind by a crashed process would otherwise wedge that task
 * forever, so a lock older than LOCK_STALE_MS is broken. That is a deliberate
 * availability-over-strictness trade: the alternative is a task nobody can ever
 * touch again, which is precisely the silent-loss failure this package exists
 * to remove.
 */
export function withTaskLock<T>(taskFile: string, fn: () => T): T {
  const lockPath = `${taskFile}.lock`;
  ensureDir(dirname(taskFile));
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\t${nowIso()}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
      break;
    } catch {
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { age = LOCK_STALE_MS + 1; }
      if (age > LOCK_STALE_MS) {
        try { unlinkSync(lockPath); } catch { /* someone else broke it first */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Task lock busy: ${lockPath} (held ${Math.round(age / 1000)}s)`);
      }
      // Busy-wait briefly. Sync by design: every caller here is synchronous,
      // and an async lock would change the signature of the whole bus API.
      const until = Date.now() + LOCK_POLL_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}

/** Read the accountability meta off a task record, supplying defaults for a
 *  legacy file that predates the contract. */
export function readMeta(task: Record<string, unknown>): TaskContractMeta {
  return {
    version: typeof task.version === 'number' && task.version > 0 ? task.version : 1,
    fence_token: typeof task.fence_token === 'number' ? task.fence_token : 0,
    lease_owner: (task.lease_owner as string) ?? null,
    lease_expires_at: (task.lease_expires_at as string) ?? null,
    canonical_state: (task.canonical_state as CanonicalState) ?? toCanonical('cortexos_tasks', task.status as string),
    human_accountable_id: (task.human_accountable_id as string) ?? null,
    agent_role_id: (task.agent_role_id as string) ?? null,
    outcome: (task.outcome as string) ?? null,
    acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [],
    dependency_ids: Array.isArray(task.dependency_ids) ? (task.dependency_ids as string[]) : [],
    authorization_scope: (task.authorization_scope as string) ?? null,
    attempt_limit: (task.attempt_limit as number) ?? null,
    next_action_at: (task.next_action_at as string) ?? null,
    not_before: (task.not_before as string) ?? null,
    source_ref: (task.source_ref as string) ?? null,
    evidence_recorded: task.evidence_recorded === true,
    impact_class: (task.impact_class as string) ?? null,
    work_type: (task.work_type as string) ?? null,
    author: (task.author as string) ?? (task.created_by as string) ?? null,
  };
}

/** Append one event to the task's journal. Unlike the older audit log this is
 *  NOT best-effort: a history that silently drops entries is worse than useless,
 *  so a failed journal write fails the mutation. */
export function appendTaskEvent(
  paths: BusPaths,
  taskFile: string,
  taskId: string,
  entry: Omit<TaskEvent, 'ts'>,
): void {
  validateTaskId(taskId);
  const dir = eventDirForTaskFile(paths, taskFile);
  ensureDir(dir);
  appendFileSync(join(dir, `${taskId}.jsonl`), JSON.stringify({ ts: nowIso(), ...entry }) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Read a task's event journal in write order. Corrupt lines are skipped so one
 *  half-written line cannot hide the rest of the history. */
export function readTaskEvents(paths: BusPaths, taskFile: string, taskId: string): TaskEvent[] {
  validateTaskId(taskId);
  const path = join(eventDirForTaskFile(paths, taskFile), `${taskId}.jsonl`);
  if (!existsSync(path)) return [];
  const out: TaskEvent[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as TaskEvent); } catch { /* skip corrupt */ }
  }
  return out;
}

export interface MutateOptions {
  /** Optimistic concurrency. Omit to accept whatever version is current. */
  expectedVersion?: number;
  /** Lease proof. A token behind the task's current fence is refused. */
  fenceToken?: number;
  actor: string;
  event: string;
  payload?: Record<string, unknown>;
  /** Explicit canonical state to record. Needed because `verify` and `doing`
   *  share the native status `in_progress`: deriving the canonical state from
   *  the native one alone cannot tell them apart, and silently demoting a
   *  verified-pending task back to `doing` would lose the distinction the whole
   *  proof gate depends on. */
  canonicalState?: CanonicalState;
}

export interface MutateResult<T = Record<string, unknown>> {
  task: T;
  version: number;
}

/**
 * The single write path for a native task: lock, re-read from disk, check the
 * version and fence, let `mutate` change the record, bump the version, write
 * atomically, journal the event.
 *
 * Re-reading INSIDE the lock is the point. Every previous bug in this area came
 * from a caller reading a task, deciding something, and writing back a record
 * built from a stale read.
 */
export function mutateTask(
  paths: BusPaths,
  taskFile: string,
  taskId: string,
  opts: MutateOptions,
  mutate: (task: Record<string, unknown>, meta: TaskContractMeta) => void,
): MutateResult {
  return withTaskLock(taskFile, () => {
    let task: Record<string, unknown>;
    try {
      task = JSON.parse(readFileSync(taskFile, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Task ${taskId} unreadable: ${err}`);
    }

    const meta = readMeta(task);

    if (opts.expectedVersion !== undefined && opts.expectedVersion !== meta.version) {
      throw new VersionConflictError(taskId, opts.expectedVersion, meta.version, task);
    }
    if (opts.fenceToken !== undefined && opts.fenceToken < meta.fence_token) {
      throw new FencedError(taskId, opts.fenceToken, meta.fence_token);
    }

    mutate(task, meta);

    const nextVersion = meta.version + 1;
    task.version = nextVersion;
    task.updated_at = nowIso();
    task.canonical_state = opts.canonicalState ?? toCanonical('cortexos_tasks', task.status as string);

    atomicWriteSync(taskFile, JSON.stringify(task));
    appendTaskEvent(paths, taskFile, taskId, {
      version: nextVersion,
      event: opts.event,
      actor: opts.actor,
      payload: opts.payload,
    });

    return { task, version: nextVersion };
  });
}

export interface LeaseGrant {
  fenceToken: number;
  leaseExpiresAt: string;
  version: number;
  /** The displaced attempt's resume point, so a reclaim continues rather than
   *  repeating side effects. */
  checkpoint: Record<string, unknown>;
}

/**
 * Take (or extend) a lease with a fresh fence token.
 *
 * A live lease held by somebody else wins — that is the concurrent-claim case.
 * An EXPIRED lease is reclaimable, and reclaiming advances the fence, which
 * immediately invalidates the token the previous holder is still carrying. The
 * same owner re-claiming is an idempotent extension, not a conflict, because
 * workers retry.
 */
export function acquireLease(
  paths: BusPaths,
  taskFile: string,
  taskId: string,
  worker: string,
  leaseSeconds = 900,
  now: () => number = Date.now,
  /** Native status to set in the SAME locked write. Claiming and moving to
   *  in_progress is one event, not two: splitting them leaves a window where a
   *  task is leased but still reads as unclaimed. */
  setStatus?: string,
): LeaseGrant {
  let grant!: LeaseGrant;
  mutateTask(
    paths,
    taskFile,
    taskId,
    { actor: worker, event: 'claim' },
    (task, meta) => {
      const live =
        meta.lease_owner &&
        meta.lease_owner !== worker &&
        meta.lease_expires_at &&
        new Date(meta.lease_expires_at).getTime() > now();
      if (live) throw new LeaseHeldError(taskId, meta.lease_owner as string, meta.lease_expires_at as string);

      const fence = meta.fence_token + 1;
      const expires = new Date(now() + leaseSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const checkpoint = (task.checkpoint as Record<string, unknown>) ?? {};

      task.fence_token = fence;
      task.lease_owner = worker;
      task.lease_expires_at = expires;
      task.assigned_to = worker;
      task.attempt = ((task.attempt as number) ?? 0) + 1;
      if (setStatus) task.status = setStatus;

      grant = { fenceToken: fence, leaseExpiresAt: expires, version: meta.version + 1, checkpoint };
    },
  );
  return grant;
}

/** Record a run attempt's progress or outcome. Refused if the caller's fence is
 *  stale — the whole reason fencing exists. */
export function reportRun(
  paths: BusPaths,
  taskFile: string,
  taskId: string,
  fenceToken: number,
  status: 'started' | 'succeeded' | 'failed' | 'abandoned',
  opts: { checkpoint?: Record<string, unknown>; evidence?: Record<string, unknown>; actor?: string } = {},
): MutateResult {
  return mutateTask(
    paths,
    taskFile,
    taskId,
    {
      actor: opts.actor ?? 'unknown',
      event: `run:${status}`,
      fenceToken,
      payload: { fence_token: fenceToken, evidence: opts.evidence ?? {} },
    },
    (task) => {
      if (opts.checkpoint) task.checkpoint = opts.checkpoint;
      if (opts.evidence) {
        task.evidence = opts.evidence;
        task.evidence_recorded = true;
      }
      task.last_run_status = status;
    },
  );
}
