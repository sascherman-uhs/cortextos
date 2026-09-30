/**
 * Rollback safety: records written by THIS branch, read by A0's code.
 *
 * The rollback path from this branch is "redeploy A0 (16fd942)" through A0's
 * drain procedure (scripts/telegram-media-rollback.ts: pause intake, wait for
 * zero unfinished media + zero media jobs, else abort). The argument:
 *   1. Pasted / stuck / submitted records are `in_flight` on disk. A0 never
 *      re-injects in_flight and never admits a drop for it; at worst it marks
 *      one `unverified` after 10 min (operator-only). No duplicate paste, no
 *      false "I may have missed this" after a rollback.
 *   2. A3 media records carry media_state/media_deadline_at, which A0 already
 *      honours (isMediaHeld) and counts as unfinished — so the drain refuses to
 *      roll back while any download is pending (and our unfinishedMedia agrees).
 *   3. Everything else this branch adds (token, submit_phase, rev, ack_stage,
 *      notify_*, resolved_at, the resolved/ dir) is an unknown field or dir to
 *      A0: its patch() spreads and keeps them, and nothing A0 decides reads them.
 *   4. The header token sits BEFORE `(chat_id:…)`, where A0's reply-evidence
 *      stripper still matches the header.
 * Every record below is produced by running this branch's FastChecker, then
 * handed to a frozen copy of A0's PendingTelegramQueue (a0-snapshot/).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { PendingTelegramQueue, MEDIA_GRACE_MS, newRecord, type PendingTelegramRecord } from '../../../src/telegram/pending-queue';
import { PendingTelegramQueue as A0Queue, sendEvidenceInTranscript as a0SendEvidence } from './a0-snapshot/pending-queue.a0';
import { telegramToken } from '../../../src/telegram/submission-proof';
import type { BusPaths } from '../../../src/types';

const CHAT = '8727328514';
const T = Date.parse('2026-09-30T12:40:00.000Z');

let root: string;
let paths: BusPaths;
let agent: any;
let api: any;
let checker: any;
let q: PendingTelegramQueue;
let a0: A0Queue;

function mkPaths(dir: string): BusPaths {
  const p: any = {
    root: dir, stateDir: join(dir, 'state'), logDir: join(dir, 'logs'), inboxDir: join(dir, 'inbox'),
    taskDir: join(dir, 'tasks'), approvalDir: join(dir, 'approvals'), analyticsDir: join(dir, 'analytics'), heartbeatDir: join(dir, 'heartbeats'),
  };
  for (const d of Object.values(p) as string[]) if (d !== dir) mkdirSync(d, { recursive: true });
  return p as BusPaths;
}

async function cycleAt(t: number) {
  vi.setSystemTime(t);
  const p = checker.durableTelegramCycle();
  await vi.advanceTimersByTimeAsync(5_000);
  await p;
}

function text(id: number, body: string, createdMs: number): PendingTelegramRecord {
  const token = telegramToken(id);
  const r = newRecord({
    update_id: id, chat_id: CHAT, from: 'Scott', text: body, token,
    formatted: FastChecker.formatTelegramTextMessage('Scott', CHAT, body, '/fw', undefined, undefined, undefined, token),
  });
  r.created_at = new Date(createdMs).toISOString();
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  process.env.TELEGRAM_DURABLE_QUEUE = '1';
  root = mkdtempSync(join(tmpdir(), 'zztest-rollback-'));
  paths = mkPaths(root);
  agent = {
    name: 'jarvis-telegram',
    isBootstrapped: () => true,
    injectMessageDetailed: vi.fn(() => ({ ok: true })),
    transcriptContains: () => false,
    isAtPrompt: () => true,
    hasModalOpen: () => false,
    getStrippedTail: () => '',
    getPtyInstance: vi.fn(() => 'pty-A'),
    getAgentDir: () => join(root, 'agent'),
    getConfig: () => ({ runtime: 'hermes' }),
    write: vi.fn(),
  };
  api = { sendMessage: vi.fn().mockResolvedValue({ ok: true }), sendChatAction: vi.fn() };
  checker = new FastChecker(agent, paths, '/fw', { telegramApi: api, chatId: CHAT, log: () => {}, proofMode: 'pty' }) as any;
  checker.setMediaDownloader({ start: () => {} });
  q = checker.pendingQueue();
  a0 = new A0Queue(join(paths.stateDir, 'pending-telegram'));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TELEGRAM_DURABLE_QUEUE;
  rmSync(root, { recursive: true, force: true });
});

const noReply = () => false;

describe('records this branch writes are harmless to A0', () => {
  it('pasted, stuck and submitted records: A0 never re-injects them and never admits a drop', async () => {
    q.insert(text(1, 'ZZTEST will stick', T));
    await cycleAt(T + 1_000); // pasted into pty-A
    await cycleAt(T + 70_000); // stuck
    agent.getPtyInstance.mockReturnValue('pty-B'); // respawn opens the gate
    q.insert(text(2, 'ZZTEST pasted', T + 71_000));
    await cycleAt(T + 72_000);
    q.insert(text(3, 'ZZTEST submitted', T + 73_000));
    writeFileSync(join(paths.logDir, 'stdout.log'), telegramToken(2));
    await cycleAt(T + 78_000); // 2 submitted (PTY proof), 3 pasted
    expect([q.read(1)!.submit_phase, q.read(2)!.submit_phase, q.read(3)!.submit_phase]).toEqual(['stuck', 'submitted', 'pasted']);
    for (const r of [q.read(1)!, q.read(2)!, q.read(3)!]) expect(r.state).toBe('in_flight');

    for (const later of [T + 5 * 60_000, T + 60 * 60_000]) {
      expect(a0.nextDeliverable(later, noReply)).toBeNull();
      expect(a0.dropCandidates(later, noReply)).toEqual([]);
      expect(a0.expiredCaptionlessMedia(later)).toEqual([]);
    }
    // At worst: operator-only unverified after 10 minutes. Nothing to Scott.
    expect(a0.unverifiedCandidates(T + 60 * 60_000, noReply).map((r) => r.update_id).sort()).toEqual([1, 2, 3]);
  });

  it('a positive non-delivery (nothing written) stays deliverable under A0 — exactly as A0 would treat its own', async () => {
    agent.injectMessageDetailed.mockReturnValueOnce({ ok: false, code: 'NOT_RUNNING', message: 'down' });
    q.insert(text(4, 'ZZTEST down', T));
    await cycleAt(T + 1_000);
    expect(q.read(4)).toMatchObject({ state: 'unattempted', attempts: 0, nondelivery_failures: 1 });
    expect(a0.nextDeliverable(T + 10 * 60_000, noReply)?.update_id).toBe(4);
    expect(a0.dropCandidates(T + 10 * 60_000, noReply)).toEqual([]);
  });

  it('a pending A3 download is held by A0 and counted as unfinished — the drain blocks the rollback', async () => {
    const r = newRecord({ update_id: 5, chat_id: CHAT, from: 'Scott', text: '', token: telegramToken(5), file_id: 'ZZTEST-f', media_type: 'photo' });
    r.created_at = new Date(T).toISOString();
    Object.assign(r, { media_state: 'pending', media_gen: 1, media_retries: 0, media_deadline_at: new Date(T + MEDIA_GRACE_MS).toISOString(), media_dest: 'telegram-images/5-photo-x.jpg' });
    q.insert(r);
    checker.startMediaJob(r, 1);
    await cycleAt(T + 1_000);
    expect(a0.isMediaHeld(q.read(5)!, T + 1_000)).toBe(true);
    expect(a0.nextDeliverable(T + 1_000, noReply)).toBeNull();
    expect(a0.unfinishedMedia().map((x) => x.update_id)).toEqual([5]);
    expect(q.unfinishedMedia().map((x) => x.update_id)).toEqual([5]);
  });

  it('a failed A3 download with a caption is ONE deliverable block to A0 (delivered once, not split)', async () => {
    const r = newRecord({ update_id: 6, chat_id: CHAT, from: 'Scott', text: 'ZZTEST caption', token: telegramToken(6), file_id: 'ZZTEST-f', media_type: 'photo' });
    r.created_at = new Date(T).toISOString();
    Object.assign(r, { media_state: 'pending', media_gen: 2, media_retries: 1, media_deadline_at: new Date(T).toISOString(), media_dest: 'telegram-images/6-photo-x.jpg' });
    q.insert(r);
    checker.startMediaJob(r, 2);
    checker.processMediaDeadlines(T + 1_000);
    const cur = q.read(6)!;
    expect(cur.media_state).toBe('failed');
    expect(a0.nextDeliverable(T + 2_000, noReply)?.update_id).toBe(6);
    expect(cur.formatted).toContain('ZZTEST caption');
    expect(cur.formatted).toContain('failed to download');
  });

  it('A0 keeps the new fields when it patches, and never reads the resolved archive', async () => {
    q.insert(text(7, 'ZZTEST fields', T));
    await cycleAt(T + 1_000);
    a0.markUnverified(a0.read(7)!, 'ZZTEST a0 note');
    const after = q.read(7)!;
    expect(after).toMatchObject({ state: 'unverified', submit_phase: 'pasted', token: telegramToken(7), ack_stage: 0 });
    expect(after.rev).toBeGreaterThan(0);
  });

  it("the token does not stop A0's stripper from removing the echoed header (no self-proving reply)", () => {
    const block = FastChecker.formatTelegramTextMessage('Scott', CHAT, 'hi', '/fw', undefined, undefined, undefined, telegramToken(8));
    expect(a0SendEvidence(block, CHAT)).toBe(false);
  });
});
