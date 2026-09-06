/**
 * OS-07 — durable reply outbox.
 *
 * A reply is written to disk BEFORE it is sent and marked sent only after the
 * transport confirms. That gives two properties the plan asks for:
 *
 *  - a crash between "we decided to answer Raquel" and "the answer left" does
 *    not lose the reply — it is still pending on restart;
 *  - a reply leaves through the bot recorded on the inbound update, never a
 *    different one, because `bot` is copied from the origin route and the
 *    sender is resolved from that id.
 *
 * Duplicate suppression is by `dedupe_key`. Two enqueues with the same key
 * produce one outbox row, so a replayed instruction cannot answer twice.
 *
 * 2026-09-06 CortexOS V4 safety review, WP-4: a live duplicate-send race was
 * found in the drain loop — two concurrent drains could both re-read an entry
 * as `pending` and both call `send`. This module now claims an entry
 * exclusively (O_EXCL claim file, mirroring `claimTask` in bus/task.ts)
 * BEFORE the first network call, persists a `sending` state with attempt
 * metadata, and only classifies a failure as retryable when it is PROVABLY
 * pre-effect (the claim itself failed, or `send` threw before any network
 * I/O started). Anything else — an explicit provider rejection, a timeout, a
 * disconnected response, or a write failure after `send` already resolved —
 * never silently retries: it lands in `failed` (provable, permanent) or
 * `ambiguous` (unprovable — needs reconciliation, not a resend).
 */

import { randomUUID } from 'crypto';
import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import {
  listJson,
  nowIso,
  readJson,
  validateBotId,
  writeJson,
  type IngressContext,
  type IngressPaths,
} from './state.js';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous';

/** Claim metadata persisted on the entry BEFORE the first network call. */
export interface SendingClaim {
  attempt_id: string;
  /** Who is attempting the send — a worker/process identity, not a bot id. */
  owner: string;
  /** Monotonic-enough fence so a stale attempt can be told apart from the current one. */
  fence: number;
  started_at: string;
  bot: string;
  chat_id: string;
}

export interface OutboxEntry {
  id: string;
  /** The ONLY bot this reply may leave through — the update's origin route. */
  bot: string;
  chat_id: string;
  text: string;
  /** Same key twice = same reply. Enqueue is idempotent on it. */
  dedupe_key: string;
  status: OutboxStatus;
  attempts: number;
  created_at: string;
  sent_at?: string;
  last_error?: string;
  /** Set once the transport confirms, so a replay can prove it already went. */
  sent_message_id?: number;
  /** Inbound update this answers, when there is one. */
  in_reply_to?: { bot: string; update_id: number };
  /** Set while `status === 'sending'` (and kept for audit once `ambiguous`). */
  sending?: SendingClaim;
  /** Set when the entry moved to `ambiguous` — needs human/worker reconciliation. */
  ambiguous_at?: string;
  /** Set once a replacement worker has reconciled an `ambiguous` entry. */
  resolution?: { resolved_at: string; resolved_by: string; evidence: string; outcome: 'sent' | 'failed' };
}

function entryPath(paths: IngressPaths, id: string): string {
  return join(paths.outboxDir, `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function claimsDir(paths: IngressPaths): string {
  return join(paths.outboxDir, '.claims');
}

function claimPath(paths: IngressPaths, id: string): string {
  return join(claimsDir(paths), `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.claim`);
}

function idForKey(dedupeKey: string): string {
  return dedupeKey.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
}

function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Record a reply for delivery. Idempotent on `dedupe_key`: calling twice
 * returns the existing entry untouched, including one already sent.
 */
export function enqueueReply(
  paths: IngressPaths,
  entry: Omit<OutboxEntry, 'id' | 'status' | 'attempts' | 'created_at'>,
  ctx: IngressContext = {},
): OutboxEntry {
  validateBotId(entry.bot);
  ensureDir(paths.outboxDir);
  const id = idForKey(entry.dedupe_key);
  const existing = readJson<OutboxEntry>(entryPath(paths, id));
  if (existing) return existing;
  const record: OutboxEntry = {
    ...entry,
    id,
    status: 'pending',
    attempts: 0,
    created_at: nowIso(ctx),
  };
  writeJson(entryPath(paths, id), record);
  return record;
}

export function readEntry(paths: IngressPaths, id: string): OutboxEntry | null {
  return readJson<OutboxEntry>(entryPath(paths, id));
}

export function listPending(paths: IngressPaths): OutboxEntry[] {
  return listJson(paths.outboxDir)
    .map((f) => readJson<OutboxEntry>(join(paths.outboxDir, f)))
    .filter((e): e is OutboxEntry => !!e && e.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Ambiguous entries, oldest first — what reconciliation must resolve. Never auto-drained. */
export function listAmbiguous(paths: IngressPaths): OutboxEntry[] {
  return listJson(paths.outboxDir)
    .map((f) => readJson<OutboxEntry>(join(paths.outboxDir, f)))
    .filter((e): e is OutboxEntry => !!e && e.status === 'ambiguous')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function listAll(paths: IngressPaths): OutboxEntry[] {
  return listJson(paths.outboxDir)
    .map((f) => readJson<OutboxEntry>(join(paths.outboxDir, f)))
    .filter((e): e is OutboxEntry => !!e);
}

export const MAX_SEND_ATTEMPTS = 5;

/** Persist the exclusive-claim state BEFORE the first network call. */
export function markSending(paths: IngressPaths, id: string, claim: SendingClaim): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: 'sending',
    sending: claim,
  } satisfies OutboxEntry);
}

export function markSent(paths: IngressPaths, id: string, messageId?: number, ctx: IngressContext = {}): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: 'sent',
    sent_at: nowIso(ctx),
    sending: undefined,
    ...(typeof messageId === 'number' ? { sent_message_id: messageId } : {}),
  } satisfies OutboxEntry);
}

/**
 * Provable pre-effect failure — the claim never resulted in a network call
 * (send threw before starting one). Safe to retry, bounded by MAX_SEND_ATTEMPTS.
 */
export function markPreSendFailure(paths: IngressPaths, id: string, error: string, ctx: IngressContext = {}): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  const attempts = entry.attempts + 1;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: attempts >= MAX_SEND_ATTEMPTS ? 'failed' : 'pending',
    attempts,
    last_error: error.slice(0, 500),
    sending: undefined,
  } satisfies OutboxEntry);
}

/** Explicit, permanent provider rejection. Never retried. */
export function markRejected(paths: IngressPaths, id: string, error: string, ctx: IngressContext = {}): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: 'failed',
    attempts: entry.attempts + 1,
    last_error: error.slice(0, 500),
    sending: undefined,
  } satisfies OutboxEntry);
}

/**
 * Unprovable outcome — a timeout, a disconnected response, or a write
 * failure after `send` already resolved/threw. NEVER auto-retried; a
 * replacement worker must reconcile it with evidence (see `reconcileAmbiguous`).
 */
export function markAmbiguous(paths: IngressPaths, id: string, error: string, ctx: IngressContext = {}): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: 'ambiguous',
    ambiguous_at: nowIso(ctx),
    last_error: error.slice(0, 500),
  } satisfies OutboxEntry);
}

/**
 * Reconcile an `ambiguous` entry with evidence a worker actually checked
 * (e.g. the provider's message history shows it went out, or it doesn't).
 * This never re-dispatches — it only records the resolved outcome. Getting
 * from `resolved: failed` back to `pending` for a genuine resend is a
 * deliberate, separate call to `enqueueReply` with a fresh dedupe key.
 */
export function reconcileAmbiguous(
  paths: IngressPaths,
  id: string,
  outcome: 'sent' | 'failed',
  resolvedBy: string,
  evidence: string,
  ctx: IngressContext = {},
): OutboxEntry | null {
  const entry = readEntry(paths, id);
  if (!entry || entry.status !== 'ambiguous') return entry;
  const record: OutboxEntry = {
    ...entry,
    status: outcome,
    resolution: { resolved_at: nowIso(ctx), resolved_by: resolvedBy, evidence, outcome },
  };
  writeJson(entryPath(paths, id), record);
  return record;
}

export type SendOutcome =
  | { status: 'sent'; messageId?: number }
  /** Provider explicitly, permanently rejected the message (e.g. blocked chat, bad token). */
  | { status: 'rejected'; error: string };

/**
 * Transport hook. Injected so tests never touch Telegram, and so the caller
 * decides which bot token backs each identity — the outbox only knows the
 * bot id.
 *
 * `onNetworkStart` MUST be called immediately before the first byte of the
 * actual request goes out. A throw before that call is treated as a provable
 * pre-effect failure (safe to retry); a throw after it is treated as
 * ambiguous (never retried) because the provider may have already received
 * the message.
 */
export type SendFn = (
  bot: string,
  chatId: string,
  text: string,
  onNetworkStart: () => void,
) => Promise<SendOutcome>;

/**
 * Persistence hooks `drainOutbox` uses once `send` resolves/throws. Exposed
 * so a caller (or a test) can inject a failing persistence step to exercise
 * "the write itself failed" without needing a real crash — the same seam a
 * real disk-full or process-death failure would hit.
 */
export interface DrainDeps {
  persistSent?: typeof markSent;
}

/**
 * Drain pending replies through `send`.
 *
 * Each entry is claimed exclusively (O_EXCL claim file) before anything else
 * touches it, so two concurrent drains racing the same entry result in
 * exactly one call to `send`. See the module doc for the full state machine.
 */
export async function drainOutbox(
  paths: IngressPaths,
  send: SendFn,
  ctx: IngressContext = {},
  owner: string = `pid:${process.pid}:${randomUUID().slice(0, 8)}`,
  deps: DrainDeps = {},
): Promise<{ sent: number; failed: number; ambiguous: number }> {
  const persistSent = deps.persistSent ?? markSent;
  let sent = 0;
  let failed = 0;
  let ambiguous = 0;
  ensureDir(claimsDir(paths));

  for (const candidate of listPending(paths)) {
    const cPath = claimPath(paths, candidate.id);
    try {
      writeFileSync(
        cPath,
        JSON.stringify({ owner, claimed_at: nowIso(ctx) }),
        { flag: 'wx', encoding: 'utf-8', mode: 0o600 },
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; // another drain owns this entry
      throw err;
    }

    try {
      // Re-read under exclusive ownership — a concurrent drain that lost the
      // claim race above never gets here, but the entry itself may have
      // changed status since `listPending` ran.
      const fresh = readEntry(paths, candidate.id);
      if (!fresh || fresh.status !== 'pending') continue;

      const claim: SendingClaim = {
        attempt_id: randomUUID(),
        owner,
        fence: fresh.attempts + 1,
        started_at: nowIso(ctx),
        bot: fresh.bot,
        chat_id: fresh.chat_id,
      };
      markSending(paths, fresh.id, claim);

      let networkStarted = false;
      try {
        const outcome = await send(fresh.bot, fresh.chat_id, fresh.text, () => {
          networkStarted = true;
        });
        if (outcome.status === 'sent') {
          try {
            persistSent(paths, fresh.id, outcome.messageId, ctx);
            sent += 1;
          } catch (persistErr) {
            // The provider confirmed the send but we could not persist that
            // fact — we do not know whether a retry would duplicate it.
            markAmbiguous(
              paths,
              fresh.id,
              `send succeeded but persisting sent status failed: ${describeError(persistErr)}`,
              ctx,
            );
            ambiguous += 1;
          }
        } else {
          markRejected(paths, fresh.id, outcome.error, ctx);
          failed += 1;
        }
      } catch (err) {
        if (networkStarted) {
          markAmbiguous(paths, fresh.id, describeError(err), ctx);
          ambiguous += 1;
        } else {
          markPreSendFailure(paths, fresh.id, describeError(err), ctx);
          failed += 1;
        }
      }
    } finally {
      try {
        unlinkSync(cPath);
      } catch {
        /* best-effort — a leftover claim file only blocks a future claim of this same id */
      }
    }
  }

  return { sent, failed, ambiguous };
}
