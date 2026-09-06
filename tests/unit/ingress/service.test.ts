/**
 * OS-07 — multiplexed ingress service.
 *
 * The plan's persona scenario: "Raquel->Vera, Angelic->Vivienne and existing
 * Tron route accept durably and reply through the same bot; no cross-person
 * data" — and it must hold while the persona's worker is absent or restarting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIngressPaths, type IngressPaths } from '../../../src/ingress/state.js';
import { enumerateBotIdentities, type BotIdentity } from '../../../src/ingress/identity.js';
import { enableMultiplexed } from '../../../src/ingress/cutover.js';
import { MultiplexedIngress, type IngressTransport } from '../../../src/ingress/service.js';
import { listInbound, hasInbound } from '../../../src/ingress/inbox.js';
import { listRecords } from '../../../src/ingress/dispatch.js';
import { readOffset } from '../../../src/ingress/fence.js';
import { enqueueReply, drainOutbox, listAll } from '../../../src/ingress/outbox.js';

const RAQUEL = 4242;
const ANGELIC = 5150;
const SCOTT = 8727328514;
const SENTINEL_TOKEN = '111111111:ZZTEST-TOKEN-SENTINEL-not-a-real-token';

let root: string;
let framework: string;
let paths: IngressPaths;

function writeAgent(name: string, allowed: number[], chatId: string, token = SENTINEL_TOKEN): void {
  const dir = join(framework, 'orgs', 'uhs', 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), `BOT_TOKEN=${token}\nCHAT_ID=${chatId}\nALLOWED_USER=${allowed.join(',')}\n`);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: name, enabled: true }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os07-svc-'));
  framework = mkdtempSync(join(tmpdir(), 'os07-fw-'));
  paths = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
  writeAgent('vera', [RAQUEL], '1001');
  writeAgent('vivienne', [ANGELIC], '1002');
  writeAgent('jarvis-telegram', [SCOTT], '1003');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(framework, { recursive: true, force: true });
});

function identities(): BotIdentity[] {
  return enumerateBotIdentities(framework, 'uhs');
}

function textUpdate(updateId: number, fromId: number, chatId: number, text: string) {
  return {
    update_id: updateId,
    message: { message_id: updateId, from: { id: fromId, first_name: 'X' }, chat: { id: chatId }, text },
  } as any;
}

/** Transport that hands out a scripted batch once, then nothing. */
function scriptedTransport(batches: any[][]): IngressTransport & { sent: Array<[string, string]> } {
  let i = 0;
  const sent: Array<[string, string]> = [];
  return {
    sent,
    async getUpdates() {
      return { ok: true, result: batches[i++] ?? [] };
    },
    async sendMessage(chatId: string, text: string) {
      sent.push([chatId, text]);
      return { ok: true };
    },
  };
}

function ingressFor(map: Record<string, IngressTransport>): MultiplexedIngress {
  return new MultiplexedIngress({
    paths,
    identities: identities(),
    transportFactory: (identity) => map[identity.id],
    // Real (tiny) sleep: an instantly-resolving stub would spin the microtask
    // queue and starve the timers the test itself waits on.
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    pollIntervalMs: 1,
    maxBackoffMs: 20,
  });
}

describe('OS-07 multiplexed ingress', () => {
  it('lists an agent whose BOT_TOKEN is present but empty, marked unusable', () => {
    // Seven UHS agents are in exactly this state. They must be visible in
    // `ingress list` rather than silently missing — an identity nobody can
    // account for is how a listener gets retired by accident.
    const dir = join(framework, 'orgs', 'uhs', 'agents', 'jarvis-mls');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'BOT_TOKEN=\nCHAT_ID=\n');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: 'jarvis-mls', enabled: true }));

    const found = identities().find((i) => i.id === 'jarvis-mls');
    expect(found).toBeDefined();
    expect(found!.usable).toBe(false);
    expect(found!.reason).toMatch(/present but empty/);
    // An unusable identity is never polled.
    expect(ingressFor({}).ownedBots().map((b) => b.id)).not.toContain('jarvis-mls');
  });

  it('skips an agent with no BOT_TOKEN key at all', () => {
    const dir = join(framework, 'orgs', 'uhs', 'agents', 'no-bot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'CHAT_ID=1\n');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: 'no-bot', enabled: true }));
    expect(identities().map((i) => i.id)).not.toContain('no-bot');
  });

  it('enumerates every configured identity by token env key, never by value', () => {
    const list = identities();
    expect(list.map((i) => i.id).sort()).toEqual(['jarvis-telegram', 'vera', 'vivienne']);
    for (const identity of list) {
      expect(identity.tokenEnvKey).toBe('BOT_TOKEN');
      expect(JSON.stringify(identity)).not.toContain('ZZTEST-TOKEN-SENTINEL');
      expect(identity.usable).toBe(true);
    }
  });

  it('accepts a persona message durably while the worker is absent, and answers through the same bot', async () => {
    await enableMultiplexed(paths, 'vera', {});
    const vera = scriptedTransport([[textUpdate(500, RAQUEL, 1001, 'is the Talus install still on for Tuesday?')]]);
    const ingress = ingressFor({ vera });

    // No agent process exists at all here — that is the point of the test.
    await ingress.pollOnce(identities().find((i) => i.id === 'vera')!, vera);

    const inbound = listInbound(paths, 'vera');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].status).toBe('dispatched');
    expect(inbound[0].role).toBe('vera');
    expect(inbound[0].reply_route).toEqual({ bot: 'vera', chat_id: '1001' });
    expect(readOffset(paths, 'vera')).toBe(501);

    const queue = listRecords(paths);
    expect(queue).toHaveLength(1);
    expect(queue[0].owner).toBe('vera');
    expect(queue[0].state).toBe('pending');

    // The worker comes back later and replies. The route comes off the record,
    // so the answer cannot leave through another bot.
    enqueueReply(paths, {
      bot: inbound[0].reply_route.bot,
      chat_id: inbound[0].reply_route.chat_id,
      text: 'Yes — Tuesday 9am, crew of three.',
      dedupe_key: `reply:${inbound[0].dedupe_key}`,
      in_reply_to: { bot: 'vera', update_id: 500 },
    });
    const sends: Array<[string, string, string]> = [];
    await drainOutbox(paths, async (bot, chatId, text) => {
      sends.push([bot, chatId, text]);
      return 77;
    });
    expect(sends).toEqual([['vera', '1001', 'Yes — Tuesday 9am, crew of three.']]);
    expect(listAll(paths)[0].status).toBe('sent');
  });

  it('keeps the ALLOWED_USER gate: Angelic cannot drive Vera and vice versa', async () => {
    await enableMultiplexed(paths, 'vera', {});
    const vera = scriptedTransport([[textUpdate(1, ANGELIC, 1001, 'show me Raquel’s load list')]]);
    const ingress = ingressFor({ vera });
    await ingress.pollOnce(identities().find((i) => i.id === 'vera')!, vera);

    const inbound = listInbound(paths, 'vera');
    expect(inbound[0].status).toBe('refused');
    expect(inbound[0].reason).toMatch(/not in ALLOWED_USER/);
    // Refused work is never dispatched — no cross-person data reaches a worker.
    expect(listRecords(paths)).toHaveLength(0);
    // The offset still advances: the update is durably recorded as refused,
    // not silently dropped and not re-delivered forever.
    expect(readOffset(paths, 'vera')).toBe(2);
  });

  it('routes each person to their own role and bot', async () => {
    await enableMultiplexed(paths, 'vera', {});
    await enableMultiplexed(paths, 'vivienne', {});
    await enableMultiplexed(paths, 'jarvis-telegram', {});
    const vera = scriptedTransport([[textUpdate(10, RAQUEL, 1001, 'a')]]);
    const vivienne = scriptedTransport([[textUpdate(20, ANGELIC, 1002, 'b')]]);
    const jarvis = scriptedTransport([[textUpdate(30, SCOTT, 1003, 'c')]]);
    const ingress = ingressFor({ vera, vivienne, 'jarvis-telegram': jarvis });
    const byId = new Map(identities().map((i) => [i.id, i]));
    await ingress.pollOnce(byId.get('vera')!, vera);
    await ingress.pollOnce(byId.get('vivienne')!, vivienne);
    await ingress.pollOnce(byId.get('jarvis-telegram')!, jarvis);

    expect(listInbound(paths, 'vera')[0].role).toBe('vera');
    expect(listInbound(paths, 'vivienne')[0].role).toBe('vivienne');
    expect(listInbound(paths, 'jarvis-telegram')[0].role).toBe('ingress');
    const owners = listRecords(paths).map((r) => r.owner).sort();
    expect(owners).toEqual(['jarvis-telegram', 'vera', 'vivienne']);
  });

  it('does not advance the offset past an update it failed to persist', async () => {
    await enableMultiplexed(paths, 'vera', {});
    const vera = scriptedTransport([[textUpdate(7, RAQUEL, 1001, 'first'), textUpdate(8, RAQUEL, 1001, 'second')]]);
    const ingress = ingressFor({ vera });
    const identity = identities().find((i) => i.id === 'vera')!;
    await ingress.pollOnce(identity, vera);
    expect(readOffset(paths, 'vera')).toBe(9);

    // Now prove the failure path: an admit that throws leaves the offset put.
    const before = readOffset(paths, 'vera');
    const failing = scriptedTransport([[textUpdate(9, RAQUEL, 1001, 'third')]]);
    vi.spyOn(ingress, 'admitUpdate').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(ingress.pollOnce(identity, failing)).rejects.toThrow('disk full');
    expect(readOffset(paths, 'vera')).toBe(before);
  });

  it('a redelivered update produces no second record and no second dispatch', async () => {
    await enableMultiplexed(paths, 'vera', {});
    const identity = identities().find((i) => i.id === 'vera')!;
    const first = scriptedTransport([[textUpdate(99, RAQUEL, 1001, 'move the Durango install')]]);
    const ingress = ingressFor({ vera: first });
    await ingress.pollOnce(identity, first);
    // Telegram redelivers the same update after a crash before the ack.
    const again = scriptedTransport([[textUpdate(99, RAQUEL, 1001, 'move the Durango install')]]);
    await ingress.pollOnce(identity, again);

    expect(listInbound(paths, 'vera')).toHaveLength(1);
    expect(listRecords(paths)).toHaveLength(1);
    expect(hasInbound(paths, 'vera', 99)).toBe(true);
  });

  it('one bot with a bad token backs off without stalling the others', async () => {
    await enableMultiplexed(paths, 'vera', {});
    await enableMultiplexed(paths, 'vivienne', {});
    let veraCalls = 0;
    let vivienneCalls = 0;
    const vera: IngressTransport = {
      async getUpdates() {
        veraCalls += 1;
        throw new Error('401 Unauthorized');
      },
      async sendMessage() {
        return {};
      },
    };
    const vivienne: IngressTransport = {
      async getUpdates() {
        vivienneCalls += 1;
        return { ok: true, result: vivienneCalls === 1 ? [textUpdate(1, ANGELIC, 1002, 'hi')] : [] };
      },
      async sendMessage() {
        return {};
      },
    };
    const ingress = ingressFor({ vera, vivienne });
    ingress.start();
    await new Promise((r) => setTimeout(r, 60));
    await ingress.stop();

    const veraState = ingress.state().find((s) => s.bot === 'vera')!;
    expect(veraCalls).toBeGreaterThan(0);
    expect(veraState.consecutive_failures).toBeGreaterThan(0);
    expect(veraState.backoff_ms).toBeGreaterThan(0);
    expect(veraState.last_error).toMatch(/401/);
    // Vivienne kept working through Vera's failure.
    expect(vivienneCalls).toBeGreaterThan(0);
    expect(listInbound(paths, 'vivienne')).toHaveLength(1);
    expect(listInbound(paths, 'vera')).toHaveLength(0);
  });

  it('only polls bots whose fence has been transferred to ingress', async () => {
    const ingress = ingressFor({});
    expect(ingress.ownedBots()).toEqual([]);
    await enableMultiplexed(paths, 'vivienne', {});
    expect(ingressFor({}).ownedBots().map((b) => b.id)).toEqual(['vivienne']);
  });
});
