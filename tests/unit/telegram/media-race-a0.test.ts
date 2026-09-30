/**
 * A0 — the media race that silently dropped 23 of 25 photos (2026-09-24 → 09-30).
 *
 * The daemon persists a RAW media record (formatted='', text='') before the
 * download, so the Telegram offset can advance safely. The checker's poll cycle
 * then picked that record up within a second, read "no block, no text" as "the
 * daemon died between persisting and formatting", and marked it
 * `failed_notified` — with no notice sent. The download finished two seconds
 * later and patched its block onto a terminal record that was never injected.
 * On 2026-09-30 04:41 that was Scott's warehouse-capacity sheet; JARVIS then
 * shipped a migration full of guessed numbers.
 *
 * Fixtures are RECORDED, not invented:
 *   tests/fixtures/telegram/pending-462809160.recorded-2026-09-30.json — the
 *     record exactly as the race left it on disk;
 *   tests/fixtures/telegram/daemon-log-462809160.recorded-2026-09-30.txt — the
 *     three pm2 log lines of the sequence (persist 04:41:31, terminalized
 *     04:41:31, download landed 04:41:33).
 * The at-receipt shape is the recorded record with the two later writes the
 * log proves happened (the block patch, the failed_notified mark) undone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import {
  PendingTelegramQueue,
  MEDIA_GRACE_MS,
  LATE_MEDIA_PREFIX,
  mediaGraceMs,
  mediaNotArrivedText,
  clockTime,
  newRecord,
  headerNeedle,
  type PendingTelegramRecord,
} from '../../../src/telegram/pending-queue';
import type { BusPaths } from '../../../src/types';

const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'telegram');
const recorded = (): PendingTelegramRecord =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, 'pending-462809160.recorded-2026-09-30.json'), 'utf-8'));
const recordedLog = readFileSync(join(FIXTURE_DIR, 'daemon-log-462809160.recorded-2026-09-30.txt'), 'utf-8');

/** The record as it was at 04:41:31, before the race touched it. */
function atReceipt(): PendingTelegramRecord {
  const r = recorded();
  return { ...r, formatted: '', state: 'unattempted', notes: [r.notes[0]] };
}

const ID = 462809160;
const T0 = Date.parse(recorded().created_at); // 2026-09-30T11:41:31.338Z

function createMockAgent() {
  return {
    name: 'jarvis-telegram',
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    injectMessageDetailed: vi.fn().mockReturnValue({ ok: true }),
    transcriptContains: vi.fn().mockReturnValue(false),
    isAtPrompt: vi.fn().mockReturnValue(true),
    hasModalOpen: vi.fn().mockReturnValue(false),
    getStrippedTail: vi.fn().mockReturnValue(''),
    write: vi.fn(),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: any = {
    root: testDir,
    stateDir: join(testDir, 'state'),
    logDir: join(testDir, 'logs'),
    inboxDir: join(testDir, 'inbox'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths) as string[]) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths as BusPaths;
}

let testDir: string;
let agent: ReturnType<typeof createMockAgent>;
let api: { sendMessage: ReturnType<typeof vi.fn>; sendChatAction: ReturnType<typeof vi.fn> };
let checker: any;
let q: PendingTelegramQueue;
let logs: string[];

function newChecker() {
  const paths = createTestPaths(testDir);
  const c = new FastChecker(agent, paths, '/tmp/framework', {
    telegramApi: api as any,
    chatId: '8727328514',
    log: (m: string) => logs.push(m),
  }) as any;
  return c;
}

/** One durable cycle at wall-clock `at`, letting the post-injection sleep elapse. */
async function cycleAt(at: number) {
  vi.setSystemTime(at);
  const p = checker.durableTelegramCycle();
  await vi.advanceTimersByTimeAsync(5_000);
  await p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  testDir = mkdtempSync(join(tmpdir(), 'zztest-a0-'));
  agent = createMockAgent();
  api = { sendMessage: vi.fn().mockResolvedValue({ ok: true }), sendChatAction: vi.fn() };
  logs = [];
  checker = newChecker();
  q = checker.pendingQueue();
});

afterEach(() => {
  vi.useRealTimers();
  try {
    chmodSync(join(testDir, 'state', 'pending-telegram'), 0o755);
  } catch { /* not created */ }
  rmSync(testDir, { recursive: true, force: true });
});

describe('the recorded fixtures are what the race produced', () => {
  it('record 462809160 was terminalized with 0 attempts while its photo block landed', () => {
    const r = recorded();
    expect(r.state).toBe('failed_notified');
    expect(r.attempts).toBe(0);
    expect(r.formatted).toContain('=== TELEGRAM PHOTO from Scott');
    // Legacy shape: none of A0's new optional fields.
    expect(r.file_id).toBeUndefined();
    expect(r.media_type).toBeUndefined();
    expect(recordedLog).toMatch(/04:41:31.*Persisted pending Telegram update 462809160/);
    expect(recordedLog).toMatch(/04:41:31.*unrecoverable after restart/);
    expect(recordedLog).toMatch(/04:41:33.*durable record 462809160 updated/);
  });
});

describe('replay of 2026-09-30 04:41:31 → 04:41:33', () => {
  it('injects the photo exactly once and never marks it failed_notified', async () => {
    q.persist(atReceipt());

    // 04:41:31 — the same-second poll cycle that used to terminalize it.
    await cycleAt(T0 + 500);
    expect(q.read(ID)!.state).toBe('unattempted');
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();

    // 04:41:33 — the download lands.
    vi.setSystemTime(T0 + 2_000);
    expect(
      checker.completePendingMedia(ID, { formatted: recorded().formatted, text: '', empty: false }, 'type=photo'),
    ).toBe(true);
    expect(logs.some((l) => l.includes(`durable record ${ID} updated`))).toBe(true);

    await cycleAt(T0 + 2_500);
    await cycleAt(T0 + 10_000);
    await cycleAt(T0 + 60_000);

    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(agent.injectMessageDetailed.mock.calls[0][0]).toContain(recorded().formatted);
    expect(agent.injectMessageDetailed.mock.calls[0][1]).toBe(`tg:${ID}#1`);
    const after = q.read(ID)!;
    expect(after.state).not.toBe('failed_notified');
    expect(after.attempts).toBe(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('unrecoverable'))).toBe(false);
  });

  it('holds the same way for a new-format record carrying file_id/media_type/message_id', async () => {
    q.persist({ ...atReceipt(), file_id: 'ZZTEST-file', media_type: 'photo', message_id: 29415 });
    await cycleAt(T0 + 500);
    expect(q.read(ID)!.state).toBe('unattempted');
    checker.completePendingMedia(ID, { formatted: recorded().formatted, text: '', empty: false }, 'type=photo');
    await cycleAt(T0 + 2_500);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
  });
});

describe('grace window', () => {
  it('defaults to 180s and honours TELEGRAM_MEDIA_GRACE_MS', () => {
    expect(MEDIA_GRACE_MS).toBe(180_000);
    expect(mediaGraceMs({})).toBe(180_000);
    expect(mediaGraceMs({ TELEGRAM_MEDIA_GRACE_MS: '240000' })).toBe(240_000);
    expect(mediaGraceMs({ TELEGRAM_MEDIA_GRACE_MS: 'nonsense' })).toBe(180_000);
    expect(mediaGraceMs({ TELEGRAM_MEDIA_GRACE_MS: '-5' })).toBe(180_000);
  });

  it('a raw record is neither deliverable nor orphaned inside the window', () => {
    q.persist({ ...atReceipt(), text: 'ZZTEST caption' });
    expect(q.isMediaHeld(q.read(ID)!, T0 + MEDIA_GRACE_MS - 1)).toBe(true);
    expect(q.nextDeliverable(T0 + MEDIA_GRACE_MS - 1, () => false)).toBeNull();
    expect(q.expiredCaptionlessMedia(T0 + MEDIA_GRACE_MS - 1)).toEqual([]);
    expect(q.isMediaHeld(q.read(ID)!, T0 + MEDIA_GRACE_MS)).toBe(false);
    expect(q.nextDeliverable(T0 + MEDIA_GRACE_MS, () => false)?.update_id).toBe(ID);
  });

  it('honours A3 media_state pending until media_deadline_at, even past grace', () => {
    const deadline = new Date(T0 + 2 * MEDIA_GRACE_MS).toISOString();
    q.persist({ ...atReceipt(), text: 'ZZTEST caption', media_state: 'pending', media_deadline_at: deadline });
    expect(q.isMediaHeld(q.read(ID)!, T0 + MEDIA_GRACE_MS + 1)).toBe(true);
    expect(q.nextDeliverable(T0 + MEDIA_GRACE_MS + 1, () => false)).toBeNull();
    expect(q.isMediaHeld(q.read(ID)!, T0 + 2 * MEDIA_GRACE_MS)).toBe(false);
  });

  it('a held media record does not block a later text message behind it', () => {
    q.persist(atReceipt());
    q.persist({
      ...newRecord({
        update_id: ID + 1,
        chat_id: '8727328514',
        from: 'Scott',
        text: 'ZZTEST follow-up',
        formatted: 'ZZTEST block',
        header: headerNeedle('Scott', '8727328514'),
      }),
    });
    expect(q.nextDeliverable(T0 + 1_000, () => false)?.update_id).toBe(ID + 1);
  });
});

describe('legacy records are unchanged', () => {
  it('a text record written by newRecord carries no new keys', () => {
    const r = newRecord({ update_id: 1, chat_id: 1, from: 'Scott', text: 'ZZTEST', formatted: 'x', header: 'h' });
    expect(Object.keys(r).sort()).toEqual(
      ['attempts', 'chat_id', 'created_at', 'empty', 'formatted', 'from', 'header', 'notes', 'state', 'text', 'update_id'].sort(),
    );
  });

  it('a formatted legacy record is eligible exactly as before', () => {
    q.persist({ ...recorded(), state: 'unattempted', notes: [] });
    expect(q.isMediaHeld(q.read(ID)!, T0)).toBe(false);
    expect(q.nextDeliverable(T0, () => false)?.update_id).toBe(ID);
  });

  it('terminal historical records are never held, never unfinished, never touched', () => {
    q.persist(recorded());
    expect(q.isMediaHeld(q.read(ID)!, T0)).toBe(false);
    expect(q.unfinishedMedia()).toEqual([]);
    expect(q.nextDeliverable(T0 + 10 * MEDIA_GRACE_MS, () => false)).toBeNull();
  });
});

describe('V4-1 expiry — captioned', () => {
  it('injects the caption with a still-downloading note, and a late download does not re-inject', async () => {
    q.persist({ ...atReceipt(), text: 'ZZTEST record all these capacities', media_type: 'photo' });
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);

    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    const payload = agent.injectMessageDetailed.mock.calls[0][0] as string;
    expect(payload).toContain('ZZTEST record all these capacities');
    expect(payload).toContain('(a photo came with this and is still downloading)');
    expect(q.read(ID)!.state).toBe('unattempted');
    expect(api.sendMessage).not.toHaveBeenCalled();

    // The download lands after the caption went in.
    expect(
      checker.completePendingMedia(ID, { formatted: recorded().formatted, text: 'ZZTEST record all these capacities', empty: false }, 'type=photo'),
    ).toBe(true);
    const r = q.read(ID)!;
    expect(r.formatted).toBe(recorded().formatted);
    expect(r.notes.join('\n')).toMatch(/not re-injected/);
    await cycleAt(T0 + MEDIA_GRACE_MS + 30_000);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
  });
});

describe('V4-1 expiry — captionless', () => {
  it('tells the sender to resend, then marks failed_notified', async () => {
    q.persist(atReceipt());
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe('8727328514');
    expect(api.sendMessage.mock.calls[0][1]).toBe(
      `A photo you sent at ${clockTime(recorded().created_at)} hasn't come through yet — if it matters, resend it`,
    );
    expect(q.read(ID)!.state).toBe('failed_notified');
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();

    // Once marked, never notified again.
    await cycleAt(T0 + MEDIA_GRACE_MS + 10_000);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a failed notice is retried next cycle and the record is NOT marked until it succeeds', async () => {
    q.persist(atReceipt());
    api.sendMessage.mockRejectedValueOnce(new Error('ZZTEST network down'));
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    expect(q.read(ID)!.state).toBe('unattempted');
    expect(logs.some((l) => l.includes('notice failed — will retry'))).toBe(true);

    await cycleAt(T0 + MEDIA_GRACE_MS + 2_000);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(q.read(ID)!.state).toBe('failed_notified');
  });

  it('a daemon restart with a raw record on disk takes the expiry path (no resume in A0)', async () => {
    q.persist(atReceipt());
    checker = newChecker(); // the restarted daemon's checker, same state dir
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(q.read(ID)!.state).toBe('failed_notified');
  });

  it('names the attachment kind when the record knows it', () => {
    expect(mediaNotArrivedText({ created_at: recorded().created_at, media_type: 'voice' })).toMatch(/^A voice note you sent at /);
  });
});

describe('V4-1 late completion re-arm', () => {
  it('re-arms a failed_notified record (attempts 0): state and empty restored, block prefixed, then delivered', async () => {
    q.persist(atReceipt());
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);
    expect(q.read(ID)!.state).toBe('failed_notified');

    expect(
      checker.completePendingMedia(ID, { formatted: recorded().formatted, text: '', empty: false }, 'type=photo'),
    ).toBe(true);
    const r = q.read(ID)!;
    expect(r.state).toBe('unattempted');
    expect(r.empty).toBe(false);
    expect(r.formatted.startsWith(LATE_MEDIA_PREFIX)).toBe(true);
    expect(r.formatted).toContain(recorded().formatted);
    expect(logs.some((l) => l.includes('re-armed'))).toBe(true);

    await cycleAt(T0 + MEDIA_GRACE_MS + 5_000);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(agent.injectMessageDetailed.mock.calls[0][0]).toContain(LATE_MEDIA_PREFIX);
  });

  it('a completion that lands DURING the notice await is delivered, not terminalized', async () => {
    q.persist(atReceipt());
    api.sendMessage.mockImplementationOnce(async () => {
      // The download finishes while the notice is on the wire.
      checker.completePendingMedia(ID, { formatted: recorded().formatted, text: '', empty: false }, 'type=photo');
      return { ok: true };
    });
    await cycleAt(T0 + MEDIA_GRACE_MS + 1);

    const r = q.read(ID)!;
    expect(r.state).toBe('unattempted');
    expect(r.empty).toBe(false);
    expect(r.formatted.startsWith(LATE_MEDIA_PREFIX)).toBe(true);
    expect(r.formatted).toContain(recorded().formatted);
    // Injected in this same cycle or the next — exactly once either way.
    await cycleAt(T0 + MEDIA_GRACE_MS + 5_000);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
  });

  it('never re-arms a record that was already injected, or a human-closed one', () => {
    q.persist({ ...recorded(), attempts: 1 });
    expect(q.applyMediaCompletion(ID, { formatted: 'x', text: '', empty: false })).toBe('discarded');
    q.persist({ ...recorded(), state: 'answered_manual' });
    expect(q.applyMediaCompletion(ID, { formatted: 'x', text: '', empty: false })).toBe('discarded');
    expect(q.read(ID)!.state).toBe('answered_manual');
  });

  it('reports a vanished record as missing', () => {
    expect(checker.completePendingMedia(ID, { formatted: 'x', text: '', empty: false }, 'type=photo')).toBe(false);
    expect(logs.some((l) => l.includes('no longer exists'))).toBe(true);
    expect(logs.some((l) => l.includes('updated'))).toBe(false);
  });

  it('a failed write is logged as an ERROR and never as "updated"', () => {
    q.persist(atReceipt());
    chmodSync(join(testDir, 'state', 'pending-telegram'), 0o555);
    expect(checker.completePendingMedia(ID, { formatted: recorded().formatted, text: '', empty: false }, 'type=photo')).toBe(false);
    chmodSync(join(testDir, 'state', 'pending-telegram'), 0o755);
    expect(logs.some((l) => l.startsWith('ERROR: media completion'))).toBe(true);
    expect(logs.some((l) => l.includes(`durable record ${ID} updated`))).toBe(false);
    expect(q.read(ID)!.formatted).toBe('');
  });
});

describe('unfinished media (the record half of the rollback drain)', () => {
  it('counts raw and pending records, never ready or terminal ones', () => {
    q.persist(atReceipt()); // raw
    q.persist({ ...atReceipt(), update_id: ID + 1, formatted: 'ZZTEST partial', media_state: 'pending', media_deadline_at: new Date(T0 + 1).toISOString() });
    q.persist({ ...recorded(), update_id: ID + 2, state: 'unattempted', media_state: 'ready' }); // ready
    q.persist({ ...recorded(), update_id: ID + 3 }); // terminal historical drop
    expect(q.unfinishedMedia().map((r) => r.update_id)).toEqual([ID, ID + 1]);
  });
});
