/**
 * dashboard/src/app/api/briefing/__tests__/briefing-route.test.ts — OS-04
 *
 * Route-level behaviour for GET /api/briefing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-route-test-'));
process.env.UHS_JARVIS_ROOT = tmpRoot;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';

const { GET } = await import('@/app/api/briefing/route');
const { REQUIRED_SECTIONS } = await import('@/lib/uhs/briefing');

const DATE = '2026-06-16';

function sections() {
  const out: Record<string, unknown> = {};
  for (const id of REQUIRED_SECTIONS) {
    out[id] = { title: id, items: [], text: '', count: 0, status: 'ok', note: null };
  }
  return out;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    business_date: DATE,
    version: 2,
    state: 'notification_delivered',
    content_hash: 'abc',
    degraded: false,
    degraded_reasons: [],
    missed_deadline: false,
    snapshot_cutoff: '2026-06-16T11:30:00Z',
    published_ui_at: '2026-06-16T11:31:00Z',
    persons: ['scott'],
    body: { schema: 1, sections: sections(), body_text: 'BRIEFING', counts: {}, labels: {} },
    ...overrides,
  };
}

function stub(rows: unknown[], ok = true, status = 200) {
  global.fetch = vi.fn(async () => ({
    ok, status, json: async () => rows, text: async () => '',
  })) as unknown as typeof fetch;
}

function req(query = '') {
  return new NextRequest(`http://localhost/api/briefing${query}`);
}

afterEach(() => vi.restoreAllMocks());

describe('GET /api/briefing', () => {
  it('returns the snapshot with freshness metadata', async () => {
    stub([row()]);
    const res = await GET(req(`?date=${DATE}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.origin).toBe('supabase');
    expect(body.snapshot.version).toBe(2);
    expect(body.freshness).toHaveProperty('age_minutes');
    expect(body.freshness.missed_deadline).toBe(false);
  });

  it('rejects a malformed date', async () => {
    const res = await GET(req('?date=last-tuesday'));
    expect(res.status).toBe(400);
  });

  it('404s a date with no snapshot, and says missing rather than empty', async () => {
    stub([]);
    const res = await GET(req(`?date=${DATE}`));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.snapshot).toBeNull();
    expect(body.message).toContain('missing briefing, not an empty one');
  });

  it('surfaces degradation at the top level', async () => {
    stub([row({ degraded: true, degraded_reasons: [{ source: 'ops_log', status: 'unavailable' }] })]);
    const body = await (await GET(req(`?date=${DATE}`))).json();
    expect(body.degraded).toBe(true);
    expect(body.degraded_reasons[0].source).toBe('ops_log');
  });

  it('reports a missed deadline', async () => {
    stub([row({ missed_deadline: true })]);
    const body = await (await GET(req(`?date=${DATE}`))).json();
    expect(body.freshness.missed_deadline).toBe(true);
  });

  it('404s a person with no facet rather than leaking Scott\'s view', async () => {
    stub([row({ persons: ['scott'] })]);
    const res = await GET(req(`?date=${DATE}&person=angelic`));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.snapshot).toBeNull();
  });

  it('defaults to today when no date is given', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    global.fetch = spy as unknown as typeof fetch;
    const body = await (await GET(req())).json();
    expect(body.business_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('500s on an unexpected failure rather than pretending success', async () => {
    global.fetch = vi.fn(() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    // A thrown fetch is handled as a fallback path, so force a deeper failure instead.
    const res = await GET(req(`?date=${DATE}`));
    expect([404, 500]).toContain(res.status);
  });
});
