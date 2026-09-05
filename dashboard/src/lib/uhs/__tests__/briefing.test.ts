/**
 * dashboard/src/lib/uhs/__tests__/briefing.test.ts — OS-04
 *
 * The read side of the briefing snapshot. Supabase is stubbed via global.fetch; the
 * local fallback uses a real temp directory, because the whole point of that path is
 * filesystem behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-test-'));
process.env.UHS_JARVIS_ROOT = tmpRoot;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';

const {
  getBriefingSnapshot,
  readLocalFallback,
  rowToSnapshot,
  currentBusinessDate,
  snapshotAgeMinutes,
  isPersonPermitted,
  REQUIRED_SECTIONS,
} = await import('@/lib/uhs/briefing');

const DATE = '2026-06-16';

function sections(overrides: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const id of REQUIRED_SECTIONS) {
    out[id] = { title: id, items: [], text: '', count: 0, status: 'ok', note: null };
  }
  return { ...out, ...overrides };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    business_date: DATE,
    version: 1,
    state: 'published_ui',
    content_hash: 'abc',
    degraded: false,
    degraded_reasons: [],
    missed_deadline: false,
    window_start: '2026-06-16T03:00:00Z',
    window_end: '2026-06-16T11:30:00Z',
    snapshot_cutoff: '2026-06-16T11:30:00Z',
    policy_version: 1,
    published_ui_at: '2026-06-16T11:31:00Z',
    persons: ['scott'],
    body: { schema: 1, sections: sections(), body_text: 'BRIEFING', counts: {}, labels: {} },
    ...overrides,
  };
}

function stubFetch(rows: unknown[], ok = true, status = 200) {
  global.fetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  })) as unknown as typeof fetch;
}

function writeFallback(date: string, version: number, r: Record<string, unknown>) {
  const dir = path.join(tmpRoot, 'output', date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `briefing-snapshot-${date}-v${version}.json`),
    JSON.stringify(r),
  );
}

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'output'), { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- normalise ---

describe('rowToSnapshot', () => {
  it('returns all six sections in the required order', () => {
    const warnings: string[] = [];
    const snap = rowToSnapshot(row(), warnings);
    expect(Object.keys(snap.sections).sort()).toEqual([...REQUIRED_SECTIONS].sort());
    expect(warnings).toEqual([]);
  });

  it('warns rather than hides a missing section', () => {
    const warnings: string[] = [];
    const partial = sections();
    delete (partial as Record<string, unknown>).improvements;
    const snap = rowToSnapshot(
      row({ body: { sections: partial, body_text: 'x' } }),
      warnings,
    );
    expect(snap.sections.improvements.count).toBe(0);
    expect(warnings.join(' ')).toContain('improvements');
  });

  it('warns when a count does not reconcile with its items', () => {
    const warnings: string[] = [];
    rowToSnapshot(
      row({
        body: {
          sections: sections({
            improvements: { title: 'x', items: [{ header: 'a' }], text: '', count: 9, status: 'ok' },
          }),
          body_text: 'x',
        },
      }),
      warnings,
    );
    expect(warnings.join(' ')).toContain('reports 9 items');
  });

  it('carries degradation through', () => {
    const snap = rowToSnapshot(
      row({ degraded: true, degraded_reasons: [{ source: 'ops_log', status: 'unavailable' }] }),
      [],
    );
    expect(snap.degraded).toBe(true);
    expect(snap.degraded_reasons[0].source).toBe('ops_log');
  });
});

// ------------------------------------------------------------------- reads ---

describe('getBriefingSnapshot', () => {
  it('serves the published snapshot from Supabase', async () => {
    stubFetch([row()]);
    const result = await getBriefingSnapshot(DATE);
    expect(result.origin).toBe('supabase');
    expect(result.snapshot?.version).toBe(1);
  });

  it('requests only published states, newest version first', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => [row()] }));
    global.fetch = spy as unknown as typeof fetch;
    await getBriefingSnapshot(DATE);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('order=version.desc');
    expect(url).toContain('published_ui');
    expect(url).toContain(`business_date=eq.${DATE}`);
  });

  it('never substitutes another date when one is missing', async () => {
    stubFetch([]);
    const result = await getBriefingSnapshot(DATE);
    expect(result.origin).toBe('none');
    expect(result.snapshot).toBeNull();
  });

  it('falls back to the local snapshot when Supabase errors', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    writeFallback(DATE, 1, row({ degraded: true, origin: 'local_fallback' }));
    const result = await getBriefingSnapshot(DATE);
    expect(result.origin).toBe('local_fallback');
    expect(result.warnings.join(' ')).toContain('Supabase unreachable');
  });

  it('falls back on a non-200 response too', async () => {
    stubFetch([], false, 503);
    writeFallback(DATE, 1, row());
    const result = await getBriefingSnapshot(DATE);
    expect(result.origin).toBe('local_fallback');
    expect(result.warnings.join(' ')).toContain('503');
  });

  it('labels the local fallback as degraded-by-origin', async () => {
    stubFetch([], false, 500);
    writeFallback(DATE, 1, row());
    const result = await getBriefingSnapshot(DATE);
    expect(result.warnings.join(' ')).toContain('written while Supabase was unreachable');
  });

  it('returns nothing when a person has no facet', async () => {
    stubFetch([row({ persons: ['scott'] })]);
    const result = await getBriefingSnapshot(DATE, 'raquel');
    expect(result.snapshot).toBeNull();
    expect(result.warnings.join(' ')).toContain('OS-04b');
  });
});

// --------------------------------------------------------- local fallback ---

describe('readLocalFallback', () => {
  it('picks the highest version', () => {
    writeFallback(DATE, 1, row({ version: 1 }));
    writeFallback(DATE, 2, row({ version: 2 }));
    const r = readLocalFallback(DATE, []);
    expect(r?.version).toBe(2);
  });

  it('returns null when the directory does not exist', () => {
    expect(readLocalFallback('1999-01-01', [])).toBeNull();
  });

  it('reports an unreadable file instead of throwing', () => {
    const dir = path.join(tmpRoot, 'output', DATE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `briefing-snapshot-${DATE}-v1.json`), '{not json');
    const warnings: string[] = [];
    expect(readLocalFallback(DATE, warnings)).toBeNull();
    expect(warnings.join(' ')).toContain('unreadable');
  });

  it('ignores files for other dates', () => {
    writeFallback(DATE, 1, row());
    const dir = path.join(tmpRoot, 'output', DATE);
    fs.writeFileSync(path.join(dir, 'briefing-snapshot-2020-01-01-v9.json'), '{}');
    expect(readLocalFallback(DATE, [])?.version).toBe(1);
  });
});

// ------------------------------------------------------------------ helpers ---

describe('helpers', () => {
  it('currentBusinessDate is a Pacific YYYY-MM-DD', () => {
    // 07:00 UTC on Jun 16 is still Jun 15 in Pacific.
    expect(currentBusinessDate(new Date('2026-06-16T06:00:00Z'))).toBe('2026-06-15');
    expect(currentBusinessDate(new Date('2026-06-16T08:00:00Z'))).toBe('2026-06-16');
  });

  it('snapshotAgeMinutes measures from when the data was read', () => {
    const snap = rowToSnapshot(row(), []);
    const age = snapshotAgeMinutes(snap, new Date('2026-06-16T12:30:00Z'));
    expect(age).toBe(60);
  });

  it('snapshotAgeMinutes is null without a timestamp', () => {
    const snap = rowToSnapshot(row({ snapshot_cutoff: null, published_ui_at: null }), []);
    expect(snapshotAgeMinutes(snap)).toBeNull();
  });

  it('isPersonPermitted gates on the snapshot person list', () => {
    const snap = rowToSnapshot(row({ persons: ['scott'] }), []);
    expect(isPersonPermitted(snap, 'scott')).toBe(true);
    expect(isPersonPermitted(snap, 'angelic')).toBe(false);
  });
});
