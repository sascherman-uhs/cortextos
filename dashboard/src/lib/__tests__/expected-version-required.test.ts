/**
 * Fix6 / D2 — a transition with no version is refused, not written.
 *
 * The library used to fall back to the record's CURRENT version when the
 * caller supplied none, in a branch its own comment called a blind write. That
 * fallback made the conflict path unreachable for every legacy caller: the
 * compare-and-set always compared the record against itself and always won.
 * Measured on the acceptance run: version 1 rendered, version 6 in the store,
 * move applied, record became 7, concurrent change lost.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('transitionTask without a version', () => {
  it('refuses the move and never reaches the store', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { transitionTask } = await import('../task-transition');
    const out = await transitionTask({ taskId: 'supa_7', to: 'doing', actor: 'scott' });

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.status).toBe(400);
    expect(out.ok === false && out.error).toBe('expected_version_required');
    // The point of failing closed: nothing was read and nothing was written.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says what to do about it, not just that it failed', async () => {
    const { transitionTask } = await import('../task-transition');
    const out = await transitionTask({ taskId: 'task_abc', to: 'waiting', actor: 'scott' });
    expect(out.ok).toBe(false);
    const detail = (out as { detail?: string }).detail;
    expect(detail).toMatch(/reload/i);
  });

  it('accepts version 0 — a falsy version is still a version', async () => {
    const { transitionTask } = await import('../task-transition');
    const out = await transitionTask({
      taskId: 'supa_7', to: 'doing', actor: 'scott', expectedVersion: 0,
    });
    expect(out.ok === false && out.error).not.toBe('expected_version_required');
  });
});
