/**
 * V5-2b / V5-3 at the injection layer (2026-09-30):
 *   - the deferred Enter is bound to the PTY the paste went to, and is
 *     cancelled if that PTY was replaced inside the delay (a stray Enter in a
 *     freshly spawned session submits whatever is in ITS composer);
 *   - a paste that threw AFTER some bytes were written is reported as such
 *     (UNKNOWN), distinct from one that wrote nothing (the only positive
 *     evidence of non-delivery).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { injectPaste, injectMessage } from '../../../src/pty/inject';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('deferred Enter bound to its PTY', () => {
  it('is cancelled when the PTY is replaced inside the Enter delay, and pressed otherwise', async () => {
    let current = 'A';
    const writes: string[] = [];
    injectPaste((d) => writes.push(`A:${d}`), 'ZZTEST', { stillCurrent: () => current === 'A' });
    current = 'B'; // respawn within 300 ms
    await vi.advanceTimersByTimeAsync(400);
    expect(writes.some((w) => w === 'A:\r')).toBe(false);
    current = 'A';
    injectPaste((d) => writes.push(`A:${d}`), 'ZZTEST2', { stillCurrent: () => current === 'A' });
    await vi.advanceTimersByTimeAsync(400);
    expect(writes.filter((w) => w === 'A:\r')).toHaveLength(1);
  });

  it('reports a partial write as wroteAny (UNKNOWN), a first-write throw as nothing written', async () => {
    let n = 0;
    const big = 'x'.repeat(9000);
    expect(injectPaste(() => { if (++n === 2) throw new Error('EPIPE'); }, big)).toMatchObject({ ok: false, wroteAny: true });
    expect(injectPaste(() => { throw new Error('EPIPE'); }, 'small')).toMatchObject({ ok: false, wroteAny: false });
  });
});

describe('back-compat', () => {
  it('injectMessage still returns a boolean and still presses Enter', async () => {
    const writes: string[] = [];
    expect(injectMessage((d) => writes.push(d), 'ZZTEST')).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(writes[writes.length - 1]).toBe('\r');
    expect(injectMessage(() => { throw new Error('EPIPE'); }, 'ZZTEST')).toBe(false);
  });
});
