/**
 * OS-07 — per-bot ownership fence.
 *
 * Exactly one component may poll a given bot: either the agent that has always
 * owned it (`owner: 'agent'`) or the multiplexed ingress (`owner: 'ingress'`).
 * The fence is the durable answer to "who owns this bot right now", and the
 * fence token is monotonic so a poller that woke up after a transfer is refused
 * even if it is convinced it still owns the bot.
 *
 * The transfer sequence the plan mandates — stop admitting on the old poller,
 * persist the checkpoint, transfer the fence, read back activation, then
 * disable the old poller — is implemented in `cutover.ts`; this module owns
 * the state and the checks.
 */

import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import {
  appendJsonl,
  nowIso,
  readJson,
  validateBotId,
  writeJson,
  type IngressContext,
  type IngressPaths,
} from './state.js';

export type FenceOwner = 'agent' | 'ingress';
export type FenceState = 'stable' | 'transferring';

export interface BotFence {
  bot: string;
  owner: FenceOwner;
  /** Monotonic. Every ownership change increments it. */
  fence_token: number;
  /** getUpdates offset carried across the transfer. Never goes backwards. */
  checkpoint_offset: number;
  state: FenceState;
  /** Set while `state === 'transferring'`. */
  transferring_to?: FenceOwner;
  updated_at: string;
  /** Free-text reason recorded with the last change. */
  note?: string;
}

export class FenceConflictError extends Error {
  constructor(message: string, public readonly fence: BotFence) {
    super(message);
    this.name = 'FenceConflictError';
  }
}

export function fencePath(paths: IngressPaths, bot: string): string {
  return join(paths.fencesDir, `${validateBotId(bot)}.json`);
}

/** Read the fence, or synthesise the pre-OS-07 default: the agent owns its bot. */
export function readFence(paths: IngressPaths, bot: string, ctx: IngressContext = {}): BotFence {
  validateBotId(bot);
  const onDisk = readJson<BotFence>(fencePath(paths, bot));
  if (onDisk && typeof onDisk.fence_token === 'number') return onDisk;
  return {
    bot,
    owner: 'agent',
    fence_token: 0,
    checkpoint_offset: 0,
    state: 'stable',
    updated_at: nowIso(ctx),
  };
}

export function writeFence(paths: IngressPaths, fence: BotFence): BotFence {
  ensureDir(paths.fencesDir);
  writeJson(fencePath(paths, fence.bot), fence);
  appendJsonl(join(paths.root, 'fence-events.jsonl'), { ...fence, event: 'fence_written' });
  return fence;
}

/**
 * May `owner` admit updates for `bot` right now?
 *
 * False during a transfer for BOTH sides — the window where neither polls is
 * deliberate, and is exactly what makes "never two pollers at once" true.
 */
export function mayAdmit(paths: IngressPaths, bot: string, owner: FenceOwner, ctx: IngressContext = {}): boolean {
  const fence = readFence(paths, bot, ctx);
  return fence.state === 'stable' && fence.owner === owner;
}

/**
 * Assert that a caller holding `fenceToken` still owns `bot`.
 *
 * This is the "old worker resumes after lease transfer" guard: a poller that
 * was sleeping through a transfer comes back with a stale token and is refused
 * before it can advance an offset or send a reply.
 */
export function assertFence(
  paths: IngressPaths,
  bot: string,
  owner: FenceOwner,
  fenceToken: number,
  ctx: IngressContext = {},
): BotFence {
  const fence = readFence(paths, bot, ctx);
  if (fence.owner !== owner || fence.fence_token !== fenceToken || fence.state !== 'stable') {
    throw new FenceConflictError(
      `Fence for ${bot} moved: holder claimed ${owner}@${fenceToken}, on disk is ` +
      `${fence.owner}@${fence.fence_token} (${fence.state}).`,
      fence,
    );
  }
  return fence;
}

/** Ingress-owned checkpoint for a bot. Monotonic — a lower offset is ignored. */
export function readOffset(paths: IngressPaths, bot: string): number {
  const rec = readJson<{ offset: number }>(join(paths.offsetsDir, `${validateBotId(bot)}.json`));
  return rec && typeof rec.offset === 'number' ? rec.offset : 0;
}

export function writeOffset(paths: IngressPaths, bot: string, offset: number, ctx: IngressContext = {}): number {
  validateBotId(bot);
  ensureDir(paths.offsetsDir);
  const current = readOffset(paths, bot);
  const next = Math.max(current, offset);
  writeJson(join(paths.offsetsDir, `${bot}.json`), { bot, offset: next, updated_at: nowIso(ctx) });
  return next;
}
