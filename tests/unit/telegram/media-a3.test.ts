/**
 * A3 — media state, one block, one deadline — plus V4-3 startup
 * reconciliation and V4-4 late-success policy.
 *
 * Records are built the way the daemon now builds them at receipt
 * (agent-manager: newRecord + media_state/gen/deadline/dest), from the
 * recorded incident message (update 462809160 / message 29415, a captionless
 * photo, 2026-09-30T11:41:31Z).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { PendingTelegramQueue, LATE_MEDIA_PREFIX, MEDIA_GRACE_MS, newRecord, type PendingTelegramRecord } from '../../../src/telegram/pending-queue';
import { mediaReceipt, partPathFor } from '../../../src/telegram/media';
import { telegramToken } from '../../../src/telegram/submission-proof';
import type { BusPaths } from '../../../src/types';

const CHAT = '8727328514';
const ID = 462809160;
const TOKEN = telegramToken(ID);
const T0 = Date.parse('2026-09-30T11:41:31.338Z');

let root: string;
let agentDir: string;
let paths: BusPaths;
let agent: any;
let api: { sendMessage: ReturnType<typeof vi.fn>; sendChatAction: ReturnType<typeof vi.fn> };
let checker: any;
let q: PendingTelegramQueue;
let logs: string[];
let started: Array<{ id: number; gen: number }>;

function mkPaths(dir: string): BusPaths {
  const p: any = {
    root: dir, stateDir: join(dir, 'state'), logDir: join(dir, 'logs'), inboxDir: join(dir, 'inbox'),
    taskDir: join(dir, 'tasks'), approvalDir: join(dir, 'approvals'), analyticsDir: join(dir, 'analytics'), heartbeatDir: join(dir, 'heartbeats'),
  };
  for (const d of Object.values(p) as string[]) if (d !== dir) mkdirSync(d, { recursive: true });
  return p as BusPaths;
}

function newChecker(withDownloader = true) {
  const c = new FastChecker(agent, paths, '/tmp/framework', {
    telegramApi: api as any,
    chatId: CHAT,
    log: (m: string) => logs.push(m),
    proofMode: 'pty',
  }) as any;
  if (withDownloader) c.setMediaDownloader({ start: (rec: PendingTelegramRecord, gen: number) => started.push({ id: rec.update_id, gen }) });
  return c;
}

async function cycleAt(t: number) {
  vi.setSystemTime(t);
  const p = checker.durableTelegramCycle();
  await vi.advanceTimersByTimeAsync(5_000);
  await p;
}

/** The record the daemon writes at receipt for the recorded photo. */
function photoAtReceipt(caption = ''): PendingTelegramRecord {
  const msg: any = {
    message_id: 29415, date: 1790771289, chat: { id: Number(CHAT) }, from: { id: 1, first_name: 'Scott' },
    photo: [{ file_id: 'ZZTEST-small', file_unique_id: 'AQADsmall' }, { file_id: 'ZZTEST-largest', file_unique_id: 'AQADlarge' }],
    ...(caption ? { caption } : {}),
  };
  const receipt = mediaReceipt(msg, ID)!;
  const rec = newRecord({ update_id: ID, chat_id: CHAT, from: 'Scott', text: caption, token: TOKEN, file_id: receipt.file_id, media_type: receipt.media_type, message_id: 29415 });
  rec.created_at = new Date(T0).toISOString();
  rec.media_state = 'pending';
  rec.media_gen = 1;
  rec.media_retries = 0;
  rec.media_deadline_at = new Date(T0 + MEDIA_GRACE_MS).toISOString();
  rec.media_dest = receipt.media_dest;
  rec.file_unique_id = receipt.file_unique_id;
  rec.message_date = 1790771289;
  return rec;
}

/** Receipt as the daemon does it: insert, then start the gen-1 job in THIS process. */
function receive(caption = ''): PendingTelegramRecord {
  const rec = photoAtReceipt(caption);
  expect(q.insert(rec)).toBe('inserted');
  checker.startMediaJob(rec, 1);
  started.length = 0;
  return rec;
}

/** What the media job leaves behind: the bytes at <dest>.part.<gen>. */
function downloaded(gen: number): string {
  const part = partPathFor(join(agentDir, `telegram-images/${ID}-photo-AQADlarge.jpg`), gen);
  mkdirSync(join(agentDir, 'telegram-images'), { recursive: true });
  writeFileSync(part, `ZZTEST jpeg bytes gen ${gen}`);
  return part;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  process.env.TELEGRAM_DURABLE_QUEUE = '1';
  root = mkdtempSync(join(tmpdir(), 'zztest-a3-'));
  agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  paths = mkPaths(root);
  logs = [];
  started = [];
  agent = {
    name: 'jarvis-telegram',
    isBootstrapped: vi.fn(() => true),
    injectMessageDetailed: vi.fn(() => ({ ok: true })),
    transcriptContains: vi.fn(() => false),
    isAtPrompt: vi.fn(() => true),
    hasModalOpen: vi.fn(() => false),
    getStrippedTail: vi.fn(() => ''),
    getPtyInstance: vi.fn(() => 'pty-A'),
    getAgentDir: vi.fn(() => agentDir),
    getConfig: vi.fn(() => ({ runtime: 'hermes' })),
    write: vi.fn(),
  };
  api = { sendMessage: vi.fn().mockResolvedValue({ ok: true }), sendChatAction: vi.fn() };
  checker = newChecker();
  q = checker.pendingQueue();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TELEGRAM_DURABLE_QUEUE;
  rmSync(root, { recursive: true, force: true });
});

const injectedPayloads = () => agent.injectMessageDetailed.mock.calls.map((c: any[]) => String(c[0]));
const sent = () => api.sendMessage.mock.calls.map((c) => String(c[1]));

describe('receipt', () => {
  it('identical filenames in the same second land at different paths (update_id prefix)', () => {
    const doc = (id: number) => mediaReceipt({ message_id: id, date: 1, chat: { id: 1 }, document: { file_id: `f${id}`, file_unique_id: `u${id}`, file_name: 'scan.pdf' } } as any, id)!;
    expect(doc(1).media_dest).toBe('telegram-images/1-scan.pdf');
    expect(doc(2).media_dest).toBe('telegram-images/2-scan.pdf');
  });
});

describe('the normal path', () => {
  it('held while pending; the gen-1 completion renames into place and lands ONE ready block carrying the token', async () => {
    receive();
    await cycleAt(T0 + 1_000);
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(checker.completeMediaDownload(ID, 1, { partPath: downloaded(1) })).toBe('landed');
    const r = q.read(ID)!;
    expect(r.media_state).toBe('ready');
    expect(r.formatted.split('\n')[0]).toBe(`=== TELEGRAM PHOTO from Scott ${TOKEN} (chat_id:${CHAT}) ===`);
    expect(r.formatted).toContain(`local_file: telegram-images/${ID}-photo-AQADlarge.jpg`);
    expect(existsSync(join(agentDir, `telegram-images/${ID}-photo-AQADlarge.jpg`))).toBe(true);
    await cycleAt(T0 + 3_000);
    expect(injectedPayloads()).toHaveLength(1);
    expect(injectedPayloads()[0]).toContain(TOKEN);
  });
});

describe('deadline → retry → fenced late completion', () => {
  it('gen 1 misses its deadline, gen 2 starts; gen 1 landing late is STALE and discarded; gen 2 lands', async () => {
    receive();
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    expect(started).toEqual([{ id: ID, gen: 2 }]);
    expect(q.read(ID)).toMatchObject({ media_gen: 2, media_retries: 1, media_state: 'pending' });
    const late = downloaded(1);
    expect(checker.completeMediaDownload(ID, 1, { partPath: late })).toBe('stale');
    expect(existsSync(late)).toBe(false);
    expect(q.read(ID)!.media_state).toBe('pending');
    expect(checker.completeMediaDownload(ID, 2, { partPath: downloaded(2) })).toBe('landed');
    expect(q.read(ID)!.media_state).toBe('ready');
  });

  it('an immediate job failure pulls the deadline in: retried on the next cycle, not after 3 minutes', async () => {
    receive();
    vi.setSystemTime(T0 + 2_000);
    checker.failMediaDownload(ID, 1, new Error('ZZTEST getFile 502'));
    await cycleAt(T0 + 3_000);
    expect(started).toEqual([{ id: ID, gen: 2 }]);
  });
});

describe('failure after the retry — one block, one deadline', () => {
  it('captioned: ONE block (caption + failed-to-download note) is injected; a later success is logged, not re-injected', async () => {
    receive('ZZTEST record all these capacities');
    await cycleAt(T0 + MEDIA_GRACE_MS + 1); // retry as gen 2
    await cycleAt(T0 + 2 * MEDIA_GRACE_MS + 10_000); // gen 2 missed too => failed, caption block injected
    expect(q.read(ID)!.media_state).toBe('failed');
    expect(injectedPayloads()).toHaveLength(1);
    expect(injectedPayloads()[0]).toContain('ZZTEST record all these capacities');
    expect(injectedPayloads()[0]).toContain('(a photo came with this but failed to download — ask Scott to resend it)');
    expect(injectedPayloads()[0]).toContain(TOKEN);
    expect(checker.completeMediaDownload(ID, 2, { partPath: downloaded(2) })).toBe('dropped');
    await cycleAt(T0 + 2 * MEDIA_GRACE_MS + 30_000);
    expect(injectedPayloads()).toHaveLength(1);
    expect(sent().some((t) => t.includes("hasn't come through"))).toBe(false);
  });

  it('captionless: the sender is told ONLY after the notice is sent; a late success re-arms with the late note (V4-4 after)', async () => {
    receive();
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    await cycleAt(T0 + 2 * MEDIA_GRACE_MS + 10_000);
    expect(q.read(ID)).toMatchObject({ media_state: 'failed', state: 'failed_notified' });
    expect(sent().filter((t) => t.startsWith("A photo you sent at"))).toHaveLength(1);
    expect(checker.completeMediaDownload(ID, 2, { partPath: downloaded(2) })).toBe('rearmed');
    const r = q.read(ID)!;
    expect(r).toMatchObject({ state: 'unattempted', empty: false, media_state: 'ready' });
    expect(r.formatted.startsWith(LATE_MEDIA_PREFIX)).toBe(true);
    await cycleAt(T0 + 2 * MEDIA_GRACE_MS + 20_000);
    expect(injectedPayloads()).toHaveLength(1);
  });

  it('late success DURING the notice await: delivered, with the late note, never marked failed_notified (V4-4 during)', async () => {
    receive();
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    let release!: () => void;
    api.sendMessage.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ok: true }); }));
    vi.setSystemTime(T0 + 2 * MEDIA_GRACE_MS + 10_000);
    const cycle = checker.durableTelegramCycle();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.read(ID)!.media_state).toBe('failed');
    expect(checker.completeMediaDownload(ID, 2, { partPath: downloaded(2) })).toBe('rearmed');
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    await cycle;
    // The same cycle goes on to paste it: once, with the late note.
    const r = q.read(ID)!;
    expect(r.formatted.startsWith(LATE_MEDIA_PREFIX)).toBe(true);
    expect(r).toMatchObject({ state: 'in_flight', submit_phase: 'pasted', media_state: 'ready' });
    await cycleAt(T0 + 2 * MEDIA_GRACE_MS + 30_000);
    expect(injectedPayloads()).toHaveLength(1);
    expect(injectedPayloads()[0].startsWith(LATE_MEDIA_PREFIX)).toBe(true);
    expect(q.read(ID)!.state).not.toBe('failed_notified');
  });

  it('late success BEFORE any notice: delivered WITHOUT a "resend" note (nothing was said)', async () => {
    receive();
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    // The failure transition, then the completion lands before the notice pass.
    vi.setSystemTime(T0 + 2 * MEDIA_GRACE_MS + 10_000);
    checker.processMediaDeadlines(T0 + 2 * MEDIA_GRACE_MS + 10_000);
    expect(q.read(ID)!.media_state).toBe('failed');
    expect(checker.completeMediaDownload(ID, 2, { partPath: downloaded(2) })).toBe('rearmed');
    expect(q.read(ID)!.formatted.startsWith(LATE_MEDIA_PREFIX)).toBe(false);
    await cycleAt(T0 + 2 * MEDIA_GRACE_MS + 11_000);
    expect(sent().some((t) => t.startsWith('A photo you sent at'))).toBe(false);
  });
});

describe('patch failure recovery', () => {
  it('a completion whose record patch fails is kept in memory and landed next cycle — never logged as updated', async () => {
    receive();
    const real = q.patch.bind(q);
    const spy = vi.spyOn(q, 'patch').mockImplementation((id: number, f: any, o?: any) => (f.media_state === 'ready' ? null : real(id, f, o)));
    vi.setSystemTime(T0 + 1_000);
    expect(checker.completeMediaDownload(ID, 1, { partPath: downloaded(1) })).toBe('write_failed');
    expect(logs.some((l) => l.includes('could NOT be written'))).toBe(true);
    expect(logs.some((l) => l.includes('ready (gen 1)'))).toBe(false);
    spy.mockRestore();
    await cycleAt(T0 + 2_000);
    expect(q.read(ID)!.media_state).toBe('ready');
  });
});

describe('Codex round 15 #3 — an owed completion is settled only when landed or discarded', () => {
  it('mediaPatchSettled resolves when the retried patch lands, not before', async () => {
    receive();
    const real = q.patch.bind(q);
    const spy = vi.spyOn(q, 'patch').mockImplementation((id: number, f: any, o?: any) => (f.media_state === 'ready' ? null : real(id, f, o)));
    vi.setSystemTime(T0 + 1_000);
    expect(checker.completeMediaDownload(ID, 1, { partPath: downloaded(1) })).toBe('write_failed');
    let settled = false;
    checker.mediaPatchSettled(ID, 1).then(() => { settled = true; });
    await cycleAt(T0 + 2_000); // patch still failing
    expect(settled).toBe(false);
    spy.mockRestore();
    await cycleAt(T0 + 3_000);
    expect(q.read(ID)!.media_state).toBe('ready');
    expect(settled).toBe(true);
  });

  it('... and when it is explicitly discarded because its record is gone', async () => {
    receive();
    const spy = vi.spyOn(q, 'patch').mockImplementation(() => null);
    vi.setSystemTime(T0 + 1_000);
    expect(checker.completeMediaDownload(ID, 1, { partPath: downloaded(1) })).toBe('write_failed');
    spy.mockRestore();
    let settled = false;
    checker.mediaPatchSettled(ID, 1).then(() => { settled = true; });
    q.remove(ID); // e.g. archived/removed by an operator
    await cycleAt(T0 + 2_000);
    expect(settled).toBe(true);
    expect(logs.some((l) => l.includes('discarded'))).toBe(true);
  });
});

describe('V4-3 restart reconciliation', () => {
  it('(a) crash BETWEEN rename and patch: the final file exists => block rebuilt from it at startup', async () => {
    q.persist(photoAtReceipt());
    mkdirSync(join(agentDir, 'telegram-images'), { recursive: true });
    writeFileSync(join(agentDir, `telegram-images/${ID}-photo-AQADlarge.jpg`), 'ZZTEST jpeg');
    checker = newChecker();
    q = checker.pendingQueue();
    await cycleAt(T0 + 5_000);
    expect(q.read(ID)!.media_state).toBe('ready');
    expect(started).toEqual([]);
  });

  it('(c)+(d) crash mid-download: the stray part file is removed and the download resumes as a new gen', async () => {
    q.persist(photoAtReceipt());
    const stray = downloaded(1);
    checker = newChecker();
    q = checker.pendingQueue();
    await cycleAt(T0 + 5_000);
    expect(existsSync(stray)).toBe(false);
    expect(started).toEqual([{ id: ID, gen: 2 }]);
    expect(q.read(ID)!.media_gen).toBe(2);
  });

  it('a part file of a job THIS process started is left alone', async () => {
    const rec = photoAtReceipt();
    q.persist(rec);
    checker.startMediaJob(rec, 1);
    const live = downloaded(1);
    await cycleAt(T0 + 2_000);
    expect(existsSync(live)).toBe(true);
    expect(started).toEqual([{ id: ID, gen: 1 }]);
  });
});

describe('V4-8 drain gate sees A3 downloads', () => {
  it('a pending A3 record is unfinished media until it lands', () => {
    receive();
    expect(q.unfinishedMedia().map((r) => r.update_id)).toEqual([ID]);
    vi.setSystemTime(T0 + 1_000);
    checker.completeMediaDownload(ID, 1, { partPath: downloaded(1) });
    expect(q.unfinishedMedia()).toEqual([]);
    expect(readdirSync(join(agentDir, 'telegram-images')).filter((n) => n.includes('.part.'))).toEqual([]);
  });
});
