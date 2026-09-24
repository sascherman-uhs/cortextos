/**
 * Durable Telegram queue — the state machine that replaces "claimed delivery".
 *
 * Between 2026-09-10 and 2026-09-23, 47 of Scott's 246 Telegram messages got no
 * reply, and on 2026-09-21 a 13-minute window destroyed everything he sent
 * including his verbatim resends. Root cause: the Telegram offset (an
 * irrevocable delivery claim) advanced before anything durable held the
 * message, and the only "proof" of delivery was that bytes reached a file
 * descriptor.
 *
 * The rules these tests exist to protect, in order of importance:
 *   1. A pending file is deleted ONLY when a reply to that chat is observed.
 *      The transcript header proves CONSUMPTION, never an answer — treating it
 *      as deletion would manufacture a clean record for exactly the 9/21 window.
 *   2. A handler that cannot durably take a message returns false, and the
 *      Telegram offset does NOT move.
 *   3. Dedup is keyed on update_id, so a system re-injection is suppressed and
 *      a verbatim human resend never is.
 *   4. Attempts cap at 2, then the miss is ADMITTED, not answered twice.
 *   5. Media with no text and no transcript is never injected.
 *
 * Offline by construction: no Telegram API call anywhere in this file — above
 * all no getUpdates, which would consume Scott's real messages.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PendingTelegramQueue,
  MAX_ATTEMPTS,
  IN_FLIGHT_RETRY_MS,
  UNATTEMPTED_RETRY_MS,
  admissionText,
  durableQueueEnabled,
  sendEvidenceInTranscript,
  strictPromptGateEnabled,
  headerNeedle,
  newRecord,
  readReplyTimestamps,
  EMPTY_MEDIA_REPLY,
} from '../../../src/telegram/pending-queue.js';
import { MessageDedup } from '../../../src/pty/inject.js';
import { TelegramPoller } from '../../../src/telegram/poller.js';
import { readFileSync } from 'fs';

let dir: string;
let q: PendingTelegramQueue;

/** No reply evidence on any rail. */
const noReply = () => false;
/** Reply evidence from the outbound-log rail only. */
const byOutboundLog = (replies: Map<string, number>) => (r: any) => q.repliedInOutboundLog(r, replies);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zztest-pending-'));
  q = new PendingTelegramQueue(join(dir, 'pending-telegram'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(updateId: number, overrides: Partial<ReturnType<typeof newRecord>> = {}) {
  return {
    ...newRecord({
      update_id: updateId,
      chat_id: '8727328514',
      from: 'Scott',
      text: 'ZZTEST where are we on the Durango install',
      formatted: 'ZZTEST block',
      header: headerNeedle('Scott', '8727328514'),
    }),
    ...overrides,
  };
}

describe('flag defaults', () => {
  it('is OFF unless explicitly enabled, so rollback is a flag not a revert', () => {
    expect(durableQueueEnabled({})).toBe(false);
    expect(durableQueueEnabled({ TELEGRAM_DURABLE_QUEUE: '' })).toBe(false);
    expect(durableQueueEnabled({ TELEGRAM_DURABLE_QUEUE: '0' })).toBe(false);
    expect(durableQueueEnabled({ TELEGRAM_DURABLE_QUEUE: '1' })).toBe(true);
    expect(durableQueueEnabled({ TELEGRAM_DURABLE_QUEUE: 'true' })).toBe(true);
  });

  it('ships the strict prompt gate OFF, and it cannot be on without the queue', () => {
    expect(strictPromptGateEnabled({ TELEGRAM_DURABLE_QUEUE: '1' })).toBe(false);
    expect(strictPromptGateEnabled({ TELEGRAM_PROMPT_GATE_STRICT: '1' })).toBe(false);
    expect(strictPromptGateEnabled({ TELEGRAM_DURABLE_QUEUE: '1', TELEGRAM_PROMPT_GATE_STRICT: '1' })).toBe(true);
  });
});

describe('persist -> in_flight -> answered', () => {
  it('persists a record durably and starts it unattempted', () => {
    expect(q.persist(rec(100))).toBe(true);
    const back = q.read(100);
    expect(back?.state).toBe('unattempted');
    expect(back?.attempts).toBe(0);
    expect(existsSync(join(dir, 'pending-telegram', '100.json'))).toBe(true);
  });

  it('records an attempt without advancing state — bytes written is not consumption', () => {
    q.persist(rec(101));
    const after = q.markAttempt(q.read(101)!);
    expect(after?.attempts).toBe(1);
    expect(after?.state).toBe('unattempted');
    expect(after?.first_attempt_at).toBeTruthy();
  });

  it('header in the transcript moves unattempted -> in_flight and NOTHING else', () => {
    q.persist(rec(102));
    q.markAttempt(q.read(102)!);
    q.markInFlight(q.read(102)!);
    const r = q.read(102)!;
    expect(r.state).toBe('in_flight');
    // THE load-bearing assertion: the file still exists. Consumption is not an answer.
    expect(existsSync(join(dir, 'pending-telegram', '102.json'))).toBe(true);
    expect(q.reapAnswered(noReply)).toBe(0);
    expect(q.read(102)).not.toBeNull();
  });

  it('deletes the file ONLY when a reply to that chat is observed', () => {
    q.persist(rec(103));
    q.markAttempt(q.read(103)!);
    q.markInFlight(q.read(103)!);
    const first = Date.parse(q.read(103)!.first_attempt_at!);

    // A reply that predates the injection proves nothing.
    expect(q.reapAnswered(byOutboundLog(new Map([['8727328514', first - 1000]])))).toBe(0);
    expect(q.read(103)).not.toBeNull();

    // A reply to a DIFFERENT chat proves nothing either.
    expect(q.reapAnswered(byOutboundLog(new Map([['999', first + 1000]])))).toBe(0);
    expect(q.read(103)).not.toBeNull();

    // A reply to this chat after the injection retires it.
    expect(q.reapAnswered(byOutboundLog(new Map([['8727328514', first + 1000]])))).toBe(1);
    expect(q.read(103)).toBeNull();
  });

  it('never retires a record that was never attempted', () => {
    q.persist(rec(104));
    expect(q.reapAnswered(byOutboundLog(new Map([['8727328514', Date.now() + 60_000]])))).toBe(0);
    expect(q.read(104)).not.toBeNull();
  });
});

describe('one file, one injection', () => {
  it('hands back the OLDEST eligible record, not a fused block', () => {
    q.persist(rec(210));
    q.persist(rec(208));
    q.persist(rec(209));
    expect(q.nextDeliverable(Date.now(), noReply)?.update_id).toBe(208);
    expect(q.list().map((r) => r.update_id)).toEqual([208, 209, 210]);
  });
});

describe('retry capping and the admission', () => {
  it('NEVER re-injects a consumed (in_flight) record — the live double-delivery bug', () => {
    // 2026-09-24 05:44: attempt 1 at :26, retry at :56, header for attempt 1 at
    // 05:45:03. The retry raced the suppressing signal and Scott's JARVIS said
    // "Got all two." A consumed block is already in the TUI; a second copy can
    // only duplicate it.
    q.persist(rec(300));
    q.markAttempt(q.read(300)!);
    q.markInFlight(q.read(300)!);
    const now = Date.parse(q.read(300)!.last_attempt_at!);
    expect(q.isEligible(q.read(300)!, now + 1000, noReply)).toBe(false);
    expect(q.isEligible(q.read(300)!, now + IN_FLIGHT_RETRY_MS + 1, noReply)).toBe(false);
    expect(q.nextDeliverable(now + IN_FLIGHT_RETRY_MS + 1, noReply)).toBeNull();
  });

  it('waits longer than the observed 37s header latency before retrying', () => {
    q.persist(rec(301));
    q.markAttempt(q.read(301)!);
    const now = Date.parse(q.read(301)!.last_attempt_at!);
    // The old 30s window is what produced the duplicate.
    expect(UNATTEMPTED_RETRY_MS).toBeGreaterThan(120_000);
    expect(q.isEligible(q.read(301)!, now + 30_000, noReply)).toBe(false);
    expect(q.isEligible(q.read(301)!, now + 37_000, noReply)).toBe(false);
    expect(q.isEligible(q.read(301)!, now + UNATTEMPTED_RETRY_MS + 1, noReply)).toBe(true);
  });

  it('admits a TRUE drop — never consumed, attempts spent — and retains the file', () => {
    q.persist(rec(302));
    q.markAttempt(q.read(302)!);
    q.markAttempt(q.read(302)!);
    const r = q.read(302)!;
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(r.state).toBe('unattempted'); // header never appeared
    const later = Date.parse(r.last_attempt_at!) + UNATTEMPTED_RETRY_MS + 1;
    expect(q.isEligible(r, later, noReply)).toBe(false);
    expect(q.dropCandidates(later, noReply).map((x) => x.update_id)).toEqual([302]);

    q.markEscalated(r, 'ZZTEST escalation');
    expect(q.read(302)!.state).toBe('escalated');
    expect(existsSync(join(dir, 'pending-telegram', '302.json'))).toBe(true);
    expect(q.dropCandidates(later, noReply)).toEqual([]);
  });

  it('never admits a miss for a CONSUMED message — the live false-escalation bug', () => {
    // 2026-09-24: the reply existed and was delivered twice, but left no row in
    // outbound-messages.jsonl (telegram-send.sh). Escalating here would have
    // told Scott "I may have missed this: «Test»" about an answered message.
    q.persist(rec(305));
    q.markAttempt(q.read(305)!);
    q.markAttempt(q.read(305)!);
    q.markInFlight(q.read(305)!);
    const r = q.read(305)!;
    const later = Date.parse(r.last_attempt_at!) + IN_FLIGHT_RETRY_MS + 1;
    expect(q.dropCandidates(later, noReply)).toEqual([]);
    // It becomes an operator-only record instead.
    expect(q.unverifiedCandidates(later, noReply).map((x) => x.update_id)).toEqual([305]);
    q.markUnverified(r, 'ZZTEST unverified');
    expect(q.read(305)!.state).toBe('unverified');
    expect(existsSync(join(dir, 'pending-telegram', '305.json'))).toBe(true);
    expect(q.unverifiedCandidates(later, noReply)).toEqual([]);
  });

  it('never escalates or flags a message that got an answer', () => {
    q.persist(rec(303));
    q.markAttempt(q.read(303)!);
    q.markAttempt(q.read(303)!);
    const r = q.read(303)!;
    const later = Date.parse(r.last_attempt_at!) + IN_FLIGHT_RETRY_MS + 1;
    const answered = byOutboundLog(new Map([['8727328514', Date.parse(r.first_attempt_at!) + 500]]));
    expect(q.dropCandidates(later, answered)).toEqual([]);
    expect(q.unverifiedCandidates(later, answered)).toEqual([]);
  });

  it('admits the miss rather than repeating an answer', () => {
    expect(admissionText('ZZTEST did we send the Durango contract?')).toBe(
      'I may have missed this: «ZZTEST did we send the Durango contract?» — do you still want it?',
    );
    expect(admissionText('   ')).toContain('could you resend it');
  });

  it('throttles a failed inject (attempts still 0) instead of spinning the poll loop', () => {
    q.persist(rec(304));
    const failedAt = new Date();
    q.patch(304, { last_attempt_at: failedAt.toISOString() });
    const r = q.read(304)!;
    expect(r.attempts).toBe(0);
    expect(q.isEligible(r, failedAt.getTime() + 1000, noReply)).toBe(false);
    expect(q.isEligible(r, failedAt.getTime() + UNATTEMPTED_RETRY_MS + 1, noReply)).toBe(true);
  });
});

describe('update_id dedupe vs a verbatim human resend', () => {
  it('suppresses a re-injection of the same attempt but never the resend', () => {
    const dedup = new MessageDedup();
    const body = 'ZZTEST are we still on for 2pm?';
    // Update 400, attempt 1 — injected once.
    expect(dedup.isDuplicate(body, 'tg:400#1')).toBe(false);
    // The system tries to inject the SAME attempt again: suppressed.
    expect(dedup.isDuplicate(body, 'tg:400#1')).toBe(true);
    // Scott resends the identical text. Different update_id => NOT suppressed.
    expect(dedup.isDuplicate(body, 'tg:401#1')).toBe(false);
    // Our own deliberate retry of update 400 stays injectable.
    expect(dedup.isDuplicate(body, 'tg:400#2')).toBe(false);
  });

  it('content keying — the old behaviour — would have eaten the resend', () => {
    const dedup = new MessageDedup();
    const body = 'ZZTEST are we still on for 2pm?';
    expect(dedup.isDuplicate(body)).toBe(false);
    expect(dedup.isDuplicate(body)).toBe(true); // the resend, destroyed
  });
});

describe('empty media', () => {
  it('is never deliverable and carries a human-legible notice', () => {
    q.persist(rec(500, { empty: true, formatted: '', text: '' }));
    expect(q.nextDeliverable(Date.now(), noReply)).toBeNull();
    q.markFailedNotified(q.read(500)!, 'ZZTEST no transcript');
    expect(q.read(500)!.state).toBe('failed_notified');
    expect(existsSync(join(dir, 'pending-telegram', '500.json'))).toBe(true);
    expect(EMPTY_MEDIA_REPLY).toBe("I couldn't transcribe that voice note — resend it or send text.");
  });

  it('an empty record is skipped while a later real message still gets through', () => {
    q.persist(rec(501, { empty: true, formatted: '', text: '' }));
    q.persist(rec(502));
    expect(q.nextDeliverable(Date.now(), noReply)?.update_id).toBe(502);
  });
});

describe('reply observation', () => {
  it('reads the newest outbound timestamp per chat and ignores malformed lines', () => {
    const logPath = join(dir, 'outbound-messages.jsonl');
    writeFileSync(
      logPath,
      [
        JSON.stringify({ timestamp: '2026-09-24T10:00:00Z', chat_id: '8727328514', text: 'ZZTEST a' }),
        'not json at all',
        JSON.stringify({ timestamp: '2026-09-24T11:00:00Z', chat_id: '8727328514', text: 'ZZTEST b' }),
        JSON.stringify({ timestamp: '2026-09-24T09:00:00Z', chat_id: '42', text: 'ZZTEST c' }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const map = readReplyTimestamps(logPath);
    expect(map.get('8727328514')).toBe(Date.parse('2026-09-24T11:00:00Z'));
    expect(map.get('42')).toBe(Date.parse('2026-09-24T09:00:00Z'));
  });

  it('a missing log yields no reply evidence, so nothing is deleted', () => {
    expect(readReplyTimestamps(join(dir, 'nope.jsonl')).size).toBe(0);
  });
});

describe('send evidence — every rail an agent can answer on', () => {
  const chat = '8727328514';

  it('recognises the rail that left NO local record at all (telegram-send.sh)', () => {
    expect(sendEvidenceInTranscript('$ scripts/telegram-send.sh "ZZTEST Got all two."', chat)).toBe(true);
  });

  it('recognises the cortextos rail and a direct API call', () => {
    expect(sendEvidenceInTranscript(`cortextos bus send-telegram ${chat} 'ZZTEST reply'`, chat)).toBe(true);
    expect(sendEvidenceInTranscript('POST https://api.telegram.org/bot123:ABC/sendMessage', chat)).toBe(true);
    expect(sendEvidenceInTranscript(`{"chat_id": ${chat}, "text": "ZZTEST"}`, chat)).toBe(true);
  });

  it('does not treat unrelated output, or a send to another chat, as a reply', () => {
    expect(sendEvidenceInTranscript('Reading files and running tests, nothing sent', chat)).toBe(false);
    expect(sendEvidenceInTranscript("cortextos bus send-telegram 999 'ZZTEST other chat'", chat)).toBe(false);
  });

  it('is empty-input safe', () => {
    expect(sendEvidenceInTranscript('', chat)).toBe(false);
  });

  it('records a byte watermark at injection so evidence can be ordered after it', () => {
    q.persist(rec(700));
    q.markAttempt(q.read(700)!);
    q.patch(700, { log_offset: 123456 });
    expect(q.read(700)!.log_offset).toBe(123456);
    // A record with no watermark must not be retired on transcript evidence:
    // there is no way to prove the evidence postdates the injection, and a
    // false positive DELETES a real message.
    q.persist(rec(701));
    expect(q.read(701)!.log_offset).toBeUndefined();
  });
});

describe('durability of the record set', () => {
  it('keeps an unreadable record on disk instead of dropping it', () => {
    q.persist(rec(600));
    writeFileSync(join(dir, 'pending-telegram', '601.json'), '{ truncated', 'utf-8');
    expect(q.list().map((r) => r.update_id)).toEqual([600]);
    expect(readdirSync(join(dir, 'pending-telegram')).sort()).toEqual(['600.json', '601.json']);
  });
});

describe('poller ACK semantics (no network)', () => {
  const update = (id: number) => ({ update_id: id, message: { message_id: id, text: 'ZZTEST hi', chat: { id: 1 }, from: { id: 7, first_name: 'Scott' } } });

  function fakeApi(updates: object[]) {
    return {
      getUpdates: async (offset: number) => ({
        ok: true,
        result: updates.filter((u: any) => u.update_id >= offset),
      }),
    } as any;
  }

  it('does NOT advance the offset when the handler declines the message', async () => {
    const poller = new TelegramPoller(fakeApi([update(900)]), dir);
    poller.onMessage(() => false);
    await poller.pollOnce();
    const offsetFile = join(dir, '.telegram-offset');
    const persisted = existsSync(offsetFile) ? readFileSync(offsetFile, 'utf-8').trim() : '0';
    expect(persisted).toBe('0');
  });

  it('advances the offset when the handler durably acks', async () => {
    const poller = new TelegramPoller(fakeApi([update(901)]), dir);
    poller.onMessage(() => true);
    await poller.pollOnce();
    expect(readFileSync(join(dir, '.telegram-offset'), 'utf-8').trim()).toBe('902');
  });

  it('awaits an async handler before acking, and passes the update_id through', async () => {
    const poller = new TelegramPoller(fakeApi([update(902)]), dir);
    const seen: number[] = [];
    let finished = false;
    poller.onMessage(async (_msg, updateId) => {
      seen.push(updateId);
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
      return true;
    });
    await poller.pollOnce();
    expect(seen).toEqual([902]);
    expect(finished).toBe(true);
    expect(readFileSync(join(dir, '.telegram-offset'), 'utf-8').trim()).toBe('903');
  });

  it('still treats a legacy void handler as success', async () => {
    const poller = new TelegramPoller(fakeApi([update(903)]), dir);
    poller.onMessage(() => { /* legacy sync handler */ });
    await poller.pollOnce();
    expect(readFileSync(join(dir, '.telegram-offset'), 'utf-8').trim()).toBe('904');
  });
});
