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
 */

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

export type OutboxStatus = 'pending' | 'sent' | 'failed';

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
}

function entryPath(paths: IngressPaths, id: string): string {
  return join(paths.outboxDir, `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function idForKey(dedupeKey: string): string {
  return dedupeKey.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
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

export function listAll(paths: IngressPaths): OutboxEntry[] {
  return listJson(paths.outboxDir)
    .map((f) => readJson<OutboxEntry>(join(paths.outboxDir, f)))
    .filter((e): e is OutboxEntry => !!e);
}

export function markSent(paths: IngressPaths, id: string, messageId?: number, ctx: IngressContext = {}): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: 'sent',
    sent_at: nowIso(ctx),
    ...(typeof messageId === 'number' ? { sent_message_id: messageId } : {}),
  } satisfies OutboxEntry);
}

export function markFailed(paths: IngressPaths, id: string, error: string): void {
  const entry = readEntry(paths, id);
  if (!entry) return;
  writeJson(entryPath(paths, id), {
    ...entry,
    status: entry.attempts + 1 >= MAX_SEND_ATTEMPTS ? 'failed' : 'pending',
    attempts: entry.attempts + 1,
    last_error: error.slice(0, 500),
  } satisfies OutboxEntry);
}

export const MAX_SEND_ATTEMPTS = 5;

/** Transport hook. Returns the sent message id when the provider gives one. */
export type SendFn = (bot: string, chatId: string, text: string) => Promise<number | undefined>;

/**
 * Drain pending replies through `send`.
 *
 * `send` is injected so tests never touch Telegram, and so the caller decides
 * which bot token backs each identity — the outbox only knows the bot id.
 */
export async function drainOutbox(
  paths: IngressPaths,
  send: SendFn,
  ctx: IngressContext = {},
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const entry of listPending(paths)) {
    // Re-read: a concurrent drain may have taken it.
    const fresh = readEntry(paths, entry.id);
    if (!fresh || fresh.status !== 'pending') continue;
    try {
      const messageId = await send(fresh.bot, fresh.chat_id, fresh.text);
      markSent(paths, fresh.id, messageId, ctx);
      sent += 1;
    } catch (err) {
      markFailed(paths, fresh.id, err instanceof Error ? err.message : String(err));
      failed += 1;
    }
  }
  return { sent, failed };
}
