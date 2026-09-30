/**
 * A4 (store + archive), A5 (notices recorded only when sent), A6 (receipt acks
 * by record age), V4-2 (unverified resolvable, never re-injected), V4-3(b)
 * (interrupted archive). Record shapes follow the recorded fixture
 * pending-462809160.recorded-2026-09-30.json; new fields are the ones this
 * change writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import {
  PendingTelegramQueue,
  NOTIFY_MAX_ATTEMPTS,
  RESOLVED_RETENTION_MS,
  newRecord,
  type PendingTelegramRecord,
} from '../../../src/telegram/pending-queue';
import { telegramToken } from '../../../src/telegram/submission-proof';
import type { BusPaths } from '../../../src/types';

const FIX = join(__dirname, '..', '..', 'fixtures', 'telegram');
const CHAT = '8727328514';
const at = (iso: string) => Date.parse(iso);

let root: string;
let paths: BusPaths;
let agent: any;
let api: { sendMessage: ReturnType<typeof vi.fn>; sendChatAction: ReturnType<typeof vi.fn> };
let checker: any;
let q: PendingTelegramQueue;
let logs: string[];

function mkPaths(dir: string): BusPaths {
  const p: any = {
    root: dir, stateDir: join(dir, 'state'), logDir: join(dir, 'logs'), inboxDir: join(dir, 'inbox'),
    taskDir: join(dir, 'tasks'), approvalDir: join(dir, 'approvals'), analyticsDir: join(dir, 'analytics'), heartbeatDir: join(dir, 'heartbeats'),
  };
  for (const d of Object.values(p) as string[]) if (d !== dir) mkdirSync(d, { recursive: true });
  return p as BusPaths;
}

function newChecker() {
  return new FastChecker(agent, paths, '/tmp/framework', {
    telegramApi: api as any,
    chatId: CHAT,
    log: (m: string) => logs.push(m),
    proofMode: 'pty',
  }) as any;
}

async function cycleAt(t: number) {
  vi.setSystemTime(t);
  const p = checker.durableTelegramCycle();
  await vi.advanceTimersByTimeAsync(5_000);
  await p;
}

function textRecord(id: number, text: string, createdIso: string, chat = CHAT): PendingTelegramRecord {
  const token = telegramToken(id);
  const r = newRecord({
    update_id: id, chat_id: chat, from: 'Scott', text, token,
    formatted: FastChecker.formatTelegramTextMessage('Scott', chat, text, '/tmp/framework', undefined, undefined, undefined, token),
  });
  r.created_at = createdIso;
  return r;
}

const resolvedPath = (id: number) => join(paths.stateDir, 'pending-telegram-resolved', `${id}.json`);
const outbound = (chat: string, iso: string) =>
  writeFileSync(join(paths.logDir, 'outbound-messages.jsonl'), JSON.stringify({ chat_id: chat, timestamp: iso, text: 'ZZTEST reply' }) + '\n', { flag: 'a' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  process.env.TELEGRAM_DURABLE_QUEUE = '1';
  root = mkdtempSync(join(tmpdir(), 'zztest-a4a6-'));
  paths = mkPaths(root);
  logs = [];
  agent = {
    name: 'jarvis-telegram',
    isBootstrapped: vi.fn(() => true),
    injectMessageDetailed: vi.fn(() => ({ ok: true })),
    transcriptContains: vi.fn(() => false),
    isAtPrompt: vi.fn(() => true),
    hasModalOpen: vi.fn(() => false),
    getStrippedTail: vi.fn(() => ''),
    getPtyInstance: vi.fn(() => 'pty-A'),
    write: vi.fn(),
  };
  api = { sendMessage: vi.fn().mockResolvedValue({ ok: true }), sendChatAction: vi.fn() };
  checker = newChecker();
  q = checker.pendingQueue();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TELEGRAM_DURABLE_QUEUE;
  delete process.env.TELEGRAM_PROMPT_GATE_STRICT;
  rmSync(root, { recursive: true, force: true });
});

const sent = () => api.sendMessage.mock.calls.map((c) => String(c[1]));

describe('A4 store', () => {
  it('insert is create-if-absent; a redelivered update is a no-op, even after it was archived', () => {
    const r = textRecord(1, 'ZZTEST a', '2026-09-30T12:00:00.000Z');
    expect(q.insert(r)).toBe('inserted');
    q.patch(1, { submit_phase: 'pasted', state: 'in_flight' });
    expect(q.insert(textRecord(1, 'ZZTEST a', '2026-09-30T12:00:05.000Z'))).toBe('exists');
    expect(q.read(1)!.submit_phase).toBe('pasted'); // not overwritten
    expect(q.archive(1, 'answered', 'test')).toBe(true);
    expect(q.insert(textRecord(1, 'ZZTEST a', '2026-09-30T12:00:05.000Z'))).toBe('exists');
    expect(q.read(1)).toBeNull();
  });

  it('patch with expectRev refuses a stale writer; every patch bumps rev', () => {
    q.insert(textRecord(2, 'ZZTEST b', '2026-09-30T12:00:00.000Z'));
    const a = q.read(2)!;
    expect(q.patch(2, { notes: ['one'] }, { expectRev: a.rev })).not.toBeNull();
    expect(q.patch(2, { notes: ['stale'] }, { expectRev: a.rev })).toBeNull();
    expect(q.read(2)!.notes).toEqual(['one']);
    expect(q.read(2)!.rev).toBe(1);
  });

  it('an answered record is ARCHIVED (resolved_at + resolution), not deleted — the watchdog can see it', async () => {
    q.insert(textRecord(3, 'ZZTEST answered', '2026-09-30T12:00:00.000Z'));
    await cycleAt(at('2026-09-30T12:00:01.000Z'));
    writeFileSync(join(paths.logDir, 'stdout.log'), telegramToken(3));
    await cycleAt(at('2026-09-30T12:00:06.000Z'));
    outbound(CHAT, '2026-09-30T12:00:20.000Z');
    await cycleAt(at('2026-09-30T12:00:30.000Z'));
    expect(q.read(3)).toBeNull();
    const r = JSON.parse(readFileSync(resolvedPath(3), 'utf-8'));
    expect(r).toMatchObject({ update_id: 3, resolution: 'answered', resolved_at: '2026-09-30T12:00:30.000Z' });
  });

  it('archive interrupted between the resolution patch and the rename: finished at startup, never injected', async () => {
    const r = textRecord(4, 'ZZTEST half-archived', '2026-09-30T12:00:00.000Z');
    r.resolved_at = '2026-09-30T12:00:10.000Z';
    r.resolution = 'answered';
    q.persist(r);
    expect(q.nextDeliverable(at('2026-09-30T12:01:00.000Z'), () => false)).toBeNull();
    await cycleAt(at('2026-09-30T12:01:00.000Z'));
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(q.read(4)).toBeNull();
    expect(existsSync(resolvedPath(4))).toBe(true);
  });

  it('resolved records older than 7 days are pruned; newer ones and hand-written ones are kept', () => {
    const dir = join(paths.stateDir, 'pending-telegram-resolved');
    mkdirSync(dir, { recursive: true });
    const now = at('2026-09-30T12:00:00.000Z');
    const old = { ...textRecord(5, 'old', '2026-09-20T00:00:00.000Z'), resolved_at: new Date(now - RESOLVED_RETENTION_MS - 1).toISOString(), resolution: 'answered' };
    const fresh = { ...textRecord(6, 'fresh', '2026-09-29T00:00:00.000Z'), resolved_at: new Date(now - 60_000).toISOString(), resolution: 'answered' };
    // The real hand-resolved record shape (462809024 lives there with no resolved_at).
    const manual = { ...textRecord(7, 'manual', '2026-09-24T00:00:00.000Z'), state: 'answered_manual' };
    for (const r of [old, fresh, manual]) writeFileSync(join(dir, `${r.update_id}.json`), JSON.stringify(r));
    expect(q.pruneResolved(now)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['6.json', '7.json']);
  });

  it('V4-2: unverified is never re-injected, and a later reply still resolves it', async () => {
    q.insert(textRecord(8, 'ZZTEST unverified', '2026-09-30T12:00:00.000Z'));
    await cycleAt(at('2026-09-30T12:00:01.000Z'));
    writeFileSync(join(paths.logDir, 'stdout.log'), telegramToken(8));
    await cycleAt(at('2026-09-30T12:00:06.000Z'));
    expect(q.read(8)!.submit_phase).toBe('submitted');
    await cycleAt(at('2026-09-30T12:11:00.000Z'));
    expect(q.read(8)!.state).toBe('unverified');
    await cycleAt(at('2026-09-30T12:20:00.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    outbound(CHAT, '2026-09-30T12:25:00.000Z');
    await cycleAt(at('2026-09-30T12:25:10.000Z'));
    expect(q.read(8)).toBeNull();
    expect(JSON.parse(readFileSync(resolvedPath(8), 'utf-8')).state).toBe('unverified');
  });
});

describe('A5 notices are recorded only after they were sent', () => {
  it('empty media: a failed notice leaves the record unmarked; retried; marked on success', async () => {
    const r = textRecord(20, '', '2026-09-30T12:00:00.000Z');
    r.empty = true;
    r.formatted = '';
    q.persist(r);
    api.sendMessage.mockRejectedValueOnce(new Error('ZZTEST network down'));
    await cycleAt(at('2026-09-30T12:00:01.000Z'));
    expect(q.read(20)).toMatchObject({ state: 'unattempted', notify_attempts: 1 });
    expect(q.read(20)!.notified_at).toBeUndefined();
    await cycleAt(at('2026-09-30T12:00:07.000Z'));
    expect(q.read(20)!.state).toBe('failed_notified');
    expect(q.read(20)!.notified_at).toBeTruthy();
  });

  it(`gives up after ${NOTIFY_MAX_ATTEMPTS} failures: marked, with notify_failed for the watchdog`, async () => {
    const r = textRecord(21, '', '2026-09-30T12:00:00.000Z');
    r.empty = true;
    r.formatted = '';
    q.persist(r);
    api.sendMessage.mockRejectedValue(new Error('ZZTEST network down'));
    for (let i = 0; i < NOTIFY_MAX_ATTEMPTS; i++) await cycleAt(at('2026-09-30T12:00:01.000Z') + i * 6_000);
    const cur = q.read(21)!;
    expect(cur).toMatchObject({ state: 'failed_notified', notify_failed: true, notify_attempts: NOTIFY_MAX_ATTEMPTS });
    expect(cur.notified_at).toBeUndefined();
    const calls = api.sendMessage.mock.calls.length;
    await cycleAt(at('2026-09-30T12:01:00.000Z'));
    expect(api.sendMessage.mock.calls.length).toBe(calls);
  });
});

describe('A6 receipt acks by unacknowledged receipt', () => {
  it('ONE ack per chat covering every record older than 45 s; stage persisted only after the send', async () => {
    process.env.TELEGRAM_PROMPT_GATE_STRICT = '1'; // strict gate: nothing injects, acks must still go out
    agent.isAtPrompt.mockReturnValue(false);
    q.insert(textRecord(30, 'ZZTEST a', '2026-09-30T12:00:00.000Z'));
    q.insert(textRecord(31, 'ZZTEST b', '2026-09-30T12:00:10.000Z'));
    q.insert(textRecord(32, 'ZZTEST other chat', '2026-09-30T12:00:10.000Z', '555'));
    await cycleAt(at('2026-09-30T12:00:30.000Z'));
    expect(api.sendMessage).not.toHaveBeenCalled();
    await cycleAt(at('2026-09-30T12:00:56.000Z'));
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // one per chat
    const mine = api.sendMessage.mock.calls.find((c) => c[0] === CHAT)!;
    expect(mine[1]).toMatch(/^Received your 2 messages \(56s ago\) — automatic receipt, not an answer\. JARVIS hasn't picked it up yet/);
    expect([q.read(30)!.ack_stage, q.read(31)!.ack_stage, q.read(32)!.ack_stage]).toEqual([1, 1, 1]);
    // Never written where replies are looked for.
    expect(existsSync(join(paths.logDir, 'outbound-messages.jsonl'))).toBe(false);
  });

  it('a failed ack is retried next cycle; a restart never repeats a persisted stage', async () => {
    q.insert(textRecord(33, 'ZZTEST c', '2026-09-30T12:00:00.000Z'));
    process.env.TELEGRAM_PROMPT_GATE_STRICT = '1';
    agent.isAtPrompt.mockReturnValue(false);
    api.sendMessage.mockRejectedValueOnce(new Error('ZZTEST 502'));
    await cycleAt(at('2026-09-30T12:00:50.000Z'));
    expect(q.read(33)!.ack_stage).toBe(0);
    await cycleAt(at('2026-09-30T12:00:56.000Z'));
    expect(q.read(33)!.ack_stage).toBe(1);
    checker = newChecker(); // daemon restart
    q = checker.pendingQueue();
    await cycleAt(at('2026-09-30T12:01:30.000Z'));
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // the failed one + the one success
  });

  it('interleaved bursts: an acked record never suppresses a new one; stage 2 at 10 min', async () => {
    process.env.TELEGRAM_PROMPT_GATE_STRICT = '1';
    agent.isAtPrompt.mockReturnValue(false);
    q.insert(textRecord(34, 'ZZTEST first', '2026-09-30T12:00:00.000Z'));
    await cycleAt(at('2026-09-30T12:00:50.000Z'));
    q.insert(textRecord(35, 'ZZTEST second', '2026-09-30T12:01:00.000Z'));
    await cycleAt(at('2026-09-30T12:01:50.000Z'));
    expect(sent().filter((t) => t.startsWith('Received your message'))).toHaveLength(2);
    await cycleAt(at('2026-09-30T12:10:05.000Z'));
    const followups = sent().filter((t) => t.startsWith('Still no reply observed'));
    expect(followups).toHaveLength(1);
    expect(followups[0]).toContain('your message from');
    expect(q.read(34)!.ack_stage).toBe(2);
    expect(q.read(35)!.ack_stage).toBe(1);
  });

  it('crash window: a stage that was sent but could not be persisted may repeat ONCE (documented bound)', async () => {
    process.env.TELEGRAM_PROMPT_GATE_STRICT = '1';
    agent.isAtPrompt.mockReturnValue(false);
    q.insert(textRecord(36, 'ZZTEST x', '2026-09-30T12:00:00.000Z'));
    q.insert(textRecord(37, 'ZZTEST y', '2026-09-30T12:00:00.000Z'));
    const real = q.patch.bind(q);
    const spy = vi.spyOn(q, 'patch').mockImplementation((id: number, f: any, o?: any) =>
      id === 37 && f.ack_stage === 1 ? null : real(id, f, o));
    await cycleAt(at('2026-09-30T12:00:50.000Z'));
    spy.mockRestore();
    expect([q.read(36)!.ack_stage, q.read(37)!.ack_stage]).toEqual([1, 0]);
    await cycleAt(at('2026-09-30T12:00:56.000Z'));
    expect(sent().filter((t) => t.startsWith('Received'))).toEqual([
      expect.stringContaining('your 2 messages'),
      expect.stringContaining('your message'),
    ]);
    expect(q.read(37)!.ack_stage).toBe(1);
  });

  it('legacy records (no ack_stage) are never acked — the 29 old records on disk stay silent', async () => {
    const legacy = JSON.parse(readFileSync(join(FIX, 'pending-462809160.recorded-2026-09-30.json'), 'utf-8'));
    q.persist({ ...legacy, state: 'unattempted', attempts: 0, formatted: 'ZZTEST', header: 'x' });
    await cycleAt(at('2026-09-30T12:30:00.000Z'));
    expect(sent().some((t) => t.startsWith('Received') || t.startsWith('Still no reply'))).toBe(false);
  });

  it('a fresh paste that goes stuck gets ONE receipt (the stuck receipt), not an ack AND a receipt; follow-up at 10 min', async () => {
    q.insert(textRecord(39, 'ZZTEST never submitted', '2026-09-30T12:00:00.000Z'));
    await cycleAt(at('2026-09-30T12:00:20.000Z')); // pasted at 12:00:20, proof window to 12:01:20
    await cycleAt(at('2026-09-30T12:00:50.000Z')); // 50 s old, still proving: no ack yet
    expect(sent()).toEqual([]);
    await cycleAt(at('2026-09-30T12:01:25.000Z')); // stuck => the one receipt
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatch(/^Received your message from .* — JARVIS hasn't picked it up yet\./);
    expect(q.read(39)).toMatchObject({ submit_phase: 'stuck', ack_stage: 1 });
    await cycleAt(at('2026-09-30T12:02:30.000Z'));
    expect(sent()).toHaveLength(1);
    await cycleAt(at('2026-09-30T12:10:05.000Z'));
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatch(/^Still no reply observed to your message from .* JARVIS hasn't picked it up yet/);
  });

  it('an answered message inside 45 s is never acked', async () => {
    q.insert(textRecord(38, 'ZZTEST quick', '2026-09-30T12:00:00.000Z'));
    await cycleAt(at('2026-09-30T12:00:01.000Z'));
    writeFileSync(join(paths.logDir, 'stdout.log'), telegramToken(38));
    await cycleAt(at('2026-09-30T12:00:07.000Z'));
    outbound(CHAT, '2026-09-30T12:00:20.000Z');
    await cycleAt(at('2026-09-30T12:00:30.000Z'));
    await cycleAt(at('2026-09-30T12:01:30.000Z'));
    expect(sent()).toEqual([]);
  });
});

