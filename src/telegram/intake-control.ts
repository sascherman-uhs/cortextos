/**
 * Telegram intake pause + outstanding-media-job accounting.
 *
 * Why this exists (2026-09-30). The media-race fix (A0) changes what a raw
 * media record on disk means: code before it treats `formatted === ''` as
 * "the daemon died", code after it treats it as "a download is in flight".
 * Rolling the daemon back while a download is in flight would therefore
 * re-create the exact silent drop the fix closed. So a rollback must first
 * stop taking new messages, then wait until nothing is mid-download, and give
 * up (leaving the running daemon untouched) if that never happens.
 *
 * Two halves:
 *   1. The daemon side (TelegramIntakeControl): the agent's poller honours
 *      `state/<agent>/telegram-intake-paused` — it finishes its current
 *      getUpdates batch and then stops polling. Downloads, the checker and
 *      injection keep running. A counter of outstanding media jobs is kept
 *      in memory. Both are published ATOMICALLY in one status file tied to
 *      this daemon instance (pid + process start time).
 *   2. The operator side (evaluateDrain / runRollbackDrain, driven by
 *      scripts/telegram-media-rollback.ts): create the pause file, wait for
 *      the ack, wait for zero unfinished media records AND zero outstanding
 *      jobs, else abort and remove the pause file.
 *
 * A missing, unparsable, stale or foreign (other pid / other start time)
 * status file is NEVER read as "drained".
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync } from '../utils/atomic.js';
import { PendingTelegramQueue } from './pending-queue.js';

export const INTAKE_PAUSE_FILE = 'telegram-intake-paused';
export const INTAKE_STATUS_FILE = 'telegram-intake-status.json';
/** Status heartbeat cadence while the poll loop is alive. */
export const INTAKE_STATUS_HEARTBEAT_MS = 2_000;
/** A status older than this is stale: the poll loop that writes it is not running. */
export const INTAKE_STATUS_MAX_AGE_MS = 15_000;
/** `ps -o lstart` has one-second resolution. */
const START_TIME_TOLERANCE_MS = 3_000;

export interface IntakeStatus {
  agent: string;
  pid: number;
  /** When this daemon process started (ISO). Ties the status to one instance. */
  daemon_started_at: string;
  intake: 'polling' | 'paused';
  /** When the poller observed the pause file and stopped polling (ISO). */
  pause_acked_at: string | null;
  /**
   * Media round trips (download/transcribe + completion patch) not yet
   * settled. Incremented when a job starts; decremented only after the
   * underlying work settled AND its completion patch was written or
   * discarded. Independent of record state on purpose: a caption injected on
   * grace expiry leaves a download running that no record shows.
   */
  outstanding_media_jobs: number;
  updated_at: string;
}

/** Daemon side. One per agent poller. */
export class TelegramIntakeControl {
  readonly stateDir: string;
  readonly agent: string;
  private pid: number;
  private startedAt: string;
  private now: () => number;
  private jobs = 0;
  private paused = false;
  private pauseAckedAt: string | null = null;
  private lastPublishedAt = 0;
  private log: (msg: string) => void;

  constructor(
    stateDir: string,
    agent: string,
    opts: { pid?: number; startedAtMs?: number; now?: () => number; log?: (msg: string) => void } = {},
  ) {
    this.stateDir = stateDir;
    this.agent = agent;
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? Date.now;
    this.startedAt = new Date(opts.startedAtMs ?? Date.now() - process.uptime() * 1000).toISOString();
    this.log = opts.log ?? (() => {});
  }

  get pausePath(): string {
    return join(this.stateDir, INTAKE_PAUSE_FILE);
  }

  get statusPath(): string {
    return join(this.stateDir, INTAKE_STATUS_FILE);
  }

  get outstandingMediaJobs(): number {
    return this.jobs;
  }

  isPauseRequested(): boolean {
    return existsSync(this.pausePath);
  }

  /**
   * Start a media job. Returns its settle function, which is idempotent — a
   * second call is a no-op, so a caller can never drive the count negative or
   * release another job's slot.
   */
  beginMediaJob(): () => void {
    this.jobs++;
    this.publish();
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.jobs--;
      this.publish();
    };
  }

  /**
   * Called by the poller BETWEEN getUpdates batches only, so `paused` is
   * never acknowledged while a batch is still being handled.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.pauseAckedAt = paused ? new Date(this.now()).toISOString() : null;
    this.log(paused ? 'Telegram intake PAUSED (pause file present) — not polling' : 'Telegram intake resumed');
    this.publish();
  }

  /** Heartbeat: republish so the status stays fresh while the poll loop lives. */
  tick(): void {
    if (this.now() - this.lastPublishedAt >= INTAKE_STATUS_HEARTBEAT_MS) this.publish();
  }

  snapshot(): IntakeStatus {
    return {
      agent: this.agent,
      pid: this.pid,
      daemon_started_at: this.startedAt,
      intake: this.paused ? 'paused' : 'polling',
      pause_acked_at: this.pauseAckedAt,
      outstanding_media_jobs: this.jobs,
      updated_at: new Date(this.now()).toISOString(),
    };
  }

  /** Pause ack and counter in ONE atomic write — never observable half-updated. */
  publish(): void {
    try {
      atomicWriteSync(this.statusPath, JSON.stringify(this.snapshot(), null, 2));
      this.lastPublishedAt = this.now();
    } catch (err) {
      // A status that fails to publish goes stale, which the drain reads as
      // NOT drained — the safe direction.
      this.log(`intake-control: status publish failed: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Operator side
// ---------------------------------------------------------------------------

export interface ProcessProbe {
  /** Is a process with this pid alive? */
  isAlive(pid: number): boolean;
  /** Its start time in ms, or null if it cannot be determined. */
  startedAtMs(pid: number): number | null;
}

export const systemProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startedAtMs(pid) {
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
      const ms = Date.parse(out);
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  },
};

export function readIntakeStatus(stateDir: string): IntakeStatus | null {
  try {
    const p = join(stateDir, INTAKE_STATUS_FILE);
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf-8')) as IntakeStatus;
    if (typeof s.pid !== 'number' || typeof s.outstanding_media_jobs !== 'number') return null;
    return s;
  } catch {
    return null;
  }
}

export interface DrainVerdict {
  drained: boolean;
  /** Why not — or 'drained'. Printed verbatim by the script. */
  reason: string;
  unfinishedMedia: number;
  outstandingJobs: number | null;
}

/**
 * Is it safe to stop this agent's daemon for a rollback? Every check fails
 * closed: anything unknown is NOT drained.
 */
export function evaluateDrain(opts: {
  stateDir: string;
  /** mtime (ms) of the pause file the ack must postdate. */
  pauseRequestedAtMs: number;
  now: number;
  probe: ProcessProbe;
  maxStatusAgeMs?: number;
}): DrainVerdict {
  const unfinished = new PendingTelegramQueue(join(opts.stateDir, 'pending-telegram')).unfinishedMedia().length;
  const s = readIntakeStatus(opts.stateDir);
  const verdict = (drained: boolean, reason: string): DrainVerdict => ({
    drained,
    reason,
    unfinishedMedia: unfinished,
    outstandingJobs: s ? s.outstanding_media_jobs : null,
  });
  if (!s) return verdict(false, 'no readable intake status file — daemon has not acknowledged anything');
  const updated = Date.parse(s.updated_at);
  const maxAge = opts.maxStatusAgeMs ?? INTAKE_STATUS_MAX_AGE_MS;
  if (Number.isNaN(updated) || opts.now - updated > maxAge) {
    return verdict(false, `intake status is stale (updated ${s.updated_at}) — the poll loop is not publishing`);
  }
  if (!opts.probe.isAlive(s.pid)) return verdict(false, `status pid ${s.pid} is not running`);
  const started = opts.probe.startedAtMs(s.pid);
  const claimed = Date.parse(s.daemon_started_at);
  if (started === null || Number.isNaN(claimed) || Math.abs(started - claimed) > START_TIME_TOLERANCE_MS) {
    return verdict(false, `status belongs to a different daemon instance (pid ${s.pid}, started ${s.daemon_started_at})`);
  }
  if (s.intake !== 'paused' || !s.pause_acked_at) return verdict(false, 'poller has not acknowledged the pause yet');
  const acked = Date.parse(s.pause_acked_at);
  if (Number.isNaN(acked) || acked + START_TIME_TOLERANCE_MS < opts.pauseRequestedAtMs) {
    return verdict(false, 'pause acknowledgement predates this pause request');
  }
  if (unfinished > 0) return verdict(false, `${unfinished} unfinished media record(s) in pending-telegram/`);
  if (s.outstanding_media_jobs !== 0) {
    return verdict(false, `${s.outstanding_media_jobs} media job(s) still running in the daemon`);
  }
  return verdict(true, 'drained');
}

export interface RollbackDrainResult {
  drained: boolean;
  reason: string;
  /** True when this run created the pause file (and so owns removing it on abort). */
  createdPause: boolean;
}

/**
 * Pause intake, then wait up to `timeoutMs` (2 x media grace) for a drain.
 * Drained => the pause file is LEFT in place (the daemon must not take new
 * messages before it is restarted). Not drained => ABORT: the pause file this
 * run created is removed so the running daemon resumes polling, untouched.
 */
export async function runRollbackDrain(opts: {
  stateDir: string;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: ProcessProbe;
  log?: (msg: string) => void;
  /** Checked each iteration; true => abort now (e.g. SIGINT). */
  aborted?: () => boolean;
}): Promise<RollbackDrainResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probe = opts.probe ?? systemProcessProbe;
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 2_000;
  const pausePath = join(opts.stateDir, INTAKE_PAUSE_FILE);

  const createdPause = !existsSync(pausePath);
  if (createdPause) {
    mkdirSync(opts.stateDir, { recursive: true });
    writeFileSync(pausePath, `paused for rollback at ${new Date(now()).toISOString()}\n`, 'utf-8');
    log(`Created ${pausePath}`);
  } else {
    log(`${pausePath} already existed — it will be left in place on abort`);
  }
  const requestedAt = createdPause ? now() : statSync(pausePath).mtimeMs;

  const abort = (reason: string): RollbackDrainResult => {
    if (createdPause) {
      try {
        unlinkSync(pausePath);
        log(`Removed ${pausePath} — the running daemon resumes polling`);
      } catch (err) {
        log(`FAILED to remove ${pausePath}: ${String(err)} — remove it by hand or intake stays paused`);
      }
    }
    return { drained: false, reason, createdPause };
  };

  const deadline = now() + opts.timeoutMs;
  let last: DrainVerdict | null = null;
  for (;;) {
    if (opts.aborted?.()) return abort('interrupted');
    last = evaluateDrain({ stateDir: opts.stateDir, pauseRequestedAtMs: requestedAt, now: now(), probe });
    if (last.drained) return { drained: true, reason: 'drained', createdPause };
    log(`not drained: ${last.reason}`);
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  return abort(`timed out after ${opts.timeoutMs} ms — last check: ${last?.reason ?? 'none'}`);
}
