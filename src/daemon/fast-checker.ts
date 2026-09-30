import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync, renameSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { join, relative, dirname } from 'path';
import { createHash } from 'crypto';
import { hardRestart } from '../bus/system.js';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox } from '../bus/message.js';
import { decideApproval } from '../bus/approval.js';
import {
  isValidRef,
  readApproval,
  readBinding,
  type BindingRejection,
} from '../bus/approval-binding.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars, sanitizeForPtyInjection, wrapFenceSafe } from '../utils/validate.js';
import {
  PendingTelegramQueue,
  admissionText,
  durableQueueEnabled,
  readReplyTimestamps,
  sendEvidenceInTranscript,
  strictPromptGateEnabled,
  clockTime,
  mediaNoun,
  EMPTY_MEDIA_REPLY,
  LATE_MEDIA_PREFIX,
  NOTIFY_MAX_ATTEMPTS,
  PROOF_WINDOW_MS,
  awaitingConsumption,
  replyReferenceTime,
  mediaNotArrivedText,
  mediaStillDownloadingNote,
  type PendingTelegramRecord,
} from '../telegram/pending-queue.js';
import {
  bootTurnEnded,
  claudeProjectDirFor,
  findSubmission,
  latestGenuinePrompt,
  normalizePtyText,
  sharedScanner,
  type ClaudeTranscriptScanner,
  type ScanSnapshot,
} from '../telegram/submission-proof.js';
import { PART_FILE_RE } from '../telegram/media.js';

type LogFn = (msg: string) => void;

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;

  // === Slow-turn acknowledgment (2026-09-24) ================================
  // Scott: "is this fixed?" — no, because the last gap was silence, not loss.
  // On 2026-09-24 at 02:51 he sent three messages; all three were received and
  // injected correctly, and seventeen minutes later he had nothing, because the
  // agent was mid-turn doing real multi-tool work on a ZPL label. A busy agent
  // and a dead one are indistinguishable from a phone.
  //
  // A typing indicator does not close this: sendChatAction expires in ~5s and
  // is invisible on a locked screen, which is why it never registered as
  // "working" during those seventeen minutes.
  //
  // So: one plain-text message, once per unanswered turn, only after the turn
  // has already run long. A turn that answers in five seconds sends nothing —
  // that is the whole point, and why this is a DELAY and not an on-receipt ack.
  /** Start of the current unanswered Telegram turn (0 = no turn open). */
  private ackTurnStartedAt: number = 0;
  /** Telegram messages injected during the current unanswered turn. */
  private ackTurnMessageCount: number = 0;
  /** One ack per turn, never per message — a burst of five gets one. */
  private ackSentForTurn: boolean = false;
  /**
   * True when a message in this turn was injected while the agent was already
   * mid-turn on something else (the soft prompt-gate path).
   *
   * Load-bearing for the ack's WORDING, not for delivery. On 2026-09-24 Scott
   * asked for a marketing-kit link at 07:06:44; the ack told him "Still
   * working" at 07:07:30, and the first tool call against his request did not
   * happen until 07:11:51 — five minutes later. Nothing was "still working" on
   * his question; the session was busy with unrelated work and his message was
   * queued behind it. The ack was not slow, it was WRONG, and it bought the
   * silence four more minutes of credibility.
   */
  private ackTurnQueuedBehindWork: boolean = false;
  // === END slow-turn acknowledgment (fields) ================================
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Durable pending-Telegram queue (TELEGRAM_DURABLE_QUEUE). Built eagerly so
  // the daemon's poller handler can persist BEFORE acking the Telegram offset,
  // but only consulted when the flag is on — with the flag off every Telegram
  // path in this class behaves exactly as it did before 2026-09-24.
  private pending: PendingTelegramQueue;

  // === Provable delivery (A1–A6 / V5, 2026-09-30) ============================
  /**
   * How a paste is proven submitted. 'jsonl' (Claude Code runtime): Claude
   * Code's own session record — see telegram/submission-proof.ts. 'pty' (every
   * other runtime): the update's token in the normalized PTY output, the best
   * signal those runtimes offer.
   */
  private proofMode: 'jsonl' | 'pty';
  private scanner: ClaudeTranscriptScanner | null = null;
  private lastSnap: { at: number; since: number; snap: ScanSnapshot } | null = null;
  /** PTY instance whose boot turn was observed to end (R4-4). */
  private bootReadyInstance: string | null = null;
  private bootHoldLoggedFor: string | null = null;
  private bootHoldEscalatedFor: string | null = null;
  /** V4-3 startup reconciliation runs once, before the first durable cycle acts. */
  private reconciled = false;
  private lastPruneAt = 0;
  /** R4-1 self-check: newest genuine prompt any scan has seen (ms), and when we last complained. */
  private lastGenuineSeenAt = 0;
  private lastSchemaWarnAt = 0;
  private readonly startedAt = Date.now();
  /** A3: starts (re)downloads. Wired by the daemon; absent in unit tests that do not need it. */
  private mediaDownloader: MediaDownloader | null = null;
  /**
   * A3: completions whose record patch FAILED. Kept in memory and retried each
   * cycle — never logged as "updated" (A3: every patch checks its boolean).
   */
  private pendingMediaPatches = new Map<number, { gen: number; partPath: string | null; transcript?: string; attempts: number }>();
  /** Media jobs waiting for their owed completion patch to land or be discarded (Codex round 15 #3). */
  private patchWaiters = new Map<string, Array<() => void>>();
  /** update_id:gen of media jobs THIS process started (their part files are live). */
  private jobsStartedHere = new Set<string>();
  /** Last PTY-token check per record (ms) — the PTY read is rate-limited like the scan. */
  private ptyCheckedAt = new Map<number, number>();
  private stuckGateLogged: string | null = null;
  /** V4-3(d) resume is owed (set by startupReconcile, done once a downloader is wired). */
  private resumeDue = false;
  // === END provable delivery (fields) ========================================

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Context monitor state
  private ctxConfigMtime: number = 0;
  private ctxWarningFiredAt: number = 0;    // dedup: 15min cooldown between warnings
  private ctxHandoffFiredAt: number = 0;    // fires once per session (0 = not yet)
  private ctxHandoffDeadlineAt: number = 0; // timestamp after which force-restart fires
  private ctxLastSessionId: string | null = null; // detects new session → clears stale deadline
  private ctxCircuitRestarts: number[] = []; // timestamps of recent context-triggered restarts
  private ctxCircuitBrokenAt: number | null = null; // when circuit tripped (null = healthy)
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  private ctxCircuitFile: string = '';

  // === JARVIS MOD #23 — personality voice cue (2026-07-05) ===
  // Per-agent opt-in: if VOICE_CUE.md exists in the agent workspace, its content
  // is appended to every injected message block at DELIVERY TIME only. The cue
  // never touches inbox files, inbound-messages.jsonl, or outbound history —
  // recency-positioned per the anti-drift technique (personality drift is
  // positional: the model imitates its own recent outputs over the system
  // prompt, so the voice reminder must be the LAST thing it reads each turn).
  // mtime-cached so edits to VOICE_CUE.md apply on the next poll, no restart.
  private voiceCueText: string | null = null;
  private voiceCueMtimeMs: number = -1;
  // === END JARVIS MOD #23 (fields) ===

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: {
      pollInterval?: number;
      log?: LogFn;
      telegramApi?: TelegramAPI;
      chatId?: string;
      allowedUserId?: number;
      /** Tests: the Claude project dir to prove submissions from (implies 'jsonl'). */
      claudeProjectDir?: string;
      /** Tests: force a proof mode. */
      proofMode?: 'jsonl' | 'pty';
    } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;

    this.pending = new PendingTelegramQueue(
      join(paths.stateDir, 'pending-telegram'),
      (msg) => this.log(msg),
    );

    const projectDir = options.claudeProjectDir ?? FastChecker.claudeProjectDirForAgent(agent);
    this.proofMode = options.proofMode ?? (projectDir ? 'jsonl' : 'pty');
    if (this.proofMode === 'jsonl' && projectDir) {
      this.scanner = sharedScanner(projectDir, (m) => this.log(m));
    }

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();

    // Load persisted circuit breaker state so --continue restarts don't reset it
    this.ctxCircuitFile = join(paths.stateDir, '.ctx-circuit.json');
    this.loadCtxCircuit();
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // V4-3: reconcile the durable queue before the first poll cycle acts
    // (interrupted archives, media left mid-download by a previous process).
    if (durableQueueEnabled() && !this.reconciled) {
      this.reconciled = true;
      try {
        this.startupReconcile();
      } catch (err) {
        this.log(`Startup reconciliation error: ${String(err)}`);
      }
    }

    // Wait for bootstrap. R4-4: the timeout path used to log the same
    // "Bootstrap complete" line as success. It no longer does, and nothing
    // treats it as ready — the boot hold checks readiness per PTY itself.
    const bootstrapped = await this.waitForBootstrap();
    this.log(bootstrapped
      ? 'Bootstrap complete. Beginning poll loop.'
      : 'Bootstrap NOT observed within the wait — beginning poll loop anyway (Telegram injection stays held until this PTY is ready).');

    const agentName = this.agent.name;

    // Write heartbeat immediately on bootstrap so dashboard shows green right away.
    // LOCAL MOD #2 (2026-04-28): the bus CLI defaults agentName to basename(process.cwd())
    // when CTX_AGENT_NAME is unset. The daemon's cwd is the framework root, so without
    // this env override every agent's heartbeat overwrites cortextos/heartbeat.json
    // instead of state/<agent>/heartbeat.json. Pass CTX_AGENT_NAME explicitly.
    const childEnv = { ...process.env, CTX_AGENT_NAME: agentName };
    {
      const ts = new Date().toISOString();
      execFile('cortextos', ['bus', 'update-heartbeat', `[bootstrap] ${agentName} online — ${ts}`], { env: childEnv }, (err) => {
        if (err) this.log(`Initial heartbeat error: ${err.message}`);
        else this.log('Initial heartbeat written');
      });
    }

    // Idle-session heartbeat watchdog: fires every 3 min to keep dashboard status green.
    // Was 50 min, but the dashboard marks agents stale after 10 min (agents.ts:135).
    const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;
    this.heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], { env: childEnv }, (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        await this.pollCycle();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }

  /** The durable queue, for the daemon's poller handler. */
  pendingQueue(): PendingTelegramQueue {
    return this.pending;
  }

  /**
   * Durably persist an inbound Telegram message BEFORE the Telegram offset is
   * acked. Returns false when the write failed, which the poller handler must
   * propagate so the offset is held and Telegram redelivers the update.
   */
  persistPendingTelegram(rec: PendingTelegramRecord): boolean {
    const ok = this.pending.persist(rec);
    this.log(
      ok
        ? `Persisted pending Telegram update ${rec.update_id} (chat ${rec.chat_id})`
        : `FAILED to persist pending Telegram update ${rec.update_id} — holding Telegram offset`,
    );
    return ok;
  }

  /**
   * Create-if-absent (A4). Returns the poller ACK: true when the update is
   * durably held — newly inserted, OR already pending / archived (Telegram
   * redelivered an update we already took; the redelivery is a no-op and must
   * not overwrite a record that may be mid-download, pasted or answered).
   * false only when nothing durable could be written.
   */
  insertPendingTelegram(rec: PendingTelegramRecord): 'inserted' | 'exists' | 'write_failed' {
    const res = this.pending.insert(rec);
    this.log(
      res === 'inserted'
        ? `Persisted pending Telegram update ${rec.update_id} (chat ${rec.chat_id})`
        : res === 'exists'
          ? `Telegram update ${rec.update_id} redelivered — already recorded, ignored`
          : `FAILED to persist pending Telegram update ${rec.update_id} — holding Telegram offset`,
    );
    return res;
  }

  /** Patch a persisted record (e.g. attach the formatted block after a media round trip). */
  patchPendingTelegram(updateId: number, fields: Partial<PendingTelegramRecord>): boolean {
    return this.pending.patch(updateId, fields) !== null;
  }

  /**
   * Land a finished media round trip on its durable record. The record may
   * already have expired (caption injected, or the sender told to resend);
   * see PendingTelegramQueue.applyMediaCompletion for what each case does.
   * Logs the true outcome — a failed write is an ERROR, never "updated".
   */
  completePendingMedia(
    updateId: number,
    fields: { formatted: string; text: string; empty: boolean; notes?: string[] },
    what: string,
  ): boolean {
    const outcome = this.pending.applyMediaCompletion(updateId, fields);
    switch (outcome) {
      case 'updated':
        this.log(`Media message received: ${what}, durable record ${updateId} updated (empty=${fields.empty})`);
        return true;
      case 'rearmed':
        this.log(`Media message received LATE: ${what}, durable record ${updateId} re-armed for delivery (sender had been asked to resend)`);
        return true;
      case 'discarded':
        this.log(`Media message received: ${what}, but durable record ${updateId} is already terminal — completion discarded`);
        return false;
      case 'missing':
        this.log(`Media message received: ${what}, but durable record ${updateId} no longer exists — completion discarded`);
        return false;
      case 'write_failed':
        this.log(`ERROR: media completion for durable record ${updateId} (${what}) could NOT be written — record left as it was`);
        return false;
    }
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages.
    //
    // With TELEGRAM_DURABLE_QUEUE on this array is not used for Telegram at
    // all: messages come from disk, one file per injection, handled by
    // durableTelegramCycle() below. Draining an in-memory array with shift()
    // is loss mode (a) — the only copy of the message became a local string
    // before the injection was even attempted.
    let hasTelegramMessage = false;
    const durable = durableQueueEnabled();
    if (!durable) {
      while (this.telegramMessages.length > 0) {
        const msg = this.telegramMessages.shift()!;
        messageBlock += msg.formatted;
        hasTelegramMessage = true;
      }
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }

    // === JARVIS MOD #23 — append recency voice cue (delivery-time only) ===
    // Appended AFTER dedup hashing and AFTER the block is assembled so the cue
    // is the last text the agent reads (recency position) and never affects
    // duplicate detection or any stored history.
    if (messageBlock) {
      const cue = this.readVoiceCue();
      if (cue) messageBlock += `\n${cue}\n`;
    }
    // === END JARVIS MOD #23 (pollCycle) ===

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
          // Anchor the ack clock to the FIRST unanswered message, not the
          // latest. Anchoring to the latest would let a steady trickle of
          // messages push the deadline forever and never acknowledge any of
          // them — the burst case (2-7 inside ten minutes) is the common one.
          if (this.ackTurnStartedAt === 0) this.ackTurnStartedAt = Date.now();
          this.ackTurnMessageCount++;
        }
        // Cooldown after injection
        await sleep(5000);
      }
    }

    if (durable) {
      await this.durableTelegramCycle();
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
      // isAgentActive() also resets the ack turn when it observes a reply, so
      // this must run after it, not before. In durable mode the per-record
      // receipt acks (A6, durableTelegramCycle step 5) replace this per-turn
      // ack — running both would acknowledge the same message twice.
      if (!durable) await this.maybeSendSlowTurnAck(this.telegramApi, this.chatId);
    }

    // Context monitor: check usage thresholds and fire warnings/handoffs
    await this.checkContextStatus();
  }

  /**
   * One durable Telegram cycle: land media, prove submissions, reap, notify,
   * acknowledge, then inject exactly ONE message.
   *
   * Ordering matters. Media deadlines first (a record may become injectable or
   * need a notice). Then submission proof (it only changes what a record
   * awaits, never deletes it), then reaping on OBSERVED REPLIES — the sole
   * evidence that retires a record, and now into the resolved archive rather
   * than the bin — then the notices, the receipt acks, and at most one
   * injection. One file, one injection, one accounting row: fusing several
   * messages into one block made per-message durability incoherent and made a
   * block count as "answered" when only its last line was.
   */
  private async durableTelegramCycle(): Promise<void> {
    if (!this.reconciled) {
      this.reconciled = true;
      this.startupReconcile();
    }
    const now = Date.now();
    const replies = readReplyTimestamps(join(this.paths.logDir, 'outbound-messages.jsonl'));

    // Reply evidence = a send Telegram ACCEPTED, on either rail that records one:
    //   1. outbound-messages.jsonl — the cortextos rail, and since 2026-09-30
    //      the uhsJARVIS shell rail too (telegram-send.sh appends when a fleet
    //      agent sends and Telegram answers ok:true — V4-6);
    //   2. state/<agent>/last-telegram-<chat>.txt (cacheLastSent) — survives a
    //      truncated/rotated log.
    // A send ATTEMPT seen in the PTY transcript is no longer reply evidence
    // (A2): it proved only that a command ran, and its needle-matching let the
    // injected block "answer" itself.
    const answered = (rec: PendingTelegramRecord): boolean => {
      if (rec.attempts < 1) return false;
      if (this.pending.repliedInOutboundLog(rec, replies)) return true;
      return this.lastSentTouchedAfter(rec);
    };

    // 0. Media (A3): resume what a previous process left mid-download, retry
    //    completions whose patch failed last time, then deadlines.
    this.resumeInterruptedMedia();
    this.retryPendingMediaPatches();
    this.processMediaDeadlines(now);

    // 1. Submission / consumption proof. Never deletes anything.
    this.proveConsumption(now);

    // 2. Only an observed reply to that chat retires a message — into the
    //    resolved archive (C2), where the watchdog can still see it.
    const reaped = this.pending.reapAnswered(answered);
    if (reaped > 0) this.log(`Pending: ${reaped} message(s) answered on some rail — archived to pending-telegram-resolved/`);
    if (now - this.lastPruneAt > 60 * 60_000) {
      this.lastPruneAt = now;
      this.pending.pruneResolved(now);
    }

    // 3a. TRUE drops only (see dropCandidates): positive non-delivery evidence,
    //     or a legacy record whose header never appeared. These — and ONLY
    //     these — earn an admission to the human, recorded only once it was
    //     actually sent (A5).
    for (const rec of this.pending.dropCandidates(now, answered)) {
      const why = rec.token
        ? `nothing reached the agent on ${rec.nondelivery_failures ?? 0} attempts (PTY absent / paste failed before any byte)`
        : `header never appeared in ${rec.attempts} attempts`;
      await this.notifyThenMark(rec, admissionText(rec.text), 'admission', (cur, sent) =>
        this.pending.markEscalated(cur, sent ? `never delivered: ${why} — admitted to the human` : `never delivered: ${why} — the admission could NOT be sent`, sent ? {} : {}),
        () => this.log(`Pending ${rec.update_id}: DROP CONFIRMED (${why}) — admitted the miss to chat ${rec.chat_id}`),
      );
    }

    // 3b. Consumed, but no reply we can see on any rail. An observability gap,
    //     NOT a lost message — recorded for the operator, and deliberately
    //     nothing is sent to the human. Telling Scott "I may have missed this"
    //     about a message he was answered on twice is worse than the silence
    //     this whole change set out to fix (observed live, 2026-09-24 05:45).
    for (const rec of this.pending.unverifiedCandidates(now, answered)) {
      this.pending.markUnverified(
        rec,
        'consumed by the TUI but no reply observable on any rail — not reported to the human',
      );
      this.log(
        `Pending ${rec.update_id}: UNVERIFIED — block was consumed but no reply is observable on any rail. ` +
        'Nothing sent to the human; record retained for audit (a later reply still resolves it).',
      );
    }

    // 4. Empty media can never be injected — an empty block is unanswerable by
    //    construction. Tell the sender instead of going silent, and keep the
    //    record — marked only once the notice was actually sent (A5).
    for (const rec of this.pending.active()) {
      if (!rec.empty || rec.state !== 'unattempted') continue;
      await this.notifyThenMark(rec, EMPTY_MEDIA_REPLY, 'empty-media', (cur, sent) =>
        this.pending.markFailedNotified(cur, sent
          ? 'media yielded no text and no transcript — sender notified'
          : 'media yielded no text and no transcript — the notice could NOT be sent'),
        () => this.log(`Pending ${rec.update_id}: empty media — sender notified, not injected`),
      );
    }

    // 4b. Legacy/A0 raw captionless media whose grace ran out (A3 records are
    //     handled by 4c). Marked ONLY after the notice was sent; a failed send
    //     is retried next cycle, at most NOTIFY_MAX_ATTEMPTS times (A5).
    for (const rec of this.pending.expiredCaptionlessMedia(now)) {
      await this.notifyThenMark(rec, mediaNotArrivedText(rec), 'media-not-arrived', (cur, sent) => {
        // The download may have landed while the send was awaited.
        if (cur.formatted !== '' && cur.state === 'unattempted') {
          const ok = this.pending.patch(cur.update_id, {
            formatted: cur.formatted.startsWith(LATE_MEDIA_PREFIX) ? cur.formatted : `${LATE_MEDIA_PREFIX}\n${cur.formatted}`,
            notes: [...cur.notes, 'media landed while the resend notice was being sent — delivering it'],
            ...(sent ? { notified_at: new Date().toISOString() } : {}),
          }, { expectRev: cur.rev ?? 0 });
          this.log(ok
            ? `Pending ${cur.update_id}: media landed during the resend notice — delivering it with a late note`
            : `ERROR: Pending ${cur.update_id}: could not write the late note — record left as it was`);
          return ok;
        }
        if (cur.formatted !== '' || cur.state !== 'unattempted') return cur;
        return this.pending.markFailedNotified(cur, sent
          ? 'media did not arrive within the grace window — sender asked to resend'
          : 'media did not arrive within the grace window — the resend notice could NOT be sent');
      }, () => this.log(`Pending ${rec.update_id}: media not arrived after grace — sender asked to resend, not injected`));
    }

    // 4c. A3: captionless media that failed for good. Nothing to inject; tell the sender.
    for (const rec of this.pending.active()) {
      if (rec.media_state !== 'failed' || rec.state !== 'unattempted' || rec.formatted !== '' || rec.text.trim()) continue;
      await this.notifyThenMark(rec, mediaNotArrivedText(rec), 'media-failed', (cur, sent) => {
        if (cur.media_state === 'ready' && cur.state === 'unattempted' && cur.attempts === 0) {
          // It landed while the notice was in flight: the sender WAS told it
          // hadn't come through, so the block must say it arrived late.
          if (!sent || cur.formatted.startsWith(LATE_MEDIA_PREFIX)) return cur;
          return this.pending.patch(cur.update_id, {
            formatted: `${LATE_MEDIA_PREFIX}\n${cur.formatted}`,
            notes: [...cur.notes, 'media landed while the resend notice was being sent — delivering it with a late note'],
          }, { expectRev: cur.rev ?? 0 });
        }
        if (cur.media_state !== 'failed' || cur.state !== 'unattempted') return cur; // landed late meanwhile
        return this.pending.markFailedNotified(cur, sent
          ? 'media failed to download after a retry — sender asked to resend'
          : 'media failed to download after a retry — the resend notice could NOT be sent');
      }, () => this.log(`Pending ${rec.update_id}: media FAILED (no caption) — sender asked to resend, not injected`));
    }

    // 4d. V5-2c: one truthful receipt per stuck paste.
    for (const rec of this.pending.active()) {
      if (rec.submit_phase !== 'stuck' || rec.stuck_receipt_at || rec.notify_failed) continue;
      await this.sendStuckReceipt(rec);
    }

    // 5. A6: receipt acks by unacknowledged receipt, independent of the agent.
    await this.processReceiptAcks(now);

    // 6. Inject exactly one.
    await this.injectNext(now, answered);
  }

  /**
   * A5: send a notice about ONE record and only then record it.
   *
   * `mark(cur, sent)` runs after the await on a FRESH read of the record (it
   * may have changed while the send was in flight) and returns the patched
   * record, or null if the write failed. A failed send is retried next cycle;
   * after NOTIFY_MAX_ATTEMPTS the record is marked anyway, with
   * `notify_failed: true`, which the watchdog reports — so a dead Telegram API
   * cannot keep a record spinning forever, and cannot hide either.
   */
  private async notifyThenMark(
    rec: PendingTelegramRecord,
    text: string,
    what: string,
    mark: (cur: PendingTelegramRecord, sent: boolean) => PendingTelegramRecord | null | boolean,
    onSent: () => void,
  ): Promise<void> {
    let sent = false;
    let error = '';
    if (!this.telegramApi) {
      error = 'no Telegram API configured';
    } else {
      try {
        await this.telegramApi.sendMessage(rec.chat_id, text);
        sent = true;
      } catch (err) {
        error = String(err);
      }
    }
    const cur = this.pending.read(rec.update_id);
    if (!cur) return;
    if (sent) {
      const marked = mark(cur, true);
      if (!marked) {
        this.log(`ERROR: Pending ${cur.update_id}: ${what} notice SENT but the record could not be marked — it may be sent again`);
        return;
      }
      const after = this.pending.read(cur.update_id);
      if (after && !after.notified_at) this.pending.patch(after.update_id, { notified_at: new Date().toISOString() }, { expectRev: after.rev ?? 0 });
      onSent();
      return;
    }
    const attempts = (cur.notify_attempts ?? 0) + 1;
    if (attempts >= NOTIFY_MAX_ATTEMPTS || !this.telegramApi) {
      const marked = mark(cur, false);
      const after = this.pending.read(cur.update_id);
      if (after) {
        this.pending.patch(after.update_id, {
          notify_attempts: attempts,
          notify_failed: true,
          notes: [...after.notes, `${what} notice failed ${attempts} time(s) — giving up: ${error}`],
        }, { expectRev: after.rev ?? 0 });
      }
      this.log(`ERROR: Pending ${cur.update_id}: ${what} notice FAILED ${attempts} time(s) — notify_failed recorded${marked ? '' : ' (and the record could not be marked)'}: ${error}`);
      return;
    }
    this.pending.patch(cur.update_id, { notify_attempts: attempts }, { expectRev: cur.rev ?? 0 });
    this.log(`Pending ${cur.update_id}: ${what} notice failed — will retry next cycle (attempt ${attempts}/${NOTIFY_MAX_ATTEMPTS}): ${error}`);
  }

  /** V5-2c: "received — JARVIS hasn't picked it up yet", once, recorded only when sent. */
  private async sendStuckReceipt(rec: PendingTelegramRecord): Promise<void> {
    const text =
      `Received your message from ${clockTime(rec.created_at)} — JARVIS hasn't picked it up yet. ` +
      'Automatic receipt, not an answer; the stuck delivery has been flagged.';
    let error = '';
    if (this.telegramApi) {
      try {
        await this.telegramApi.sendMessage(rec.chat_id, text);
        const cur = this.pending.read(rec.update_id);
        if (!cur) return;
        const iso = new Date().toISOString();
        // The stuck receipt IS this record's receipt ack (A6 stage 1) — Scott
        // should not get "received" twice fifteen seconds apart.
        const ackFields: Partial<PendingTelegramRecord> = cur.ack_stage === 0 ? { ack_stage: 1, ack1_at: iso } : {};
        const ok = this.pending.patch(cur.update_id, { stuck_receipt_at: iso, ...ackFields }, { expectRev: cur.rev ?? 0 });
        this.log(ok
          ? `Pending ${rec.update_id}: stuck receipt sent to chat ${rec.chat_id}`
          : `ERROR: Pending ${rec.update_id}: stuck receipt SENT but not recorded — it may be sent again`);
        return;
      } catch (err) {
        error = String(err);
      }
    } else {
      error = 'no Telegram API configured';
    }
    const cur = this.pending.read(rec.update_id);
    if (!cur) return;
    const attempts = (cur.stuck_receipt_attempts ?? 0) + 1;
    const giveUp = attempts >= NOTIFY_MAX_ATTEMPTS || !this.telegramApi;
    this.pending.patch(cur.update_id, {
      stuck_receipt_attempts: attempts,
      ...(giveUp ? { notify_failed: true, notes: [...cur.notes, `stuck receipt failed ${attempts} time(s) — giving up: ${error}`] } : {}),
    }, { expectRev: cur.rev ?? 0 });
    this.log(giveUp
      ? `ERROR: Pending ${rec.update_id}: stuck receipt FAILED ${attempts} time(s) — notify_failed recorded: ${error}`
      : `Pending ${rec.update_id}: stuck receipt failed (attempt ${attempts}/${NOTIFY_MAX_ATTEMPTS}) — will retry: ${error}`);
  }

  /**
   * A6 — receipt acks driven by the records themselves, not by agent activity.
   *
   * The old slow-turn ack fired only while isAgentActive() said a turn was
   * open, so a message queued behind a strict gate, a boot window or a stuck
   * paste got no ack at all. Now, per chat, every cycle:
   *   stage 1 — records with ack_stage 0 older than the ack delay (45 s) get
   *             ONE ack covering all of them;
   *   stage 2 — records with ack_stage 1 older than 10 min get ONE follow-up.
   * A record's stage is persisted ONLY after its ack was sent, so a failed
   * send retries next cycle and a restart never repeats an ack — except the
   * documented crash window between a successful send and the persist, which
   * can repeat ONE ack. Stages are per record: an old acked record cannot
   * suppress a new one. Acks are never written to outbound-messages.jsonl — an
   * ack is proof of receipt, not an answer.
   *
   * Records written before this change carry no ack_stage and are never acked.
   */
  private async processReceiptAcks(now: number): Promise<void> {
    if (!this.telegramApi) return;
    const delay = this.slowAckDelayMs();
    if (delay === 0) return;
    const live = (r: PendingTelegramRecord) =>
      r.ack_stage !== undefined && !r.empty && (r.state === 'unattempted' || r.state === 'in_flight' || r.state === 'unverified');
    const byChat = new Map<string, PendingTelegramRecord[]>();
    for (const r of this.pending.active()) {
      if (!live(r)) continue;
      const list = byChat.get(r.chat_id) ?? [];
      list.push(r);
      byChat.set(r.chat_id, list);
    }
    for (const [chatId, recs] of byChat) {
      const age = (r: PendingTelegramRecord) => now - Date.parse(r.created_at);
      // A paste still inside its proof window is about to be either proven or
      // stuck (which sends its own receipt) — acking it now would say the same
      // thing twice within seconds.
      const provingNow = (r: PendingTelegramRecord) =>
        r.submit_phase === 'pasted' && Date.parse(r.submit_deadline_at ?? '') > now;
      const stage1 = recs.filter((r) => r.ack_stage === 0 && r.state !== 'unverified' && age(r) >= delay && !provingNow(r));
      if (stage1.length > 0) await this.sendAckStage(chatId, stage1, 1, now);
      const stage2 = recs.filter((r) => r.ack_stage === 1 && age(r) >= ACK_FOLLOWUP_MS);
      if (stage2.length > 0) await this.sendAckStage(chatId, stage2, 2, now);
    }
  }

  private async sendAckStage(chatId: string, recs: PendingTelegramRecord[], stage: 1 | 2, now: number): Promise<void> {
    // Consumed = Claude Code recorded the prompt as READ (in_flight_at). An
    // enqueue-only record is submitted but NOT read (Codex round 16 #4).
    const consumed = (r: PendingTelegramRecord) => !!r.in_flight_at;
    const n = recs.length;
    const subject = n === 1 ? 'your message' : `your ${n} messages`;
    const oldest = recs.reduce((a, b) => (Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b));
    const all = recs.every(consumed);
    const none = !recs.some(consumed);
    // Say only what the records know: received; whether Claude Code recorded
    // the prompt; no reply observed. Never "working on it".
    const status = all
      ? (n === 1 ? 'JARVIS has read it; no reply yet.' : 'JARVIS has read them; no reply yet.')
      : none
        ? recs.some((r) => r.submit_phase === 'stuck' || r.submit_phase === 'pasted')
          ? "JARVIS hasn't picked it up yet — the delivery is stuck and has been flagged."
          : "JARVIS hasn't read it yet — it is queued."
        : 'JARVIS has read some of them; no reply yet.';
    const text = stage === 1
      ? `Received ${subject} (${Math.round((now - Date.parse(oldest.created_at)) / 1000)}s ago) — automatic receipt, not an answer. ${status}`
      : `Still no reply observed to ${subject} from ${clockTime(oldest.created_at)} — automatic notice, not an answer. ${status}`;
    try {
      await this.telegramApi!.sendMessage(chatId, text);
    } catch (err) {
      this.log(`Receipt ack (stage ${stage}) FAILED for ${n} message(s) in chat ${chatId} — will retry next cycle: ${String(err)}`);
      return;
    }
    const at = new Date().toISOString();
    let persisted = 0;
    for (const r of recs) {
      const cur = this.pending.read(r.update_id);
      if (!cur || cur.ack_stage === undefined || cur.ack_stage >= stage) continue;
      const ok = this.pending.patch(cur.update_id, stage === 1 ? { ack_stage: 1, ack1_at: at } : { ack_stage: 2, ack2_at: at }, { expectRev: cur.rev ?? 0 });
      if (ok) persisted++;
      else this.log(`ERROR: Pending ${cur.update_id}: ack stage ${stage} SENT but not persisted — a restart may repeat it`);
    }
    this.log(`Receipt ack stage ${stage} sent for ${n} message(s) in chat ${chatId} (${persisted} persisted)`);
  }

  /** Step 6: gates, persist-before-write, then ONE paste. */
  private async injectNext(now: number, answered: (rec: PendingTelegramRecord) => boolean): Promise<void> {
    const candidate = this.pending.nextDeliverable(now, answered);
    if (!candidate) return;

    // V5-2a: the boot window of THIS PTY (JSONL runtimes).
    if (this.bootHoldActive(now)) return;
    // The gate may have patched it (escalation cleared on release): paste
    // from the current copy, or the rev-guarded accounting write refuses.
    const next = this.pending.read(candidate.update_id) ?? candidate;

    // V5-2c: a paste into this PTY is still unproven (pasted) or stuck — later
    // messages queue rather than pile into a composer that may not be submitting.
    const inst = this.currentPtyInstance();
    const gate = this.stuckGate(inst);
    if (gate) {
      const key = `${gate.update_id}:${gate.submit_phase}:${next.update_id}`;
      if (this.stuckGateLogged !== key) {
        this.stuckGateLogged = key;
        this.log(`Pending ${next.update_id}: HELD — update ${gate.update_id} is ${gate.submit_phase} in this PTY (no proof of submission yet)`);
      }
      return;
    }

    let block = next.formatted;
    if (!block) {
      // A media record past its grace window whose download has not landed
      // (still running, or the daemon died mid round trip). isEligible never
      // returns a raw record inside the grace window, and never one with no
      // caption (step 4b handles those), so this carries the caption plus a
      // note that the attachment is still owed. A later completion re-arms or
      // updates the record (applyMediaCompletion). Legacy/A0 shape only.
      if (!next.text.trim()) return; // defensive: never inject an empty block
      block = FastChecker.formatTelegramTextMessage(
        next.from,
        next.chat_id,
        `${next.text}\n${mediaStillDownloadingNote(next.media_type)}`,
        this.frameworkRoot,
        undefined,
        undefined,
        undefined,
        next.token,
      );
      const ok = this.pending.patch(next.update_id, {
        formatted: block,
        notes: [...next.notes, 'media not arrived after grace — injecting the caption with a still-downloading note'],
      });
      if (!ok) {
        this.log(`ERROR: Pending ${next.update_id}: could not persist the caption block — ${next.token ? 'NOT injecting this cycle' : 'injecting it anyway'}`);
        if (next.token) return;
      }
    }

    // Prompt-state gate. SOFT for the first 24h: log what it WOULD have held
    // and inject anyway, because a heuristic gate that holds messages is a new
    // way to lose them. TELEGRAM_PROMPT_GATE_STRICT flips it, and ships in this
    // same commit — never a gate without its satisfier.
    if (!this.agent.isAtPrompt()) {
      const why = this.agent.hasModalOpen() ? 'modal open' : 'not at prompt';
      if (strictPromptGateEnabled()) {
        this.log(`Pending ${next.update_id}: HELD in queue (${why}) — strict prompt gate`);
        return;
      }
      this.log(`Pending ${next.update_id}: prompt gate would have held (${why}) — injecting anyway (soft mode)`);
      // Remember it for the ack: this message landed behind work in progress,
      // so the ack must not claim anyone is working on IT yet.
      this.ackTurnQueuedBehindWork = true;
    }

    if (next.token) {
      await this.pasteWithAccounting(next, block, inst);
      return;
    }

    // ---- Legacy record (written before 2026-09-30): the old header-needle path.
    const attemptNo = next.attempts + 1;
    let payload = block;
    if (attemptNo > 1) {
      const lastSent = FastChecker.readLastSent(this.paths.stateDir, next.chat_id);
      const lastSentCtx = lastSent
        ? `[Your last message to this chat: "${sanitizeForPtyInjection(lastSent.slice(0, 500))}"]\n`
        : '';
      payload =
        `[RETRY attempt ${attemptNo}] No reply to chat ${next.chat_id} was observed after the first delivery. ` +
        `If you ALREADY answered this, say so — do not answer twice.\n${lastSentCtx}${block}`;
    }

    // Dedup keyed on update_id + attempt, not content: a re-injection of this
    // attempt is suppressed, Scott's verbatim resend (a different update_id)
    // never is, and the deliberate retry above stays injectable.
    const res = this.agent.injectMessageDetailed(payload, `tg:${next.update_id}#${attemptNo}`);
    if (!res.ok) {
      // Loss mode (b): this used to be `if (injected)` with no else at all.
      this.pending.patch(next.update_id, {
        last_attempt_at: new Date().toISOString(),
        notes: [...next.notes, `inject failed (${res.code}): ${res.message}`],
      });
      this.log(`Pending ${next.update_id}: inject failed (${res.code}) — retained for retry: ${res.message}`);
      return;
    }

    this.pending.markAttempt(next);
    // Byte watermark for send-evidence scanning: a rail that writes no
    // timestamps still gives a rigorous "after the injection" ordering.
    this.pending.patch(next.update_id, { log_offset: this.stdoutLogSizeNow() });
    this.noteTelegramInjected();
    this.log(`Pending ${next.update_id}: injected attempt ${attemptNo} (${payload.length} bytes) — awaiting a reply before deletion`);
    await sleep(5000);
  }

  /**
   * R4-2 + V5-3 for a record with a token: write the attempt's accounting
   * (verified), THEN paste. A paste that wrote nothing is positive
   * non-delivery and is undone for a later retry; anything else — including a
   * paste that threw after some bytes — is UNKNOWN until Claude Code's record
   * shows the token, and is never pasted again.
   */
  private async pasteWithAccounting(next: PendingTelegramRecord, block: string, inst: string | null): Promise<void> {
    const watermark = this.stdoutLogSizeNow();
    const begun = this.pending.beginPaste(next, { at: new Date(), ptyInstance: inst ?? 'none', logOffset: watermark });
    if (!begun) {
      this.log(`ERROR: Pending ${next.update_id}: could not persist the paste accounting — NOT injecting this cycle`);
      return;
    }
    const key = `tg:${next.update_id}#${begun.attempts}.${next.nondelivery_failures ?? 0}`;
    const res = this.agent.injectMessageDetailed(block, key);
    if (!res.ok) {
      const partial = res.code === 'WRITE_FAILED' && (res as { partial?: boolean }).partial === true;
      if (partial) {
        // Bytes reached the PTY: we cannot know what the TUI has. UNKNOWN — the
        // record stays `pasted`; proof or the stuck timer decides what happens.
        this.pending.patch(begun.update_id, { write_error: res.message, notes: [...begun.notes, `paste threw after some bytes were written: ${res.message}`] }, { expectRev: begun.rev ?? 0 });
        this.log(`Pending ${next.update_id}: paste PARTIALLY written (${res.message}) — delivery state UNKNOWN, not retried`);
        return;
      }
      const undone = this.pending.abortPaste(begun, `inject failed (${res.code}) before any byte reached the PTY: ${res.message}`);
      this.log(undone
        ? `Pending ${next.update_id}: inject failed (${res.code}) — nothing reached the PTY; retained for retry: ${res.message}`
        : `ERROR: Pending ${next.update_id}: inject failed (${res.code}) and the accounting could not be undone — it stays UNKNOWN: ${res.message}`);
      return;
    }
    this.noteTelegramInjected();
    this.log(`Pending ${next.update_id}: pasted ${telegramTokenLabel(begun)} (${block.length} bytes) into PTY ${(inst ?? 'none').slice(0, 8)} — awaiting proof of submission`);
    await sleep(5000);
  }

  /** Typing indicator + legacy slow-turn ack bookkeeping after any Telegram paste. */
  private noteTelegramInjected(): void {
    this.lastMessageInjectedAt = Date.now();
    // Arm the slow-turn ack clock (973573e) on the durable path too. Same
    // semantics: anchor to the FIRST unanswered message, count every one.
    if (this.ackTurnStartedAt === 0) this.ackTurnStartedAt = Date.now();
    this.ackTurnMessageCount++;
  }

  private currentPtyInstance(): string | null {
    const a = this.agent as unknown as { getPtyInstance?: () => string | null };
    return typeof a.getPtyInstance === 'function' ? a.getPtyInstance() : 'unknown';
  }

  /** A paste in THIS PTY with no proof of submission yet, or stuck (V5-2c). */
  private stuckGate(inst: string | null): PendingTelegramRecord | null {
    if (!inst) return null;
    return (
      this.pending.active().find(
        (r) =>
          !!r.token &&
          r.pty_instance === inst &&
          (r.submit_phase === 'pasted' || r.submit_phase === 'stuck'),
        // No expiry, no reply, no elapsed time opens this gate — only proof of
        // submission (the record moves to 'submitted') or a new PTY instance.
        // Nothing else shows the composer is clear (Codex round 15 #2).
      ) ?? null
    );
  }

  /**
   * V5-2a / R4-4: hold Telegram injection while THIS PTY is booting.
   *
   * Released for a PTY instance only on readiness EVIDENCE: (1) its output
   * shows a successful bootstrap (the ring buffer is per PTY, so a previous
   * generation's output cannot count, and the bootstrap-TIMEOUT path never
   * marks anything ready), and (2) Claude Code's session record shows this
   * spawn's boot prompt (by its unique `Current UTC time:` marker) followed by
   * a turn end. Every respawn is a new instance and starts held again.
   *
   * Elapsed time is not readiness (Codex round 15 #6). Past BOOT_HOLD_MAX_MS
   * the hold ESCALATES — one loud log per PTY, and every held record carries
   * `hold_escalated_at`, which the watchdog reports as HELD — and keeps
   * holding. Scott's receipt acks keep flowing meanwhile (A6).
   */
  private bootHoldActive(now: number): boolean {
    if (this.proofMode !== 'jsonl' || !this.scanner) return false;
    const a = this.agent as unknown as {
      getPtyInstance?: () => string | null;
      getPtySpawnedAt?: () => number;
      getBootMarker?: () => string | null;
    };
    if (typeof a.getPtyInstance !== 'function') return false;
    const inst = a.getPtyInstance();
    if (!inst) return false; // no PTY: the paste itself reports NOT_RUNNING
    if (this.bootReadyInstance === inst) return false;
    const spawnedAt = a.getPtySpawnedAt?.() ?? 0;
    const marker = a.getBootMarker?.() ?? null;
    const overdue = spawnedAt > 0 && now - spawnedAt >= bootHoldMaxMs();
    const held = (why: string): boolean => {
      if (this.bootHoldLoggedFor !== `${inst}:${why}`) {
        this.bootHoldLoggedFor = `${inst}:${why}`;
        this.log(`Telegram injection HELD — boot window of PTY ${inst.slice(0, 8)}: ${why}`);
      }
      if (overdue) this.escalateBootHold(inst, now, why);
      return true;
    };
    const release = (why: string): boolean => {
      this.bootReadyInstance = inst;
      this.log(`Telegram injection RELEASED for PTY ${inst.slice(0, 8)}: ${why}`);
      this.clearBootHoldEscalation();
      return false;
    };
    if (!this.agent.isBootstrapped()) return held('bootstrap not observed for this PTY');
    if (!marker) return release('bootstrap observed; this spawn has no boot marker to bind a turn end to');
    const snap = this.transcriptSnapshot(spawnedAt - 60_000, now);
    const r = bootTurnEnded(snap, marker);
    if (r.ready) return release(`boot turn ended at ${new Date(r.turnEndTs!).toISOString()} (Claude Code session record)`);
    if (overdue && !r.promptTs) {
      return held(
        `this spawn's boot prompt was never recorded as a genuine prompt in ${this.scanner.projectDir} — ` +
        'the Claude Code JSONL schema may have changed',
      );
    }
    return held(r.promptTs ? 'boot turn still running' : 'boot prompt not recorded yet');
  }

  /** Past the bound: one loud log per PTY; mark every held record (new ones too) for the watchdog. */
  private escalateBootHold(inst: string, now: number, why: string): void {
    if (this.bootHoldEscalatedFor !== inst) {
      this.bootHoldEscalatedFor = inst;
      this.log(
        `LOUD: Telegram injection has been held ${Math.round(bootHoldMaxMs() / 60_000)}+ min in the boot window of PTY ${inst.slice(0, 8)} ` +
        `(${why}). NOT releasing on time alone — waiting for readiness evidence; held messages are flagged for the watchdog.`,
      );
    }
    const iso = new Date(now).toISOString();
    for (const r of this.pending.active()) {
      if (r.hold_escalated_at || r.submit_phase !== undefined || r.state !== 'unattempted' || r.empty) continue;
      this.pending.patch(r.update_id, { hold_escalated_at: iso, hold_reason: 'boot_not_ready' }, { expectRev: r.rev ?? 0 });
    }
  }

  private clearBootHoldEscalation(): void {
    for (const r of this.pending.active()) {
      if (!r.hold_escalated_at) continue;
      this.pending.patch(r.update_id, {
        hold_escalated_at: undefined,
        hold_reason: undefined,
        notes: [...r.notes, `boot hold (escalated ${r.hold_escalated_at}) released on readiness evidence`],
      }, { expectRev: r.rev ?? 0 });
    }
  }

  /** One scan per ≤5 s, shared by the boot hold and the proof pass (R4-5 cadence). */
  private transcriptSnapshot(sinceMs: number, now: number): ScanSnapshot {
    const last = this.lastSnap;
    if (last && now - last.at < PROOF_SCAN_MIN_INTERVAL_MS && last.since <= sinceMs) return last.snap;
    const snap = this.scanner!.scan(sinceMs);
    this.lastSnap = { at: now, since: sinceMs, snap };
    if (snap.error) this.log(`Submission proof: ${snap.error}`);
    const newest = latestGenuinePrompt(snap);
    if (newest > this.lastGenuineSeenAt) this.lastGenuineSeenAt = newest;
    // R4-1 self-check: scans are running, yet no genuine prompt anywhere in the
    // project dir for 24 h => the provenance schema probably changed.
    if (
      now - this.startedAt > PROOF_WINDOW_MS &&
      now - this.lastGenuineSeenAt > PROOF_WINDOW_MS &&
      now - this.lastSchemaWarnAt > 60 * 60_000
    ) {
      this.lastSchemaWarnAt = now;
      this.log(
        `LOUD: no genuine submitted prompt has matched the Claude Code JSONL provenance schema in 24 h (${this.scanner!.projectDir}). ` +
        'Every submission will read UNKNOWN until the schema rules in telegram/submission-proof.ts are updated.',
      );
    }
    if (snap.durationMs > 250) this.log(`Submission proof scan took ${Math.round(snap.durationMs)} ms (${snap.filesRead} read / ${snap.filesConsidered} files; p95 ${Math.round(this.scanner!.p95())} ms)`);
    return snap;
  }

  /**
   * Step 1: move pastes forward on evidence only.
   *
   * Records with a token: proof comes from Claude Code's record ('jsonl') or,
   * for runtimes without one, the token in normalized PTY output ('pty'); in
   * jsonl mode the PTY is a logged hint and nothing more. No evidence within
   * SUBMIT_TIMEOUT_MS of the paste => `stuck` (only after a scan that ran past
   * the deadline, so a slow scan can never manufacture one). Late evidence
   * keeps counting for 24 h and clears stuck. Legacy records: the old
   * header-needle rule.
   */
  private proveConsumption(now: number): void {
    const recs = this.pending.active();
    for (const rec of recs) {
      if (!rec.token && rec.state === 'unattempted' && rec.attempts > 0 && rec.header && this.agent.transcriptContains(rec.header)) {
        this.pending.markInFlight(rec);
        this.log(`Pending ${rec.update_id}: header seen in transcript — in_flight (consumed, NOT answered)`);
      }
    }
    // A record that gates THIS PTY is scanned for as long as it gates it — past
    // the 24 h window too: only its evidence can release the queue behind it.
    const inst = this.currentPtyInstance();
    const gating = (r: PendingTelegramRecord) =>
      !!inst && r.pty_instance === inst && (r.submit_phase === 'pasted' || r.submit_phase === 'stuck');
    const awaiting = recs.filter(
      (r) =>
        awaitingConsumption(r) &&
        (r.state === 'in_flight' || r.state === 'unverified') &&
        !!r.attempt_started_at &&
        (!r.proof_window_closed_at || gating(r)),
    );
    if (awaiting.length === 0) return;

    let snap: ScanSnapshot | null = null;
    if (this.proofMode === 'jsonl' && this.scanner) {
      const since = Math.min(...awaiting.map((r) => Date.parse(r.attempt_started_at!)).filter((t) => !Number.isNaN(t)));
      snap = this.transcriptSnapshot(since, now);
    }

    for (const rec of awaiting) {
      const started = Date.parse(rec.attempt_started_at!);
      let finding: { consumed: boolean; via: NonNullable<PendingTelegramRecord['submitted_via']>; uuid: string; ts: number } | null = null;
      if (snap) {
        const f = findSubmission(snap, rec.token!, started, rec.proof_uuids ?? []);
        if (f) finding = { consumed: f.phase === 'consumed', via: f.evidence.kind, uuid: f.evidence.uuid, ts: f.evidence.ts };
      }
      const lastPty = this.ptyCheckedAt.get(rec.update_id) ?? 0;
      const ptyDue = this.proofMode === 'pty'
        ? (rec.submit_phase === 'pasted' || now - lastPty >= PROOF_SCAN_MIN_INTERVAL_MS)
        : (!rec.pty_hint_at && now - lastPty >= PROOF_SCAN_MIN_INTERVAL_MS);
      let ptySeen = false;
      if (ptyDue) {
        this.ptyCheckedAt.set(rec.update_id, now);
        ptySeen = this.ptyTokenSeen(rec);
      }
      if (ptySeen && this.proofMode === 'jsonl' && !rec.pty_hint_at) {
        this.pending.patch(rec.update_id, { pty_hint_at: new Date(now).toISOString() });
        this.log(`Pending ${rec.update_id}: token seen in PTY output — a hint only; proof comes from Claude Code's record`);
      }
      if (!finding && ptySeen && this.proofMode === 'pty') finding = { consumed: true, via: 'pty', uuid: `pty:${rec.pty_instance ?? '?'}`, ts: now };

      const cur = this.pending.read(rec.update_id);
      if (!cur) continue;
      if (finding) {
        this.recordSubmission(cur, finding);
        continue;
      }
      if (!Number.isNaN(started) && now - started > PROOF_WINDOW_MS && !cur.proof_window_closed_at) {
        this.pending.patch(cur.update_id, { proof_window_closed_at: new Date(now).toISOString() }, { expectRev: cur.rev ?? 0 });
        this.log(gating(cur)
          ? `Pending ${cur.update_id}: no proof of submission within 24 h — still UNKNOWN; it still gates this PTY, so scanning continues`
          : `Pending ${cur.update_id}: no proof of consumption within 24 h — delivery state stays UNKNOWN; no longer scanning`);
        if (!gating(cur)) continue;
      }
      if (cur.submit_phase === 'pasted') {
        const deadline = Date.parse(cur.submit_deadline_at ?? '');
        const scannedPastDeadline = this.proofMode === 'pty' || (this.lastSnap !== null && this.lastSnap.at >= deadline);
        if (!Number.isNaN(deadline) && now >= deadline && scannedPastDeadline) {
          this.pending.patch(cur.update_id, { submit_phase: 'stuck', stuck_at: new Date(now).toISOString() }, { expectRev: cur.rev ?? 0 });
          this.log(
            `Pending ${cur.update_id}: STUCK — no submitted prompt carrying ${cur.token} in ${Math.round((now - started) / 1000)}s ` +
            `(${this.proofMode === 'jsonl' ? "Claude Code's session record" : 'PTY output'}). Not re-pasted; later messages queue behind it in this PTY.`,
          );
        }
      }
    }
  }

  private recordSubmission(
    cur: PendingTelegramRecord,
    f: { consumed: boolean; via: NonNullable<PendingTelegramRecord['submitted_via']>; uuid: string; ts: number },
  ): void {
    const iso = new Date(f.ts).toISOString();
    const fields: Partial<PendingTelegramRecord> = {
      submit_phase: 'submitted',
      proof_uuids: [...(cur.proof_uuids ?? []), f.uuid],
    };
    if (!cur.submitted_at) fields.submitted_at = iso;
    if (f.consumed) {
      fields.in_flight_at = iso;
      fields.submitted_via = f.via;
    } else if (!cur.submitted_via) {
      fields.submitted_via = f.via;
    }
    const ok = this.pending.patch(cur.update_id, fields, { expectRev: cur.rev ?? 0 });
    const late = cur.submit_phase === 'stuck' ? ' — LATE submission, stuck cleared' : '';
    const what = f.consumed ? 'consumed (NOT answered)' : 'accepted into the input queue (not yet read)';
    this.log(ok
      ? `Pending ${cur.update_id}: submission PROVEN via ${f.via} (${f.uuid.slice(0, 12)} at ${iso}) — ${what}${late}`
      : `ERROR: Pending ${cur.update_id}: submission proof found but could not be recorded — will retry`);
  }

  /**
   * A1: is this record's token in the PTY output after its watermark?
   * Normalized (every ANSI/OSC sequence and ALL whitespace removed), because
   * the TUI draws spaces as cursor moves and wraps long lines. The watermark
   * was captured BEFORE the paste; if the log is now smaller (rotated, or a
   * restart truncated it) the current file is searched from 0 — never from a
   * stale offset.
   */
  private ptyTokenSeen(rec: PendingTelegramRecord): boolean {
    if (!rec.token) return false;
    const needle = normalizePtyText(rec.token);
    const MAX_SCAN = 2 * 1024 * 1024;
    try {
      const path = join(this.paths.logDir, 'stdout.log');
      const size = statSync(path).size;
      const mark = typeof rec.log_offset === 'number' && rec.log_offset <= size ? rec.log_offset : 0;
      const start = Math.max(mark, size - MAX_SCAN);
      if (size <= start) return false;
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, size - start, start);
        return normalizePtyText(buf.toString('utf-8')).includes(needle);
      } finally {
        closeSync(fd);
      }
    } catch {
      return normalizePtyText(this.agent.getStrippedTail(20000)).includes(needle);
    }
  }

  // === A3 media ===========================================================

  /** Wire the daemon's downloader (agent-manager). */
  setMediaDownloader(d: MediaDownloader): void {
    this.mediaDownloader = d;
  }

  /** Start (or restart) a download as generation `gen`. Every start goes through here. */
  startMediaJob(rec: PendingTelegramRecord, gen: number): void {
    if (!this.mediaDownloader) {
      this.log(`Pending ${rec.update_id}: no media downloader wired — gen ${gen} not started; the deadline pass will fail it`);
      return;
    }
    this.jobsStartedHere.add(`${rec.update_id}:${gen}`);
    this.mediaDownloader.start(rec, gen);
  }

  /**
   * A3 deadline pass. A pending download past its deadline gets ONE retry
   * (new generation, new deadline — the old generation's late completion is
   * then fenced out). After that it is `failed`: a caption is injected with a
   * note (ONE block), a captionless record is left for the notice pass (4c).
   * The failure transition requires the expected gen AND media_state pending.
   */
  private processMediaDeadlines(now: number): void {
    for (const rec of this.pending.active()) {
      if (rec.media_state !== 'pending' || rec.media_gen === undefined || rec.state !== 'unattempted') continue;
      const deadline = Date.parse(rec.media_deadline_at ?? '');
      if (!Number.isNaN(deadline) && now < deadline) continue;
      if ((rec.media_retries ?? 0) < 1 && this.mediaDownloader) {
        const gen = rec.media_gen + 1;
        const next = this.pending.patch(rec.update_id, {
          media_gen: gen,
          media_retries: (rec.media_retries ?? 0) + 1,
          media_deadline_at: new Date(now + this.pending.mediaGraceMs).toISOString(),
          notes: [...rec.notes, `download gen ${rec.media_gen} missed its deadline — re-downloading as gen ${gen}`],
        }, { expectRev: rec.rev ?? 0 });
        if (!next) {
          this.log(`ERROR: Pending ${rec.update_id}: could not record the media retry — will try again next cycle`);
          continue;
        }
        this.log(`Pending ${rec.update_id}: ${mediaNoun(rec.media_type)} download gen ${rec.media_gen} missed its deadline — retrying as gen ${gen}`);
        this.startMediaJob(next, gen);
        continue;
      }
      const caption = rec.text.trim();
      const fields: Partial<PendingTelegramRecord> = {
        media_state: 'failed',
        notes: [...rec.notes, `download failed after ${(rec.media_retries ?? 0) + 1} attempt(s)${caption ? ' — injecting the caption with a note' : ' — no caption; the sender will be told'}`],
      };
      if (caption) {
        fields.formatted = FastChecker.formatTelegramTextMessage(
          rec.from,
          rec.chat_id,
          `${caption}\n${mediaFailedNote(rec)}`,
          this.frameworkRoot,
          undefined,
          undefined,
          undefined,
          rec.token,
        );
      }
      const ok = this.pending.patch(rec.update_id, fields, { expectRev: rec.rev ?? 0 });
      this.log(ok
        ? `Pending ${rec.update_id}: ${mediaNoun(rec.media_type)} download FAILED for good (gen ${rec.media_gen})${caption ? ' — caption will be delivered with a note' : ''}`
        : `ERROR: Pending ${rec.update_id}: could not mark the media failure — will try again next cycle`);
    }
  }

  /**
   * A3 completion from the daemon's media job. Only the CURRENT generation of
   * a record that is still pending (or failed — a late success) may rename its
   * part file into place and patch the block; anything else is stale and is
   * discarded (logged, part file removed).
   */
  completeMediaDownload(
    updateId: number,
    gen: number,
    result: { partPath: string; transcript?: string },
  ): 'landed' | 'rearmed' | 'dropped' | 'stale' | 'missing' | 'write_failed' {
    const cur = this.pending.read(updateId);
    const discardPart = () => {
      try { unlinkSync(result.partPath); } catch { /* already gone */ }
    };
    if (!cur) {
      discardPart();
      this.log(`Media completion for ${updateId} gen ${gen}: record no longer exists — discarded`);
      return 'missing';
    }
    if (cur.media_gen !== gen || (cur.media_state !== 'pending' && cur.media_state !== 'failed') || !cur.media_dest) {
      discardPart();
      this.log(`Media completion for ${updateId} gen ${gen} is STALE (record gen ${cur.media_gen}, state ${cur.media_state}) — discarded`);
      return 'stale';
    }
    const dest = join(this.agentDirOr(), cur.media_dest);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(result.partPath, dest);
    } catch (err) {
      this.log(`ERROR: media completion for ${updateId} gen ${gen}: rename into place failed: ${String(err)} — kept for retry`);
      this.owePatch(updateId, { gen, partPath: result.partPath, transcript: result.transcript, attempts: 1 });
      return 'write_failed';
    }
    return this.landMedia(cur, dest, result.transcript, gen);
  }

  /** Immediate failure from the job: pull the deadline in so the next cycle retries or fails it. */
  failMediaDownload(updateId: number, gen: number, err: unknown): void {
    const cur = this.pending.read(updateId);
    if (!cur || cur.media_gen !== gen || cur.media_state !== 'pending') {
      this.log(`Media download for ${updateId} gen ${gen} failed after it was superseded — ignored: ${String(err)}`);
      return;
    }
    const ok = this.pending.patch(updateId, {
      media_deadline_at: new Date().toISOString(),
      notes: [...cur.notes, `download gen ${gen} failed: ${String(err)}`],
    }, { expectRev: cur.rev ?? 0 });
    this.log(`Media download for ${updateId} gen ${gen} FAILED: ${String(err)}${ok ? ' — retry/failure decided next cycle' : ' (could not record; the deadline will decide)'}`);
  }

  /** Patch the block for a file that is already at its final path. */
  private landMedia(
    cur: PendingTelegramRecord,
    destAbs: string,
    transcript: string | undefined,
    gen: number,
  ): 'landed' | 'rearmed' | 'dropped' | 'write_failed' {
    const block = this.buildMediaBlock(cur, destAbs, transcript);
    const text = (transcript || cur.text || '').trim();
    let fields: Partial<PendingTelegramRecord>;
    let outcome: 'landed' | 'rearmed' | 'dropped';
    if (cur.media_state === 'pending' && cur.state === 'unattempted') {
      fields = { formatted: block, text, empty: false, media_state: 'ready' };
      outcome = 'landed';
    } else if (cur.media_state === 'failed' && cur.attempts === 0 && (cur.state === 'unattempted' || cur.state === 'failed_notified')) {
      // V4-4: a late success always delivers if nothing was injected yet — even
      // after the resend notice went out. The block says it arrived late when
      // the sender was told otherwise (a notice still in flight gets the same
      // prefix from the notice pass once its send returns).
      const noticeSent = cur.state === 'failed_notified' || !!cur.notified_at;
      fields = {
        state: 'unattempted',
        empty: false,
        media_state: 'ready',
        formatted: noticeSent ? `${LATE_MEDIA_PREFIX}\n${block}` : block,
        text,
        notes: [...cur.notes, `gen ${gen} landed after the download was marked failed — re-armed with a late note`],
      };
      outcome = 'rearmed';
    } else {
      // The caption (with its "failed to download" note) was already pasted.
      // Re-pasting would duplicate it; the file is kept on disk and noted.
      fields = { notes: [...cur.notes, `gen ${gen} landed after the caption was already delivered — file kept at ${cur.media_dest}, not re-injected`] };
      outcome = 'dropped';
    }
    const ok = this.pending.patch(cur.update_id, fields, { expectRev: cur.rev ?? 0 });
    if (!ok) {
      const prev = this.pendingMediaPatches.get(cur.update_id);
      this.owePatch(cur.update_id, { gen, partPath: null, transcript, attempts: prev && prev.gen === gen ? prev.attempts : 1 });
      this.log(`ERROR: media completion for ${cur.update_id} gen ${gen}: the block could NOT be written — kept in memory, retried next cycle`);
      return 'write_failed';
    }
    this.settleMediaPatch(cur.update_id);
    this.log(
      outcome === 'landed'
        ? `Media message received: type=${cur.media_type}, durable record ${cur.update_id} ready (gen ${gen})`
        : outcome === 'rearmed'
          ? `Media message received LATE: type=${cur.media_type}, durable record ${cur.update_id} re-armed for delivery (gen ${gen})`
          : `Media for ${cur.update_id} landed after its caption was delivered — logged, not re-injected`,
    );
    return outcome;
  }

  private retryPendingMediaPatches(): void {
    for (const [updateId, p] of [...this.pendingMediaPatches]) {
      const cur = this.pending.read(updateId);
      if (!cur || cur.media_gen !== p.gen || !cur.media_dest) {
        // Superseded or gone: explicitly discarded.
        if (p.partPath) { try { unlinkSync(p.partPath); } catch { /* gone */ } }
        this.log(`Owed media completion for ${updateId} gen ${p.gen} discarded — record ${cur ? `moved to gen ${cur.media_gen}` : 'no longer exists'}`);
        this.settleMediaPatch(updateId);
        continue;
      }
      p.attempts++;
      const dest = join(this.agentDirOr(), cur.media_dest);
      if (p.partPath) {
        try {
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(p.partPath, dest);
          p.partPath = null;
        } catch (err) {
          if (p.attempts % 10 === 0) this.log(`ERROR: owed media completion for ${updateId} gen ${p.gen}: rename still failing after ${p.attempts} tries: ${String(err)}`);
          continue;
        }
      }
      this.landMedia(cur, dest, p.transcript, p.gen);
    }
  }

  /**
   * Record an owed completion. A different generation already owed for the
   * same record is SUPERSEDED — its result can never land (only the current gen
   * may) — so it is discarded explicitly and its job released here. Overwriting
   * it silently left that job counted forever (Codex round 16 #1).
   */
  private owePatch(updateId: number, entry: { gen: number; partPath: string | null; transcript?: string; attempts: number }): void {
    const prev = this.pendingMediaPatches.get(updateId);
    if (prev && prev.gen !== entry.gen) {
      if (prev.partPath) { try { unlinkSync(prev.partPath); } catch { /* gone */ } }
      this.log(`Owed media completion for ${updateId} gen ${prev.gen} discarded — superseded by gen ${entry.gen}`);
      this.settleMediaPatch(updateId);
    }
    this.pendingMediaPatches.set(updateId, entry);
  }

  /** The owed completion for this record is resolved (landed or discarded): release its job. */
  private settleMediaPatch(updateId: number): void {
    const p = this.pendingMediaPatches.get(updateId);
    this.pendingMediaPatches.delete(updateId);
    if (!p) return;
    const key = `${updateId}:${p.gen}`;
    for (const resolve of this.patchWaiters.get(key) ?? []) resolve();
    this.patchWaiters.delete(key);
  }

  /**
   * Resolves once the completion for (updateId, gen) is no longer owed —
   * immediately if it is not. The daemon's media job awaits this after a
   * 'write_failed' completion, so the outstanding-job count the rollback drain
   * reads cannot reach zero while a download's result exists only in memory.
   */
  mediaPatchSettled(updateId: number, gen: number): Promise<void> {
    const p = this.pendingMediaPatches.get(updateId);
    if (!p || p.gen !== gen) return Promise.resolve();
    const key = `${updateId}:${gen}`;
    return new Promise<void>((resolve) => {
      const list = this.patchWaiters.get(key) ?? [];
      list.push(resolve);
      this.patchWaiters.set(key, list);
    });
  }

  /** The block for a downloaded attachment — same formatters, token in the header. */
  private buildMediaBlock(rec: PendingTelegramRecord, destAbs: string, transcript?: string): string {
    const cfg = (this.agent as unknown as { getConfig?: () => { working_directory?: string } }).getConfig?.();
    const launchDir = cfg?.working_directory || this.agentDirOr();
    const rel = relative(launchDir, destAbs);
    const caption = rec.text;
    const name = rec.file_name || rec.media_dest?.replace(/^.*?\d+-/, '') || '';
    switch (rec.media_type) {
      case 'photo':
        return FastChecker.formatTelegramPhotoMessage(rec.from, rec.chat_id, caption, rel, rec.token);
      case 'document':
        return FastChecker.formatTelegramDocumentMessage(rec.from, rec.chat_id, caption, rel, name, rec.token);
      case 'voice':
      case 'audio':
        return FastChecker.formatTelegramVoiceMessage(rec.from, rec.chat_id, rel, rec.media_duration, transcript, rec.token);
      default:
        return FastChecker.formatTelegramVideoMessage(rec.from, rec.chat_id, caption, rel, name, rec.media_duration, rec.token);
    }
  }

  private agentDirOr(): string {
    const a = this.agent as unknown as { getAgentDir?: () => string };
    return typeof a.getAgentDir === 'function' ? a.getAgentDir() : this.paths.stateDir;
  }

  /**
   * V4-3 startup reconciliation — once, before the first durable cycle acts:
   *   (a) a pending download whose final file exists => rebuild the block from
   *       the file and mark it ready (crash between rename and patch); voice/
   *       audio are re-downloaded instead, to get their transcript back;
   *   (b) a record carrying resolved_at still in pending/ => finish the archive;
   *   (c) stray `.part.*` files no job of THIS process owns => deleted;
   *   (d) any other pending download => resumed via file_id as a new gen.
   * Pasted/stuck records need nothing: their state is on disk, they are never
   * re-pasted, and a new PTY instance opens the stuck gate (R4-2/R4-3).
   */
  private startupReconcile(): void {
    const moved = this.pending.finishArchives();
    if (moved > 0) this.log(`Startup: finished ${moved} interrupted archive(s)`);
    const agentDir = this.agentDirOr();
    let rebuilt = 0;
    for (const rec of this.pending.active()) {
      if (rec.media_state !== 'pending' || rec.media_gen === undefined || !rec.media_dest || rec.state !== 'unattempted') continue;
      if (this.jobsStartedHere.has(`${rec.update_id}:${rec.media_gen}`)) continue;
      const dest = join(agentDir, rec.media_dest);
      const textual = rec.media_type === 'voice' || rec.media_type === 'audio';
      if (existsSync(dest) && !textual && this.landMedia(rec, dest, undefined, rec.media_gen) !== 'write_failed') rebuilt++;
    }
    let stray = 0;
    try {
      const imgDir = join(agentDir, 'telegram-images');
      if (existsSync(imgDir)) {
        for (const name of readdirSync(imgDir)) {
          const m = name.match(PART_FILE_RE);
          if (!m) continue;
          if (this.jobsStartedHere.has(`${m[1]}:${m[2]}`)) continue;
          try { unlinkSync(join(imgDir, name)); stray++; } catch { /* gone */ }
        }
      }
    } catch { /* unreadable dir: nothing to reconcile */ }
    const uncertain = this.pending.active().filter((r) => r.submit_phase === 'pasted' || r.submit_phase === 'stuck').length;
    if (rebuilt || stray || uncertain) {
      this.log(`Startup reconciliation: ${rebuilt} media block(s) rebuilt from disk, ${stray} stray part file(s) removed, ${uncertain} paste(s) still awaiting proof (never re-pasted)`);
    }
    // (d) needs the daemon's downloader, which is wired after start() begins;
    // resumeInterruptedMedia() runs on the first cycle that has it.
    this.resumeDue = true;
  }

  /** V4-3(d): pending downloads left by a previous process resume as a new gen. */
  private resumeInterruptedMedia(): void {
    if (!this.resumeDue || !this.mediaDownloader) return;
    this.resumeDue = false;
    let resumed = 0;
    for (const rec of this.pending.active()) {
      if (rec.media_state !== 'pending' || rec.media_gen === undefined || !rec.media_dest || rec.state !== 'unattempted') continue;
      if (this.jobsStartedHere.has(`${rec.update_id}:${rec.media_gen}`)) continue;
      const gen = rec.media_gen + 1;
      const next = this.pending.patch(rec.update_id, {
        media_gen: gen,
        media_deadline_at: new Date(Date.now() + this.pending.mediaGraceMs).toISOString(),
        notes: [...rec.notes, `daemon restarted mid-download — resumed as gen ${gen}`],
      }, { expectRev: rec.rev ?? 0 });
      if (next) {
        this.startMediaJob(next, gen);
        resumed++;
      }
    }
    if (resumed > 0) this.log(`Startup: resumed ${resumed} interrupted media download(s) via file_id`);
  }

  /** Current size of the agent's stdout.log, or 0 when it is unreadable. */
  private stdoutLogSizeNow(): number {
    try {
      return statSync(join(this.paths.logDir, 'stdout.log')).size;
    } catch {
      return 0;
    }
  }

  /**
   * Rail 2: `cacheLastSent` writes state/<agent>/last-telegram-<chat>.txt on
   * every cortextos send. Its mtime survives a rotated or truncated outbound
   * log, so it is checked independently.
   */
  private lastSentTouchedAfter(rec: PendingTelegramRecord): boolean {
    const since = replyReferenceTime(rec);
    if (Number.isNaN(since)) return false;
    try {
      const f = join(this.paths.stateDir, `last-telegram-${rec.chat_id}.txt`);
      return statSync(f).mtimeMs > since;
    } catch {
      return false;
    }
  }

  /**
   * Diagnostic only (A2): did the agent run a send command for this chat after
   * the injection? NOT reply evidence — kept so an operator can see "a send was
   * attempted" next to an unverified record.
   */
  sendAttemptObserved(rec: PendingTelegramRecord): boolean {
    if (rec.log_offset === undefined || rec.log_offset === null) return false;
    try {
      const path = join(this.paths.logDir, 'stdout.log');
      const size = statSync(path).size;
      if (size <= rec.log_offset) return false;
      const start = Math.max(rec.log_offset, size - 2 * 1024 * 1024);
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, size - start, start);
        return sendEvidenceInTranscript(buf.toString('utf-8').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''), rec.chat_id);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /**
   * The Claude project dir for a claude-code agent (V5-1), or null for other
   * runtimes / agents whose config cannot be read. CLAUDE_CONFIG_DIR (from the
   * daemon env or the agent's .env) moves `projects/` with it.
   */
  static claudeProjectDirForAgent(agent: AgentProcess): string | null {
    const a = agent as unknown as { getConfig?: () => { runtime?: string; working_directory?: string }; getAgentDir?: () => string };
    if (typeof a.getConfig !== 'function' || typeof a.getAgentDir !== 'function') return null;
    let cfg: { runtime?: string; working_directory?: string } | undefined;
    try {
      cfg = a.getConfig();
    } catch {
      return null;
    }
    if (!cfg || (cfg.runtime !== undefined && cfg.runtime !== 'claude-code')) return null;
    const agentDir = a.getAgentDir();
    const cwd = cfg.working_directory || agentDir;
    if (!cwd) return null;
    let configDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      const envFile = join(agentDir, '.env');
      if (existsSync(envFile)) {
        const m = readFileSync(envFile, 'utf-8').match(/^\s*CLAUDE_CONFIG_DIR\s*=\s*(.+?)\s*$/m);
        if (m) configDir = m[1].replace(/^['"]|['"]$/g, '');
      }
    } catch { /* keep the daemon's */ }
    return configDir ? claudeProjectDirFor(cwd, join(configDir, 'projects')) : claudeProjectDirFor(cwd);
  }

  // === JARVIS MOD #23 — voice cue loader (2026-07-05) ===
  /**
   * Read VOICE_CUE.md from the agent workspace, mtime-cached. Returns the
   * trimmed cue text, or null when the file is absent/empty (the common case
   * for worker agents — they never opt in). Any fs error disables the cue for
   * that poll rather than blocking message delivery.
   */
  private readVoiceCue(): string | null {
    try {
      const cuePath = join(this.agent.getAgentDir(), 'VOICE_CUE.md');
      if (!existsSync(cuePath)) {
        this.voiceCueText = null;
        this.voiceCueMtimeMs = -1;
        return null;
      }
      const mtimeMs = statSync(cuePath).mtimeMs;
      if (mtimeMs !== this.voiceCueMtimeMs) {
        const raw = readFileSync(cuePath, 'utf-8').trim();
        this.voiceCueText = raw.length > 0 ? raw : null;
        this.voiceCueMtimeMs = mtimeMs;
      }
      return this.voiceCueText;
    } catch {
      return null;
    }
  }
  // === END JARVIS MOD #23 (loader) ===

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    // msg.text/from are externally influenced (a body can carry its own
    // fence/header markers; --body-stdin/--body-file made arbitrary bodies easy
    // to send). The body is wrapped with wrapFenceSafe — a dynamically-sized
    // fence the body cannot close, with the body left byte-exact so pasted code
    // blocks stay readable. The inline `from` is collapse-sanitized (it sits in
    // the header line, not a fence).
    const safeFrom = sanitizeForPtyInjection(msg.from);
    return `=== AGENT MESSAGE from ${safeFrom}${replyNote} [msg_id: ${msg.id}] ===
${wrapFenceSafe(msg.text)}
Reply using: cortextos bus send-message ${safeFrom} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(
    from: string,
    chatId: string | number,
    text: string,
    frameworkRoot: string,
    replyToText?: string,
    lastSentText?: string,
    recentHistory?: string,
    token?: string,
  ): string {
    // Every externally-influenced field below is untrusted (the sender controls
    // text/display-name; reply-context, last-sent and recent-history are built
    // from prior external messages). Sanitize each so none can escape the fence
    // or forge a containment header. Unfenced context fields (reply/history) are
    // the weakest surface — they sit raw in [Replying to: "..."] / [Recent ...].
    let replyCx = '';
    if (replyToText) {
      replyCx = `[Replying to: "${sanitizeForPtyInjection(replyToText.slice(0, 500))}"]\n`;
    }

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${sanitizeForPtyInjection(lastSentText.slice(0, 500))}"]\n`;
    }

    let historyCx = '';
    if (recentHistory) {
      historyCx = `[Recent conversation:]\n${sanitizeForPtyInjection(recentHistory)}\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    // Non-slash bodies use wrapFenceSafe: an unescapable dynamically-sized fence
    // that leaves the body byte-exact (legit code blocks preserved). Slash commands
    // get control-char strip + header-quote only (no fence — must stay invokable).
    const isSlashCommand = /^\/[a-zA-Z]/.test(stripControlChars(text).trim());
    const body = isSlashCommand
      ? sanitizeForPtyInjection(text).trim()
      : wrapFenceSafe(text);
    return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}]${tokenPart(token)} (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(
    from: string,
    chatId: string | number,
    messageId: number,
    oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
    newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  ): string {
    const render = (list: typeof newReaction): string =>
      list.length === 0
        ? '(none)'
        : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

    const removed = newReaction.length === 0 && oldReaction.length > 0;
    const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

    return `=== REACTION from [USER: ${from}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    imagePath: string,
    token?: string,
  ): string {
    return `=== TELEGRAM PHOTO from ${sanitizeForPtyInjection(from)}${tokenPart(token)} (chat_id:${chatId}) ===
caption:
${wrapFenceSafe(caption)}
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    token?: string,
  ): string {
    return `=== TELEGRAM DOCUMENT from ${sanitizeForPtyInjection(from)}${tokenPart(token)} (chat_id:${chatId}) ===
caption:
${wrapFenceSafe(caption)}
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   *
   * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
   * and the GGML model are available; otherwise it stays undefined and the
   * agent receives only the .ogg path. The codex extractor surfaces the
   * transcript block when present.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
    transcript?: string,
    token?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    const transcriptBlock = transcript && transcript.trim()
      ? `transcript:\n${wrapFenceSafe(transcript.trim())}\n`
      : '';
    return `=== TELEGRAM VOICE from ${sanitizeForPtyInjection(from)}${tokenPart(token)} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    duration: number | undefined,
    token?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${sanitizeForPtyInjection(from)}${tokenPart(token)} (chat_id:${chatId}) ===
caption:
${wrapFenceSafe(caption)}
duration: ${dur}s
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return true;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
    return false;
  }

  /** Close the current unanswered-turn window. */
  private resetAckTurn(): void {
    this.ackTurnStartedAt = 0;
    this.ackTurnMessageCount = 0;
    this.ackSentForTurn = false;
    this.ackTurnQueuedBehindWork = false;
  }

  /**
   * How long an unanswered Telegram turn may run before it is acknowledged.
   * `TELEGRAM_SLOW_ACK_MS=0` disables the ack entirely (the kill switch —
   * no redeploy, just an env change and a restart).
   *
   * 45s by default. Chosen so an ordinary reply NEVER triggers one: the
   * complaint being fixed is a seventeen-minute silence, not a five-second
   * one, and an ack on every request would just be a second notification for
   * Scott to ignore.
   */
  private slowAckDelayMs(): number {
    const raw = process.env.TELEGRAM_SLOW_ACK_MS;
    if (raw === undefined || raw.trim() === '') return 45_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 45_000;
    return n;
  }

  /**
   * Tell the human the message landed, when the turn is running long enough
   * that silence would otherwise read as an outage.
   *
   * Deliberately sent with `telegramApi.sendMessage` and NOT logged via
   * `logOutboundMessage`. That asymmetry is load-bearing, not an oversight:
   * `outbound-messages.jsonl` is the ONLY evidence `isAgentActive()` and
   * `reply_sla_audit.py` accept for "this message was answered". Logging the
   * ack there would clear the typing state, delete the durable pending record,
   * and book a reply Scott never received — manufacturing a spotless delivery
   * record for exactly the windows he sat repeating himself into a void. An
   * ack is proof of receipt; it is not an answer, and nothing downstream may
   * mistake it for one.
   */
  private async maybeSendSlowTurnAck(api: TelegramAPI, chatId: string): Promise<void> {
    if (this.ackSentForTurn || this.ackTurnStartedAt === 0) return;
    const delay = this.slowAckDelayMs();
    if (delay === 0) return;
    if (Date.now() - this.ackTurnStartedAt < delay) return;

    // Set the flag BEFORE awaiting the send. pollCycle runs every ~1s and the
    // send can take seconds (it now retries), so a flag set afterwards would
    // let several cycles queue duplicate acks for one turn.
    this.ackSentForTurn = true;

    const n = this.ackTurnMessageCount;
    const subject = n > 1 ? `all ${n}` : 'it';
    const waited = Math.round((Date.now() - this.ackTurnStartedAt) / 1000);

    // Say only what this timer actually knows. It knows the message arrived and
    // that no reply has been logged for `waited` seconds. It does NOT know that
    // anyone has read the message, and when the soft prompt gate fired it knows
    // the opposite — so claiming progress ("still working") is a lie the ack is
    // not entitled to tell. Scott has to be able to trust that a JARVIS status
    // line reflects a real state; an automatic message that sounds like a person
    // reporting progress is worse than silence, because it buys the silence time.
    const text = this.ackTurnQueuedBehindWork
      ? `Received ${subject} (${waited}s ago) — automatic receipt, not an answer. ` +
        `The session was mid-turn on other work, so this is queued behind it and ` +
        `hasn't been read yet. The reply lands here when it's done.`
      : `Received ${subject} (${waited}s ago) — automatic receipt, not an answer. ` +
        `The turn is running long. The reply lands here when it's done.`;
    try {
      await api.sendMessage(chatId, text);
      this.log(`Slow-turn ack sent after ${Math.round((Date.now() - this.ackTurnStartedAt) / 1000)}s (${n} message(s) pending)`);
    } catch (err) {
      // Never let the ack break the cycle. It is a courtesy; the real reply
      // still has every other path. Logged, though — a silently failing ack
      // would recreate the invisibility this whole change exists to remove.
      this.log(`Slow-turn ack FAILED: ${err instanceof Error ? err.message : String(err)}`);
      this.ackSentForTurn = false; // let the next cycle try again
    }
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir: string, chatId: string | number): string | null {
    const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
        return;
      }
    }

    // OS-02 bound callback: apprb_<32 hex ref>. The reference is opaque and
    // single-use; everything it authorizes is checked server-side.
    const boundMatch = data.match(/^apprb_([a-f0-9]{32})$/);
    if (boundMatch) {
      await this.routeBoundApprovalCallback(boundMatch[1], query, activityApi);
      return;
    }

    // Legacy unbound callback: appr_(allow|deny)_<approval_id>. These carry the
    // approval id in the clear and prove nothing about version, payload, bot,
    // chat or decider, so they can no longer authorize anything. They are
    // rejected with an explanation rather than silently ignored, because a
    // button that does nothing and says nothing is how a decision gets lost.
    if (/^appr_(allow|deny)_/.test(data)) {
      this.log(`activity-channel callback REJECTED (legacy unbound button): ${data.slice(0, 60)}`);
      try {
        await activityApi.answerCallbackQuery(
          callbackQueryId,
          'This button predates approval binding and can no longer authorize. Open the current request.',
        );
      } catch { /* ignore */ }
      return;
    }

    this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
    try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
  }

  /**
   * Resolve one BOUND approval callback (OS-02).
   *
   * The button carries only an opaque reference. Everything that decides
   * whether it may authorize — the approval's current version and payload
   * hash, which bot posted it, which chat it was posted in, who is allowed to
   * click it, whether it expired, whether it was already used — is verified
   * server-side against the approval authority and consumed in the same locked
   * step. A duplicate click therefore records ONE decision, and a forwarded,
   * replayed, expired or stale button records none.
   *
   * A rejection is never silent. The person gets the reason and, where the
   * request still exists, the CURRENT request re-rendered, so a stale button
   * turns into an informed decision instead of a dead end.
   */
  private async routeBoundApprovalCallback(
    ref: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const callbackQueryId = query.id;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;

    if (!isValidRef(ref)) {
      if (api) { try { await api.answerCallbackQuery(callbackQueryId, 'Invalid button'); } catch { /* ignore */ } }
      return;
    }

    // Peek (non-consuming) at the binding purely to learn which decision
    // this specific button requests — decideApproval() does the actual
    // consume-and-verify under its own lock. If the ref is unknown/garbage,
    // decision here is a placeholder: decideApproval's own consumeBinding
    // call rejects with 'unknown_ref' before this value is ever compared.
    const peeked = readBinding(this.paths, ref);
    const decision: 'approved' | 'rejected' = peeked?.action === 'allow' ? 'approved' : 'rejected';

    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);

    const result = decideApproval(
      this.paths,
      peeked?.approval_id ?? '',
      decision,
      String(query.from?.id ?? 'unknown'),
      {
        route: 'telegram',
        bindingRef: ref,
        presented: {
          decider: query.from?.id ?? 'unknown',
          botIdentity: api?.botId ?? 'unknown-bot',
          chatId: chatId ?? '',
        },
      },
      `via Telegram by ${auditWho}`,
    );

    if (!result.ok) {
      const rejection = result.rejection ?? 'unknown_ref';
      this.log(`Approval callback REJECTED (${rejection}) ref=${ref.slice(0, 8)}… : ${result.detail ?? ''}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, this.rejectionMessage(rejection)); } catch { /* ignore */ }
        // Re-render the request as it stands now, so the person can act on the
        // real thing instead of guessing what changed.
        const current = result.current ?? (peeked ? readApproval(this.paths, peeked.approval_id) : null);
        if (chatId && messageId && current) {
          const body = [
            `⚠️ ${this.rejectionMessage(rejection)}`,
            '',
            `Current request: ${current.title}`,
            `Category: ${current.category} · Status: ${current.status}`,
            current.description ? '' : undefined,
            current.description || undefined,
            '',
            `id: ${current.id}`,
          ].filter((l) => l !== undefined).join('\n');
          try { await api.editMessageText(chatId, messageId, body); } catch { /* ignore */ }
        }
      }
      return;
    }

    const status = result.status!;
    const approvalId = result.current!.id;

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, status === 'approved' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = status === 'approved' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    // The decision is recorded. Execution is a SEPARATE event with its own
    // intent and provider receipt — no external effect happens here.
    this.log(`Approval decision recorded: ${status} for ${approvalId} by ${auditWho} (execution pending its own intent)`);
  }

  /** Plain-language reason a bound button was refused. */
  private rejectionMessage(rejection: BindingRejection | 'missing_actor' | 'missing_binding' | 'approval_locked'): string {
    switch (rejection) {
      case 'already_consumed': return 'This decision was already recorded.';
      case 'expired': return 'This approval button has expired. Open the current request.';
      case 'wrong_decider': return 'This button was issued to a different person.';
      case 'wrong_bot': return 'This button belongs to a different bot.';
      case 'wrong_chat': return 'A forwarded approval button cannot authorize anything.';
      case 'version_changed':
      case 'payload_changed': return 'The request changed since this button was posted, so it no longer applies.';
      case 'action_spec_changed': return 'The underlying action changed since this button was posted, even though the text did not. Open the current request.';
      case 'approval_resolved': return 'This request has already been decided.';
      case 'approval_missing': return 'The request this button refers to no longer exists.';
      case 'approval_locked': return 'This request is being decided right now. Try again in a moment.';
      default: return 'This approval button is not valid.';
    }
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const boundMatch = data.match(/^apprb_([a-f0-9]{32})$/);
    if (boundMatch) {
      await this.routeBoundApprovalCallback(boundMatch[1], query, this.telegramApi);
      return;
    }
    if (/^appr_(allow|deny)_/.test(data)) {
      this.log(`approval callback REJECTED (legacy unbound button): ${data.slice(0, 60)}`);
      if (this.telegramApi) {
        try {
          await this.telegramApi.answerCallbackQuery(
            callbackQueryId,
            'This button predates approval binding and can no longer authorize. Open the current request.',
          );
        } catch { /* ignore */ }
      }
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // [UHS MOD] Overnight task approval callbacks: route to JARVIS telegram_callbacks.py.
    // Must run BEFORE upstream's generic inject-to-agent handler so ovnt_ callbacks
    // reach the JARVIS overnight pipeline rather than being injected to the agent PTY.
    if (data.startsWith('ovnt_')) {
      this.log(`Routing overnight callback to JARVIS: ${data}`);
      const { execFile } = await import('child_process');
      const jarvisRoot = '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS';
      const scriptPath = join(jarvisRoot, 'scripts', 'telegram_callbacks.py');
      execFile('python3', [scriptPath, '--handle-callback', callbackQueryId, data], {
        cwd: jarvisRoot,
        timeout: 30000,
      }, (err, stdout, stderr) => {
        if (err) {
          this.log(`Overnight callback error: ${err.message} ${stderr}`);
        } else {
          this.log(`Overnight callback handled: ${stdout.trim()}`);
        }
      });
      return;
    }

    // [UHS MOD #10] Trillion report buttons are action shortcuts, not browser
    // links. Convert the native Telegram callback payload into the same plain
    // command Scott used before buttons existed, then inject it through the
    // normal Telegram message path so existing approval handling still applies.
    const trillionMatch = data.match(/^trillion_(fix|skip|run)_(\d+)$/);
    if (trillionMatch && chatId && this.agent) {
      const [, action, id] = trillionMatch;
      const command = action === 'fix'
        ? `yes fix ${id}`
        : action === 'run'
          ? `yes run ${id}`
          : `skip ${id}`;
      const senderName = sanitizeForPtyInjection(query.from?.first_name || 'User');
      const safeCommand = sanitizeForPtyInjection(command);
      const msg = [
        `=== TELEGRAM from [USER: ${senderName}] (chat_id:${chatId}) ===`,
        safeCommand,
        `Reply using: cortextos bus send-telegram ${chatId} '<your reply>'`,
      ].join('\n');
      const injected = this.agent.injectMessage(msg);
      if (injected && this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Received'); } catch { /* ignore */ }
      }
      this.log(`Trillion report callback routed as command: ${command}`);
      return;
    }

    if (data === 'trillion_report_more') {
      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Open the HTML report for the remaining items'); } catch { /* ignore */ }
      }
      this.log('Trillion report overflow callback acknowledged');
      return;
    }

    // Inject unhandled callbacks as a Telegram message so the agent can process custom button flows.
    // senderName (Telegram first_name) and callback_data are untrusted: sanitize both against
    // PTY-injection before interpolating, matching the text path (sanitizeForPtyInjection at the
    // `=== TELEGRAM from [USER: ...]` header). This block predates #592; #592's hardening was never
    // retrofitted here, leaving forged `=== AGENT MESSAGE`/fence-breakout headers un-neutralized.
    if (chatId && this.agent) {
      const senderName = sanitizeForPtyInjection(query.from?.first_name || 'User');
      const safeData = sanitizeForPtyInjection(data);
      // T005: thread reply context from the button's parent message so the agent
      // knows what it's responding to without a separate registry lookup.
      const originalText = query.message?.text || query.message?.caption;
      const replyCx = originalText
        ? `[Replying to: "${sanitizeForPtyInjection(originalText.slice(0, 200))}"]\n`
        : '';
      const msg = [
        `=== TELEGRAM from [USER: ${senderName}] (chat_id:${chatId}) ===`,
        `${replyCx}callback_data: ${safeData}`,
        `message_id: ${messageId}`,
        `Reply using: cortextos bus send-telegram ${chatId} '<your reply>'`,
      ].join('\n');
      const injected = this.agent.injectMessage(msg);
      if (injected && this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
      }
      this.log(`Injected unhandled callback to agent: ${data.slice(0, 60)}`);
    } else {
      this.log(`Unhandled callback data (no agent/chatId): ${data}`);
    }
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message — fence the body unescapably (#592 follow-up)
        // so a signal payload carrying its own fence can't break out and forge
        // daemon containment headers.
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n${wrapFenceSafe(content)}\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   */
  private getCtxThresholds(): { warn: number; handoff: number } {
    try {
      const configPath = join(this.agent.getAgentDir(), 'config.json');
      const mtime = statSync(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        const config = this.agent.getConfig();
        config.ctx_warning_threshold = cfg.ctx_warning_threshold;
        config.ctx_handoff_threshold = cfg.ctx_handoff_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch { /* keep stale values */ }
    const config = this.agent.getConfig();
    return {
      warn: config.ctx_warning_threshold ?? 70,
      handoff: config.ctx_handoff_threshold ?? 80,
    };
  }

  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  private async checkContextStatus(): Promise<void> {
    const now = Date.now();

    // Circuit breaker: check if we should pause auto-restarts
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 60_000) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.saveCtxCircuit();
        this.log('Context circuit breaker reset after 30min pause');
      } else {
        return; // still paused
      }
    }

    // Read the bridge file written by hook-context-status
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return;

    let pct: number | null = null;
    let exceeds200k = false;
    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const data = JSON.parse(raw);
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 60_000) return; // stale file — skip
      pct = typeof data.used_percentage === 'number' ? data.used_percentage : null;
      exceeds200k = Boolean(data.exceeds_200k_tokens);

      // Detect new session: if session_id changed, clear stale per-session ctx state.
      // This handles the case where the agent self-restarts (voluntary handoff) and the
      // 5-min deadline timer would otherwise fire on the fresh low-context session.
      const incomingSessionId = typeof data.session_id === 'string' ? data.session_id : null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}…) — per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
      }
    } catch { return; }

    // Check PTY output for hard API overflow errors (always act regardless of threshold config)
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8000) ?? '';
    if (/extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log('Context overflow error detected in PTY output — force restarting');
      this.forceContextRestart('API overflow error in PTY output');
      return;
    }

    const { warn, handoff } = this.getCtxThresholds();

    // No threshold configured — observe-only mode (log but don't act)
    if (this.agent.getConfig().ctx_handoff_threshold === undefined) return;

    const effectivePct = pct ?? (exceeds200k ? 101 : null);
    if (effectivePct === null) return;

    // Tier 3: deadline exceeded — force restart if agent ignored handoff prompt
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) — force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% — handoff not completed within 5min`);
      return;
    }

    // Tier 1: warning — PTY injection only, no Telegram ping (context management is internal)
    if (effectivePct >= warn && now - this.ctxWarningFiredAt > 15 * 60_000) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? 'Handoff in progress.' : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }

    // Tier 2: handoff (fires once per session lifecycle)
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0) {
      this.ctxHandoffFiredAt = now;
      this.ctxHandoffDeadlineAt = now + 5 * 60_000; // 5min grace for agent to cooperate
      // Reset context_status.json so the new session doesn't re-trigger immediately
      const statusPath = join(this.paths.stateDir, 'context_status.json');
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. Write a handoff document to memory/handoffs/handoff-${ts}.md with these sections: ## Current Tasks, ## Next Actions, ## Active Crons, ## Key Context, ## Files Modified This Session. Then run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      // Pre-arm .force-fresh so the next restart is always a clean fresh session.
      // If the agent cooperates and calls hard-restart, it also writes .force-fresh — no-op.
      // If context exhausts naturally before the agent acts, .force-fresh is already set,
      // preventing a --continue restart that would loop at the same high context level.
      try {
        writeFileSync(join(this.paths.stateDir, '.force-fresh'), '');
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  private forceContextRestart(reason: string): void {
    const now = Date.now();

    // Update and check circuit breaker window (persisted to disk — survives --continue restarts)
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter(t => now - t < 15 * 60_000);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();

    // If the agent wrote a handoff doc in the last 15 minutes but didn't get to call
    // hard-restart --handoff-doc (e.g. Tier 3 force-restart cut it short), pick it up
    // so the new session still receives handoff context.
    try {
      const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
      if (existsSync(handoffsDir)) {
        const cutoff = now - 15 * 60_000;
        const recent = readdirSync(handoffsDir)
          .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
          .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
          .filter(({ mtime }) => mtime >= cutoff)
          .sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 0) {
          const docPath = join(handoffsDir, recent[0].f);
          const markerPath = join(this.paths.stateDir, '.handoff-doc-path');
          writeFileSync(markerPath, docPath, 'utf-8');
          this.log(`Tier 3 restart: found recent handoff doc, writing marker → ${docPath}`);
        }
      }
    } catch { /* non-fatal — proceed without handoff context */ }

    // Reset per-session context state for the new session
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;

    // Write .force-fresh + .restart-planned (hardRestart from src/bus/system.ts)
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);

    // Reset context_status.json so the new session's FastChecker doesn't re-trigger
    // Tier 2 immediately by reading the stale high-% value from the previous session.
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    try {
      writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    // sessionRefresh() does stop() + start(); shouldContinue() will return false
    // because .force-fresh was just written, giving us a clean fresh session.
    this.agent.sessionRefresh().catch(err => this.log(`Context restart failed: ${err}`));
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  private loadCtxCircuit(): void {
    try {
      if (!existsSync(this.ctxCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.ctxCircuitFile, 'utf-8'));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /**
   * Persist circuit breaker state to disk after every update.
   */
  private saveCtxCircuit(): void {
    try {
      writeFileSync(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        brokenAt: this.ctxCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) {
      // Turn abandoned rather than answered. Close it so the NEXT message
      // opens a fresh one and can still be acknowledged; leaving it open would
      // mark the next slow turn as already-acked.
      this.resetAckTurn();
      return false;
    }

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          this.resetAckTurn();
          return false;
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ` ⟦u:<id>⟧` in a header line (A1). Placed BEFORE `(chat_id:…)` on purpose:
 * A0's reply-evidence stripper matches `=== TELEGRAM from … (chat_id:<id>) ===`
 * with a lazy wildcard in front of `(chat_id:`, so a block written by this code
 * is still stripped if the daemon is rolled back to A0.
 */
function tokenPart(token?: string): string {
  return token ? ` ${token}` : '';
}

/** R4-5 cadence: at most one transcript scan (and one PTY token read per record) per 5 s. */
const PROOF_SCAN_MIN_INTERVAL_MS = 5_000;
/** A6 stage-2 follow-up: "received, no reply observed yet". */
const ACK_FOLLOWUP_MS = 10 * 60_000;

/** Upper bound on the boot-window hold (TELEGRAM_BOOT_HOLD_MAX_MS; default 10 min). */
export function bootHoldMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.TELEGRAM_BOOT_HOLD_MAX_MS ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10 * 60_000;
}

/** The note on a caption whose attachment failed for good (A3). */
function mediaFailedNote(rec: Pick<PendingTelegramRecord, 'media_type' | 'from'>): string {
  return `(a ${mediaNoun(rec.media_type)} came with this but failed to download — ask ${rec.from} to resend it)`;
}

function telegramTokenLabel(rec: PendingTelegramRecord): string {
  return rec.token ?? `update ${rec.update_id}`;
}

/**
 * A daemon-side media job (A3). Started by FastChecker.startMediaJob; must end
 * in completeMediaDownload or failMediaDownload for the same generation.
 */
export interface MediaDownloader {
  start(rec: PendingTelegramRecord, gen: number): void;
}
