/**
 * OS-07 — the multiplexed ingress service.
 *
 * One persistent service hosting one isolated poller per configured bot
 * identity. It replaces the arrangement where each agent process owned its own
 * Telegram listener, and with it the failure this package exists to remove:
 * restarting or re-modelling a persona worker took its listener down with it.
 *
 * Isolation properties, each deliberate:
 *
 *  - **Per-bot lock.** A bot is polled by exactly one loop, ever. The lock is
 *    taken before the first `getUpdates` and released on stop.
 *  - **Independent backoff.** Each bot has its own consecutive-failure counter
 *    and its own sleep. Vera's bot with a revoked token backs off to minutes
 *    while Vivienne's keeps polling at its normal cadence — one invalid token
 *    cannot starve the others.
 *  - **Persist before acknowledge.** The update record is written, and the work
 *    accepted into the dispatch queue, BEFORE the offset advances. An update is
 *    never acknowledged merely to discard it.
 *  - **Fence-checked.** Every batch re-asserts the fence. A cutover that
 *    happened while this loop slept stops it before it can touch an offset.
 *  - **Replies through the origin route.** The reply route is copied off the
 *    inbound record into the outbox; nothing downstream chooses a bot.
 */

import type { TelegramUpdate } from '../types/index.js';
import { stripControlChars } from '../utils/validate.js';
import { ensureDir } from '../utils/atomic.js';
import {
  acquirePollerLock,
  releasePollerLock,
  renewPollerLock,
  PollerLockHeldError,
  type IngressContext,
  type IngressPaths,
} from './state.js';
import { assertFence, FenceConflictError, readFence, readOffset, writeOffset } from './fence.js';
import { agentPollerSuppressed } from './cutover.js';
import { loadRoutingTable, routeUpdate, type RoutingTable } from './routing.js';
import { newInboundRecord, persistInbound, updateInbound, type InboundRecord } from './inbox.js';
import { acceptWork, type WorkClass } from './dispatch.js';
import type { BotIdentity } from './identity.js';

/** Minimal transport surface the ingress needs. Injected, so tests never call Telegram. */
export interface IngressTransport {
  getUpdates(offset: number, timeout?: number): Promise<{ ok?: boolean; result?: TelegramUpdate[] } | undefined>;
  sendMessage(chatId: string, text: string): Promise<unknown>;
}

export type TransportFactory = (identity: BotIdentity) => IngressTransport | undefined;

export interface IngressOptions {
  paths: IngressPaths;
  identities: BotIdentity[];
  transportFactory: TransportFactory;
  ctx?: IngressContext;
  log?: (msg: string) => void;
  /** Base delay between polls for a healthy bot. */
  pollIntervalMs?: number;
  /** Backoff ceiling for a failing bot. */
  maxBackoffMs?: number;
  /** getUpdates long-poll seconds. */
  pollTimeoutSec?: number;
  /** Injected sleep so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BotRuntimeState {
  bot: string;
  running: boolean;
  fence_token: number;
  offset: number;
  consecutive_failures: number;
  backoff_ms: number;
  last_error?: string;
  accepted: number;
  refused: number;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function workClassFor(role: string): WorkClass {
  return role === 'ingress' || role === 'dispatcher' ? 'ingress' : 'work';
}

export class MultiplexedIngress {
  private readonly paths: IngressPaths;
  private readonly ctx: IngressContext;
  private readonly log: (msg: string) => void;
  private readonly transportFactory: TransportFactory;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly pollTimeoutSec: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly identities: Map<string, BotIdentity> = new Map();
  private readonly runtime: Map<string, BotRuntimeState> = new Map();
  private readonly loops: Map<string, Promise<void>> = new Map();
  private routing: RoutingTable;
  private stopping = false;

  constructor(opts: IngressOptions) {
    this.paths = opts.paths;
    this.ctx = opts.ctx ?? {};
    this.log = opts.log ?? (() => {});
    this.transportFactory = opts.transportFactory;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 1;
    this.sleep = opts.sleep ?? defaultSleep;
    for (const id of opts.identities) this.identities.set(id.id, id);
    ensureDir(this.paths.root);
    this.routing = loadRoutingTable(this.paths);
  }

  /** Bots this ingress currently owns (flag on, fence transferred, usable). */
  ownedBots(): BotIdentity[] {
    return [...this.identities.values()].filter((identity) => {
      if (!identity.enabled || !identity.usable) return false;
      return readFence(this.paths, identity.id, this.ctx).owner === 'ingress';
    });
  }

  state(): BotRuntimeState[] {
    return [...this.runtime.values()];
  }

  /** Start a poll loop for every bot ingress owns. Idempotent. */
  start(): void {
    this.stopping = false;
    this.routing = loadRoutingTable(this.paths);
    for (const identity of this.ownedBots()) {
      if (this.loops.has(identity.id)) continue;
      const loop = this.runBot(identity).catch((err) => {
        this.log(`[ingress] ${identity.id} loop exited: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.loops.set(identity.id, loop);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const loops = [...this.loops.values()];
    this.loops.clear();
    await Promise.all(loops);
    for (const bot of this.runtime.keys()) {
      releasePollerLock(this.paths, bot, this.ownerIdFor(bot));
      const rt = this.runtime.get(bot);
      if (rt) rt.running = false;
    }
  }

  private ownerIdFor(bot: string): string {
    return `ingress:${bot}`;
  }

  private rt(bot: string): BotRuntimeState {
    let rt = this.runtime.get(bot);
    if (!rt) {
      rt = {
        bot,
        running: false,
        fence_token: 0,
        offset: readOffset(this.paths, bot),
        consecutive_failures: 0,
        backoff_ms: 0,
        accepted: 0,
        refused: 0,
      };
      this.runtime.set(bot, rt);
    }
    return rt;
  }

  private async runBot(identity: BotIdentity): Promise<void> {
    const bot = identity.id;
    const rt = this.rt(bot);
    const owner = this.ownerIdFor(bot);

    try {
      acquirePollerLock(this.paths, bot, owner, this.ctx);
    } catch (err) {
      if (err instanceof PollerLockHeldError) {
        this.log(`[ingress] ${bot}: another poller holds the lock — not starting a second one.`);
        return;
      }
      throw err;
    }

    const transport = this.transportFactory(identity);
    if (!transport) {
      this.log(`[ingress] ${bot}: no transport available (token key ${identity.tokenEnvKey} unreadable) — not polling.`);
      releasePollerLock(this.paths, bot, owner);
      return;
    }

    const fence = readFence(this.paths, bot, this.ctx);
    rt.fence_token = fence.fence_token;
    rt.offset = Math.max(readOffset(this.paths, bot), fence.checkpoint_offset);
    rt.running = true;

    try {
      while (!this.stopping) {
        try {
          assertFence(this.paths, bot, 'ingress', rt.fence_token, this.ctx);
        } catch (err) {
          if (err instanceof FenceConflictError) {
            this.log(`[ingress] ${bot}: ${err.message} Stopping this loop.`);
            break;
          }
          throw err;
        }
        renewPollerLock(this.paths, bot, owner, this.ctx);

        try {
          await this.pollOnce(identity, transport, rt);
          rt.consecutive_failures = 0;
          rt.backoff_ms = 0;
          delete rt.last_error;
        } catch (err) {
          // Per-bot backoff. Nothing here touches any other bot's loop.
          rt.consecutive_failures += 1;
          rt.last_error = err instanceof Error ? err.message : String(err);
          rt.backoff_ms = Math.min(
            this.maxBackoffMs,
            this.pollIntervalMs * Math.pow(2, Math.min(rt.consecutive_failures, 12)),
          );
          this.log(
            `[ingress] ${bot}: poll failed (${rt.consecutive_failures} consecutive) — ` +
            `backing off ${rt.backoff_ms}ms. ${rt.last_error}`,
          );
        }
        await this.sleep(rt.backoff_ms || this.pollIntervalMs);
      }
    } finally {
      rt.running = false;
      releasePollerLock(this.paths, bot, owner);
    }
  }

  /**
   * One poll cycle for one bot.
   *
   * Ordering is the contract: for each update we persist the record and accept
   * the work FIRST, and only then advance and persist the offset. An exception
   * anywhere before that leaves the update un-acknowledged for redelivery.
   */
  async pollOnce(identity: BotIdentity, transport: IngressTransport, rtIn?: BotRuntimeState): Promise<number> {
    const bot = identity.id;
    const rt = rtIn ?? this.rt(bot);
    const result = await transport.getUpdates(rt.offset, this.pollTimeoutSec);
    const updates = (result?.result ?? []) as TelegramUpdate[];
    let handled = 0;
    for (const update of updates) {
      this.admitUpdate(identity, update);
      handled += 1;
      rt.offset = writeOffset(this.paths, bot, update.update_id + 1, this.ctx);
    }
    return handled;
  }

  /**
   * Persist and route one update. Safe to call twice with the same update:
   * `persistInbound` and `acceptWork` are both idempotent on their keys, so a
   * redelivery produces no second record and no second effect.
   */
  admitUpdate(identity: BotIdentity, update: TelegramUpdate): InboundRecord {
    const bot = identity.id;
    const rt = this.rt(bot);
    const kind: InboundRecord['kind'] = update.callback_query
      ? 'callback_query'
      : update.message_reaction
        ? 'message_reaction'
        : 'message';
    const from =
      update.message?.from?.id ??
      update.callback_query?.from?.id ??
      update.message_reaction?.user?.id;
    const chatId = String(
      update.message?.chat?.id ??
      update.callback_query?.message?.chat?.id ??
      update.message_reaction?.chat?.id ??
      identity.chatId ??
      '',
    );
    const text = stripControlChars(
      update.message?.text ?? update.message?.caption ?? update.callback_query?.data ?? '',
    );

    const decision = routeUpdate(this.routing, identity, from);
    const record = newInboundRecord(
      bot,
      update.update_id,
      {
        reply_route: { bot, chat_id: chatId },
        chat_id: chatId,
        kind,
        role: decision.role,
        ...(decision.person ? { person: decision.person } : {}),
        ...(typeof from === 'number' ? { from_user_id: from } : {}),
        ...(decision.targetAgent ? { target_agent: decision.targetAgent } : {}),
        ...(decision.mode ? { mode: decision.mode } : {}),
        ...(text ? { text } : {}),
        status: decision.authorized ? 'accepted' : 'refused',
        ...(decision.authorized ? {} : { reason: decision.reason }),
      },
      this.ctx,
    );

    const { record: stored, created } = persistInbound(this.paths, record);
    if (!decision.authorized) {
      if (created) {
        rt.refused += 1;
        this.log(`[ingress] ${bot}: refused update ${update.update_id} — ${decision.reason}`);
      }
      return stored;
    }

    // Accept durably before the caller advances the offset.
    acceptWork(
      this.paths,
      {
        owner: decision.targetAgent ?? decision.role,
        work_class: workClassFor(decision.role),
        dedupe_key: stored.dedupe_key,
        payload: {
          kind: stored.kind,
          bot_identity: bot,
          update_id: stored.update_id,
          reply_route: stored.reply_route,
          role: stored.role,
          ...(stored.mode ? { mode: stored.mode } : {}),
          ...(stored.person ? { person: stored.person } : {}),
          ...(stored.text ? { text: stored.text } : {}),
        },
      },
      this.ctx,
    );
    if (created) {
      rt.accepted += 1;
      updateInbound(this.paths, bot, update.update_id, { status: 'dispatched' });
    }
    return stored;
  }
}

/**
 * True when `agent-manager` must NOT start its own poller for this agent.
 * Re-exported here so the daemon has one import for the whole decision.
 */
export function shouldAgentPollerStandDown(paths: IngressPaths, bot: string, ctx: IngressContext = {}): boolean {
  return agentPollerSuppressed(paths, bot, ctx);
}
