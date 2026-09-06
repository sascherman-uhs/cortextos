/**
 * OS-07 — durable dispatch.
 *
 * Four things the plan requires and this module provides:
 *
 *  1. **Outbox/ack.** An accepted instruction is written to the queue before
 *     anyone tries to execute it, and moves `pending -> leased -> done` under a
 *     lease. A crash anywhere in that path leaves the row recoverable, never
 *     lost, and `runExactlyOnce` (state.ts) keeps the external effect single.
 *  2. **Bounded fair routing.** The plan calls out the failure directly: a
 *     `LIMIT 20` scan that skips ineligible rows starves eligible work behind
 *     permanently-skipped rows. `selectDispatchable` scans a bounded window
 *     starting from a PERSISTED rotating cursor and round-robins across
 *     owners, so a wall of blocked rows at the head of the queue cannot hide
 *     the work behind it.
 *  3. **Lease expiry and reconciliation on restart.** A worker that died
 *     holding a lease releases it by expiry, and `reconcileOnRestart` returns
 *     those rows to `pending` — bounded by `attempt_limit`, so a poison row
 *     stops rather than loops.
 *  4. **Reserved capacity.** Ingress and briefing hold slots no ordinary work
 *     item can take, so one stalled worker cannot block ingress.
 */

import { join } from 'path';
import { randomBytes } from 'crypto';
import { ensureDir } from '../utils/atomic.js';
import {
  appendJsonl,
  listJson,
  nowIso,
  nowMs,
  readJson,
  writeJson,
  type IngressContext,
  type IngressPaths,
} from './state.js';

export type DispatchState = 'pending' | 'leased' | 'done' | 'failed' | 'blocked';

/** Work classes. `ingress` and `briefing` draw on reserved capacity. */
export type WorkClass = 'ingress' | 'briefing' | 'work';

export interface DispatchRecord {
  id: string;
  /** Owner the work belongs to — an agent name or role. Fairness is per owner. */
  owner: string;
  work_class: WorkClass;
  /** Same key twice = same instruction. */
  dedupe_key: string;
  payload: Record<string, unknown>;
  state: DispatchState;
  attempts: number;
  attempt_limit: number;
  /** Monotonic per record; a stale lease holder is refused by token. */
  fence_token: number;
  lease_owner?: string;
  lease_expires_at?: string;
  created_at: string;
  updated_at: string;
  /** Not eligible before this time. Used for backoff. */
  not_before?: string;
  last_error?: string;
  /** Why a row is blocked — always human-readable, never a bare code. */
  reason?: string;
}

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_ATTEMPT_LIMIT = 5;
/** How many rows one selection pass may examine. */
export const SCAN_WINDOW = 20;
/** Total concurrent leases, and the slots ingress/briefing keep for themselves. */
export const DEFAULT_CAPACITY = 6;
export const DEFAULT_RESERVED = 2;

function recordPath(paths: IngressPaths, id: string): string {
  return join(paths.dispatchQueueDir, `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function idForKey(dedupeKey: string): string {
  return dedupeKey.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
}

function journal(paths: IngressPaths, event: Record<string, unknown>): void {
  appendJsonl(paths.dispatchEventsPath, event);
}

/**
 * Accept an instruction durably. Idempotent on `dedupe_key` — the same inbound
 * update replayed after a crash produces one queue row, not two.
 */
export function acceptWork(
  paths: IngressPaths,
  input: {
    owner: string;
    work_class?: WorkClass;
    dedupe_key: string;
    payload: Record<string, unknown>;
    attempt_limit?: number;
    not_before?: string;
  },
  ctx: IngressContext = {},
): { record: DispatchRecord; created: boolean } {
  ensureDir(paths.dispatchQueueDir);
  const id = idForKey(input.dedupe_key);
  const existing = readJson<DispatchRecord>(recordPath(paths, id));
  if (existing) return { record: existing, created: false };
  const at = nowIso(ctx);
  const record: DispatchRecord = {
    id,
    owner: input.owner,
    work_class: input.work_class ?? 'work',
    dedupe_key: input.dedupe_key,
    payload: input.payload,
    state: 'pending',
    attempts: 0,
    attempt_limit: input.attempt_limit ?? DEFAULT_ATTEMPT_LIMIT,
    fence_token: 0,
    created_at: at,
    updated_at: at,
    ...(input.not_before ? { not_before: input.not_before } : {}),
  };
  writeJson(recordPath(paths, id), record);
  journal(paths, { event: 'accepted', id, owner: record.owner, work_class: record.work_class, at });
  return { record, created: true };
}

export function readRecord(paths: IngressPaths, id: string): DispatchRecord | null {
  return readJson<DispatchRecord>(recordPath(paths, id));
}

export function listRecords(paths: IngressPaths): DispatchRecord[] {
  return listJson(paths.dispatchQueueDir)
    .map((f) => readJson<DispatchRecord>(join(paths.dispatchQueueDir, f)))
    .filter((r): r is DispatchRecord => !!r)
    .sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)));
}

function leaseLive(record: DispatchRecord, atMs: number): boolean {
  if (record.state !== 'leased' || !record.lease_expires_at) return false;
  const expires = Date.parse(record.lease_expires_at);
  return !Number.isNaN(expires) && expires > atMs;
}

function eligible(record: DispatchRecord, atMs: number): boolean {
  if (record.state !== 'pending') return false;
  if (record.attempts >= record.attempt_limit) return false;
  if (record.not_before && Date.parse(record.not_before) > atMs) return false;
  return true;
}

interface Cursor {
  index: number;
  updated_at: string;
}

function readCursor(paths: IngressPaths): number {
  const c = readJson<Cursor>(paths.dispatchCursorPath);
  return c && typeof c.index === 'number' ? c.index : 0;
}

function writeCursor(paths: IngressPaths, index: number, ctx: IngressContext): void {
  ensureDir(paths.dispatchDir);
  writeJson(paths.dispatchCursorPath, { index, updated_at: nowIso(ctx) } satisfies Cursor);
}

export interface SelectOptions {
  limit?: number;
  /** Slots already in use. Defaults to the live lease count on disk. */
  capacity?: number;
  reserved?: number;
  /** Only pick work of these classes. */
  workClasses?: WorkClass[];
  /** Max rows one pass may take from a single owner, before rotating. */
  perOwnerCap?: number;
}

/**
 * Choose the next rows to dispatch.
 *
 * Starvation is prevented two ways at once:
 *   - the scan window starts at a persisted rotating cursor and wraps, so rows
 *     behind a block of ineligible ones are reached on a later pass instead of
 *     living forever outside a head-anchored `LIMIT 20`;
 *   - selection round-robins across owners, so one owner with a hundred rows
 *     cannot fill the batch while another owner's single row waits.
 *
 * Reserved capacity is enforced here: ordinary `work` may consume at most
 * `capacity - reserved` live leases, leaving `ingress` and `briefing` able to
 * run while every worker slot is stalled.
 */
export function selectDispatchable(
  paths: IngressPaths,
  opts: SelectOptions = {},
  ctx: IngressContext = {},
): DispatchRecord[] {
  const atMs = nowMs(ctx);
  const all = listRecords(paths);
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const reserved = opts.reserved ?? DEFAULT_RESERVED;
  const limit = opts.limit ?? SCAN_WINDOW;
  const perOwnerCap = opts.perOwnerCap ?? Math.max(1, Math.ceil(limit / 2));

  const liveLeases = all.filter((r) => leaseLive(r, atMs));
  const liveWorkLeases = liveLeases.filter((r) => r.work_class === 'work').length;
  const freeTotal = Math.max(0, capacity - liveLeases.length);
  const freeForWork = Math.max(0, Math.min(freeTotal, capacity - reserved - liveWorkLeases));

  if (all.length === 0 || freeTotal === 0) return [];

  // Rotating bounded scan.
  const start = all.length === 0 ? 0 : readCursor(paths) % all.length;
  const window: DispatchRecord[] = [];
  const scanned = Math.min(limit, all.length);
  for (let i = 0; i < scanned; i += 1) {
    window.push(all[(start + i) % all.length]);
  }
  writeCursor(paths, (start + scanned) % all.length, ctx);

  const wanted = opts.workClasses;
  const candidates = window.filter(
    (r) => eligible(r, atMs) && (!wanted || wanted.includes(r.work_class)),
  );

  // Round-robin across owners.
  const byOwner = new Map<string, DispatchRecord[]>();
  for (const r of candidates) {
    const list = byOwner.get(r.owner) ?? [];
    list.push(r);
    byOwner.set(r.owner, list);
  }
  const owners = [...byOwner.keys()].sort();
  const picked: DispatchRecord[] = [];
  const takenPerOwner = new Map<string, number>();
  let workTaken = 0;
  let round = 0;
  while (picked.length < freeTotal) {
    let progressed = false;
    for (const owner of owners) {
      if (picked.length >= freeTotal) break;
      const list = byOwner.get(owner)!;
      if (round >= list.length) continue;
      const taken = takenPerOwner.get(owner) ?? 0;
      if (taken >= perOwnerCap) continue;
      const candidate = list[round];
      if (candidate.work_class === 'work') {
        if (workTaken >= freeForWork) continue;
        workTaken += 1;
      }
      picked.push(candidate);
      takenPerOwner.set(owner, taken + 1);
      progressed = true;
    }
    if (!progressed) break;
    round += 1;
  }
  return picked;
}

export class DispatchLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchLeaseError';
  }
}

export interface LeaseHandle {
  id: string;
  lease_owner: string;
  fence_token: number;
  expires_at: string;
}

/** Take a lease. Refused when someone else holds a live one. */
export function leaseWork(
  paths: IngressPaths,
  id: string,
  leaseOwner: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  ctx: IngressContext = {},
): LeaseHandle {
  const record = readRecord(paths, id);
  if (!record) throw new DispatchLeaseError(`No dispatch record ${id}`);
  const atMs = nowMs(ctx);
  if (leaseLive(record, atMs) && record.lease_owner !== leaseOwner) {
    throw new DispatchLeaseError(`Dispatch ${id} is leased by ${record.lease_owner} until ${record.lease_expires_at}`);
  }
  if (record.state === 'done') throw new DispatchLeaseError(`Dispatch ${id} is already done`);
  const next: DispatchRecord = {
    ...record,
    state: 'leased',
    attempts: record.attempts + 1,
    fence_token: record.fence_token + 1,
    lease_owner: leaseOwner,
    lease_expires_at: new Date(atMs + leaseMs).toISOString(),
    updated_at: nowIso(ctx),
  };
  writeJson(recordPath(paths, id), next);
  journal(paths, { event: 'leased', id, lease_owner: leaseOwner, fence_token: next.fence_token, at: next.updated_at });
  return { id, lease_owner: leaseOwner, fence_token: next.fence_token, expires_at: next.lease_expires_at! };
}

function assertHolds(paths: IngressPaths, handle: LeaseHandle): DispatchRecord {
  const record = readRecord(paths, handle.id);
  if (!record) throw new DispatchLeaseError(`No dispatch record ${handle.id}`);
  if (record.fence_token !== handle.fence_token || record.lease_owner !== handle.lease_owner) {
    throw new DispatchLeaseError(
      `Lease on ${handle.id} moved: holder had ${handle.lease_owner}@${handle.fence_token}, ` +
      `on disk is ${record.lease_owner ?? 'none'}@${record.fence_token}.`,
    );
  }
  return record;
}

/** Acknowledge completion. Refused if the lease moved while the work ran. */
export function ackWork(paths: IngressPaths, handle: LeaseHandle, ctx: IngressContext = {}): DispatchRecord {
  const record = assertHolds(paths, handle);
  const next: DispatchRecord = {
    ...record,
    state: 'done',
    lease_owner: undefined,
    lease_expires_at: undefined,
    updated_at: nowIso(ctx),
  };
  writeJson(recordPath(paths, handle.id), next);
  journal(paths, { event: 'acked', id: handle.id, at: next.updated_at });
  return next;
}

/** Return a row for another attempt, or fail it once the limit is reached. */
export function nackWork(
  paths: IngressPaths,
  handle: LeaseHandle,
  error: string,
  opts: { backoffMs?: number } = {},
  ctx: IngressContext = {},
): DispatchRecord {
  const record = assertHolds(paths, handle);
  const exhausted = record.attempts >= record.attempt_limit;
  const next: DispatchRecord = {
    ...record,
    state: exhausted ? 'failed' : 'pending',
    lease_owner: undefined,
    lease_expires_at: undefined,
    last_error: error.slice(0, 500),
    updated_at: nowIso(ctx),
    ...(exhausted
      ? { reason: `attempt limit ${record.attempt_limit} reached; last error: ${error.slice(0, 200)}` }
      : opts.backoffMs
        ? { not_before: new Date(nowMs(ctx) + opts.backoffMs).toISOString() }
        : {}),
  };
  writeJson(recordPath(paths, handle.id), next);
  journal(paths, { event: exhausted ? 'failed' : 'nacked', id: handle.id, error: next.last_error, at: next.updated_at });
  return next;
}

/**
 * Restart reconciliation.
 *
 * Any row still `leased` with an expired (or missing) lease belonged to a
 * worker that died. It goes back to `pending` — or to `failed` with a stated
 * reason once its attempt limit is spent, so a poison row stops instead of
 * looping forever.
 */
export function reconcileOnRestart(
  paths: IngressPaths,
  ctx: IngressContext = {},
): { requeued: string[]; failed: string[] } {
  const atMs = nowMs(ctx);
  const requeued: string[] = [];
  const failed: string[] = [];
  for (const record of listRecords(paths)) {
    if (record.state !== 'leased') continue;
    if (leaseLive(record, atMs)) continue;
    const exhausted = record.attempts >= record.attempt_limit;
    const next: DispatchRecord = {
      ...record,
      state: exhausted ? 'failed' : 'pending',
      lease_owner: undefined,
      lease_expires_at: undefined,
      updated_at: nowIso(ctx),
      reason: exhausted
        ? `lease expired and attempt limit ${record.attempt_limit} reached — needs a human`
        : `lease from ${record.lease_owner ?? 'unknown'} expired; requeued by restart reconciliation`,
    };
    writeJson(recordPath(paths, record.id), next);
    (exhausted ? failed : requeued).push(record.id);
    journal(paths, { event: exhausted ? 'reconcile_failed' : 'reconcile_requeued', id: record.id, at: next.updated_at });
  }
  return { requeued, failed };
}

/** New opaque lease-owner id for one worker instance. */
export function newLeaseOwner(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
