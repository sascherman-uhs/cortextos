/**
 * OS-07 — fenced cutover between the agent-owned poller and multiplexed ingress.
 *
 * Deploying OS-07 changes NOTHING until a bot is explicitly enabled: the flag
 * store starts empty and `isMultiplexed()` is false for every identity, so
 * `agent-manager` keeps starting the per-agent poller exactly as before.
 *
 * The transfer sequence is the one the plan mandates, in this order:
 *
 *   1. mark the fence `transferring` — BOTH sides stop admitting immediately
 *   2. persist the checkpoint (the old poller's `.telegram-offset`) into
 *      ingress state, never moving it backwards
 *   3. stop the old poller (the caller's `stopOldPoller` hook)
 *   4. transfer the fence: new owner, fence_token + 1, state `stable`
 *   5. read back activation from disk and verify owner + token + checkpoint
 *   6. set the flag so the next daemon start also honours the new owner
 *
 * If step 5 does not read back what step 4 wrote, the fence is left
 * `transferring` — visible, no poller running, no update acknowledged and
 * discarded — rather than reported as a successful cutover.
 *
 * `revert()` is the same sequence with the owners swapped. The checkpoint goes
 * back with it and the fence token still increments, so a poller from before
 * the revert is refused too.
 */

import { existsSync, readFileSync } from 'fs';
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
import {
  readFence,
  readOffset,
  writeFence,
  writeOffset,
  type BotFence,
  type FenceOwner,
} from './fence.js';

export interface BotFlag {
  multiplexed: boolean;
  updated_at: string;
  actor?: string;
  reason?: string;
}

export interface IngressFlags {
  version: number;
  bots: Record<string, BotFlag>;
}

export function loadFlags(paths: IngressPaths): IngressFlags {
  const onDisk = readJson<IngressFlags>(paths.flagsPath);
  if (!onDisk || typeof onDisk.bots !== 'object' || onDisk.bots === null) {
    return { version: 1, bots: {} };
  }
  return { version: onDisk.version ?? 1, bots: onDisk.bots };
}

export function saveFlags(paths: IngressPaths, flags: IngressFlags): void {
  ensureDir(paths.root);
  writeJson(paths.flagsPath, flags);
}

/** Default OFF. A bot with no flag row keeps its agent-owned poller. */
export function isMultiplexed(paths: IngressPaths, bot: string): boolean {
  return loadFlags(paths).bots[bot]?.multiplexed === true;
}

/**
 * True when the per-agent poller in `agent-manager` should stand down for this
 * bot — either ingress owns it, or a transfer is in flight. Reading the fence
 * (not just the flag) is what keeps the daemon from racing a cutover.
 */
export function agentPollerSuppressed(paths: IngressPaths, bot: string, ctx: IngressContext = {}): boolean {
  const fence = readFence(paths, bot, ctx);
  if (fence.state === 'transferring') return true;
  if (fence.owner === 'ingress') return true;
  return isMultiplexed(paths, bot) && fence.owner !== 'agent';
}

/** Path of the legacy per-agent offset file the old poller maintains. */
export function legacyOffsetPath(paths: IngressPaths, agentName: string, suffix?: string): string {
  const file = suffix ? `.telegram-offset-${suffix}` : '.telegram-offset';
  return join(paths.ctxRoot, 'state', agentName, file);
}

export function readLegacyOffset(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

export interface TransferOptions {
  /** Stop the currently-admitting poller. Must resolve only once it is stopped. */
  stopOldPoller?: () => Promise<void> | void;
  /** Where the outgoing owner kept its offset, when it is the legacy file. */
  legacyOffsetFile?: string;
  actor?: string;
  reason?: string;
}

export interface TransferResult {
  ok: boolean;
  bot: string;
  from: FenceOwner;
  to: FenceOwner;
  fence: BotFence;
  checkpoint_offset: number;
  /** Set when the read-back did not match — the fence stays `transferring`. */
  error?: string;
}

async function transfer(
  paths: IngressPaths,
  bot: string,
  to: FenceOwner,
  opts: TransferOptions,
  ctx: IngressContext,
): Promise<TransferResult> {
  validateBotId(bot);
  ensureDir(paths.root);
  const before = readFence(paths, bot, ctx);
  const from: FenceOwner = before.owner;

  if (before.state === 'transferring') {
    return {
      ok: false,
      bot,
      from,
      to,
      fence: before,
      checkpoint_offset: before.checkpoint_offset,
      error:
        `A transfer of ${bot} to ${before.transferring_to ?? 'unknown'} is already in flight and did not ` +
        `complete. Resolve it (cortextos ingress status --bot ${bot}) before starting another.`,
    };
  }
  if (before.owner === to) {
    return {
      ok: true,
      bot,
      from,
      to,
      fence: before,
      checkpoint_offset: before.checkpoint_offset,
    };
  }

  // 1. Stop admitting on BOTH sides.
  const transferring: BotFence = {
    ...before,
    state: 'transferring',
    transferring_to: to,
    updated_at: nowIso(ctx),
    ...(opts.reason ? { note: opts.reason } : {}),
  };
  writeFence(paths, transferring);

  // 2. Persist the checkpoint before anything is disabled. Highest of the
  //    legacy file, the ingress offset and the fence's own record wins; an
  //    offset never moves backwards across a transfer.
  const legacy = opts.legacyOffsetFile ? readLegacyOffset(opts.legacyOffsetFile) : 0;
  const checkpoint = Math.max(before.checkpoint_offset, readOffset(paths, bot), legacy);
  writeOffset(paths, bot, checkpoint, ctx);

  // 3. Disable the outgoing poller.
  if (opts.stopOldPoller) await opts.stopOldPoller();

  // 4. Move the fence.
  const moved: BotFence = {
    bot,
    owner: to,
    fence_token: before.fence_token + 1,
    checkpoint_offset: checkpoint,
    state: 'stable',
    updated_at: nowIso(ctx),
    ...(opts.reason ? { note: opts.reason } : {}),
  };
  writeFence(paths, moved);

  // 5. Read back activation.
  const readback = readFence(paths, bot, ctx);
  if (
    readback.owner !== to ||
    readback.fence_token !== moved.fence_token ||
    readback.state !== 'stable' ||
    readback.checkpoint_offset !== checkpoint
  ) {
    writeFence(paths, { ...transferring, note: 'read-back failed after fence write' });
    return {
      ok: false,
      bot,
      from,
      to,
      fence: readback,
      checkpoint_offset: checkpoint,
      error: `Fence read-back for ${bot} did not match the write — leaving the transfer pending, no poller admitted.`,
    };
  }

  // 6. Persist the flag so the next daemon start honours the same owner.
  const flags = loadFlags(paths);
  flags.bots[bot] = {
    multiplexed: to === 'ingress',
    updated_at: nowIso(ctx),
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  saveFlags(paths, flags);

  appendJsonl(join(paths.root, 'fence-events.jsonl'), {
    event: 'transfer',
    bot,
    from,
    to,
    fence_token: moved.fence_token,
    checkpoint_offset: checkpoint,
    at: nowIso(ctx),
    actor: opts.actor,
  });

  return { ok: true, bot, from, to, fence: moved, checkpoint_offset: checkpoint };
}

/** Hand a bot from its agent-owned poller to multiplexed ingress. */
export function enableMultiplexed(
  paths: IngressPaths,
  bot: string,
  opts: TransferOptions = {},
  ctx: IngressContext = {},
): Promise<TransferResult> {
  return transfer(paths, bot, 'ingress', opts, ctx);
}

/** Hand a bot back to its agent-owned poller, carrying the same checkpoint. */
export function revertToAgent(
  paths: IngressPaths,
  bot: string,
  opts: TransferOptions = {},
  ctx: IngressContext = {},
): Promise<TransferResult> {
  return transfer(paths, bot, 'agent', opts, ctx);
}
