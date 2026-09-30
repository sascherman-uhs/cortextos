/**
 * V5 (rev3/rev4, R4-5) — provable delivery through the FastChecker.
 *
 * The recorded incident (2026-09-30, jarvis-telegram, PT = Z-7):
 *   12:36:53.749Z spawn (boot prompt marker), 12:37:02Z boot prompt recorded,
 *   12:38:21Z boot turn ended (turn_duration), 12:38:39Z photo 462809160
 *   pasted, rendered COLLAPSED ([Pasted text #1 +9 lines]) and NOT submitted;
 *   12:41:40Z pasted again; 12:44:41Z "DROP CONFIRMED" + a false "I may have
 *   missed your message" to Scott; 12:47:12Z an operator's paste submitted the
 *   composer — the genuine prompt (JSONL line 98) that carried the photo.
 * Fixtures: claude-session-entries.recorded-2026-09-30.json (real JSONL
 * entries), stdout-collapsed-paste-462809160.recorded-2026-09-30.txt (the real
 * PTY frames), pending-462809160.recorded-2026-09-30.json (the real record).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker, bootHoldMaxMs } from '../../../src/daemon/fast-checker';
import {
  PendingTelegramQueue,
  newRecord,
  stripInjectedScaffolding,
  sendEvidenceInTranscript,
  type PendingTelegramRecord,
} from '../../../src/telegram/pending-queue';
import { telegramToken, bootMarkerFromPrompt } from '../../../src/telegram/submission-proof';
import { sanitizeForPtyInjection } from '../../../src/utils/validate';
import type { BusPaths } from '../../../src/types';

const FIX = join(__dirname, '..', '..', 'fixtures', 'telegram');
const entries = JSON.parse(readFileSync(join(FIX, 'claude-session-entries.recorded-2026-09-30.json'), 'utf-8')).entries as Record<string, any>;
const E = (k: string) => JSON.parse(JSON.stringify(entries[k]));
const line = (o: unknown) => JSON.stringify(o) + '\n';
const collapsedFrames = readFileSync(join(FIX, 'stdout-collapsed-paste-462809160.recorded-2026-09-30.txt'));

const CHAT = '8727328514';
const ID = 462809160;
const TOKEN = telegramToken(ID);
const SPAWN = Date.parse('2026-09-30T12:36:53.749Z');
const MARKER = bootMarkerFromPrompt(E('boot_prompt_b64c01d7_line8').message.content)!;
const at = (iso: string) => Date.parse(iso);

function genuinePromptWith(token: string, ts: string, uuid: string): any {
  const e = E('genuine_prompt_photo_b64c01d7_line98');
  e.message.content = e.message.content.replace(
    '=== TELEGRAM PHOTO from Scott (chat_id:8727328514) ===',
    `=== TELEGRAM PHOTO from Scott ${token} (chat_id:8727328514) ===`,
  );
  e.timestamp = ts;
  e.uuid = uuid;
  return e;
}

let root: string;
let projDir: string;
let sessionFile: string;
let paths: BusPaths;
let agent: any;
let api: { sendMessage: ReturnType<typeof vi.fn>; sendChatAction: ReturnType<typeof vi.fn> };
let checker: any;
let q: PendingTelegramQueue;
let logs: string[];
let inst: string | null;
let bootstrapped: boolean;
let pasteSnapshots: Array<PendingTelegramRecord | null>;

function mkPaths(dir: string): BusPaths {
  const p: any = {
    root: dir,
    stateDir: join(dir, 'state'),
    logDir: join(dir, 'logs'),
    inboxDir: join(dir, 'inbox'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
    heartbeatDir: join(dir, 'heartbeats'),
  };
  for (const d of Object.values(p) as string[]) if (d !== dir) mkdirSync(d, { recursive: true });
  return p as BusPaths;
}

function mkAgent() {
  return {
    name: 'jarvis-telegram',
    isBootstrapped: vi.fn(() => bootstrapped),
    injectMessage: vi.fn(() => true),
    injectMessageDetailed: vi.fn((_payload: string, key: string) => {
      // What was on disk at the instant the first PTY byte would be written.
      const id = Number(String(key).replace(/^tg:(\d+)#.*$/, '$1'));
      pasteSnapshots.push(q.read(id));
      return { ok: true };
    }),
    transcriptContains: vi.fn(() => false),
    isAtPrompt: vi.fn(() => true),
    hasModalOpen: vi.fn(() => false),
    getStrippedTail: vi.fn(() => ''),
    getPtyInstance: vi.fn(() => inst),
    getPtySpawnedAt: vi.fn(() => SPAWN),
    getBootMarker: vi.fn(() => MARKER),
    getAgentDir: vi.fn(() => join(root, 'agent')),
    getConfig: vi.fn(() => ({})),
    write: vi.fn(),
  };
}

function newChecker() {
  const c = new FastChecker(agent, paths, '/tmp/framework', {
    telegramApi: api as any,
    chatId: CHAT,
    log: (m: string) => logs.push(m),
    claudeProjectDir: projDir,
  }) as any;
  return c;
}

async function cycleAt(t: number) {
  vi.setSystemTime(t);
  const p = checker.durableTelegramCycle();
  await vi.advanceTimersByTimeAsync(5_000);
  await p;
}

/** A text record exactly as the daemon now builds one (token in header, ack stage 0). */
function textRecord(id: number, text: string, createdIso: string): PendingTelegramRecord {
  const token = telegramToken(id);
  const r = newRecord({
    update_id: id,
    chat_id: CHAT,
    from: 'Scott',
    text,
    token,
    formatted: FastChecker.formatTelegramTextMessage('Scott', CHAT, text, '/tmp/framework', undefined, undefined, undefined, token),
  });
  r.created_at = createdIso;
  return r;
}

/** The incident photo, rebuilt through today's formatter from the recorded record. */
function photoRecord(): PendingTelegramRecord {
  const recorded = JSON.parse(readFileSync(join(FIX, 'pending-462809160.recorded-2026-09-30.json'), 'utf-8'));
  const r = newRecord({ update_id: ID, chat_id: CHAT, from: 'Scott', text: '', token: TOKEN, media_type: 'photo', message_id: 29415 });
  r.created_at = recorded.created_at; // 2026-09-30T11:41:31.338Z
  r.formatted = FastChecker.formatTelegramPhotoMessage('Scott', CHAT, '', 'telegram-images/20260930_044129_file_481.jpg', TOKEN);
  r.media_state = 'ready';
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  process.env.TELEGRAM_DURABLE_QUEUE = '1';
  root = mkdtempSync(join(tmpdir(), 'zztest-v5-'));
  projDir = join(root, 'claude-project');
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(root, 'agent'), { recursive: true });
  sessionFile = join(projDir, 'b64c01d7-9e24-467b-8d65-e43bd2f05382.jsonl');
  // The recorded boot: prompt (line 8) then its turn end (line 96).
  writeFileSync(sessionFile, line(E('boot_prompt_b64c01d7_line8')) + line(E('turn_duration_b64c01d7_line96')));
  paths = mkPaths(root);
  inst = 'pty-instance-A';
  bootstrapped = true;
  pasteSnapshots = [];
  logs = [];
  agent = mkAgent();
  api = { sendMessage: vi.fn().mockResolvedValue({ ok: true }), sendChatAction: vi.fn() };
  checker = newChecker();
  q = checker.pendingQueue();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TELEGRAM_DURABLE_QUEUE;
  delete process.env.TELEGRAM_BOOT_HOLD_MAX_MS;
  rmSync(root, { recursive: true, force: true });
});

const sentTexts = () => api.sendMessage.mock.calls.map((c) => String(c[1]));

describe('the recorded 05:38 incident, replayed through the new path', () => {
  it('collapsed + unsubmitted paste => STUCK (one truthful receipt, no re-paste, no admission) => late genuine prompt resolves it', async () => {
    q.persist(photoRecord());
    // The PTY shows the recorded collapsed frames — no header, no token.
    writeFileSync(join(paths.logDir, 'stdout.log'), collapsedFrames);

    await cycleAt(at('2026-09-30T12:38:39.527Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    let r = q.read(ID)!;
    expect(r).toMatchObject({ state: 'in_flight', submit_phase: 'pasted', attempts: 1, pty_instance: 'pty-instance-A' });
    expect(r.attempt_started_at).toBe('2026-09-30T12:38:39.527Z');

    // 60 s: Claude Code has recorded no prompt carrying the token.
    await cycleAt(at('2026-09-30T12:39:45.000Z'));
    r = q.read(ID)!;
    expect(r.submit_phase).toBe('stuck');
    expect(r.state).toBe('in_flight'); // never escalated, never re-injectable
    expect(logs.some((l) => l.includes('STUCK'))).toBe(true);
    await cycleAt(at('2026-09-30T12:39:51.000Z')); // the receipt goes out on the cycle after
    expect(sentTexts().filter((t) => t.includes("hasn't picked it up yet") && t.startsWith('Received your message from'))).toHaveLength(1);

    // Where the old code re-pasted (12:41:40) and admitted a drop (12:44:41):
    await cycleAt(at('2026-09-30T12:41:40.931Z'));
    await cycleAt(at('2026-09-30T12:44:41.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(sentTexts().some((t) => t.includes('I may have missed'))).toBe(false);
    expect(sentTexts().filter((t) => t.startsWith('Received your message from'))).toHaveLength(1);
    expect(q.read(ID)!.state).toBe('in_flight');

    // 12:47:12Z: the composer is finally submitted — recorded line 98.
    appendFileSync(sessionFile, line(genuinePromptWith(TOKEN, '2026-09-30T12:47:12.017Z', '095a4402-f12e-450a-9033-b06f42fd179f')));
    await cycleAt(at('2026-09-30T12:47:20.000Z'));
    r = q.read(ID)!;
    expect(r).toMatchObject({
      submit_phase: 'submitted',
      submitted_via: 'prompt',
      in_flight_at: '2026-09-30T12:47:12.017Z',
      proof_uuids: ['095a4402-f12e-450a-9033-b06f42fd179f'],
    });
    expect(logs.some((l) => l.includes('LATE submission, stuck cleared'))).toBe(true);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
  });
});

describe('V5-1 / R4-1 through the checker', () => {
  it('a normal submission: pasted, then the genuine prompt => submitted + consumed, gate opens for the next message', async () => {
    q.persist(textRecord(900001, 'ZZTEST one', '2026-09-30T12:40:00.000Z'));
    q.persist(textRecord(900002, 'ZZTEST two', '2026-09-30T12:40:01.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    // 900002 is HELD behind 900001 (pasted, unproven) in the same PTY.
    await cycleAt(at('2026-09-30T12:40:08.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('900002: HELD — update 900001 is pasted'))).toBe(true);
    appendFileSync(sessionFile, line(genuinePromptWith(telegramToken(900001), '2026-09-30T12:40:03.000Z', 'zztest-uuid-1')));
    await cycleAt(at('2026-09-30T12:40:14.000Z'));
    expect(q.read(900001)).toMatchObject({ submit_phase: 'submitted', in_flight_at: '2026-09-30T12:40:03.000Z' });
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
    expect(q.read(900002)!.submit_phase).toBe('pasted');
  });

  it('the token echoed only in a tool_result => stuck, never consumed', async () => {
    q.persist(textRecord(900003, 'ZZTEST echo', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    const tr = E('tool_result_b64c01d7_line84');
    tr.message.content[0].content = `cat pending: ${telegramToken(900003)}`;
    tr.timestamp = '2026-09-30T12:40:05.000Z';
    appendFileSync(sessionFile, line(tr));
    await cycleAt(at('2026-09-30T12:41:10.000Z'));
    expect(q.read(900003)).toMatchObject({ submit_phase: 'stuck' });
    expect(q.read(900003)!.in_flight_at).toBeUndefined();
  });

  it('a prompt recorded in ANOTHER session file (shared cwd) still proves it', async () => {
    q.persist(textRecord(900004, 'ZZTEST other file', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    writeFileSync(join(projDir, 'ffff-new-session.jsonl'), line(genuinePromptWith(telegramToken(900004), '2026-09-30T12:40:04.000Z', 'zztest-uuid-4')));
    await cycleAt(at('2026-09-30T12:40:09.000Z'));
    expect(q.read(900004)!.submit_phase).toBe('submitted');
  });

  it('stuck is decided only after a scan that ran past the deadline', async () => {
    q.persist(textRecord(900005, 'ZZTEST slow scan', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    // A cycle at the deadline whose snapshot is still the pre-deadline one.
    checker.lastSnap = { at: at('2026-09-30T12:41:01.000Z'), since: 0, snap: checker.lastSnap.snap };
    await cycleAt(at('2026-09-30T12:41:03.000Z'));
    expect(q.read(900005)!.submit_phase).toBe('pasted');
    await cycleAt(at('2026-09-30T12:41:09.000Z'));
    expect(q.read(900005)!.submit_phase).toBe('stuck');
  });
});

describe('R4-2 persist-before-write', () => {
  it('the attempt is on disk (pasted, in_flight, start, deadline, PTY) BEFORE the first byte', async () => {
    q.persist(textRecord(900010, 'ZZTEST pbw', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    expect(pasteSnapshots[0]).toMatchObject({
      state: 'in_flight',
      submit_phase: 'pasted',
      attempt_started_at: '2026-09-30T12:40:02.000Z',
      submit_deadline_at: '2026-09-30T12:41:02.000Z',
      pty_instance: 'pty-instance-A',
      attempts: 1,
    });
  });

  it('if the accounting cannot be written and verified, nothing is pasted this cycle', async () => {
    q.persist(textRecord(900011, 'ZZTEST no write', '2026-09-30T12:40:00.000Z'));
    const spy = vi.spyOn(q, 'beginPaste').mockReturnValue(null);
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('could not persist the paste accounting — NOT injecting'))).toBe(true);
    spy.mockRestore();
    await cycleAt(at('2026-09-30T12:40:08.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
  });

  it('crash after the paste, before any proof: the restarted daemon never pastes it again', async () => {
    q.persist(textRecord(900012, 'ZZTEST crash', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    // Daemon restart: new checker, new PTY instance.
    inst = 'pty-instance-B';
    checker = newChecker();
    q = checker.pendingQueue();
    for (const t of ['2026-09-30T12:40:30.000Z', '2026-09-30T12:43:40.000Z', '2026-09-30T13:10:00.000Z']) await cycleAt(at(t));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(q.read(900012)!.submit_phase).toBe('stuck');
  });
});

describe('R4-3 stuck gate vs record retry', () => {
  it('respawn opens the gate for LATER records but never retries the uncertain one; late proof still resolves it', async () => {
    q.persist(textRecord(900020, 'ZZTEST stuck one', '2026-09-30T12:40:00.000Z'));
    q.persist(textRecord(900021, 'ZZTEST queued behind', '2026-09-30T12:40:01.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    await cycleAt(at('2026-09-30T12:41:10.000Z'));
    expect(q.read(900020)!.submit_phase).toBe('stuck');
    await cycleAt(at('2026-09-30T12:41:20.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1); // 900021 queued

    inst = 'pty-instance-respawned';
    await cycleAt(at('2026-09-30T12:41:30.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
    expect(agent.injectMessageDetailed.mock.calls[1][1]).toMatch(/^tg:900021#/);
    expect(q.read(900020)!.submit_phase).toBe('stuck'); // still UNKNOWN, not retryable

    // Its submission happened before the crash; the line shows up late.
    appendFileSync(sessionFile, line(genuinePromptWith(telegramToken(900020), '2026-09-30T12:40:03.000Z', 'zztest-uuid-20')));
    await cycleAt(at('2026-09-30T12:41:40.000Z'));
    expect(q.read(900020)!.submit_phase).toBe('submitted');
    expect(agent.injectMessageDetailed.mock.calls.filter((c) => /^tg:900020#/.test(c[1]))).toHaveLength(1);
  });
});

describe('Codex round 15 #2 — the stuck gate persists until submission evidence or a new PTY', () => {
  it('a later reply to the same chat does NOT archive an unsubmitted paste or open the gate', async () => {
    q.persist(textRecord(900060, 'ZZTEST stuck', '2026-09-30T12:40:00.000Z'));
    q.persist(textRecord(900061, 'ZZTEST behind it', '2026-09-30T12:40:01.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    await cycleAt(at('2026-09-30T12:41:10.000Z'));
    expect(q.read(900060)!.submit_phase).toBe('stuck');
    // JARVIS answers something else in the same chat (an earlier message).
    writeFileSync(join(paths.logDir, 'outbound-messages.jsonl'), JSON.stringify({ chat_id: CHAT, timestamp: '2026-09-30T12:41:30.000Z', text: 'ZZTEST unrelated reply' }) + '\n');
    await cycleAt(at('2026-09-30T12:41:40.000Z'));
    await cycleAt(at('2026-09-30T12:41:50.000Z'));
    expect(q.read(900060)).not.toBeNull(); // not archived: a reply cannot prove an unsubmitted paste was read
    expect(q.read(900060)!.submit_phase).toBe('stuck');
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1); // 900061 still queued behind the gate
  });

  it('the 24 h proof window closing does NOT open the gate; scanning continues for this PTY and late proof clears it', async () => {
    q.persist(textRecord(900062, 'ZZTEST stuck a day', '2026-09-30T12:40:00.000Z'));
    q.persist(textRecord(900063, 'ZZTEST behind it', '2026-09-30T12:40:01.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    await cycleAt(at('2026-09-30T12:41:10.000Z'));
    await cycleAt(at('2026-10-01T12:41:10.000Z')); // > 24 h later, same PTY
    await cycleAt(at('2026-10-01T12:41:20.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    appendFileSync(sessionFile, line(genuinePromptWith(telegramToken(900062), '2026-10-01T12:42:00.000Z', 'zztest-uuid-62')));
    await cycleAt(at('2026-10-01T12:42:10.000Z'));
    expect(q.read(900062)!.submit_phase).toBe('submitted');
    await cycleAt(at('2026-10-01T12:42:20.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
  });
});

describe('Codex round 15 #4 — submitted-only is its own state, never "consumed"', () => {
  function enqueueOf(id: number, ts: string): any {
    const e = E('enqueue_telegram_b7476096');
    e.content = e.content.replace('(chat_id:8727328514)', `${telegramToken(id)} (chat_id:8727328514)`);
    e.timestamp = ts;
    return e;
  }

  it('enqueue-only stays submitted (not unverified) past 10 min, is scanned on, and a later queued_command consumes it', async () => {
    q.persist(textRecord(900070, 'ZZTEST queued behind a long tool', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    appendFileSync(sessionFile, line(enqueueOf(900070, '2026-09-30T12:40:03.000Z')));
    await cycleAt(at('2026-09-30T12:40:08.000Z'));
    expect(q.read(900070)).toMatchObject({ submit_phase: 'submitted', submitted_via: 'enqueue' });
    expect(q.read(900070)!.in_flight_at).toBeUndefined();
    await cycleAt(at('2026-09-30T12:55:00.000Z'));
    expect(q.read(900070)!.state).toBe('in_flight'); // NOT unverified: nothing shows the model read it
    const qc = E('queued_command_telegram_b7476096');
    qc.attachment.prompt = qc.attachment.prompt.replace('(chat_id:8727328514)', `${telegramToken(900070)} (chat_id:8727328514)`);
    qc.timestamp = '2026-09-30T12:56:00.000Z';
    qc.uuid = 'zztest-qc-70';
    appendFileSync(sessionFile, line(qc));
    await cycleAt(at('2026-09-30T12:56:10.000Z'));
    expect(q.read(900070)).toMatchObject({ submitted_via: 'queued_command', in_flight_at: '2026-09-30T12:56:00.000Z' });
    // Only NOW does the 10-minute unverified clock run.
    await cycleAt(at('2026-09-30T13:07:00.000Z'));
    expect(q.read(900070)!.state).toBe('unverified');
  });

  it('a same-chat reply does not archive a submitted-but-unread message', async () => {
    q.persist(textRecord(900071, 'ZZTEST unread', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    appendFileSync(sessionFile, line(enqueueOf(900071, '2026-09-30T12:40:03.000Z')));
    await cycleAt(at('2026-09-30T12:40:08.000Z'));
    writeFileSync(join(paths.logDir, 'outbound-messages.jsonl'), JSON.stringify({ chat_id: CHAT, timestamp: '2026-09-30T12:40:20.000Z', text: 'ZZTEST reply to something earlier' }) + '\n');
    await cycleAt(at('2026-09-30T12:40:30.000Z'));
    expect(q.read(900071)).not.toBeNull();
  });
});

describe('Codex round 16 #2/#4 — consumption, not submission, is the reference point', () => {
  const enq = (id: number, ts: string) => {
    const e = E('enqueue_telegram_b7476096');
    e.content = e.content.replace('(chat_id:8727328514)', `${telegramToken(id)} (chat_id:8727328514)`);
    e.timestamp = ts;
    return e;
  };
  const qcmd = (id: number, ts: string, uuid: string) => {
    const e = E('queued_command_telegram_b7476096');
    e.attachment.prompt = e.attachment.prompt.replace('(chat_id:8727328514)', `${telegramToken(id)} (chat_id:8727328514)`);
    e.timestamp = ts;
    e.uuid = uuid;
    return e;
  };
  const outbound = (iso: string) =>
    appendFileSync(join(paths.logDir, 'outbound-messages.jsonl'), JSON.stringify({ chat_id: CHAT, timestamp: iso, text: 'ZZTEST reply' }) + '\n');

  for (const rail of ['outbound-log', 'last-sent cache'] as const) {
    it(`a reply sent while the message was queued is NOT its answer once it is read (${rail}); a later reply is`, async () => {
      q.persist(textRecord(900080, 'ZZTEST queued', '2026-09-30T12:40:00.000Z'));
      await cycleAt(at('2026-09-30T12:40:02.000Z'));
      appendFileSync(sessionFile, line(enq(900080, '2026-09-30T12:40:03.000Z')));
      await cycleAt(at('2026-09-30T12:40:08.000Z'));
      // An unrelated reply while it sits queued, unread.
      const lastSent = join(paths.stateDir, `last-telegram-${CHAT}.txt`);
      if (rail === 'outbound-log') outbound('2026-09-30T12:40:20.000Z');
      else { writeFileSync(lastSent, 'ZZTEST'); utimesSync(lastSent, new Date('2026-09-30T12:40:20.000Z'), new Date('2026-09-30T12:40:20.000Z')); }
      // It is read at 12:41:00.
      appendFileSync(sessionFile, line(qcmd(900080, '2026-09-30T12:41:00.000Z', 'zztest-qc-80')));
      await cycleAt(at('2026-09-30T12:41:10.000Z'));
      await cycleAt(at('2026-09-30T12:41:20.000Z'));
      expect(q.read(900080)).not.toBeNull(); // the 12:40:20 reply predates consumption
      if (rail === 'outbound-log') outbound('2026-09-30T12:41:30.000Z');
      else utimesSync(lastSent, new Date('2026-09-30T12:41:30.000Z'), new Date('2026-09-30T12:41:30.000Z'));
      await cycleAt(at('2026-09-30T12:41:40.000Z'));
      expect(q.read(900080)).toBeNull();
    });
  }

  it('the receipt for a queued-but-unread message says it has not been read — not "JARVIS has it"', async () => {
    q.persist(textRecord(900081, 'ZZTEST queued ack', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    appendFileSync(sessionFile, line(enq(900081, '2026-09-30T12:40:03.000Z')));
    await cycleAt(at('2026-09-30T12:40:08.000Z'));
    await cycleAt(at('2026-09-30T12:40:50.000Z'));
    const acks = sentTexts().filter((t) => t.startsWith('Received'));
    expect(acks).toHaveLength(1);
    expect(acks[0]).not.toContain('JARVIS has it');
    expect(acks[0]).toContain("JARVIS hasn't read it yet — it is queued.");
  });
});

describe('V5-3 DROP only on positive non-delivery evidence', () => {
  it('a PARTIAL paste (some bytes written, then a throw) is UNKNOWN: no retry, no admission', async () => {
    agent.injectMessageDetailed.mockReturnValue({ ok: false, code: 'WRITE_FAILED', partial: true, message: 'ZZTEST EPIPE after chunk 1' });
    q.persist(textRecord(900030, 'ZZTEST partial', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    expect(q.read(900030)).toMatchObject({ state: 'in_flight', submit_phase: 'pasted', attempts: 1 });
    expect(q.read(900030)!.write_error).toContain('EPIPE');
    for (const t of ['2026-09-30T12:43:10.000Z', '2026-09-30T12:46:20.000Z', '2026-09-30T12:49:30.000Z']) await cycleAt(at(t));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(sentTexts().some((t) => t.includes('I may have missed'))).toBe(false);
    expect(q.read(900030)!.submit_phase).toBe('stuck');
  });

  it('nothing written (PTY absent) is undone, retried after the throttle, and only after MAX_ATTEMPTS such failures admitted', async () => {
    agent.injectMessageDetailed.mockReturnValue({ ok: false, code: 'NOT_RUNNING', message: 'ZZTEST agent down' });
    q.persist(textRecord(900031, 'ZZTEST down', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    let r = q.read(900031)!;
    expect(r).toMatchObject({ state: 'unattempted', attempts: 0, nondelivery_failures: 1 });
    expect(r.submit_phase).toBeUndefined();
    await cycleAt(at('2026-09-30T12:40:30.000Z')); // throttled
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    await cycleAt(at('2026-09-30T12:43:10.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
    expect(q.read(900031)!.nondelivery_failures).toBe(2);
    await cycleAt(at('2026-09-30T12:46:20.000Z'));
    r = q.read(900031)!;
    expect(r.state).toBe('escalated');
    expect(r.notified_at).toBeTruthy();
    expect(sentTexts().some((t) => t.startsWith('I may have missed this: «ZZTEST down»'))).toBe(true);
  });
});

describe('V5-2a / R4-4 boot-window hold', () => {
  it('held until this PTY bootstraps AND its boot turn ends in the session record; then released', async () => {
    writeFileSync(sessionFile, line(E('boot_prompt_b64c01d7_line8'))); // turn not ended yet
    bootstrapped = false;
    q.persist(textRecord(900040, 'ZZTEST during boot', '2026-09-30T12:37:30.000Z'));
    await cycleAt(at('2026-09-30T12:37:40.000Z'));
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('bootstrap not observed'))).toBe(true);
    bootstrapped = true;
    await cycleAt(at('2026-09-30T12:37:50.000Z'));
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('boot turn still running'))).toBe(true);
    appendFileSync(sessionFile, line(E('turn_duration_b64c01d7_line96')));
    await cycleAt(at('2026-09-30T12:38:22.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('RELEASED') && l.includes('2026-09-30T12:38:21.469Z'))).toBe(true);
  });

  // Codex round 15 #6: elapsed time is not readiness. Past the bound the hold
  // ESCALATES (loud log + hold_escalated_at on every held record, which the
  // watchdog reports as HELD) and keeps holding until readiness evidence.
  it('bootstrap never observed: past the bound it escalates and KEEPS holding; readiness later releases it', async () => {
    bootstrapped = false;
    q.persist(textRecord(900041, 'ZZTEST no bootstrap', '2026-09-30T12:37:30.000Z'));
    await cycleAt(at('2026-09-30T12:38:30.000Z'));
    await cycleAt(SPAWN + bootHoldMaxMs() + 1_000);
    await cycleAt(SPAWN + bootHoldMaxMs() + 60_000);
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.includes('LOUD') && l.includes('boot')).length).toBe(1); // once per PTY
    expect(q.read(900041)!.hold_escalated_at).toBeTruthy();
    expect(q.read(900041)!.hold_reason).toBe('boot_not_ready');
    // A message arriving during the escalated hold is marked too.
    q.persist(textRecord(900044, 'ZZTEST later', new Date(SPAWN + bootHoldMaxMs() + 70_000).toISOString()));
    await cycleAt(SPAWN + bootHoldMaxMs() + 80_000);
    expect(q.read(900044)!.hold_escalated_at).toBeTruthy();
    bootstrapped = true; // the session finally comes up (boot prompt + turn end already recorded)
    await cycleAt(SPAWN + bootHoldMaxMs() + 90_000);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    expect(q.read(900041)!.hold_escalated_at).toBeUndefined();
  });

  it('bootstrapped but the boot turn never ends in the record: escalates, still held', async () => {
    writeFileSync(sessionFile, line(E('boot_prompt_b64c01d7_line8')));
    q.persist(textRecord(900045, 'ZZTEST turn never ends', '2026-09-30T12:37:30.000Z'));
    await cycleAt(SPAWN + bootHoldMaxMs() + 1_000);
    await cycleAt(SPAWN + bootHoldMaxMs() + 30_000);
    expect(agent.injectMessageDetailed).not.toHaveBeenCalled();
    expect(q.read(900045)!.hold_escalated_at).toBeTruthy();
  });

  it("a previous generation's boot turn end does not release a NEW PTY; its own does", async () => {
    q.persist(textRecord(900042, 'ZZTEST gen', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    // Respawn: new instance, new marker. The session file only holds the OLD boot.
    inst = 'pty-instance-C';
    const newMarker = 'Current UTC time: 2026-09-30T12:50:00.000Z';
    agent.getBootMarker.mockReturnValue(newMarker);
    agent.getPtySpawnedAt.mockReturnValue(at('2026-09-30T12:50:00.000Z'));
    q.persist(textRecord(900043, 'ZZTEST after respawn', '2026-09-30T12:50:05.000Z'));
    await cycleAt(at('2026-09-30T12:50:30.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    const boot = E('boot_prompt_b64c01d7_line8');
    boot.message.content = boot.message.content.replace(MARKER, newMarker);
    boot.timestamp = '2026-09-30T12:50:09.000Z';
    boot.uuid = 'zztest-boot-2';
    const end = E('turn_duration_b64c01d7_line96');
    end.timestamp = '2026-09-30T12:51:00.000Z';
    appendFileSync(sessionFile, line(boot) + line(end));
    await cycleAt(at('2026-09-30T12:51:10.000Z'));
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
  });
});

describe('A2 — injected scaffolding never proves a reply', () => {
  const blocks = (token: string) => [
    FastChecker.formatTelegramTextMessage('Scott', CHAT, 'hi', '/fw', undefined, undefined, undefined, token),
    FastChecker.formatTelegramPhotoMessage('Scott', CHAT, 'cap', 'telegram-images/x.jpg', token),
    FastChecker.formatTelegramDocumentMessage('Scott', CHAT, 'cap', 'a.pdf', 'a.pdf', token),
    FastChecker.formatTelegramVoiceMessage('Scott', CHAT, 'v.ogg', 3, 'hello', token),
    FastChecker.formatTelegramVideoMessage('Scott', CHAT, 'cap', 'v.mp4', 'v.mp4', 3, token),
    FastChecker.formatTelegramReaction('Scott', CHAT, 12, [], [{ type: 'emoji', emoji: '👍' }]),
  ];

  for (const withToken of [true, false]) {
    it(`every formatter's echo (${withToken ? 'with' : 'without'} token), as typed AND as the TUI renders it without spaces, is stripped`, () => {
      for (const b of blocks(withToken ? TOKEN : '')) {
        expect(sendEvidenceInTranscript(b, CHAT)).toBe(false);
        expect(sendEvidenceInTranscript(b.replace(/[ \t]+/g, ''), CHAT)).toBe(false);
        expect(stripInjectedScaffolding(b, CHAT)).not.toMatch(/chat_id/);
      }
    });
  }

  it('injected, echoed, no outbound send => no resolution (the transcript rail no longer counts)', async () => {
    q.persist(textRecord(900050, 'ZZTEST echo only', '2026-09-30T12:40:00.000Z'));
    await cycleAt(at('2026-09-30T12:40:02.000Z'));
    appendFileSync(sessionFile, line(genuinePromptWith(telegramToken(900050), '2026-09-30T12:40:03.000Z', 'zztest-uuid-50')));
    // The transcript shows the block AND an agent send ATTEMPT — neither is a reply.
    writeFileSync(join(paths.logDir, 'stdout.log'), `${q.read(900050)!.formatted}\n$ scripts/telegram-send.sh "ZZTEST"\n`);
    await cycleAt(at('2026-09-30T12:40:09.000Z'));
    expect(q.read(900050)).not.toBeNull();
    expect(existsSync(join(paths.stateDir, 'pending-telegram-resolved', '900050.json'))).toBe(false);
  });
});

describe('A1 — every formatter carries the token in its header line', () => {
  it('text / photo / document / voice / video headers carry it, and it survives sanitizeForPtyInjection', () => {
    const blocks = [
      FastChecker.formatTelegramTextMessage('Scott', CHAT, 'hi', '/fw', undefined, undefined, undefined, TOKEN),
      FastChecker.formatTelegramPhotoMessage('Scott', CHAT, '', 'telegram-images/x.jpg', TOKEN),
      FastChecker.formatTelegramDocumentMessage('Scott', CHAT, '', 'a.pdf', 'a.pdf', TOKEN),
      FastChecker.formatTelegramVoiceMessage('Scott', CHAT, 'v.ogg', 3, 'hello', TOKEN),
      FastChecker.formatTelegramVideoMessage('Scott', CHAT, '', 'v.mp4', 'v.mp4', 3, TOKEN),
    ];
    for (const b of blocks) {
      expect(b.split('\n')[0]).toContain(TOKEN);
      expect(sanitizeForPtyInjection(b)).toContain(TOKEN);
    }
    // Text header keeps A0's shape: token BEFORE (chat_id:…).
    expect(blocks[0].split('\n')[0]).toBe(`=== TELEGRAM from [USER: Scott] ${TOKEN} (chat_id:${CHAT}) ===`);
  });
});
