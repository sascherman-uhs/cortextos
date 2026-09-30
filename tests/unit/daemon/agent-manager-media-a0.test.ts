/**
 * A0 wiring in the daemon's Telegram handler (agent-manager):
 *   - the raw media record persisted at receipt carries file_id, media_type
 *     and message_id;
 *   - the outstanding-media-job counter rises when the round trip starts and
 *     falls only AFTER the completion has been handed to the durable record
 *     (the counter the rollback drain waits on);
 *   - the poller is given the intake pause gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const h = vi.hoisted(() => ({
  handler: null as null | ((msg: any, updateId: number) => unknown),
  gate: null as any,
  persisted: [] as any[],
  completions: [] as Array<{ id: number; fields: any; jobsAtCompletion: number }>,
  finishMedia: null as null | ((v: any) => void),
  intake: null as any,
}));

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    constructor(public name: string) {}
    async start() {}
    async stop() {}
    getStatus() { return { name: this.name, status: 'running' }; }
    onExit() {}
    onStatusChanged() {}
    setTelegramHandle() {}
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { return Promise.resolve(); }
    stop() {}
    wake() {}
    persistPendingTelegram(rec: any) { h.persisted.push(rec); return true; }
    completePendingMedia(id: number, fields: any) {
      h.completions.push({ id, fields, jobsAtCompletion: h.gate?.outstandingMediaJobs });
      return true;
    }
    static formatTelegramTextMessage() { return 'ZZTEST text block'; }
    static formatTelegramPhotoMessage() { return 'ZZTEST photo block'; }
    static readLastSent() { return null; }
  },
}));
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    async sendMessage() { return { ok: true }; }
    async getUpdates() { return { ok: true, result: [] }; }
  },
}));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    onMessage(fn: any) { h.handler = fn; }
    onCallback() {}
    onReaction() {}
    setIntakeGate(g: any) { h.gate = g; }
    lastExitReason = 'stopped-externally';
    async start() { return; }
    stop() {}
  },
}));
vi.mock('../../../src/telegram/media.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/telegram/media.js')>()),
  processMediaMessage: () => new Promise((r) => { h.finishMedia = r; }),
}));
vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { readIntakeStatus } = await import('../../../src/telegram/intake-control.js');

let framework: string;
let ctxRoot: string;

beforeEach(() => {
  process.env.TELEGRAM_DURABLE_QUEUE = '1';
  h.handler = null;
  h.gate = null;
  h.persisted.length = 0;
  h.completions.length = 0;
  framework = mkdtempSync(join(tmpdir(), 'zztest-a0-am-fw-'));
  ctxRoot = mkdtempSync(join(tmpdir(), 'zztest-a0-am-ctx-'));
});
afterEach(() => {
  delete process.env.TELEGRAM_DURABLE_QUEUE;
  rmSync(framework, { recursive: true, force: true });
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('agent-manager media handler (A0)', () => {
  it('records media identity, counts the job until its completion is handed over, and wires the pause gate', async () => {
    const dir = join(framework, 'orgs', 'uhs', 'agents', 'vera');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'BOT_TOKEN=111111111:ZZTEST-TOKEN-SENTINEL-aaaaaaaaaaaaaaaaaaaaa\nCHAT_ID=1001\nALLOWED_USER=4242\n');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: 'vera', enabled: true }));

    const manager = new AgentManager('default', ctxRoot, framework, 'uhs');
    await manager.startAgent('vera', dir, undefined, 'uhs');
    expect(h.handler).toBeTypeOf('function');
    expect(h.gate).toBeTruthy();

    const photoMsg = {
      message_id: 29415,
      date: 1790771289,
      chat: { id: 1001 },
      from: { id: 4242, first_name: 'Scott' },
      photo: [
        { file_id: 'ZZTEST-small', file_unique_id: 'a', width: 90, height: 90 },
        { file_id: 'ZZTEST-largest', file_unique_id: 'b', width: 1280, height: 960 },
      ],
    };
    const ack = await h.handler!(photoMsg, 462809160);
    expect(ack).toBe(true);

    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]).toMatchObject({
      update_id: 462809160,
      formatted: '',
      file_id: 'ZZTEST-largest',
      media_type: 'photo',
      message_id: 29415,
    });
    expect(h.gate.outstandingMediaJobs).toBe(1);
    expect(readIntakeStatus(join(ctxRoot, 'state', 'vera'))!.outstanding_media_jobs).toBe(1);

    h.finishMedia!({ type: 'photo', chat_id: 1001, from: 'Scott', text: '', date: 1, image_path: join(dir, 'telegram-images', 'x.jpg') });
    await vi.waitFor(() => expect(h.gate.outstandingMediaJobs).toBe(0));

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].id).toBe(462809160);
    // The completion was handed to the record while the job was still counted.
    expect(h.completions[0].jobsAtCompletion).toBe(1);
    expect(readIntakeStatus(join(ctxRoot, 'state', 'vera'))!.outstanding_media_jobs).toBe(0);
    await manager.stopAgent('vera');
  });
});
