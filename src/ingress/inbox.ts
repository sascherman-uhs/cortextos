/**
 * OS-07 — persisted inbound updates.
 *
 * `(bot_identity, update_id)` is written here BEFORE the getUpdates offset
 * advances. That ordering is the whole point: an update is never acknowledged
 * to Telegram until it exists durably on our side, so a crash mid-batch
 * re-delivers nothing that was already accepted and loses nothing that was not.
 *
 * The record carries everything a reply needs — person, chat, the origin reply
 * route and the task id — so a worker that comes back after a restart can
 * answer through the same bot without reconstructing anything.
 */

import { existsSync } from 'fs';
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
import type { IngressRole } from './routing.js';

export type InboundStatus = 'accepted' | 'dispatched' | 'answered' | 'refused';

export interface InboundRecord {
  bot_identity: string;
  update_id: number;
  /** Where a reply must go back. Never recomputed, only read. */
  reply_route: { bot: string; chat_id: string };
  person?: string;
  from_user_id?: number;
  chat_id: string;
  role: IngressRole;
  target_agent?: string;
  mode?: string;
  text?: string;
  kind: 'message' | 'callback_query' | 'message_reaction';
  task_id?: string;
  dedupe_key: string;
  received_at: string;
  status: InboundStatus;
  /** Set on a refused update so the reason is visible, not silent. */
  reason?: string;
}

export function inboundDir(paths: IngressPaths, bot: string): string {
  return join(paths.inboxDir, validateBotId(bot));
}

export function inboundPath(paths: IngressPaths, bot: string, updateId: number): string {
  return join(inboundDir(paths, bot), `${updateId}.json`);
}

export function hasInbound(paths: IngressPaths, bot: string, updateId: number): boolean {
  return existsSync(inboundPath(paths, bot, updateId));
}

/**
 * Persist an inbound update. Idempotent on `(bot_identity, update_id)`: a
 * re-delivered update returns the record already on disk rather than creating
 * a second one, which is what makes "no duplicated effect" survive a redelivery.
 */
export function persistInbound(paths: IngressPaths, record: InboundRecord): { record: InboundRecord; created: boolean } {
  validateBotId(record.bot_identity);
  ensureDir(inboundDir(paths, record.bot_identity));
  const path = inboundPath(paths, record.bot_identity, record.update_id);
  const existing = readJson<InboundRecord>(path);
  if (existing) return { record: existing, created: false };
  writeJson(path, record);
  return { record, created: true };
}

export function updateInbound(
  paths: IngressPaths,
  bot: string,
  updateId: number,
  patch: Partial<InboundRecord>,
): InboundRecord | null {
  const path = inboundPath(paths, bot, updateId);
  const existing = readJson<InboundRecord>(path);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  writeJson(path, next);
  return next;
}

export function listInbound(paths: IngressPaths, bot: string): InboundRecord[] {
  return listJson(inboundDir(paths, bot))
    .map((f) => readJson<InboundRecord>(join(inboundDir(paths, bot), f)))
    .filter((r): r is InboundRecord => !!r)
    .sort((a, b) => a.update_id - b.update_id);
}

/** Stable dedupe key for one update. */
export function dedupeKeyFor(bot: string, updateId: number): string {
  return `${bot}:${updateId}`;
}

/** Deterministic task id derived from the update, so a replay reuses it. */
export function taskIdFor(bot: string, updateId: number, ctx: IngressContext = {}): string {
  void ctx;
  return `ingress_${bot}_${updateId}`;
}

export function newInboundRecord(
  bot: string,
  updateId: number,
  fields: Omit<InboundRecord, 'bot_identity' | 'update_id' | 'dedupe_key' | 'received_at' | 'task_id' | 'status'> &
    Partial<Pick<InboundRecord, 'status'>>,
  ctx: IngressContext = {},
): InboundRecord {
  return {
    bot_identity: bot,
    update_id: updateId,
    dedupe_key: dedupeKeyFor(bot, updateId),
    task_id: taskIdFor(bot, updateId, ctx),
    received_at: nowIso(ctx),
    status: fields.status ?? 'accepted',
    ...fields,
  };
}
