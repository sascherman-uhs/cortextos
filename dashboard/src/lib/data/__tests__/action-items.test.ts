/**
 * getActionItems() is the shared "needs attention" source for both Overview and
 * Queue. These tests pin the rule that matters most: when a source behind it is
 * unreadable, the result must say so, because every consumer renders an
 * all-clear on an empty list.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-items-'));
fs.mkdirSync(path.join(tmpDir, 'dashboard'), { recursive: true });
process.env.CTX_ROOT = tmpDir;

vi.mock('../approvals', () => ({ getPendingApprovals: () => [] }));
vi.mock('../heartbeats', () => ({
  getHealthSummary: async () => ({ agents: [], healthy: 0, stale: 0, down: 0, total: 0 }),
}));

const skillRuns = vi.hoisted(() => ({
  impl: async () => ({
    data: [],
    source: 'supabase://skill_runs',
    fetched_at: new Date().toISOString(),
    source_updated_at: null,
    stale_after: 900,
    status: 'fresh' as const,
    error: null,
    last_good_at: null,
  }),
}));
vi.mock('../skill-runs', () => ({
  getBlockedSkillRunsEnvelope: () => skillRuns.impl(),
  getBlockedSkillRuns: async () => [],
}));

let getActionItems: typeof import('../action-items')['getActionItems'];
let db: typeof import('../../db')['db'];

function insert(id: string, status: string, assignee: string | null, needsApproval = 0) {
  db.prepare(
    `INSERT OR REPLACE INTO tasks
       (id, title, description, status, priority, assignee, org, project,
        needs_approval, created_at, updated_at, completed_at, notes, source_file)
     VALUES (?, ?, NULL, ?, 'normal', ?, 'uhs', 'ops', ?, '2026-09-01T00:00:00Z', NULL, NULL, NULL, ?)`,
  ).run(id, `Task ${id}`, status, assignee, needsApproval, `supabase://tasks/${id}`);
}

beforeAll(async () => {
  db = (await import('../../db')).db;
  getActionItems = (await import('../action-items')).getActionItems;
});

beforeEach(() => {
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM source_health').run();
  skillRuns.impl = async () => ({
    data: [],
    source: 'supabase://skill_runs',
    fetched_at: new Date().toISOString(),
    source_updated_at: null,
    stale_after: 900,
    status: 'fresh' as const,
    error: null,
    last_good_at: null,
  });
});

describe('getActionItems', () => {
  it('puts scott-assigned pending rows in his queue', async () => {
    insert('s1', 'pending', 'scott');
    insert('s2', 'pending', 'scott');
    const items = await getActionItems();
    expect(items.humanTasks.map((i) => i.id).sort()).toEqual(['s1', 's2']);
    expect(items.degradedSources).toEqual([]);
  });

  it('surfaces failed and blocked rows in recovery, tagged by subtype', async () => {
    insert('f1', 'failed', 'jarvis');
    insert('b1', 'blocked', 'jarvis');
    insert('a1', 'blocked', 'jarvis', 1);
    const items = await getActionItems();

    const byId = Object.fromEntries(items.recoveryTasks.map((i) => [i.id, i]));
    expect(byId.f1.kind).toBe('failed_task');
    expect(byId.f1.waitingSubtype).toBe('retry');
    expect(byId.f1.status).toBe('failed');
    expect(byId.b1.waitingSubtype).toBe('unclassified');
    expect(byId.a1.waitingSubtype).toBe('human');
    // blockedTasks stays the human-decision slice for existing callers.
    expect(items.blockedTasks.map((i) => i.id)).toEqual(['a1']);
  });

  it('surfaces unowned rows in unassigned recovery with the reason', async () => {
    insert('o1', 'pending', null);
    insert('o2', 'pending', 'team');
    const items = await getActionItems();
    const byId = Object.fromEntries(items.unassignedTasks.map((i) => [i.id, i]));
    expect(byId.o1.subtitle).toContain('no owner assigned');
    expect(byId.o2.subtitle).toContain('ambiguous owner');
  });

  it('reports a degraded skill-run source instead of an empty all-clear', async () => {
    skillRuns.impl = async () => ({
      data: [],
      source: 'supabase://skill_runs',
      fetched_at: new Date().toISOString(),
      source_updated_at: null,
      stale_after: 900,
      status: 'unavailable' as const,
      error: 'HTTP 503 from skill_runs',
      last_good_at: '2026-09-05T00:00:00Z',
    });
    const items = await getActionItems();
    expect(items.degradedSources).toHaveLength(1);
    expect(items.degradedSources[0].source).toBe('supabase://skill_runs');
    expect(items.degradedSources[0].error).toContain('503');
    expect(items.degradedSources[0].lastGoodAt).toBe('2026-09-05T00:00:00Z');
  });

  it("reports a degraded source the dashboard does not fetch itself", async () => {
    // The JARVIS Python projector reports through source_health.
    db.prepare(
      `INSERT INTO source_health (source, status, fetched_at, source_updated_at,
         stale_after_seconds, last_good_at, row_count, error)
       VALUES ('supabase://tasks?org=uhs', 'unavailable', ?, NULL, 900, ?, 1918, 'HTTP 503')`,
    ).run(new Date().toISOString(), '2026-09-05T09:00:00Z');

    const items = await getActionItems();
    expect(items.degradedSources.map((s) => s.source)).toContain('supabase://tasks?org=uhs');
  });

  it('a row in Scott’s queue is not repeated in recovery', async () => {
    insert('s1', 'blocked', 'scott');
    const items = await getActionItems();
    expect(items.humanTasks.map((i) => i.id)).toEqual(['s1']);
    expect(items.recoveryTasks.map((i) => i.id)).not.toContain('s1');
  });
});
