/**
 * V4-8 — the rollback drain gate for the media-race fix (A0).
 *
 * Rolling the daemon back while a media download is in flight would re-create
 * the silent drop A0 closed (old code reads a raw record as "daemon died").
 * So a rollback pauses intake, waits for zero unfinished media records AND
 * zero outstanding media jobs, and otherwise ABORTS leaving the daemon alone.
 *
 * Binding notes from review round 7, each pinned by a test below:
 *   - the job counter covers the underlying work through settlement AND the
 *     completion patch; a timeout wrapper settling must not decrement it;
 *   - pause ack + counter are published atomically, tied to pid + start time;
 *     a missing or stale status file NEVER means drained;
 *   - restart stays blocked after a caption fallback until the download
 *     settles; a drain timeout restores polling.
 *
 * Offline: the poller runs against an in-memory fake API; nothing here can
 * call getUpdates on a real bot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TelegramIntakeControl,
  INTAKE_PAUSE_FILE,
  INTAKE_STATUS_FILE,
  INTAKE_STATUS_MAX_AGE_MS,
  evaluateDrain,
  readIntakeStatus,
  runRollbackDrain,
  type ProcessProbe,
} from '../../../src/telegram/intake-control';
import { PendingTelegramQueue, MEDIA_GRACE_MS, type PendingTelegramRecord } from '../../../src/telegram/pending-queue';
import { TelegramPoller } from '../../../src/telegram/poller';

const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'telegram', 'pending-462809160.recorded-2026-09-30.json');
const recorded = (): PendingTelegramRecord => JSON.parse(readFileSync(FIXTURE, 'utf-8'));
const rawAtReceipt = (id: number): PendingTelegramRecord => {
  const r = recorded();
  return { ...r, update_id: id, formatted: '', state: 'unattempted', notes: [r.notes[0]] };
};

const PID = 4242;
const STARTED = Date.parse('2026-09-30T11:00:00.000Z');

/** This daemon instance is alive and started when its status says it did. */
const liveProbe: ProcessProbe = { isAlive: (pid) => pid === PID, startedAtMs: (pid) => (pid === PID ? STARTED : null) };

let dir: string;
let stateDir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zztest-intake-'));
  stateDir = join(dir, 'state', 'jarvis-telegram');
  mkdirSync(stateDir, { recursive: true });
  clock = Date.parse('2026-09-30T12:00:00.000Z');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function control() {
  return new TelegramIntakeControl(stateDir, 'jarvis-telegram', { pid: PID, startedAtMs: STARTED, now });
}

/** What the poll loop does between batches: observe the pause file, ack, heartbeat. */
function pollLoopTurn(c: TelegramIntakeControl) {
  c.setPaused(c.isPauseRequested());
  c.tick();
}

describe('status publication', () => {
  it('publishes the pause ack and the job counter in one file, tied to pid + start time', () => {
    const c = control();
    c.publish();
    const s = readIntakeStatus(stateDir)!;
    expect(s.pid).toBe(PID);
    expect(s.daemon_started_at).toBe(new Date(STARTED).toISOString());
    expect(s.intake).toBe('polling');
    expect(s.pause_acked_at).toBeNull();
    expect(s.outstanding_media_jobs).toBe(0);

    writeFileSync(join(stateDir, INTAKE_PAUSE_FILE), 'x');
    const settle = c.beginMediaJob();
    pollLoopTurn(c);
    const p = readIntakeStatus(stateDir)!;
    expect(p.intake).toBe('paused');
    expect(p.pause_acked_at).toBe(new Date(clock).toISOString());
    expect(p.outstanding_media_jobs).toBe(1);
    settle();
    expect(readIntakeStatus(stateDir)!.outstanding_media_jobs).toBe(0);
  });

  it('settle is idempotent — a double call never frees another job\'s slot', () => {
    const c = control();
    const a = c.beginMediaJob();
    c.beginMediaJob();
    a();
    a();
    expect(c.outstandingMediaJobs).toBe(1);
  });
});

describe('job counter semantics', () => {
  it('a timeout wrapper settling does NOT decrement; only the underlying work + its patch does', async () => {
    const c = control();
    let finishDownload!: (v: string) => void;
    const download = new Promise<string>((r) => { finishDownload = r; });
    let patched = false;
    // Exactly the agent-manager shape: count from job start, settle in .finally
    // after the completion handler (the patch) has run.
    const settle = c.beginMediaJob();
    const job = download.then(() => { patched = true; }).finally(settle);
    // A timeout wrapper around the download wins the race...
    await Promise.race([download, new Promise((r) => setTimeout(r, 5))]);
    expect(c.outstandingMediaJobs).toBe(1); // ...and the job is still counted.
    finishDownload('ZZTEST bytes');
    await job;
    expect(patched).toBe(true);
    expect(c.outstandingMediaJobs).toBe(0);
  });
});

describe('poller honours the pause file', () => {
  function fakeApi(batches: object[][]) {
    const calls: number[] = [];
    return {
      calls,
      getUpdates: async (offset: number) => {
        calls.push(offset);
        const batch = batches.shift() ?? [];
        return { ok: true, result: batch.filter((u: any) => u.update_id >= offset) };
      },
    };
  }
  const update = (id: number) => ({
    update_id: id,
    message: { message_id: id, text: 'ZZTEST hi', chat: { id: 1 }, from: { id: 7, first_name: 'Scott' } },
  });
  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('a pause requested mid-batch lets the batch finish, then stops polling; removing it resumes', async () => {
    const api = fakeApi([[update(900), update(901)]]);
    const poller = new TelegramPoller(api as any, stateDir, 10);
    const c = new TelegramIntakeControl(stateDir, 'jarvis-telegram', { pid: PID, startedAtMs: STARTED });
    poller.setIntakeGate(c);
    const handled: number[] = [];
    poller.onMessage(async (_m, id) => {
      if (id === 900) writeFileSync(join(stateDir, INTAKE_PAUSE_FILE), 'x'); // pause lands mid-batch
      await new Promise((r) => setTimeout(r, 20));
      handled.push(id);
      return true;
    });
    const loop = poller.start();
    await until(() => readIntakeStatus(stateDir)?.intake === 'paused');

    expect(handled).toEqual([900, 901]); // the batch in hand finished
    expect(readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim()).toBe('902');
    const callsAtPause = api.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls.length).toBe(callsAtPause); // no getUpdates while paused

    rmSync(join(stateDir, INTAKE_PAUSE_FILE));
    await until(() => api.calls.length > callsAtPause);
    expect(readIntakeStatus(stateDir)!.intake).toBe('polling');
    poller.stop();
    await loop;
  });
});

describe('evaluateDrain fails closed', () => {
  function pausedAndAcked(c: TelegramIntakeControl) {
    writeFileSync(join(stateDir, INTAKE_PAUSE_FILE), 'x');
    pollLoopTurn(c);
  }

  it('missing status file => not drained', () => {
    const v = evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: liveProbe });
    expect(v.drained).toBe(false);
    expect(v.reason).toMatch(/no readable intake status/);
  });

  it('unparsable status file => not drained', () => {
    writeFileSync(join(stateDir, INTAKE_STATUS_FILE), '{ truncated');
    expect(evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: liveProbe }).drained).toBe(false);
  });

  it('stale status (poll loop not publishing) => not drained', () => {
    const c = control();
    pausedAndAcked(c);
    const v = evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock + INTAKE_STATUS_MAX_AGE_MS + 1, probe: liveProbe });
    expect(v.drained).toBe(false);
    expect(v.reason).toMatch(/stale/);
  });

  it('dead pid, or a different daemon instance reusing the pid => not drained', () => {
    const c = control();
    pausedAndAcked(c);
    expect(
      evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: { isAlive: () => false, startedAtMs: () => STARTED } }).reason,
    ).toMatch(/not running/);
    expect(
      evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: { isAlive: () => true, startedAtMs: () => STARTED + 60_000 } }).reason,
    ).toMatch(/different daemon instance/);
    expect(
      evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: { isAlive: () => true, startedAtMs: () => null } }).drained,
    ).toBe(false);
  });

  it('no pause ack, or an ack older than this request => not drained', () => {
    const c = control();
    c.publish();
    expect(evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: liveProbe }).reason).toMatch(/not acknowledged/);
    pausedAndAcked(c);
    expect(evaluateDrain({ stateDir, pauseRequestedAtMs: clock + 60_000, now: clock, probe: liveProbe }).reason).toMatch(/predates/);
  });

  it('raw, pending and ready records at pause time: waits on raw + pending only', () => {
    const q = new PendingTelegramQueue(join(stateDir, 'pending-telegram'));
    q.persist(rawAtReceipt(1));
    q.persist({ ...rawAtReceipt(2), formatted: 'ZZTEST partial', media_state: 'pending', media_deadline_at: new Date(clock + 1).toISOString() });
    q.persist({ ...recorded(), update_id: 3, state: 'unattempted', media_state: 'ready' });
    q.persist({ ...recorded(), update_id: 4 }); // the recorded terminal drop — never blocks
    const c = control();
    pausedAndAcked(c);
    const v = evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: liveProbe });
    expect(v.drained).toBe(false);
    expect(v.unfinishedMedia).toBe(2);

    q.applyMediaCompletion(1, { formatted: recorded().formatted, text: '', empty: false });
    q.patch(2, { media_state: 'ready' });
    expect(evaluateDrain({ stateDir, pauseRequestedAtMs: clock, now: clock, probe: liveProbe }).drained).toBe(true);
    expect(q.read(4)!.state).toBe('failed_notified'); // historical record untouched
  });
});

describe('runRollbackDrain', () => {
  it('caption fallback with its download still running: restart stays blocked until the job settles', async () => {
    const q = new PendingTelegramQueue(join(stateDir, 'pending-telegram'));
    // Grace expired and the caption block was injected, so the RECORD is no
    // longer unfinished — only the job counter knows the download still runs.
    q.persist({ ...rawAtReceipt(10), text: 'ZZTEST caption', formatted: 'ZZTEST caption block', attempts: 1 });
    expect(q.unfinishedMedia()).toEqual([]);
    const c = control();
    const settle = c.beginMediaJob();
    let turns = 0;
    const res = await runRollbackDrain({
      stateDir,
      timeoutMs: 2 * MEDIA_GRACE_MS,
      pollMs: 2_000,
      now,
      probe: liveProbe,
      sleep: async (ms) => {
        clock += ms;
        pollLoopTurn(c); // the daemon's poll loop keeps publishing
        if (++turns === 5) {
          q.applyMediaCompletion(10, { formatted: recorded().formatted, text: 'ZZTEST caption', empty: false });
          settle(); // download settled and its patch written
        }
      },
    });
    expect(turns).toBeGreaterThanOrEqual(5); // was blocked until settlement
    expect(res.drained).toBe(true);
    expect(existsSync(join(stateDir, INTAKE_PAUSE_FILE))).toBe(true); // stays paused for the restart
  });

  it('drain timeout => ABORT: pause file removed, daemon resumes polling', async () => {
    const c = control();
    c.beginMediaJob(); // never settles
    const res = await runRollbackDrain({
      stateDir,
      timeoutMs: 2 * MEDIA_GRACE_MS,
      now,
      probe: liveProbe,
      sleep: async (ms) => { clock += ms; pollLoopTurn(c); },
    });
    expect(res.drained).toBe(false);
    expect(res.reason).toMatch(/timed out/);
    expect(existsSync(join(stateDir, INTAKE_PAUSE_FILE))).toBe(false);
    pollLoopTurn(c);
    expect(readIntakeStatus(stateDir)!.intake).toBe('polling');
  });

  it('a daemon that never acknowledges (missing status) is never drained', async () => {
    const res = await runRollbackDrain({
      stateDir,
      timeoutMs: 10_000,
      now,
      probe: liveProbe,
      sleep: async (ms) => { clock += ms; },
    });
    expect(res.drained).toBe(false);
    expect(existsSync(join(stateDir, INTAKE_PAUSE_FILE))).toBe(false);
  });

  it('a pause file someone else created is left in place on abort', async () => {
    const pause = join(stateDir, INTAKE_PAUSE_FILE);
    writeFileSync(pause, 'operator pause');
    utimesSync(pause, new Date(clock - 1000), new Date(clock - 1000));
    const res = await runRollbackDrain({ stateDir, timeoutMs: 4_000, now, probe: liveProbe, sleep: async (ms) => { clock += ms; } });
    expect(res.drained).toBe(false);
    expect(res.createdPause).toBe(false);
    expect(existsSync(pause)).toBe(true);
  });

  it('an interrupt aborts and removes the pause file', async () => {
    const res = await runRollbackDrain({ stateDir, timeoutMs: 60_000, now, probe: liveProbe, aborted: () => true });
    expect(res).toEqual({ drained: false, reason: 'interrupted', createdPause: true });
    expect(existsSync(join(stateDir, INTAKE_PAUSE_FILE))).toBe(false);
  });
});
