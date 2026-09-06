/**
 * OS-03 — POST /api/tasks/[id]/transition.
 *
 * This is the single door a board move goes through. The tests below are
 * about what it REFUSES, because that is the whole point of having one door:
 *
 *   * a state the board does not know;
 *   * Done — verification is not something a drag grants;
 *   * failed_terminal — obligations are not dead-lettered by a drag;
 *   * a transition the contract does not permit, refused with the legal moves
 *     named so the person knows what to do instead;
 *   * a concurrent edit, refused as a conflict rather than overwriting it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTaskById = vi.fn();
const transitionTask = vi.fn();

vi.mock('@/lib/data/tasks', () => ({ getTaskById: (id: string) => getTaskById(id) }));
vi.mock('@/lib/task-transition', () => ({
  transitionTask: (req: unknown) => transitionTask(req),
}));

const { POST } = await import('@/app/api/tasks/[id]/transition/route');

function req(body: unknown) {
  return new Request('http://localhost/api/tasks/supa_1/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function ctx(id = 'supa_1') {
  return { params: Promise.resolve({ id }) };
}

function cachedTask(status: string) {
  return { id: 'supa_1', title: 'Task', status, priority: 'normal', org: 'uhs', needs_approval: false, created_at: '' };
}

beforeEach(() => {
  getTaskById.mockReset();
  transitionTask.mockReset();
});

describe('input the board should never send', () => {
  it('rejects a task id that is not a task id', async () => {
    const res = await POST(req({ to: 'ready' }), { params: Promise.resolve({ id: '../etc' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_task_id');
  });

  it('rejects a body that is not JSON', async () => {
    const bad = new Request('http://localhost/x', { method: 'POST', body: 'not json' });
    const res = await POST(bad as unknown as Parameters<typeof POST>[0], ctx());
    expect(res.status).toBe(400);
  });

  it('names the valid states when it does not recognise one', async () => {
    const res = await POST(req({ to: 'in_progress' }), ctx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_state');
    expect(body.reason).toContain('backlog, ready, doing, verify, waiting, done');
  });
});

describe('what a board move may never do', () => {
  it('refuses to mark work Done, and says why', async () => {
    const res = await POST(req({ to: 'done' }), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden_move');
    expect(body.reason).toMatch(/independent verifier/);
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('refuses to abandon work into failed_terminal', async () => {
    const res = await POST(req({ to: 'failed_terminal' }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toMatch(/forbidden outright for obligations/);
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('checks the forbidden list before it ever reads the task', async () => {
    await POST(req({ to: 'done' }), ctx());
    expect(getTaskById).not.toHaveBeenCalled();
  });
});

describe('the task itself', () => {
  it('404s a task the cache does not hold, and says what that means', async () => {
    getTaskById.mockReturnValue(null);
    const res = await POST(req({ to: 'ready' }), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toMatch(/may have been removed/);
  });

  it('refuses a no-op rather than reporting a move that did not happen', async () => {
    getTaskById.mockReturnValue(cachedTask('in_progress'));
    const res = await POST(req({ to: 'doing' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_op');
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('refuses an illegal transition and names the legal ones', async () => {
    // pending projects onto backlog; backlog cannot go straight to doing.
    getTaskById.mockReturnValue(cachedTask('pending'));
    const res = await POST(req({ to: 'doing' }), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('illegal_transition');
    expect(body.reason).toContain('backlog → doing is not a permitted transition');
    expect(body.allowed).toContain('ready');
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('refuses to move out of a terminal state', async () => {
    getTaskById.mockReturnValue(cachedTask('completed'));
    const res = await POST(req({ to: 'doing' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(/terminal state/);
  });
});

describe('a legal move', () => {
  it('hands it to the OS-02 transition service and returns both vocabularies', async () => {
    getTaskById.mockReturnValue(cachedTask('pending'));
    transitionTask.mockResolvedValue({
      ok: true, version: 5, canonicalState: 'ready', nativeStatus: 'pending',
    });
    const res = await POST(req({ to: 'ready', expectedVersion: 4 }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, from: 'backlog', canonicalState: 'ready', version: 5 });
    // The version the caller decided on is passed through, so a concurrent
    // edit is detected rather than silently overwritten.
    expect(transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'supa_1', to: 'ready', expectedVersion: 4 }),
    );
  });
});

describe('a concurrent edit', () => {
  it('answers a version conflict with the current record and a plain reason', async () => {
    getTaskById.mockReturnValue(cachedTask('pending'));
    transitionTask.mockResolvedValue({
      ok: false, status: 409, error: 'version_conflict',
      current: { id: 1, status: 'in_progress' }, currentVersion: 9,
    });
    const res = await POST(req({ to: 'ready', expectedVersion: 4 }), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('version_conflict');
    expect(body.currentVersion).toBe(9);
    expect(body.current).toEqual({ id: 1, status: 'in_progress' });
    expect(body.reason).toMatch(/rather than overwriting their change/);
  });

  it('passes a store-level refusal through with its own detail', async () => {
    getTaskById.mockReturnValue(cachedTask('pending'));
    transitionTask.mockResolvedValue({
      ok: false, status: 500, error: 'transition_failed', detail: 'bus script exited 1',
    });
    const res = await POST(req({ to: 'ready' }), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).reason).toBe('bus script exited 1');
  });
});
