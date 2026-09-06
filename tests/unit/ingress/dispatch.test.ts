/**
 * OS-07 — durable dispatch.
 *
 * Plan §11: "worker dies before/after external action — lease recovery and
 * reconciliation; no duplicate draft/product/task", and §5's explicit
 * starvation rule about a bounded scan skipping ineligible rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveIngressPaths, runExactlyOnce, effectState, listAmbiguousEffects, type IngressPaths } from '../../../src/ingress/state.js';
import {
  acceptWork,
  leaseWork,
  ackWork,
  nackWork,
  readRecord,
  listRecords,
  selectDispatchable,
  reconcileOnRestart,
  DispatchLeaseError,
  DEFAULT_CAPACITY,
  dispatchIdFor as idOf,
} from '../../../src/ingress/dispatch.js';

let root: string;
let paths: IngressPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os07-dispatch-'));
  paths = resolveIngressPaths({ ctxRoot: root, org: 'uhs' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function accept(owner: string, key: string, extra: Partial<Parameters<typeof acceptWork>[1]> = {}) {
  return acceptWork(paths, { owner, dedupe_key: key, payload: { key }, ...extra }).record;
}

describe('OS-07 durable dispatch', () => {
  it('accepts an instruction once, however many times it is replayed', () => {
    const first = acceptWork(paths, { owner: 'vera', dedupe_key: 'vera:1', payload: { text: 'a' } });
    const second = acceptWork(paths, { owner: 'vera', dedupe_key: 'vera:1', payload: { text: 'a' } });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(listRecords(paths)).toHaveLength(1);
  });

  it('refuses a second live lease and refuses an ack from a stale holder', () => {
    accept('vera', 'vera:2');
    const handle = leaseWork(paths, idOf('vera:2'), 'worker-a');
    expect(() => leaseWork(paths, idOf('vera:2'), 'worker-b')).toThrow(DispatchLeaseError);
    // Worker A dies; its lease expires and worker B takes over.
    nackWork(paths, handle, 'worker-a crashed');
    const handleB = leaseWork(paths, idOf('vera:2'), 'worker-b');
    // Worker A comes back convinced it still owns the row.
    expect(() => ackWork(paths, handle)).toThrow(DispatchLeaseError);
    expect(ackWork(paths, handleB).state).toBe('done');
  });

  it('requeues rows whose lease died with their worker, on restart', () => {
    accept('vera', 'vera:3');
    accept('vivienne', 'viv:1');
    const past = () => new Date(Date.now() - 60 * 60 * 1000);
    leaseWork(paths, idOf('vera:3'), 'dead-worker', 1, { now: past });
    leaseWork(paths, idOf('viv:1'), 'live-worker', 60 * 60 * 1000);

    const { requeued, failed } = reconcileOnRestart(paths);
    expect(requeued).toEqual([idOf('vera:3')]);
    expect(failed).toEqual([]);
    expect(readRecord(paths, idOf('vera:3'))!.state).toBe('pending');
    expect(readRecord(paths, idOf('vera:3'))!.reason).toMatch(/expired/);
    // A live lease is left alone.
    expect(readRecord(paths, idOf('viv:1'))!.state).toBe('leased');
  });

  it('stops retrying a poison row once its attempt limit is spent', () => {
    accept('vera', 'vera:poison', { attempt_limit: 2 });
    for (let i = 0; i < 2; i += 1) {
      const h = leaseWork(paths, idOf('vera:poison'), `w${i}`);
      nackWork(paths, h, 'external system rejected it');
    }
    const record = readRecord(paths, idOf('vera:poison'))!;
    expect(record.state).toBe('failed');
    expect(record.reason).toMatch(/attempt limit 2 reached/);
    expect(selectDispatchable(paths).map((r) => r.id)).not.toContain(idOf('vera:poison'));
  });

  it('does not starve eligible work behind a wall of permanently-skipped rows', () => {
    // 25 blocked rows ahead of the one real instruction: a head-anchored
    // LIMIT-20 scan would never reach it. The rotating cursor does.
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 25; i += 1) {
      accept('blocked-owner', `blocked:${String(i).padStart(3, '0')}`, { not_before: farFuture });
    }
    accept('vera', 'zzz-vera:real');

    let found = false;
    for (let pass = 0; pass < 5 && !found; pass += 1) {
      found = selectDispatchable(paths, { limit: 20 }).some((r) => r.id === idOf('zzz-vera:real'));
    }
    expect(found).toBe(true);
  });

  it('round-robins across owners instead of letting one owner fill the batch', () => {
    for (let i = 0; i < 10; i += 1) accept('busy-owner', `busy:${i}`);
    accept('vera', 'vera:single');
    const picked = selectDispatchable(paths, { limit: 20, capacity: 4, reserved: 0 });
    expect(picked.map((r) => r.owner)).toContain('vera');
    const busyCount = picked.filter((r) => r.owner === 'busy-owner').length;
    expect(busyCount).toBeLessThan(picked.length);
  });

  it('keeps reserved capacity for ingress while every worker slot is stalled', () => {
    // Fill every non-reserved slot with live `work` leases.
    for (let i = 0; i < DEFAULT_CAPACITY; i += 1) accept('stalled-owner', `stall:${i}`);
    const workSlots = DEFAULT_CAPACITY - 2;
    for (let i = 0; i < workSlots; i += 1) leaseWork(paths, idOf(`stall:${i}`), `w${i}`, 60 * 60 * 1000);

    acceptWork(paths, { owner: 'jarvis-telegram', work_class: 'ingress', dedupe_key: 'ing:1', payload: {} });
    const picked = selectDispatchable(paths, { limit: 20 });
    expect(picked.map((r) => r.id)).toContain(idOf('ing:1'));
    // The reserved slots are NOT handed to ordinary work.
    expect(picked.filter((r) => r.work_class === 'work')).toHaveLength(0);
  });

  it('a crash between accept and execute replays into exactly one effect', async () => {
    accept('vera', 'vera:effect');
    let sideEffects = 0;
    const doIt = () => runExactlyOnce(paths, 'vera:effect', async () => { sideEffects += 1; return 'sent'; });

    // Attempt 1: leased, then the process dies before ack.
    const handle = leaseWork(paths, idOf('vera:effect'), 'worker-a', 1, { now: () => new Date(Date.now() - 60_000) });
    expect((await doIt()).status).toBe('executed');
    expect(sideEffects).toBe(1);
    void handle;

    // Restart: the row is requeued and a new worker replays it.
    expect(reconcileOnRestart(paths).requeued).toEqual([idOf('vera:effect')]);
    const handleB = leaseWork(paths, idOf('vera:effect'), 'worker-b');
    const replay = await doIt();
    expect(replay.status).toBe('skipped');
    expect(sideEffects).toBe(1);
    expect(ackWork(paths, handleB).state).toBe('done');
    expect(effectState(paths, 'vera:effect')).toBe('done');
  });

  it('reports an effect that died mid-flight as ambiguous rather than repeating it', async () => {
    let sideEffects = 0;
    await expect(
      runExactlyOnce(paths, 'vera:midflight', async () => {
        sideEffects += 1;
        throw new Error('killed after the external call went out');
      }),
    ).rejects.toThrow('killed');
    expect(sideEffects).toBe(1);

    // A replay refuses to repeat an external action it cannot prove failed.
    const replay = await runExactlyOnce(paths, 'vera:midflight', async () => { sideEffects += 1; });
    expect(replay.status).toBe('ambiguous');
    expect(sideEffects).toBe(1);
    expect(listAmbiguousEffects(paths)).toContain('vera_midflight');
  });
});
