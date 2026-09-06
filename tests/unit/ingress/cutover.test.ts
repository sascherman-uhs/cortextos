/**
 * OS-07 — fenced cutover.
 *
 * The scenarios from plan §11: "poller cutover/revert loses no updates and
 * duplicates no effect", and "old worker resumes after lease transfer —
 * fencing prevents late mutation".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIngressPaths, type IngressPaths } from '../../../src/ingress/state.js';
import { readFence, readOffset, writeOffset, assertFence, FenceConflictError } from '../../../src/ingress/fence.js';
import {
  enableMultiplexed,
  revertToAgent,
  isMultiplexed,
  agentPollerSuppressed,
  loadFlags,
  legacyOffsetPath,
} from '../../../src/ingress/cutover.js';

let root: string;
let paths: IngressPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os07-cutover-'));
  paths = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeLegacyOffset(agent: string, value: number): string {
  const dir = join(root, 'state', agent);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.telegram-offset');
  writeFileSync(file, String(value), 'utf-8');
  return file;
}

describe('OS-07 fenced cutover', () => {
  it('defaults every bot to its agent-owned poller with the flag OFF', () => {
    expect(isMultiplexed(paths, 'vera')).toBe(false);
    expect(agentPollerSuppressed(paths, 'vera')).toBe(false);
    expect(readFence(paths, 'vera').owner).toBe('agent');
    expect(loadFlags(paths).bots).toEqual({});
  });

  it('carries the legacy checkpoint across the transfer and never runs two pollers', async () => {
    const legacy = writeLegacyOffset('vera', 4102);
    const admittedDuringStop: boolean[] = [];

    const result = await enableMultiplexed(paths, 'vera', {
      legacyOffsetFile: legacy,
      actor: 'test',
      reason: 'ZZTEST-OS07 cutover',
      stopOldPoller: () => {
        // While the old poller is being stopped the fence is `transferring`,
        // so NEITHER side may admit. This is the "never two pollers" window.
        admittedDuringStop.push(agentPollerSuppressed(paths, 'vera'));
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checkpoint_offset).toBe(4102);
    expect(admittedDuringStop).toEqual([true]);
    expect(readFence(paths, 'vera').owner).toBe('ingress');
    expect(readOffset(paths, 'vera')).toBe(4102);
    expect(isMultiplexed(paths, 'vera')).toBe(true);
    expect(agentPollerSuppressed(paths, 'vera')).toBe(true);
  });

  it('reverts with the same checkpoint and a higher fence token', async () => {
    const legacy = writeLegacyOffset('vera', 10);
    await enableMultiplexed(paths, 'vera', { legacyOffsetFile: legacy });
    // Ingress consumed more updates while it owned the bot.
    writeOffset(paths, 'vera', 42);
    const afterEnable = readFence(paths, 'vera');

    const reverted = await revertToAgent(paths, 'vera', { legacyOffsetFile: legacy });
    expect(reverted.ok).toBe(true);
    // The checkpoint goes BACK with the bot — no update is re-read or skipped.
    expect(reverted.checkpoint_offset).toBe(42);
    expect(readOffset(paths, 'vera')).toBe(42);
    const fence = readFence(paths, 'vera');
    expect(fence.owner).toBe('agent');
    expect(fence.fence_token).toBeGreaterThan(afterEnable.fence_token);
    expect(isMultiplexed(paths, 'vera')).toBe(false);
    expect(agentPollerSuppressed(paths, 'vera')).toBe(false);
  });

  it('an offset never moves backwards across a transfer', async () => {
    const legacy = writeLegacyOffset('vera', 5);
    writeOffset(paths, 'vera', 900);
    const result = await enableMultiplexed(paths, 'vera', { legacyOffsetFile: legacy });
    expect(result.checkpoint_offset).toBe(900);
  });

  it('refuses a poller holding a fence token from before the transfer', async () => {
    const stale = readFence(paths, 'vera').fence_token;
    // The agent-side poller is valid right up to the transfer.
    expect(() => assertFence(paths, 'vera', 'agent', stale)).not.toThrow();
    await enableMultiplexed(paths, 'vera', {});
    // The same poller waking up afterwards is refused — no late offset write,
    // no late reply through a bot it no longer owns.
    expect(() => assertFence(paths, 'vera', 'agent', stale)).toThrow(FenceConflictError);
  });

  it('leaves a half-finished transfer visible instead of reporting success', async () => {
    // Simulate the first phase completing and the process dying: the fence is
    // left `transferring`, so nobody admits and a second attempt refuses.
    await enableMultiplexed(paths, 'vera', {
      stopOldPoller: () => {
        throw new Error('poller stop failed');
      },
    }).catch(() => undefined);
    const fence = readFence(paths, 'vera');
    expect(fence.state).toBe('transferring');
    expect(agentPollerSuppressed(paths, 'vera')).toBe(true);

    const second = await enableMultiplexed(paths, 'vera', {});
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already in flight/);
  });

  it('derives the legacy offset path from the runtime root', () => {
    expect(legacyOffsetPath(paths, 'vera')).toBe(join(root, 'state', 'vera', '.telegram-offset'));
    expect(legacyOffsetPath(paths, 'tron', 'activity')).toBe(join(root, 'state', 'tron', '.telegram-offset-activity'));
  });
});
