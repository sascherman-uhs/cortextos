/**
 * Durable pending-Telegram queue.
 *
 * Why this exists (2026-09-24). Between 2026-09-10 and 2026-09-23 at least 47
 * of Scott's 246 Telegram messages got no reply — 19% — and 74% of those were
 * in bursts of 2-7 inside ten minutes. On 2026-09-21 a 13-minute window
 * destroyed everything he sent, INCLUDING the copies he resent verbatim after
 * noticing the first ones were ignored.
 *
 * The whole failure was that delivery was CLAIMED without ever being PROVED:
 *   - `TelegramPoller.pollOnce` discarded the handler's return value and then
 *     persisted the Telegram offset — an irrevocable "delivered" promise —
 *     before anything durable held the message.
 *   - The handler's last act only pushed onto an in-memory array, which
 *     `FastChecker.pollCycle` drained with `shift()` into a local string.
 *   - `injectMessage`'s `{ok:true}` means only that bytes reached a file
 *     descriptor. There is no reverse channel from the TUI at all.
 *
 * This module is the durable thing that must hold a message BEFORE the offset
 * moves. One file per update_id under `state/<agent>/pending-telegram/`.
 *
 * THE LOAD-BEARING RULE: a pending file is deleted ONLY when a reply to that
 * chat is observed. The `=== TELEGRAM from ...` header appearing in the PTY
 * transcript proves the TUI *consumed* the block — it does NOT prove anyone
 * answered — so the header moves a record `unattempted -> in_flight`, which
 * changes retry eligibility and NOTHING else. Treating the header as deletion
 * would have manufactured a spotless delivery record for exactly the 9/21
 * window in which Scott sat repeating himself into a void.
 *
 * State machine:
 *   unattempted --header seen--> in_flight --reply seen--> (file deleted)
 *   never consumed + attempts exhausted --> escalated  (RETAINED, Scott is told)
 *   consumed but no reply we can see    --> unverified (RETAINED, operator only)
 *   media with no text and no transcript --> failed_notified (RETAINED)
 * Nothing is ever silently dropped.
 *
 * Why `unverified` exists (live defect, 2026-09-24 05:45). Scott's first real
 * message through this queue was answered TWICE ("Got all two"), and the reply
 * left no row in outbound-messages.jsonl at all: the agent answered via
 * uhsJARVIS `scripts/telegram-send.sh`, which POSTs straight to
 * api.telegram.org and records nothing locally. Escalating on the absence of
 * that row would have told Scott "I may have missed this: «Test»" about a
 * message he had been answered on twice — the system looking confused is worse
 * than the deafness we set out to fix. So an admission to Scott now requires
 * that the message was NEVER CONSUMED (header never appeared). A consumed
 * message with no observable reply is an OBSERVABILITY gap, not a lost
 * message, and it is surfaced to the operator, never to Scott.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

export type PendingState =
  | 'unattempted'
  | 'in_flight'
  | 'escalated'
  | 'unverified'
  | 'failed_notified'
  /**
   * Closed by a human who confirmed out-of-band that the message WAS answered.
   * Written by an operator, never by this code (the first one was update
   * 462809024 on 2026-09-24, resolved by hand to stop a false escalation
   * reaching Scott). Recognised here so the queue treats it as terminal:
   * never re-injected, never escalated, never reaped, and its audit note is
   * left exactly as the human wrote it.
   */
  | 'answered_manual';

/** States the queue will not act on again. */
export const TERMINAL_STATES: readonly PendingState[] = [
  'escalated',
  'unverified',
  'failed_notified',
  'answered_manual',
];

function isTerminal(state: PendingState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface PendingTelegramRecord {
  update_id: number;
  chat_id: string;
  from: string;
  /**
   * The human-legible message text (caption or transcript for media). Kept
   * separately from `formatted` because the attempt-cap admission quotes it
   * back to Scott verbatim, and because a record persisted before a media
   * round trip has no formatted block yet.
   */
  text: string;
  /** The fully formatted injection block. '' = not formatted yet (media). */
  formatted: string;
  /** The `=== TELEGRAM from ...` header line — the transcript-proof needle. */
  header: string;
  state: PendingState;
  attempts: number;
  /** Media that yielded neither text nor transcript. Never injectable. */
  empty: boolean;
  created_at: string;
  first_attempt_at?: string;
  last_attempt_at?: string;
  in_flight_at?: string;
  /**
   * Size of the agent's stdout.log at injection time. Send-evidence scanning
   * only reads bytes AFTER this watermark, which gives a rigorous "after the
   * injection" ordering for a rail that writes no timestamps anywhere.
   */
  log_offset?: number | null;
  notes: string[];
}

/** After this many injections with no observed reply, admit it rather than repeat. */
export const MAX_ATTEMPTS = 2;
/**
 * How long to wait for the header before concluding the block never landed.
 *
 * Was a flat 30s, which produced a DOUBLE DELIVERY on the first real message
 * (2026-09-24): attempt 1 at 05:44:26, attempt 2 at 05:44:56, and the header
 * for attempt 1 only appeared at 05:45:03 — 37s after injection. The retry
 * raced the very signal meant to suppress it and Scott's JARVIS replied "Got
 * all two."
 *
 * 180s: ~5x the observed latency, with headroom for a busy agent (the live
 * case was NOT at a prompt on either attempt, so the TUI was mid-turn and
 * slower to echo than a quiet one). Telegram itself has already retained the
 * message, so a three-minute delay costs a little latency; a duplicate costs
 * Scott's trust in every reply he gets.
 */
export const UNATTEMPTED_RETRY_MS = 180_000;
/**
 * How long a consumed-but-unanswered message waits before it is recorded as
 * unverified. It is never RE-INJECTED: the header proves the block is already
 * in the TUI, so a second copy can only duplicate it.
 */
export const IN_FLIGHT_RETRY_MS = 10 * 60_000;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Master flag. Default OFF so the rollback is a flag, not a revert: with
 * TELEGRAM_DURABLE_QUEUE unset every path in this change falls back to the
 * pre-existing in-memory behaviour exactly.
 */
export function durableQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.TELEGRAM_DURABLE_QUEUE);
}

/**
 * The prompt-state gate's strict flip. Ships in the same commit as the gate
 * itself — never a gate without its satisfier — but OFF, so for the first 24h
 * the gate only logs "would have held" and injects anyway.
 */
export function strictPromptGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return durableQueueEnabled(env) && truthy(env.TELEGRAM_PROMPT_GATE_STRICT);
}

/**
 * Latest outbound reply timestamp (ms) per chat_id, read from the agent's
 * outbound-messages.jsonl. This is the ONLY evidence accepted for deleting a
 * pending file: the agent actually sent something back to that chat.
 */
export function readReplyTimestamps(outboundLogPath: string, maxLines = 400): Map<string, number> {
  const out = new Map<string, number>();
  try {
    if (!existsSync(outboundLogPath)) return out;
    const raw = readFileSync(outboundLogPath, 'utf-8').trim();
    if (!raw) return out;
    const lines = raw.split('\n').filter(Boolean).slice(-maxLines);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { chat_id?: unknown; timestamp?: unknown };
        const chatId = obj.chat_id === undefined || obj.chat_id === null ? '' : String(obj.chat_id);
        if (!chatId) continue;
        const ts = Date.parse(String(obj.timestamp ?? ''));
        if (Number.isNaN(ts)) continue;
        const prev = out.get(chatId);
        if (prev === undefined || ts > prev) out.set(chatId, ts);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // Unreadable log: no reply evidence. Fails toward RETAINING pending files,
    // which is the safe direction — we would rather retry than lose a message.
  }
  return out;
}

/**
 * Patterns that prove an agent ATTEMPTED to send to this chat from inside its
 * own session. Needed because not every reply rail leaves a local record:
 * uhsJARVIS `scripts/telegram-send.sh` POSTs directly to api.telegram.org and
 * writes nothing anywhere (that repo is another session's, so the rail is
 * observed here rather than instrumented there).
 *
 * Every rail an agent can use is a command it runs in its PTY, so the PTY
 * transcript covers all of them. Weaker than an outbound-log row — it proves a
 * send was attempted, not that Telegram accepted it — which is the right trade
 * when the alternative is telling the human we missed something we answered.
 */
export function sendEvidenceInTranscript(text: string, chatId: string): boolean {
  if (!text) return false;
  const patterns: RegExp[] = [
    /telegram-send\.sh/,
    /telegram_notify\.py/,
    /telegram-send\.py/,
    new RegExp(`send-telegram\\s+['"\`]?${chatId}`),
    new RegExp(`sendMessage[^\\n]{0,200}${chatId}`),
    new RegExp(`chat_id['"\\s:=]{1,6}${chatId}`),
    /api\.telegram\.org\/bot[^\s]*\/sendMessage/,
  ];
  return patterns.some((re) => re.test(text));
}

export class PendingTelegramQueue {
  readonly dir: string;
  private log: (msg: string) => void;

  constructor(dir: string, log?: (msg: string) => void) {
    this.dir = dir;
    this.log = log ?? (() => {});
  }

  private pathFor(updateId: number): string {
    return join(this.dir, `${updateId}.json`);
  }

  /**
   * Durably write a record. Returns false if the write failed — the poller
   * MUST then leave the Telegram offset alone so the update is redelivered.
   */
  persist(rec: PendingTelegramRecord): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      atomicWriteSync(this.pathFor(rec.update_id), JSON.stringify(rec, null, 2));
      return true;
    } catch (err) {
      this.log(`pending-queue: persist failed for update ${rec.update_id}: ${String(err)}`);
      return false;
    }
  }

  read(updateId: number): PendingTelegramRecord | null {
    try {
      const p = this.pathFor(updateId);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf-8')) as PendingTelegramRecord;
    } catch {
      return null;
    }
  }

  patch(updateId: number, fields: Partial<PendingTelegramRecord>): PendingTelegramRecord | null {
    const cur = this.read(updateId);
    if (!cur) return null;
    const next = { ...cur, ...fields };
    return this.persist(next) ? next : null;
  }

  /** Every record on disk, oldest update_id first. */
  list(): PendingTelegramRecord[] {
    let names: string[] = [];
    try {
      if (!existsSync(this.dir)) return [];
      names = readdirSync(this.dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return [];
    }
    const recs: PendingTelegramRecord[] = [];
    for (const n of names) {
      try {
        recs.push(JSON.parse(readFileSync(join(this.dir, n), 'utf-8')) as PendingTelegramRecord);
      } catch {
        this.log(`pending-queue: unreadable record ${n} — left in place for audit`);
      }
    }
    return recs.sort((a, b) => a.update_id - b.update_id);
  }

  remove(updateId: number): void {
    try {
      unlinkSync(this.pathFor(updateId));
    } catch {
      // already gone
    }
  }

  /**
   * Reply evidence from the cortextos rail: a row in outbound-messages.jsonl
   * for this chat, strictly newer than the first attempt. Requires attempts >= 1
   * so an unrelated earlier outbound can never delete an unattempted record.
   *
   * This is ONE rail of several — see ReplyEvidence / answeredBy in
   * fast-checker for the union. It is the strongest (it proves Telegram
   * accepted the send) but it is NOT complete: telegram-send.sh bypasses it.
   */
  repliedInOutboundLog(rec: PendingTelegramRecord, replies: Map<string, number>): boolean {
    if (rec.attempts < 1) return false;
    const since = Date.parse(rec.first_attempt_at ?? rec.created_at);
    if (Number.isNaN(since)) return false;
    const reply = replies.get(rec.chat_id);
    return reply !== undefined && reply > since;
  }

  /** Delete every record with observed reply evidence on ANY rail. Returns the count. */
  reapAnswered(answered: (rec: PendingTelegramRecord) => boolean): number {
    let n = 0;
    for (const rec of this.list()) {
      // A terminal record is an audit record. Never delete one, even if reply
      // evidence turns up later — a human's resolution note is the only record
      // of why it was closed.
      if (isTerminal(rec.state)) continue;
      if (answered(rec)) {
        this.remove(rec.update_id);
        n++;
      }
    }
    return n;
  }

  isEligible(rec: PendingTelegramRecord, now: number, answered: (rec: PendingTelegramRecord) => boolean): boolean {
    if (rec.empty) return false;
    if (isTerminal(rec.state)) return false;
    // A consumed block is already in the TUI. Re-injecting it can only produce
    // the duplicate delivery observed live on 2026-09-24 ("Got all two").
    if (rec.state === 'in_flight') return false;
    if (answered(rec)) return false;
    if (rec.attempts === 0) {
      // attempts stays 0 when an inject FAILED outright (agent down, paste
      // threw). Throttle those so a stopped agent does not spin the poll loop,
      // while keeping the record permanently eligible — it is never dropped.
      if (!rec.last_attempt_at) return true;
      const lastFail = Date.parse(rec.last_attempt_at);
      return Number.isNaN(lastFail) || now - lastFail >= UNATTEMPTED_RETRY_MS;
    }
    if (rec.attempts >= MAX_ATTEMPTS) return false;
    const last = Date.parse(rec.last_attempt_at ?? rec.created_at);
    if (Number.isNaN(last)) return true;
    // Retry is gated on the HEADER'S ABSENCE (state still unattempted) plus a
    // bound comfortably larger than observed header latency — not on a short
    // fixed timer that races the signal.
    return now - last >= UNATTEMPTED_RETRY_MS;
  }

  /**
   * The single oldest record to inject this cycle — ONE file, ONE injection,
   * ONE accounting row. Coalescing several messages into one fused block is
   * what made per-message durability incoherent and produced false
   * "unanswered" readings when only the last line of a block got answered.
   * Three queued messages now mean three turns. That cost is accepted.
   */
  nextDeliverable(now: number, answered: (rec: PendingTelegramRecord) => boolean): PendingTelegramRecord | null {
    for (const rec of this.list()) {
      if (this.isEligible(rec, now, answered)) return rec;
    }
    return null;
  }

  /**
   * TRUE drops: the header NEVER appeared, so the block never reached the TUI,
   * and the attempts are spent. Only these earn an admission to the human —
   * requiring "never consumed" is what stops the queue telling Scott it missed
   * a message he was answered on twice.
   */
  dropCandidates(now: number, answered: (rec: PendingTelegramRecord) => boolean): PendingTelegramRecord[] {
    const out: PendingTelegramRecord[] = [];
    for (const rec of this.list()) {
      if (rec.empty) continue;
      // ONLY 'unattempted' earns an admission, which also means every terminal
      // state — including a human's answered_manual — is excluded by construction.
      if (rec.state !== 'unattempted') continue;
      if (rec.attempts < MAX_ATTEMPTS) continue;
      if (answered(rec)) continue;
      const last = Date.parse(rec.last_attempt_at ?? rec.created_at);
      if (!Number.isNaN(last) && now - last < UNATTEMPTED_RETRY_MS) continue;
      out.push(rec);
    }
    return out;
  }

  /**
   * Consumed by the TUI, but no reply we can observe on any rail. This is an
   * OBSERVABILITY gap, not a lost message: it is recorded for the operator and
   * NOTHING is sent to the human.
   */
  unverifiedCandidates(now: number, answered: (rec: PendingTelegramRecord) => boolean): PendingTelegramRecord[] {
    const out: PendingTelegramRecord[] = [];
    for (const rec of this.list()) {
      if (rec.empty) continue;
      if (rec.state !== 'in_flight') continue;
      if (answered(rec)) continue;
      const since = Date.parse(rec.in_flight_at ?? rec.last_attempt_at ?? rec.created_at);
      if (!Number.isNaN(since) && now - since < IN_FLIGHT_RETRY_MS) continue;
      out.push(rec);
    }
    return out;
  }

  /** Record an injection attempt. State is NOT advanced here — only the header can do that. */
  markAttempt(rec: PendingTelegramRecord, at = new Date()): PendingTelegramRecord | null {
    const iso = at.toISOString();
    return this.patch(rec.update_id, {
      attempts: rec.attempts + 1,
      first_attempt_at: rec.first_attempt_at ?? iso,
      last_attempt_at: iso,
    });
  }

  /**
   * The header was seen in the stripped PTY transcript: the TUI consumed the
   * block. Retry eligibility changes; the file is NOT deleted. Only an
   * observed reply deletes it.
   */
  markInFlight(rec: PendingTelegramRecord, at = new Date()): PendingTelegramRecord | null {
    if (rec.state !== 'unattempted') return rec;
    return this.patch(rec.update_id, { state: 'in_flight', in_flight_at: at.toISOString() });
  }

  markEscalated(rec: PendingTelegramRecord, note: string): PendingTelegramRecord | null {
    return this.patch(rec.update_id, { state: 'escalated', notes: [...rec.notes, note] });
  }

  markUnverified(rec: PendingTelegramRecord, note: string): PendingTelegramRecord | null {
    return this.patch(rec.update_id, { state: 'unverified', notes: [...rec.notes, note] });
  }

  markFailedNotified(rec: PendingTelegramRecord, note: string): PendingTelegramRecord | null {
    return this.patch(rec.update_id, { state: 'failed_notified', notes: [...rec.notes, note] });
  }
}

/** Build a fresh record. `formatted` may be '' when a media round trip still owes us the block. */
export function newRecord(fields: {
  update_id: number;
  chat_id: string | number;
  from: string;
  text: string;
  formatted?: string;
  header?: string;
  empty?: boolean;
  note?: string;
}): PendingTelegramRecord {
  return {
    update_id: fields.update_id,
    chat_id: String(fields.chat_id),
    from: fields.from,
    text: fields.text,
    formatted: fields.formatted ?? '',
    header: fields.header ?? '',
    state: 'unattempted',
    attempts: 0,
    empty: fields.empty ?? false,
    created_at: new Date().toISOString(),
    notes: fields.note ? [fields.note] : [],
  };
}

/**
 * The header needle for a formatted block — the substring whose appearance in
 * the stripped transcript proves the TUI consumed it.
 */
export function headerNeedle(from: string, chatId: string | number): string {
  return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===`;
}

/** The admission sent after the attempt cap. An admission, never a duplicate answer. */
export function admissionText(text: string): string {
  const preview = text.trim().length > 300 ? `${text.trim().slice(0, 300)}…` : text.trim();
  return preview
    ? `I may have missed this: «${preview}» — do you still want it?`
    : 'I may have missed a message you sent — could you resend it?';
}

export const EMPTY_MEDIA_REPLY =
  "I couldn't transcribe that voice note — resend it or send text.";
