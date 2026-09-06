/**
 * OS-07 integration — the outcome this package exists for.
 *
 * Raquel messages Vera while Vera's worker is being restarted onto a different
 * model. The instruction must be accepted durably, executed exactly once when
 * the worker comes back, and answered through Vera's own bot — with no window
 * in which two pollers are live on the same bot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIngressPaths, runExactlyOnce, type IngressPaths } from '../../src/ingress/state.js';
import { enumerateBotIdentities } from '../../src/ingress/identity.js';
import { enableMultiplexed, revertToAgent, agentPollerSuppressed } from '../../src/ingress/cutover.js';
import { MultiplexedIngress, type IngressTransport } from '../../src/ingress/service.js';
import { listInbound } from '../../src/ingress/inbox.js';
import {
  listRecords,
  leaseWork,
  ackWork,
  reconcileOnRestart,
  selectDispatchable,
  dispatchIdFor,
} from '../../src/ingress/dispatch.js';
import { enqueueReply, drainOutbox } from '../../src/ingress/outbox.js';
import { readOffset } from '../../src/ingress/fence.js';

const RAQUEL = 4242;
const SENTINEL_TOKEN = '111111111:ZZTEST-TOKEN-SENTINEL-aaaaaaaaaaaaaaaaaaaaa';

let root: string;
let framework: string;
let paths: IngressPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os07-int-'));
  framework = mkdtempSync(join(tmpdir(), 'os07-intfw-'));
  paths = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
  const dir = join(framework, 'orgs', 'uhs', 'agents', 'vera');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), `BOT_TOKEN=${SENTINEL_TOKEN}\nCHAT_ID=1001\nALLOWED_USER=${RAQUEL}\n`);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: 'vera', enabled: true }));
  // The agent-owned poller had consumed up to update 3000 before the cutover.
  mkdirSync(join(root, 'state', 'vera'), { recursive: true });
  writeFileSync(join(root, 'state', 'vera', '.telegram-offset'), '3000', 'utf-8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(framework, { recursive: true, force: true });
});

function update(id: number, text: string) {
  return {
    update_id: id,
    message: { message_id: id, from: { id: RAQUEL, first_name: 'Raquel' }, chat: { id: 1001 }, text },
  } as any;
}

describe('OS-07 — a persona answers while its worker restarts', () => {
  it('accepts, executes once and replies through the same bot across a restart', async () => {
    // --- cutover -----------------------------------------------------------
    const overlap: boolean[] = [];
    const transferred = await enableMultiplexed(paths, 'vera', {
      legacyOffsetFile: join(root, 'state', 'vera', '.telegram-offset'),
      actor: 'ZZTEST',
      reason: 'ZZTEST-OS07 integration',
      stopOldPoller: () => { overlap.push(agentPollerSuppressed(paths, 'vera')); },
    });
    expect(transferred.ok).toBe(true);
    // Neither side admitted during the hand-off, and the checkpoint came over.
    expect(overlap).toEqual([true]);
    expect(readOffset(paths, 'vera')).toBe(3000);
    // agent-manager's gate now says: do not start the per-agent poller.
    expect(agentPollerSuppressed(paths, 'vera')).toBe(true);

    // --- Raquel writes while Vera's worker is DOWN -------------------------
    const identity = enumerateBotIdentities(framework, 'uhs').find((i) => i.id === 'vera')!;
    const transport: IngressTransport = {
      async getUpdates() {
        return { ok: true, result: [update(3001, 'push the Sable Ridge removal to Thursday')] };
      },
      async sendMessage() {
        throw new Error('the ingress must not send directly — replies go through the outbox');
      },
    };
    const ingress = new MultiplexedIngress({
      paths,
      identities: [identity],
      transportFactory: () => transport,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    });
    await ingress.pollOnce(identity, transport);

    const inbound = listInbound(paths, 'vera');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].status).toBe('dispatched');
    expect(readOffset(paths, 'vera')).toBe(3002);
    const queued = listRecords(paths);
    expect(queued).toHaveLength(1);
    expect(queued[0].owner).toBe('vera');

    // --- the worker comes back, crashes mid-attempt, then retries ----------
    let stageforceWrites = 0;
    const doWork = () =>
      runExactlyOnce(paths, `effect:${inbound[0].dedupe_key}`, async () => {
        stageforceWrites += 1;
        return 'moved';
      });

    const id = dispatchIdFor(inbound[0].dedupe_key);
    // Attempt 1: leased with a lease that is already expired (worker died).
    leaseWork(paths, id, 'vera-worker-old', 1, { now: () => new Date(Date.now() - 60_000) });
    // It died BEFORE doing anything external.
    expect(reconcileOnRestart(paths).requeued).toEqual([id]);

    // Attempt 2: the restarted worker picks the same row up and does the work.
    const eligible = selectDispatchable(paths);
    expect(eligible.map((r) => r.id)).toEqual([id]);
    const handle = leaseWork(paths, id, 'vera-worker-new');
    expect((await doWork()).status).toBe('executed');
    // A third replay of the same instruction changes nothing.
    expect((await doWork()).status).toBe('skipped');
    expect(stageforceWrites).toBe(1);

    // --- the reply leaves through Vera's bot, not any other ----------------
    enqueueReply(paths, {
      bot: inbound[0].reply_route.bot,
      chat_id: inbound[0].reply_route.chat_id,
      text: 'Moved to Thursday 8am. Calendar and Stageforce both updated.',
      dedupe_key: `reply:${inbound[0].dedupe_key}`,
    });
    // Enqueuing the same reply twice must not answer twice.
    enqueueReply(paths, {
      bot: 'vera',
      chat_id: '1001',
      text: 'Moved to Thursday 8am. Calendar and Stageforce both updated.',
      dedupe_key: `reply:${inbound[0].dedupe_key}`,
    });
    const sent: Array<[string, string]> = [];
    await drainOutbox(paths, async (bot, chatId) => {
      sent.push([bot, chatId]);
      return 1;
    });
    expect(sent).toEqual([['vera', '1001']]);
    expect(ackWork(paths, handle).state).toBe('done');

    // A second drain sends nothing — `sent` rows are terminal.
    const again: string[] = [];
    await drainOutbox(paths, async (bot) => { again.push(bot); return 1; });
    expect(again).toEqual([]);

    // --- revert loses nothing ---------------------------------------------
    const reverted = await revertToAgent(paths, 'vera', {
      legacyOffsetFile: join(root, 'state', 'vera', '.telegram-offset'),
    });
    expect(reverted.ok).toBe(true);
    expect(reverted.checkpoint_offset).toBe(3002);
    expect(agentPollerSuppressed(paths, 'vera')).toBe(false);
    // The agent's own offset file is still the pre-cutover value; the
    // authoritative checkpoint is the fence, which the agent poller reads
    // through the ingress state on its next start.
    expect(readFileSync(join(root, 'state', 'vera', '.telegram-offset'), 'utf-8').trim()).toBe('3000');
    expect(readOffset(paths, 'vera')).toBe(3002);
  });

  it('never writes a token value into any ingress state file', async () => {
    await enableMultiplexed(paths, 'vera', {});
    const identity = enumerateBotIdentities(framework, 'uhs').find((i) => i.id === 'vera')!;
    const transport: IngressTransport = {
      async getUpdates() { return { ok: true, result: [update(1, 'hello')] }; },
      async sendMessage() { return {}; },
    };
    const ingress = new MultiplexedIngress({ paths, identities: [identity], transportFactory: () => transport });
    await ingress.pollOnce(identity, transport);

    const { execSync } = await import('child_process');
    const hits = execSync(`grep -rl 'ZZTEST-TOKEN-SENTINEL' ${JSON.stringify(paths.root)} || true`, { encoding: 'utf-8' }).trim();
    expect(hits).toBe('');
  });
});
