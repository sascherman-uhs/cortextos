/**
 * Queue selector tests, seeded with the real shape of the live data.
 *
 * Counts below come from a read-only inspection of the uhs-jarvis Supabase
 * `tasks` table on 2026-09-05: 42 pending rows assigned to 'scott', 35 failed,
 * 5 blocked, 41 non-terminal rows with no assignee. On that same date the
 * dashboard cache held 69 rows, all completed — and the Queue page rendered
 * "All clear". These tests pin the three defects that produced that:
 *
 *   1. the human filter matched assignee IN ('human','user'), so all 42 of
 *      Scott's pending rows were invisible;
 *   2. the Queue fetched only in_progress and pending, so 35 failed and 5
 *      blocked rows appeared in no lane at all;
 *   3. a thrown query returned [], which rendered as an all-clear.
 *
 * The live 647MB DB is not copied into the repo; the rows are reconstructed
 * here at the same counts and shapes.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-selectors-'));
fs.mkdirSync(path.join(tmpDir, 'dashboard'), { recursive: true });
process.env.CTX_ROOT = tmpDir;

type TasksModule = typeof import('../tasks');
type HealthModule = typeof import('../source-health');

let T: TasksModule;
let H: HealthModule;
let db: typeof import('../../db')['db'];

const PENDING_SCOTT = 42;
const FAILED = 35;
const BLOCKED = 5;
const UNASSIGNED = 41;

function insert(row: {
  id: string;
  status: string;
  assignee: string | null;
  title?: string;
  project?: string | null;
  needs_approval?: number;
}) {
  db.prepare(
    `INSERT OR REPLACE INTO tasks
       (id, title, description, status, priority, assignee, org, project,
        needs_approval, created_at, updated_at, completed_at, notes, source_file)
     VALUES (?, ?, NULL, ?, 'normal', ?, 'uhs', ?, ?, '2026-09-01T00:00:00Z', NULL, NULL, NULL, ?)`,
  ).run(
    row.id,
    row.title ?? `Task ${row.id}`,
    row.status,
    row.assignee,
    row.project ?? 'ops',
    row.needs_approval ?? 0,
    `supabase://tasks/${row.id}`,
  );
}

function seedLiveShape() {
  db.prepare('DELETE FROM tasks').run();
  for (let i = 0; i < PENDING_SCOTT; i++) {
    insert({ id: `p-scott-${i}`, status: 'pending', assignee: 'scott' });
  }
  for (let i = 0; i < FAILED; i++) {
    insert({ id: `failed-${i}`, status: 'failed', assignee: 'jarvis' });
  }
  for (let i = 0; i < BLOCKED; i++) {
    insert({ id: `blocked-${i}`, status: 'blocked', assignee: 'jarvis-orchestrator' });
  }
  for (let i = 0; i < UNASSIGNED; i++) {
    insert({ id: `orphan-${i}`, status: 'pending', assignee: null });
  }
  // Legacy-alias rows: all the old "human" filter ever matched.
  insert({ id: 'legacy-human', status: 'pending', assignee: 'human' });
  insert({ id: 'legacy-user', status: 'pending', assignee: 'user' });
  // Other people, which must never be folded into Scott's queue.
  insert({ id: 'ange-1', status: 'pending', assignee: 'angelic' });
  insert({ id: 'raq-1', status: 'in_progress', assignee: 'raquel' });
  // A status this build does not recognise.
  insert({ id: 'weird-1', status: 'needs_triage', assignee: 'jarvis' });
}

beforeAll(async () => {
  db = (await import('../../db')).db;
  T = await import('../tasks');
  H = await import('../source-health');
});

beforeEach(() => {
  seedLiveShape();
});

describe("Scott's queue", () => {
  it('surfaces all 42 pending rows assigned to scott', () => {
    const env = T.getPersonTasksEnvelope('scott');
    const pending = env.data.filter((t) => t.projection.status === 'pending');
    expect(pending.filter((t) => t.assignee === 'scott')).toHaveLength(PENDING_SCOTT);
  });

  it('also picks up the legacy human/user aliases, flagged as legacy', () => {
    const env = T.getPersonTasksEnvelope('scott');
    const legacy = env.data.filter((t) => t.projection.legacy_alias);
    expect(legacy.map((t) => t.id).sort()).toEqual(['legacy-human', 'legacy-user']);
  });

  it('never folds Angelic or Raquel into Scott', () => {
    const ids = T.getPersonTasksEnvelope('scott').data.map((t) => t.id);
    expect(ids).not.toContain('ange-1');
    expect(ids).not.toContain('raq-1');
    expect(T.getPersonTasksEnvelope('angelic').data.map((t) => t.id)).toEqual(['ange-1']);
    expect(T.getPersonTasksEnvelope('raquel').data.map((t) => t.id)).toEqual(['raq-1']);
  });

  it('the legacy agent=human filter now means Scott', () => {
    const legacyFilter = T.getTasksEnvelope({ agent: 'human' }).data.map((t) => t.id).sort();
    const personFilter = T.getTasksEnvelope({ person: 'scott' }).data.map((t) => t.id).sort();
    expect(legacyFilter).toEqual(personFilter);
    expect(legacyFilter.length).toBe(PENDING_SCOTT + 2);
  });
});

describe('recovery lane', () => {
  it('surfaces all 35 failed and 5 blocked rows, which had no lane at all', () => {
    const rows = T.getRecoveryTasksEnvelope().data;
    expect(rows.filter((t) => t.projection.status === 'failed')).toHaveLength(FAILED);
    expect(rows.filter((t) => t.projection.status === 'blocked')).toHaveLength(BLOCKED);
  });

  it('classifies failed as retry and agent-owned blocked as unclassified', () => {
    const rows = T.getRecoveryTasksEnvelope().data;
    expect(
      rows.filter((t) => t.projection.status === 'failed').every((t) => t.projection.waiting_subtype === 'retry'),
    ).toBe(true);
    expect(
      rows
        .filter((t) => t.projection.status === 'blocked')
        .every((t) => t.projection.waiting_subtype === 'unclassified'),
    ).toBe(true);
  });

  it('includes an unrecognised status rather than dropping it', () => {
    const rows = T.getRecoveryTasksEnvelope().data;
    const weird = rows.find((t) => t.id === 'weird-1');
    expect(weird?.projection.status).toBe('needs_triage');
    expect(weird?.projection.waiting_subtype).toBe('unclassified');
  });

  it('preserves the native status on every row it shows', () => {
    const statuses = new Set(T.getRecoveryTasksEnvelope().data.map((t) => t.projection.status));
    expect(statuses).toEqual(new Set(['failed', 'blocked', 'needs_triage']));
  });
});

describe('unassigned recovery', () => {
  it('surfaces every non-terminal row with no routable owner', () => {
    const rows = T.getUnassignedRecoveryEnvelope().data;
    expect(rows.filter((t) => t.projection.owner_kind === 'unassigned')).toHaveLength(UNASSIGNED);
  });

  it('includes ambiguous and unknown owners, and excludes completed rows', () => {
    insert({ id: 'amb-1', status: 'pending', assignee: 'team' });
    insert({ id: 'unk-1', status: 'pending', assignee: 'kimberly' });
    insert({ id: 'done-orphan', status: 'completed', assignee: null });
    const ids = T.getUnassignedRecoveryEnvelope().data.map((t) => t.id);
    expect(ids).toContain('amb-1');
    expect(ids).toContain('unk-1');
    expect(ids).not.toContain('done-orphan');
  });

  it('does not sweep agent-owned rows into unassigned', () => {
    const ids = T.getUnassignedRecoveryEnvelope().data.map((t) => t.id);
    expect(ids).not.toContain('failed-0');
  });
});

describe('source health', () => {
  it('a healthy read is fresh and not degraded', () => {
    const env = T.getTasksEnvelope({});
    expect(env.status).toBe('fresh');
    expect(H.isDegraded(env)).toBe(false);
    expect(env.source_updated_at).toBeTruthy();
  });

  it('a thrown query returns unavailable, not an empty all-clear', () => {
    const spy = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('database disk image is malformed');
    });
    try {
      const env = T.getTasksEnvelope({});
      expect(env.data).toEqual([]);
      expect(env.status).toBe('unavailable');
      expect(env.error).toContain('malformed');
      expect(H.isDegraded(env)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the envelope carries the agreed shape', () => {
    const env = T.getTasksEnvelope({});
    expect(Object.keys(env).sort()).toEqual(
      ['data', 'error', 'fetched_at', 'last_good_at', 'source', 'source_updated_at', 'stale_after', 'status'].sort(),
    );
  });

  it('an aged-out fresh snapshot still counts as degraded', () => {
    expect(
      H.isDegraded({
        status: 'fresh',
        fetched_at: new Date(Date.now() - 3600_000).toISOString(),
        stale_after: 900,
      }),
    ).toBe(true);
  });

  it('a non-fresh record keeps last_good_at so the UI can age the rows', () => {
    H.recordSourceHealth('test://src', 'fresh', { rowCount: 10 });
    const good = H.getSourceHealth().find((r) => r.source === 'test://src');
    expect(good?.last_good_at).toBeTruthy();

    H.recordSourceHealth('test://src', 'unavailable', { error: 'boom' });
    const bad = H.getSourceHealth().find((r) => r.source === 'test://src');
    expect(bad?.status).toBe('unavailable');
    expect(bad?.last_good_at).toBe(good?.last_good_at);
    expect(bad?.row_count).toBe(10);
  });

  it('getTaskCount reports -1 for unknown rather than a confident zero', () => {
    const spy = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('io error');
    });
    try {
      expect(T.getTaskCount()).toBe(-1);
    } finally {
      spy.mockRestore();
    }
  });
});
