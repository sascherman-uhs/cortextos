/**
 * Media wiring in the daemon's Telegram handler (agent-manager). Written for
 * A0; updated for A3 (2026-09-30), which replaced the in-handler round trip
 * with a generation-fenced media job:
 *   - the record inserted at receipt carries file_id, media_type, message_id,
 *     the update's token, media_state 'pending', gen 1, a deadline and a
 *     unique media_dest;
 *   - a redelivered update inserts nothing and starts no second download;
 *   - the outstanding-media-job counter rises when the job starts and falls
 *     only AFTER the completion has been handed to the checker (the counter
 *     the rollback drain waits on);
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
  completions: [] as Array<{ id: number; gen: number; result: any; jobsAtCompletion: number }>,
  finishMedia: null as null | ((v: any) => void),
  intake: null as any,
  downloader: null as any,
  started: [] as Array<{ id: number; gen: number }>,
  exists: new Set<number>(),
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
    insertPendingTelegram(rec: any) {
      if (h.exists.has(rec.update_id)) return 'exists';
      h.exists.add(rec.update_id);
      h.persisted.push(rec);
      return 'inserted';
    }
    pendingQueue() { return { mediaGraceMs: 180_000 }; }
    setMediaDownloader(d: any) { h.downloader = d; }
    startMediaJob(rec: any, gen: number) { h.started.push({ id: rec.update_id, gen }); h.downloader.start(rec, gen); }
    completeMediaDownload(id: number, gen: number, result: any) {
      h.completions.push({ id, gen, result, jobsAtCompletion: h.gate?.outstandingMediaJobs });
      return 'landed';
    }
    failMediaDownload() {}
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
  downloadTelegramFileTo: () => new Promise((r) => { h.finishMedia = r; }),
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
  h.started.length = 0;
  h.exists.clear();
  h.downloader = null;
  framework = mkdtempSync(join(tmpdir(), 'zztest-a0-am-fw-'));
  ctxRoot = mkdtempSync(join(tmpdir(), 'zztest-a0-am-ctx-'));
});
afterEach(() => {
  delete process.env.TELEGRAM_DURABLE_QUEUE;
  rmSync(framework, { recursive: true, force: true });
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('agent-manager media handler (A0 → A3)', () => {
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
      file_unique_id: 'b',
      media_type: 'photo',
      message_id: 29415,
      message_date: 1790771289,
      token: '\u27E6u:462809160\u27E7',
      header: '\u27E6u:462809160\u27E7',
      media_state: 'pending',
      media_gen: 1,
      media_retries: 0,
      media_dest: 'telegram-images/462809160-photo-b.jpg',
      ack_stage: 0,
    });
    expect(Date.parse(h.persisted[0].media_deadline_at) - Date.parse(h.persisted[0].created_at)).toBe(180_000);
    expect(h.started).toEqual([{ id: 462809160, gen: 1 }]);
    expect(h.gate.outstandingMediaJobs).toBe(1);
    expect(readIntakeStatus(join(ctxRoot, 'state', 'vera'))!.outstanding_media_jobs).toBe(1);

    // Telegram redelivers the same update (offset not yet acked): no new
    // record, no second download.
    expect(await h.handler!(photoMsg, 462809160)).toBe(true);
    expect(h.persisted).toHaveLength(1);
    expect(h.started).toHaveLength(1);

    h.finishMedia!(undefined);
    await vi.waitFor(() => expect(h.gate.outstandingMediaJobs).toBe(0));

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]).toMatchObject({ id: 462809160, gen: 1 });
    expect(h.completions[0].result.partPath).toBe(join(dir, 'telegram-images', '462809160-photo-b.jpg.part.1'));
    // The completion was handed to the checker while the job was still counted.
    expect(h.completions[0].jobsAtCompletion).toBe(1);
    expect(readIntakeStatus(join(ctxRoot, 'state', 'vera'))!.outstanding_media_jobs).toBe(0);
    await manager.stopAgent('vera');
  });
});
