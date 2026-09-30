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
 * THE LOAD-BEARING RULE: a pending file is retired (since 2026-09-30:
 * archived, not deleted) ONLY when a reply to that chat is observed. The `=== TELEGRAM from ...` header appearing in the PTY
 * transcript proves the TUI *consumed* the block — it does NOT prove anyone
 * answered — so the header moves a record `unattempted -> in_flight`, which
 * changes retry eligibility and NOTHING else. Treating the header as deletion
 * would have manufactured a spotless delivery record for exactly the 9/21
 * window in which Scott sat repeating himself into a void.
 *
 * State machine — records with a `token` (written since 2026-09-30):
 *   unattempted --paste (accounting persisted FIRST)--> in_flight/pasted
 *   pasted --Claude Code recorded the prompt--> in_flight/submitted (consumed)
 *   pasted --no such record within SUBMIT_TIMEOUT_MS--> in_flight/stuck
 *          (UNKNOWN: never re-pasted, one receipt to the human, watchdog alert;
 *           late proof moves it to submitted)
 *   paste wrote NOTHING (PTY absent) --> back to unattempted, retried;
 *          MAX_ATTEMPTS of those --> escalated (the only admission)
 *   submitted, no reply after 10 min --> unverified (operator only)
 *   any non-terminal or unverified + reply seen --> archived to
 *          pending-telegram-resolved/ with resolved_at + resolution
 *   media with no text and no transcript --> failed_notified (after the notice)
 * Legacy records (no token) keep the header-needle rules below.
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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

/**
 * SINGLE WRITER (A4, 2026-09-30). Every write to `pending-telegram/` and
 * `pending-telegram-resolved/` happens in the daemon process, on the agent's
 * FastChecker/poller thread — there is no second process writing these files.
 * The `rev` counter therefore guards against ONE hazard: a caller that read a
 * record, awaited something (a Telegram send, a download), and then writes
 * back a copy that another step of the same process changed in between. Such a
 * caller passes `expectRev` and gets `null` instead of clobbering.
 *
 * Operators (B1 one-off scripts, a human resolving a record by hand) write
 * outside this discipline; `rev` is optional so their records still load.
 */

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
  // --- Media identity (A0, 2026-09-30). Optional: records written before this
  // change have none of them and are handled exactly as before. -------------
  /** Telegram file_id of the attachment — what a later re-download would need. */
  file_id?: string;
  /** photo | document | voice | audio | video | video_note */
  media_type?: string;
  /** Telegram message_id of the inbound media message. */
  message_id?: number;
  /**
   * A3 media state machine. A0 only HONOURS media_state/media_deadline_at, so
   * rolling A1–A7 back to A0 can never re-terminalize a record whose download
   * the newer code still considers in progress.
   */
  media_state?: 'pending' | 'ready' | 'failed';
  media_deadline_at?: string;
  /** Download generation: only a completion carrying the CURRENT gen may land. */
  media_gen?: number;
  /** Re-downloads started after a missed deadline (max 1). */
  media_retries?: number;
  /** Final path of the attachment, relative to the agent dir: telegram-images/<update_id>-<name>. */
  media_dest?: string;
  file_unique_id?: string;
  file_name?: string;
  /** Telegram message `date` (unix seconds). */
  message_date?: number;
  /** Voice/audio/video duration (s), for the block. */
  media_duration?: number;

  // --- Provable delivery (A1/V5, 2026-09-30). Absent on older records. ------
  /**
   * `⟦u:<update_id>⟧` — emitted in the formatted block's header line. The
   * consumption needle: found in Claude Code's session JSONL (V5-1) or, for
   * runtimes without one, in the normalized PTY output.
   */
  token?: string;
  /**
   * Where the paste stands (JSONL-proof runtimes only):
   *   pasted    — bytes were written; no proof of submission yet (UNKNOWN);
   *   submitted — Claude Code recorded the prompt (see submitted_via). With
   *               `in_flight_at` it was READ (genuine prompt / queued_command);
   *               without it only an enqueue row shows the composer accepted
   *               Enter — submitted-but-unread, still scanned, never unverified;
   *   stuck     — no proof within SUBMIT_TIMEOUT_MS: the composer probably
   *               holds it unsent. Never re-pasted; queues later messages.
   * The uhsJARVIS audit reads `submit_phase === 'stuck'` as STUCK.
   */
  submit_phase?: 'pasted' | 'submitted' | 'stuck';
  /** Persisted BEFORE the first PTY byte; JSONL evidence older than this never counts. */
  attempt_started_at?: string;
  submit_deadline_at?: string;
  /** The PTY instance the paste went to — a respawn opens the stuck gate. */
  pty_instance?: string;
  submitted_at?: string;
  submitted_via?: 'prompt' | 'queued_command' | 'enqueue' | 'pty';
  /** JSONL entry uuids already counted for this record (R4-1 dedupe). */
  proof_uuids?: string[];
  stuck_at?: string;
  /** The one truthful "hasn't picked it up yet" receipt (V5-2c). */
  stuck_receipt_at?: string;
  stuck_receipt_attempts?: number;
  /** 24 h after the attempt with no proof: scanning stops; the record stays UNKNOWN. */
  proof_window_closed_at?: string;
  /** A write error AFTER some bytes reached the PTY (V5-3: UNKNOWN, never DROP). */
  write_error?: string;
  /** The token was seen in PTY output — a hint only, never proof, in JSONL mode. */
  pty_hint_at?: string;
  /**
   * Held before injection past the boot-hold bound (Codex round 15 #6): the
   * agent's session has not shown readiness, so the message is still queued.
   * Set on every held record and cleared when the hold releases. The watchdog
   * reports it as HELD — an engineering alert; injection stays held.
   */
  hold_escalated_at?: string;
  hold_reason?: 'boot_not_ready';
  /** Pastes that wrote NOTHING (PTY absent / first write threw) — V5-3 positive non-delivery. */
  nondelivery_failures?: number;

  // --- Store (A4) ------------------------------------------------------------
  /** Incremented on every patch; see SINGLE WRITER above. */
  rev?: number;
  /** Set (with `resolution`) immediately before the record is archived. */
  resolved_at?: string;
  /** 'answered' — a reply to this chat was observed after the injection. */
  resolution?: string;
  resolved_by?: string;

  // --- Sender notices (A5) --------------------------------------------------
  /** Set only after the notice was actually sent. */
  notified_at?: string;
  notify_attempts?: number;
  /** The notice failed NOTIFY_MAX_ATTEMPTS times — reported by the audit. */
  notify_failed?: boolean;

  // --- Receipt acks (A6). Absent (legacy) => never acked. ---------------------
  ack_stage?: 0 | 1 | 2;
  ack1_at?: string;
  ack2_at?: string;
}

/** Sibling archive dir for resolved records (same filesystem => atomic rename). */
export const RESOLVED_DIR_NAME = 'pending-telegram-resolved';
/** Resolved records are pruned after this long (> the audit's lookback). */
export const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A sender notice is attempted at most this many times, then `notify_failed`. */
export const NOTIFY_MAX_ATTEMPTS = 3;
/** V5-2c: no proof of submission within this long => `stuck`. */
export const SUBMIT_TIMEOUT_MS = 60_000;
/** Late submission evidence keeps counting this long after the attempt (V5-1). */
export const PROOF_WINDOW_MS = 24 * 60 * 60_000;

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

/**
 * How long a raw media record (persisted BEFORE its download, `formatted === ''`)
 * is held — neither deliverable nor treated as orphaned — while the download
 * and transcription finish.
 *
 * Why (2026-09-30). The raw record is persisted first so the Telegram offset can
 * advance safely, and the checker's poll cycle then saw it within ~1 second,
 * concluded "the daemon died between persisting and formatting", and marked it
 * `failed_notified` without telling anyone. The download landed two seconds
 * later on a terminal record that was never injected. 23 of 25 photos Scott
 * sent between 9/24 and 9/29 were dropped this way; on 9/30 JARVIS missed a
 * warehouse-capacity sheet and shipped a guessed migration instead.
 *
 * 180s: the measured persist -> "durable record updated" gap over all 25 media
 * records in the pm2 logs was 1-3s (p99 3s), so this is ~60x p99 — and it is
 * also the bound on how long a genuinely orphaned record (daemon really did
 * die) waits before the expiry path tells the sender.
 */
export const MEDIA_GRACE_MS = 180_000;

/** MEDIA_GRACE_MS, overridable with TELEGRAM_MEDIA_GRACE_MS (positive integer ms). */
export function mediaGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TELEGRAM_MEDIA_GRACE_MS;
  if (!raw) return MEDIA_GRACE_MS;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MEDIA_GRACE_MS;
}

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
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove everything the DAEMON injected (A2): every Telegram formatter's header
 * line (TEXT / PHOTO / DOCUMENT / VOICE / VIDEO / REACTION, with or without the
 * `⟦u:…⟧` token), the `Reply using: cortextos bus send-telegram <chat>` footer,
 * the retry preamble and the `[Your last message …]` context line. Each names
 * the chat, and each is echoed into the transcript AFTER the injection's
 * watermark — unstripped, a block "proved" its own reply the moment it landed.
 *
 * Whitespace-tolerant (`\s*` between every word): the current Claude Code TUI
 * draws spaces as cursor moves, so the stripped PTY text reads
 * `Replyusing:cortextosbussend-telegram8727…`. A pattern that needs a literal
 * space would silently stop stripping.
 */
export function stripInjectedScaffolding(text: string, chatId: string): string {
  const id = escapeRegExp(chatId);
  const ws = '\\s*';
  return text
    .replace(new RegExp(`Reply${ws}using:${ws}cortextos${ws}bus${ws}send-telegram${ws}${id}${ws}'<your${ws}reply>'`, 'g'), '')
    .replace(new RegExp(`={3}${ws}TELEGRAM${ws}(?:PHOTO|DOCUMENT|VOICE|VIDEO)?${ws}from[^\\n]*?\\(${ws}chat_id${ws}:${ws}${id}${ws}\\)${ws}={3}`, 'g'), '')
    .replace(new RegExp(`={3}${ws}REACTION${ws}from[^\\n]*?\\(${ws}chat_id${ws}:${ws}${id}${ws}\\)[^\\n]*?={3}`, 'g'), '')
    .replace(new RegExp(`\\[RETRY${ws}attempt${ws}\\d+\\][^\\n]*`, 'g'), '')
    .replace(/\[Your\s*last\s*message[^\n]*/g, '');
}

/**
 * Did the agent run a send command for this chat? A DIAGNOSTIC HINT ONLY since
 * 2026-09-30 (A2): a send ATTEMPT in the transcript is not a reply. Reply
 * evidence is the outbound log (which the shell rail now writes too, V4-6) and
 * the last-sent cache — both written only after Telegram accepted the send.
 */
export function sendEvidenceInTranscript(text: string, chatId: string): boolean {
  if (!text) return false;
  text = stripInjectedScaffolding(text, chatId);
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
  /** Sibling archive (A4/C2): same parent => same filesystem => atomic rename. */
  readonly resolvedDir: string;
  private log: (msg: string) => void;
  /** See MEDIA_GRACE_MS. Read once at construction; tests pass it explicitly. */
  readonly mediaGraceMs: number;

  constructor(dir: string, log?: (msg: string) => void, opts: { mediaGraceMs?: number } = {}) {
    this.dir = dir;
    this.resolvedDir = join(dirname(dir), RESOLVED_DIR_NAME);
    this.log = log ?? (() => {});
    this.mediaGraceMs = opts.mediaGraceMs ?? mediaGraceMs();
  }

  /**
   * A media download still owes this record its block. While held, a record is
   * NOT deliverable and NOT an orphan — the two readings the 9/30 race confused.
   *
   * Held when non-terminal AND either:
   *   - `formatted === ''` and it is younger than the grace window, or
   *   - it carries A3's `media_state: 'pending'` with a deadline still ahead.
   * Past the grace window a raw record falls through to the expiry path in the
   * checker (caption injected with a note, or the sender told to resend).
   */
  isMediaHeld(rec: PendingTelegramRecord, now: number): boolean {
    if (isTerminal(rec.state)) return false;
    if (rec.media_state === 'pending') {
      // A3: the checker's deadline pass owns this record. A pending record past
      // its deadline is still held here — the deadline pass retries it or moves
      // it to 'failed' in the same cycle; it is never injected raw.
      if (!rec.media_deadline_at) return true;
      const deadline = Date.parse(rec.media_deadline_at);
      if (Number.isNaN(deadline) || now < deadline || rec.media_gen !== undefined) return true;
    }
    if (rec.formatted !== '') return false;
    const created = Date.parse(rec.created_at);
    if (Number.isNaN(created)) return false;
    return now - created < this.mediaGraceMs;
  }

  /**
   * Media records whose download has not settled into a block: NON-TERMINAL
   * with `formatted === ''` (the raw A0/legacy shape) or `media_state:
   * 'pending'`. Terminal historical records are never counted. This is the
   * record half of the rollback drain gate (see intake-control.ts).
   */
  unfinishedMedia(): PendingTelegramRecord[] {
    return this.list().filter(
      (r) => !isTerminal(r.state) && !r.resolved_at && (r.formatted === '' || r.media_state === 'pending'),
    );
  }

  /**
   * Captionless raw media whose grace has run out: nothing can be injected, so
   * the checker tells the sender to resend (and only marks the record once that
   * notice has actually been sent). A0/legacy shape only — A3 records (they
   * carry media_state) are owned by the checker's media deadline pass.
   */
  expiredCaptionlessMedia(now: number): PendingTelegramRecord[] {
    return this.active().filter(
      (r) =>
        r.state === 'unattempted' &&
        r.media_state === undefined &&
        !r.empty &&
        r.formatted === '' &&
        !r.text.trim() &&
        !this.isMediaHeld(r, now),
    );
  }

  /**
   * Land a finished media round trip on its record (A0 / legacy records — A3
   * records complete through the checker's generation-fenced path).
   *
   * The record may have moved while the download ran:
   *   - still raw / non-terminal       => patch the block in ('updated');
   *   - `failed_notified`, never injected (attempts 0) — the sender was told it
   *     hadn't come through — => RE-ARM: back to `unattempted`, block prefixed
   *     so the agent knows the resend note is moot ('rearmed');
   *   - any other terminal state, or an answered-and-reaped record => nothing
   *     is re-injected ('discarded' / 'missing').
   * Every write's result is checked: 'write_failed' is never reported as done.
   */
  applyMediaCompletion(
    updateId: number,
    fields: { formatted: string; text: string; empty: boolean; notes?: string[] },
  ): 'updated' | 'rearmed' | 'discarded' | 'missing' | 'write_failed' {
    const cur = this.read(updateId);
    if (!cur) return 'missing';
    const notes = [...cur.notes, ...(fields.notes ?? [])];
    if (!isTerminal(cur.state)) {
      const next: Partial<PendingTelegramRecord> = { formatted: fields.formatted, text: fields.text, empty: fields.empty, notes };
      if (cur.formatted && fields.formatted && cur.attempts > 0) {
        // The expiry path already injected the caption. The block is updated so
        // a retry would carry the attachment, but it is NOT re-injected.
        next.notes = [...notes, 'media completed after the caption was injected — not re-injected'];
      }
      return this.patch(updateId, next, { expectRev: cur.rev ?? 0 }) ? 'updated' : 'write_failed';
    }
    if (cur.state === 'failed_notified' && cur.attempts === 0 && !fields.empty && fields.formatted) {
      const next: Partial<PendingTelegramRecord> = {
        state: 'unattempted',
        empty: false,
        formatted: `${LATE_MEDIA_PREFIX}\n${fields.formatted}`,
        text: fields.text,
        notes: [...notes, 'media arrived after the sender was told to resend — re-armed'],
        last_attempt_at: undefined,
      };
      return this.patch(updateId, next, { expectRev: cur.rev ?? 0 }) ? 'rearmed' : 'write_failed';
    }
    return 'discarded';
  }

  private pathFor(updateId: number): string {
    return join(this.dir, `${updateId}.json`);
  }

  private resolvedPathFor(updateId: number): string {
    return join(this.resolvedDir, `${updateId}.json`);
  }

  /**
   * Durably write a whole record (overwrite). Returns false if the write
   * failed. New inbound updates go through insert(), which never overwrites.
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

  /**
   * Create-if-absent (A4). A redelivered update — Telegram resends when the
   * offset was not acked — must never overwrite the record the first delivery
   * created (it may already be mid-download, pasted, or answered and archived):
   *   'inserted'     — new record written;
   *   'exists'       — a record for this update_id is already pending OR in the
   *                    resolved archive; the redelivery is a no-op (ack it);
   *   'write_failed' — nothing durable; the caller must hold the offset.
   */
  insert(rec: PendingTelegramRecord): 'inserted' | 'exists' | 'write_failed' {
    if (existsSync(this.pathFor(rec.update_id)) || existsSync(this.resolvedPathFor(rec.update_id))) return 'exists';
    return this.persist(rec) ? 'inserted' : 'write_failed';
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

  /** A record in the resolved archive, or null. */
  readResolved(updateId: number): PendingTelegramRecord | null {
    try {
      const p = this.resolvedPathFor(updateId);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf-8')) as PendingTelegramRecord;
    } catch {
      return null;
    }
  }

  /**
   * Read-modify-write, tmp+rename. `expectRev` (see SINGLE WRITER): when given
   * and the record on disk has moved on, nothing is written and null is
   * returned — the caller re-reads and decides again. A field set to
   * `undefined` is removed.
   */
  patch(
    updateId: number,
    fields: Partial<PendingTelegramRecord>,
    opts: { expectRev?: number } = {},
  ): PendingTelegramRecord | null {
    const cur = this.read(updateId);
    if (!cur) return null;
    if (opts.expectRev !== undefined && (cur.rev ?? 0) !== opts.expectRev) {
      this.log(`pending-queue: patch of ${updateId} refused — rev ${cur.rev ?? 0} on disk, expected ${opts.expectRev}`);
      return null;
    }
    const next = { ...cur, ...fields, rev: (cur.rev ?? 0) + 1 } as PendingTelegramRecord;
    return this.persist(next) ? (JSON.parse(JSON.stringify(next)) as PendingTelegramRecord) : null;
  }

  /** Every record in pending-telegram/, oldest update_id first (includes half-archived ones). */
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

  /**
   * Records the queue still acts on. A record carrying `resolved_at` is
   * mid-archive (a crash between the resolution patch and the rename) — it is
   * never injected, escalated or acked again; finishArchives() completes it.
   */
  active(): PendingTelegramRecord[] {
    return this.list().filter((r) => !r.resolved_at);
  }

  remove(updateId: number): void {
    try {
      unlinkSync(this.pathFor(updateId));
    } catch {
      // already gone
    }
  }

  /**
   * Archive a resolved record (A4/C2): patch `resolved_at` + `resolution`,
   * THEN rename into pending-telegram-resolved/. A crash between the two
   * leaves a record with `resolved_at` in pending/, which finishArchives()
   * completes and which nothing else will act on. The watchdog reads both dirs,
   * so an answered message is evidence, not an absence.
   */
  archive(updateId: number, resolution: string, resolvedBy: string, at = new Date()): boolean {
    const cur = this.read(updateId);
    if (!cur) return false;
    const marked = cur.resolved_at
      ? cur
      : this.patch(updateId, { resolved_at: at.toISOString(), resolution, resolved_by: resolvedBy }, { expectRev: cur.rev ?? 0 });
    if (!marked) return false;
    return this.renameToResolved(updateId);
  }

  private renameToResolved(updateId: number): boolean {
    try {
      mkdirSync(this.resolvedDir, { recursive: true });
      renameSync(this.pathFor(updateId), this.resolvedPathFor(updateId));
      return true;
    } catch (err) {
      this.log(`pending-queue: archive rename failed for ${updateId}: ${String(err)} — resolved_at is set, will retry`);
      return false;
    }
  }

  /** V4-3(b): finish any archive a crash interrupted. Returns how many were moved. */
  finishArchives(): number {
    let n = 0;
    for (const r of this.list()) {
      if (r.resolved_at && this.renameToResolved(r.update_id)) n++;
    }
    return n;
  }

  /** C2: resolved records older than RESOLVED_RETENTION_MS are deleted. */
  pruneResolved(now: number, retentionMs = RESOLVED_RETENTION_MS): number {
    let names: string[] = [];
    try {
      if (!existsSync(this.resolvedDir)) return 0;
      names = readdirSync(this.resolvedDir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      const p = join(this.resolvedDir, name);
      try {
        const r = JSON.parse(readFileSync(p, 'utf-8')) as PendingTelegramRecord;
        // Only records THIS code archived (resolved_at) are pruned. A record an
        // operator dropped in by hand without one is kept — it is their audit note.
        const at = Date.parse(r.resolved_at ?? '');
        if (Number.isNaN(at) || now - at < retentionMs) continue;
        unlinkSync(p);
        n++;
      } catch {
        // unreadable: leave it for a human
      }
    }
    if (n > 0) this.log(`pending-queue: pruned ${n} resolved record(s) older than ${Math.round(retentionMs / 86_400_000)}d from ${basename(this.resolvedDir)}/`);
    return n;
  }

  /**
   * Reply evidence from the cortextos rail: a row in outbound-messages.jsonl
   * for this chat, strictly newer than the first attempt. Requires attempts >= 1
   * so an unrelated earlier outbound can never delete an unattempted record.
   *
   * This is ONE rail of several — see ReplyEvidence / answeredBy in
   * fast-checker for the union. It is the strongest (it proves Telegram
   * accepted the send). Shell-rail sends (uhsJARVIS telegram-send.sh) append
   * rows here too since 2026-09-30 (V4-6).
   */
  repliedInOutboundLog(rec: PendingTelegramRecord, replies: Map<string, number>): boolean {
    if (rec.attempts < 1) return false;
    const since = Date.parse(rec.first_attempt_at ?? rec.created_at);
    if (Number.isNaN(since)) return false;
    const reply = replies.get(rec.chat_id);
    return reply !== undefined && reply > since;
  }

  /**
   * Archive every record with observed reply evidence on ANY rail. Returns the
   * count. `unverified` is resolvable here (V4-2): a reply observed after the
   * 10-minute mark still resolves it. Every other terminal state is an audit
   * record and is never touched — a human's resolution note is the only record
   * of why it was closed.
   */
  reapAnswered(answered: (rec: PendingTelegramRecord) => boolean, by = 'reply observed'): number {
    let n = 0;
    for (const rec of this.active()) {
      if (isTerminal(rec.state) && rec.state !== 'unverified') continue;
      // A reply to this chat cannot be an answer to a message the agent has not
      // read: pasted/stuck (maybe never submitted) and submitted-but-unread
      // records stay until Claude Code records the prompt. Archiving them on an
      // unrelated reply also silently opened the stuck gate (Codex round 15 #2).
      if (awaitingConsumption(rec)) continue;
      if (answered(rec) && this.archive(rec.update_id, 'answered', by)) n++;
    }
    return n;
  }

  isEligible(rec: PendingTelegramRecord, now: number, answered: (rec: PendingTelegramRecord) => boolean): boolean {
    if (rec.empty) return false;
    // V4-2: `unverified` is resolvable but NEVER re-injectable — explicit, not
    // just implied by TERMINAL_STATES, so a future edit to that list cannot
    // quietly start re-pasting consumed blocks.
    if (rec.state === 'unverified') return false;
    if (isTerminal(rec.state)) return false;
    // Mid-archive (V4-3b): resolved, never injected again.
    if (rec.resolved_at) return false;
    // A paste already reached (or may have reached) the PTY. Pasted/stuck are
    // UNKNOWN, submitted is consumed — none is ever re-pasted (R4-2/R4-3).
    if (rec.submit_phase !== undefined) return false;
    // A download still owes this record its block (see MEDIA_GRACE_MS).
    if (this.isMediaHeld(rec, now)) return false;
    // Nothing to inject at all (captionless media past grace): the checker's
    // expiry path notifies the sender instead. Never hand it to the injector.
    if (rec.formatted === '' && !rec.text.trim()) return false;
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
    // fixed timer that races the signal. (Legacy records only: a record with a
    // token moves to in_flight the moment any byte is pasted.)
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
    for (const rec of this.active()) {
      if (this.isEligible(rec, now, answered)) return rec;
    }
    return null;
  }

  /**
   * TRUE drops earn an admission to the human — and only positive
   * non-delivery evidence proves a drop (V5-3):
   *   - a record with a token: the PTY was absent or the paste threw before
   *     ANY byte was written, on MAX_ATTEMPTS separate attempts. A paste that
   *     wrote bytes is never a drop, whatever happened next (UNKNOWN instead).
   *   - a legacy record (no token): the old rule — pasted MAX_ATTEMPTS times,
   *     header never seen. Kept only for records written before this change.
   */
  dropCandidates(now: number, answered: (rec: PendingTelegramRecord) => boolean): PendingTelegramRecord[] {
    const out: PendingTelegramRecord[] = [];
    for (const rec of this.active()) {
      if (rec.empty) continue;
      // ONLY 'unattempted' earns an admission, which also means every terminal
      // state — including a human's answered_manual — is excluded by construction.
      if (rec.state !== 'unattempted') continue;
      if (rec.submit_phase !== undefined) continue;
      if (answered(rec)) continue;
      const last = Date.parse(rec.last_attempt_at ?? rec.created_at);
      if (!Number.isNaN(last) && now - last < UNATTEMPTED_RETRY_MS) continue;
      if (rec.token) {
        if ((rec.nondelivery_failures ?? 0) < MAX_ATTEMPTS || rec.attempts > 0) continue;
      } else if (rec.attempts < MAX_ATTEMPTS) {
        continue;
      }
      out.push(rec);
    }
    return out;
  }

  /**
   * Consumed, but no reply we can observe on any rail. This is an
   * OBSERVABILITY gap, not a lost message: it is recorded for the operator and
   * NOTHING is sent to the human. For a record with a token, "consumed" means
   * Claude Code recorded the prompt (submit_phase 'submitted'); a pasted or
   * stuck record is UNKNOWN, not consumed, and never becomes unverified.
   */
  unverifiedCandidates(now: number, answered: (rec: PendingTelegramRecord) => boolean): PendingTelegramRecord[] {
    const out: PendingTelegramRecord[] = [];
    for (const rec of this.active()) {
      if (rec.empty) continue;
      if (rec.state !== 'in_flight') continue;
      // Consumed = Claude Code recorded the prompt as READ (a genuine prompt or
      // a queued_command — in_flight_at). An enqueue alone only proves the
      // composer accepted Enter; that record keeps waiting for consumption
      // (Codex round 15 #4) and its 10-minute clock has not started.
      if (rec.token && (rec.submit_phase !== 'submitted' || !rec.in_flight_at)) continue;
      if (answered(rec)) continue;
      const since = Date.parse(rec.token ? rec.in_flight_at! : (rec.in_flight_at ?? rec.last_attempt_at ?? rec.created_at));
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
   * R4-2 persist-before-write. Everything that describes this paste — its
   * start time (JSONL evidence older than this never counts), the submission
   * deadline, the PTY instance, the stdout watermark — is written and read
   * back BEFORE any byte reaches the PTY. The record is `in_flight` from here
   * on: a crash after this write can never lead to a second paste of the same
   * update; the attempt stays UNKNOWN until its token is found (or 24 h pass).
   * Returns null (=> do not paste this cycle) if the write cannot be verified.
   */
  beginPaste(
    rec: PendingTelegramRecord,
    opts: { at: Date; ptyInstance: string; logOffset: number | null; submitTimeoutMs?: number },
  ): PendingTelegramRecord | null {
    const iso = opts.at.toISOString();
    const deadline = new Date(opts.at.getTime() + (opts.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS)).toISOString();
    const fields: Partial<PendingTelegramRecord> = {
      state: 'in_flight',
      submit_phase: 'pasted',
      attempt_started_at: iso,
      submit_deadline_at: deadline,
      pty_instance: opts.ptyInstance,
      attempts: rec.attempts + 1,
      first_attempt_at: rec.first_attempt_at ?? iso,
      last_attempt_at: iso,
      log_offset: opts.logOffset,
    };
    const written = this.patch(rec.update_id, fields, { expectRev: rec.rev ?? 0 });
    if (!written) return null;
    const back = this.read(rec.update_id);
    if (!back || back.rev !== written.rev || back.submit_phase !== 'pasted' || back.attempt_started_at !== iso) return null;
    return back;
  }

  /**
   * The paste wrote NOTHING (PTY absent, or the first write threw): positive
   * non-delivery evidence. Undo beginPaste so the record is retried after the
   * usual throttle, and count the failure (V5-3 DROP needs MAX_ATTEMPTS of them).
   */
  abortPaste(rec: PendingTelegramRecord, note: string, at = new Date()): PendingTelegramRecord | null {
    return this.patch(rec.update_id, {
      state: 'unattempted',
      submit_phase: undefined,
      attempt_started_at: undefined,
      submit_deadline_at: undefined,
      pty_instance: undefined,
      attempts: Math.max(0, rec.attempts - 1),
      first_attempt_at: rec.attempts - 1 > 0 ? rec.first_attempt_at : undefined,
      last_attempt_at: at.toISOString(),
      nondelivery_failures: (rec.nondelivery_failures ?? 0) + 1,
      notes: [...rec.notes, note],
    }, { expectRev: rec.rev ?? 0 });
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

  markEscalated(rec: PendingTelegramRecord, note: string, extra: Partial<PendingTelegramRecord> = {}): PendingTelegramRecord | null {
    return this.patch(rec.update_id, { state: 'escalated', notes: [...rec.notes, note], ...extra });
  }

  markUnverified(rec: PendingTelegramRecord, note: string): PendingTelegramRecord | null {
    return this.patch(rec.update_id, { state: 'unverified', notes: [...rec.notes, note] });
  }

  markFailedNotified(rec: PendingTelegramRecord, note: string, extra: Partial<PendingTelegramRecord> = {}): PendingTelegramRecord | null {
    return this.patch(rec.update_id, { state: 'failed_notified', notes: [...rec.notes, note], ...extra });
  }
}

/**
 * A pasted record the agent is not proven to have READ: pasted or stuck (maybe
 * never submitted), or submitted via an enqueue row only. Such a record is
 * never resolved by a reply to the chat, never made unverified, and stays
 * scanned for evidence.
 */
export function awaitingConsumption(rec: PendingTelegramRecord): boolean {
  if (!rec.token) return false;
  return rec.submit_phase === 'pasted' || rec.submit_phase === 'stuck' || (rec.submit_phase === 'submitted' && !rec.in_flight_at);
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
  file_id?: string;
  media_type?: string;
  message_id?: number;
  /**
   * The update's `⟦u:<update_id>⟧` token. When given, the record uses the
   * provable-delivery path: the token is the needle (stored as `header` too,
   * so A0 code reading `header` still has a needle), and receipt acks apply.
   */
  token?: string;
}): PendingTelegramRecord {
  const rec: PendingTelegramRecord = {
    update_id: fields.update_id,
    chat_id: String(fields.chat_id),
    from: fields.from,
    text: fields.text,
    formatted: fields.formatted ?? '',
    header: fields.header ?? fields.token ?? '',
    state: 'unattempted',
    attempts: 0,
    empty: fields.empty ?? false,
    created_at: new Date().toISOString(),
    notes: fields.note ? [fields.note] : [],
  };
  // Only set when given, so a text record's JSON is byte-for-byte what it was.
  if (fields.file_id !== undefined) rec.file_id = fields.file_id;
  if (fields.media_type !== undefined) rec.media_type = fields.media_type;
  if (fields.message_id !== undefined) rec.message_id = fields.message_id;
  if (fields.token !== undefined) {
    rec.token = fields.token;
    rec.ack_stage = 0;
    rec.rev = 0;
  }
  return rec;
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

/** Prefix on a block whose media landed after the sender was asked to resend. */
export const LATE_MEDIA_PREFIX = "(this photo arrived late — ignore the earlier 'resend' note)";

const MEDIA_NOUNS: Record<string, string> = {
  photo: 'photo',
  document: 'file',
  voice: 'voice note',
  audio: 'audio file',
  video: 'video',
  video_note: 'video message',
};

/** "photo" for a photo; legacy records without media_type are photos in practice. */
export function mediaNoun(mediaType: string | undefined): string {
  return (mediaType && MEDIA_NOUNS[mediaType]) || 'photo';
}

/** The note appended to a caption injected while its attachment is still downloading. */
export function mediaStillDownloadingNote(mediaType?: string): string {
  return `(a ${mediaNoun(mediaType)} came with this and is still downloading)`;
}

/** Local wall-clock HH:MM of the record, e.g. "4:41 AM". */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Sent to the sender when a captionless attachment never finished downloading. */
export function mediaNotArrivedText(rec: Pick<PendingTelegramRecord, 'created_at' | 'media_type'>): string {
  return `A ${mediaNoun(rec.media_type)} you sent at ${clockTime(rec.created_at)} hasn't come through yet — if it matters, resend it`;
}

export const EMPTY_MEDIA_REPLY =
  "I couldn't transcribe that voice note — resend it or send text.";
