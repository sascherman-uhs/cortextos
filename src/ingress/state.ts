/**
 * OS-07 — durable ingress state.
 *
 * Everything the multiplexed ingress must survive a crash with lives under
 * `CTX_ROOT/orgs/<org>/ingress/`. This module owns the paths and the small
 * atomic read/write helpers; the behavioural modules (fence, outbox, service,
 * dispatch) sit on top and never build a path by hand.
 *
 * Layout:
 *
 *   ingress/
 *     flags.json              per-bot multiplex flag (default OFF)
 *     routing.json            person -> role routing overrides (optional)
 *     fences/<bot>.json       ownership fence + checkpoint for one bot identity
 *     offsets/<bot>.json      ingress-owned getUpdates checkpoint
 *     inbox/<bot>/<id>.json   an inbound update, persisted BEFORE the offset moves
 *     outbox/<id>.json        a reply, persisted BEFORE it is sent
 *     effects/<key>.claim     an external effect that has been started
 *     effects/<key>.done      an external effect that completed
 *     locks/<bot>.lock        per-bot poller lock (one poller, ever)
 *     dispatch/queue/<id>.json, dispatch/cursor.json, dispatch/events.jsonl
 *
 * Nothing in here ever stores a bot token. A bot identity is referenced by the
 * NAME of the env key that holds its token, never by its value.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
  openSync,
  closeSync,
  writeSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export const DEFAULT_ORG = 'uhs';

export interface IngressContext {
  /** Runtime root. Defaults to CTX_ROOT, else ~/.cortextos/<instance>. */
  ctxRoot?: string;
  org?: string;
  instanceId?: string;
  /** Injectable clock — tests freeze it. */
  now?: () => Date;
}

export interface IngressPaths {
  ctxRoot: string;
  org: string;
  root: string;
  flagsPath: string;
  routingPath: string;
  fencesDir: string;
  offsetsDir: string;
  inboxDir: string;
  outboxDir: string;
  effectsDir: string;
  locksDir: string;
  dispatchDir: string;
  dispatchQueueDir: string;
  dispatchCursorPath: string;
  dispatchEventsPath: string;
}

/**
 * A bot identity id is used as a filename. Keep it to the same character class
 * agent names use so a hostile config cannot escape the ingress directory.
 */
export function validateBotId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`Invalid bot identity id: ${JSON.stringify(id)} (expected [A-Za-z0-9_-], 1-64 chars)`);
  }
  return id;
}

export function resolveIngressPaths(ctx: IngressContext = {}): IngressPaths {
  const instanceId = ctx.instanceId || process.env.CTX_INSTANCE_ID || 'default';
  const ctxRoot = ctx.ctxRoot || process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId);
  const org = ctx.org || process.env.CTX_ORG || DEFAULT_ORG;
  const root = join(ctxRoot, 'orgs', org, 'ingress');
  const dispatchDir = join(root, 'dispatch');
  return {
    ctxRoot,
    org,
    root,
    flagsPath: join(root, 'flags.json'),
    routingPath: join(root, 'routing.json'),
    fencesDir: join(root, 'fences'),
    offsetsDir: join(root, 'offsets'),
    inboxDir: join(root, 'inbox'),
    outboxDir: join(root, 'outbox'),
    effectsDir: join(root, 'effects'),
    locksDir: join(root, 'locks'),
    dispatchDir,
    dispatchQueueDir: join(dispatchDir, 'queue'),
    dispatchCursorPath: join(dispatchDir, 'cursor.json'),
    dispatchEventsPath: join(dispatchDir, 'events.jsonl'),
  };
}

export function nowIso(ctx: IngressContext = {}): string {
  return (ctx.now ? ctx.now() : new Date()).toISOString();
}

export function nowMs(ctx: IngressContext = {}): number {
  return (ctx.now ? ctx.now() : new Date()).getTime();
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  atomicWriteSync(path, JSON.stringify(value, null, 2));
}

export function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

export function appendJsonl(path: string, record: unknown): void {
  ensureDir(join(path, '..'));
  try {
    appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    /* journal is best-effort observability; never block the durable write */
  }
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((v): v is T => v !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-bot poller lock
// ---------------------------------------------------------------------------

export interface PollerLock {
  bot: string;
  owner: string;
  pid: number;
  acquired_at: string;
  expires_at: string;
}

/** A lock older than this is presumed abandoned by a crashed daemon. */
export const LOCK_TTL_MS = 2 * 60 * 1000;

export class PollerLockHeldError extends Error {
  constructor(public readonly holder: PollerLock) {
    super(
      `Telegram poller lock for ${holder.bot} is held by ${holder.owner} ` +
      `(pid ${holder.pid}, expires ${holder.expires_at}). Refusing to start a second poller.`,
    );
    this.name = 'PollerLockHeldError';
  }
}

function lockPath(paths: IngressPaths, bot: string): string {
  return join(paths.locksDir, `${validateBotId(bot)}.lock`);
}

function lockIsLive(lock: PollerLock | null, atMs: number): boolean {
  if (!lock) return false;
  const expires = Date.parse(lock.expires_at);
  if (Number.isNaN(expires)) return false;
  if (expires <= atMs) return false;
  // Same-process re-entry is a bug, not a liveness question: report it live.
  if (lock.pid === process.pid) return true;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    // Holder is gone. The lock is dead even if its TTL has not expired.
    return false;
  }
}

/**
 * Acquire the exclusive poll lock for one bot identity.
 *
 * O_EXCL create, so two daemons racing cannot both win. A lock whose holder
 * process is gone, or whose TTL has passed, is broken and re-taken — the
 * failure this guards is "two pollers on one bot", not "a stale file forever".
 */
export function acquirePollerLock(
  paths: IngressPaths,
  bot: string,
  owner: string,
  ctx: IngressContext = {},
): PollerLock {
  validateBotId(bot);
  ensureDir(paths.locksDir);
  const path = lockPath(paths, bot);
  const at = nowMs(ctx);
  const lock: PollerLock = {
    bot,
    owner,
    pid: process.pid,
    acquired_at: new Date(at).toISOString(),
    expires_at: new Date(at + LOCK_TTL_MS).toISOString(),
  };
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, JSON.stringify(lock, null, 2));
    closeSync(fd);
    return lock;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const existing = readJson<PollerLock>(path);
  if (lockIsLive(existing, at)) throw new PollerLockHeldError(existing!);
  // Dead or expired — break it and take over.
  writeJson(path, lock);
  return lock;
}

/** Extend a held lock. Returns false if someone else now owns it. */
export function renewPollerLock(
  paths: IngressPaths,
  bot: string,
  owner: string,
  ctx: IngressContext = {},
): boolean {
  const path = lockPath(paths, bot);
  const existing = readJson<PollerLock>(path);
  if (!existing || existing.owner !== owner || existing.pid !== process.pid) return false;
  const at = nowMs(ctx);
  writeJson(path, { ...existing, expires_at: new Date(at + LOCK_TTL_MS).toISOString() });
  return true;
}

export function releasePollerLock(paths: IngressPaths, bot: string, owner: string): void {
  const path = lockPath(paths, bot);
  const existing = readJson<PollerLock>(path);
  if (!existing) return;
  if (existing.owner !== owner || existing.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* best effort */
  }
}

export function readPollerLock(paths: IngressPaths, bot: string): PollerLock | null {
  return readJson<PollerLock>(lockPath(paths, bot));
}

// ---------------------------------------------------------------------------
// Exactly-once external effects
// ---------------------------------------------------------------------------

export type EffectState = 'none' | 'claimed' | 'done';

export interface EffectRecord {
  key: string;
  claimed_at: string;
  completed_at?: string;
  result_ref?: string;
  /** Set when a claim was found without a completion after a crash. */
  ambiguous?: boolean;
}

function effectPath(paths: IngressPaths, key: string, kind: 'claim' | 'done'): string {
  // Effect keys are caller-supplied (dedupe keys). Hash-safe them into a
  // single path segment rather than trusting the caller's character set.
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
  return join(paths.effectsDir, `${safe}.${kind}`);
}

export function effectState(paths: IngressPaths, key: string): EffectState {
  if (existsSync(effectPath(paths, key, 'done'))) return 'done';
  if (existsSync(effectPath(paths, key, 'claim'))) return 'claimed';
  return 'none';
}

/**
 * Run `fn` at most once for `key`, and — when the crash happened before any
 * claim was written — exactly once on replay.
 *
 * - `done` already on disk: skip, return the recorded result ref. This is the
 *   replay case the plan asks for: one accepted instruction, one effect.
 * - `claim` on disk without `done`: the previous attempt died mid-flight. We
 *   do NOT silently repeat an external action. The effect is reported
 *   `ambiguous` so reconciliation surfaces it instead of double-drafting,
 *   double-posting or double-sending.
 * - nothing on disk: claim, run, complete.
 */
export async function runExactlyOnce<T>(
  paths: IngressPaths,
  key: string,
  fn: () => Promise<T> | T,
  ctx: IngressContext = {},
): Promise<{ status: 'executed' | 'skipped' | 'ambiguous'; value?: T }> {
  ensureDir(paths.effectsDir);
  const donePath = effectPath(paths, key, 'done');
  const claimPath = effectPath(paths, key, 'claim');
  if (existsSync(donePath)) return { status: 'skipped' };
  if (existsSync(claimPath)) return { status: 'ambiguous' };
  try {
    const fd = openSync(claimPath, 'wx', 0o600);
    writeSync(fd, JSON.stringify({ key, claimed_at: nowIso(ctx) }));
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'ambiguous' };
    throw err;
  }
  const value = await fn();
  writeJson(donePath, { key, claimed_at: nowIso(ctx), completed_at: nowIso(ctx) } satisfies EffectRecord);
  return { status: 'executed', value };
}

/** Claims with no completion, oldest first — what reconciliation must resolve. */
export function listAmbiguousEffects(paths: IngressPaths, olderThanMs = 0, ctx: IngressContext = {}): string[] {
  if (!existsSync(paths.effectsDir)) return [];
  const cutoff = nowMs(ctx) - olderThanMs;
  const out: string[] = [];
  for (const f of readdirSync(paths.effectsDir)) {
    if (!f.endsWith('.claim')) continue;
    const base = f.slice(0, -'.claim'.length);
    if (existsSync(join(paths.effectsDir, `${base}.done`))) continue;
    try {
      if (statSync(join(paths.effectsDir, f)).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    out.push(base);
  }
  return out.sort();
}
