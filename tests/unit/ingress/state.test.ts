/** OS-07 — per-bot poller lock: one poller per bot, ever. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveIngressPaths,
  acquirePollerLock,
  releasePollerLock,
  readPollerLock,
  renewPollerLock,
  PollerLockHeldError,
  validateBotId,
  LOCK_TTL_MS,
  type IngressPaths,
} from '../../../src/ingress/state.js';

let root: string;
let paths: IngressPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os07-lock-'));
  paths = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('OS-07 per-bot poller lock', () => {
  it('refuses a second holder for the same bot', () => {
    acquirePollerLock(paths, 'vera', 'ingress:vera');
    expect(() => acquirePollerLock(paths, 'vera', 'agent:vera')).toThrow(PollerLockHeldError);
  });

  it('locks are per bot, so one bot never blocks another', () => {
    acquirePollerLock(paths, 'vera', 'ingress:vera');
    expect(() => acquirePollerLock(paths, 'vivienne', 'ingress:vivienne')).not.toThrow();
  });

  it('releases only for the holder', () => {
    acquirePollerLock(paths, 'vera', 'ingress:vera');
    releasePollerLock(paths, 'vera', 'someone-else');
    expect(readPollerLock(paths, 'vera')).not.toBeNull();
    releasePollerLock(paths, 'vera', 'ingress:vera');
    expect(readPollerLock(paths, 'vera')).toBeNull();
  });

  it('breaks a lock whose holder process is gone', () => {
    const past = () => new Date(Date.now() - LOCK_TTL_MS * 2);
    acquirePollerLock(paths, 'vera', 'dead-daemon', { now: past });
    // Same pid but long expired — the TTL breaker applies.
    const taken = acquirePollerLock(paths, 'vera', 'ingress:vera');
    expect(taken.owner).toBe('ingress:vera');
  });

  it('renew extends only the current holder', () => {
    acquirePollerLock(paths, 'vera', 'ingress:vera');
    expect(renewPollerLock(paths, 'vera', 'ingress:vera')).toBe(true);
    expect(renewPollerLock(paths, 'vera', 'impostor')).toBe(false);
  });

  it('rejects a bot id that would escape the ingress directory', () => {
    expect(() => validateBotId('../../etc/passwd')).toThrow(/Invalid bot identity/);
    expect(() => validateBotId('jarvis-telegram')).not.toThrow();
  });
});
