/**
 * dashboard/src/app/api/improvements/__tests__/improvements-route.test.ts — OS-08
 *
 * `@/lib/auth` is mocked: it opens the dashboard's SQLite users table at import time,
 * which a unit test has no business doing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

let sessionUser: string | null = 'scott@utopiahomestaging.com';
vi.mock('@/lib/auth', () => ({
  auth: async () => (sessionUser ? { user: { name: sessionUser, id: '1' } } : null),
}));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';

const { GET } = await import('@/app/api/improvements/route');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  sessionUser = 'scott@utopiahomestaging.com';
  vi.restoreAllMocks();
});

function ok(body: unknown = []) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response) as never;
}

function req(qs = '') {
  return new Request(`http://localhost/api/improvements${qs}`);
}

describe('GET /api/improvements', () => {
  it('requires a session', async () => {
    sessionUser = null;
    expect((await GET(req())).status).toBe(401);
  });

  it('returns the loop with its degraded flag', async () => {
    ok([]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('improvements');
    expect(body).toHaveProperty('cycles');
    expect(body).toHaveProperty('degraded');
  });

  it('rejects a nonsense limit rather than silently defaulting', async () => {
    ok([]);
    const res = await GET(req('?limit=banana'));
    expect(res.status).toBe(400);
  });

  it('caps an enormous limit instead of asking Supabase for everything', async () => {
    ok([]);
    const body = await (await GET(req('?limit=99999'))).json();
    expect(body.limit).toBe(200);
  });

  it('stays 200 with a labelled outage rather than hiding the data that loaded', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => [] }) as Response) as never;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).degraded).toContain('503');
  });
});
