// cortextOS Dashboard - Task data fetcher
// Reads from SQLite (synced from JSON task files on disk).

import { db } from '@/lib/db';
import type { Task, TaskFilters } from '@/lib/types';
import {
  loadContract,
  projectTask,
  type Projection,
  type PersonKey,
} from './task-projection';
import {
  envelope,
  unavailable,
  type SourceEnvelope,
} from './source-health';

const TASKS_SOURCE = 'sqlite://tasks';

/** A cached task row plus its work-board projection. */
export type ProjectedTask = Task & { projection: Projection };

export function withProjection(task: Task): ProjectedTask {
  return {
    ...task,
    projection: projectTask({
      status: task.status,
      assignee: task.assignee,
      needs_approval: task.needs_approval,
      title: task.title,
      project: task.project,
    }),
  };
}

/**
 * SQL fragment matching every row that could belong to `person`, including the
 * legacy aliases and the title/project heuristics. Deliberately WIDER than the
 * exact match: precise attribution is then done in TypeScript by the shared
 * projector, so SQL and the projector can never disagree about who owns a row.
 *
 * The predicate this replaces was `assignee IN ('human','user')` plus the two
 * heuristics, under a filter named "human". It matched zero of the 42 pending
 * rows Supabase had assigned to 'scott' — the single reason Scott's own inbox
 * rendered empty.
 */
function personCandidateSql(person: PersonKey, params: (string | number)[]): string {
  const contract = loadContract();
  const spec = contract.people[person];
  const aliases = [...spec.aliases, ...spec.legacy_aliases];
  const clauses = [`LOWER(TRIM(assignee)) IN (${aliases.map(() => '?').join(',')})`];
  params.push(...aliases.map((a) => a.toLowerCase()));

  if (person === contract.legacy_person) {
    for (const prefix of contract.legacy_title_prefixes) {
      clauses.push('(assignee IS NULL AND title LIKE ?)');
      params.push(`${prefix}%`);
    }
    for (const proj of contract.legacy_projects) {
      clauses.push('(assignee IS NULL AND project = ?)');
      params.push(proj);
    }
  }
  return `(${clauses.join(' OR ')})`;
}

/**
 * Get tasks with optional filters.
 * Returns newest first by default.
 */
export function getTasksEnvelope(filters?: TaskFilters): SourceEnvelope<Task[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.org) {
    conditions.push('org = ?');
    params.push(filters.org);
  }
  if (filters?.person) {
    // Ownership filter for a named human, resolved through the shared person
    // map rather than a hardcoded alias list.
    conditions.push(personCandidateSql(filters.person, params));
  } else if (filters?.agent) {
    // 'human' is a legacy virtual filter kept for existing links; it now means
    // "owned by Scott", which is what it always intended.
    if (filters.agent === 'human') {
      conditions.push(personCandidateSql('scott', params));
    } else {
      conditions.push('assignee = ?');
      params.push(filters.agent);
    }
  }
  if (filters?.priority) {
    conditions.push('priority = ?');
    params.push(filters.priority);
  }
  if (filters?.status) {
    if (Array.isArray(filters.status)) {
      conditions.push(`status IN (${filters.status.map(() => '?').join(',')})`);
      params.push(...filters.status);
    } else {
      conditions.push('status = ?');
      params.push(filters.status);
    }
  }
  if (filters?.unassignedOnly) {
    // Rows with no routable owner. Kept deliberately broad in SQL (anything not
    // matching a known person or agent-looking assignee); the projector makes
    // the final unassigned_recovery call.
    conditions.push(
      "(assignee IS NULL OR TRIM(assignee) = '' OR LOWER(TRIM(assignee)) IN ('unassigned','tbd','team','staff','uhs','admin'))",
    );
  }
  if (filters?.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters?.search) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }
  if (filters?.date === 'today') {
    // Same UTC-day boundary as getTasksCompletedToday() — only meaningful
    // paired with status=completed, but scopes on completed_at regardless.
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    conditions.push('completed_at >= ?');
    params.push(todayStart.toISOString());
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, notes, source_file
         FROM tasks ${where}
         ORDER BY created_at DESC`
      )
      .all(...params) as Record<string, unknown>[];

    const data = rows.map(rowToTask);
    const newest = data.reduce<string | null>(
      (acc, t) => {
        const u = t.updated_at ?? t.created_at;
        return u && (!acc || u > acc) ? u : acc;
      },
      null,
    );
    return envelope(data, TASKS_SOURCE, { source_updated_at: newest });
  } catch (err) {
    // An unreadable cache is NOT an empty queue. Returning [] here is what let
    // the board render "all clear - nothing needs your attention" on top of a
    // failed query.
    console.error('[data/tasks] getTasks error:', err);
    return unavailable([] as Task[], TASKS_SOURCE, err);
  }
}

/**
 * Envelope-free convenience wrapper for the many existing call sites that just
 * want rows. Callers that render a "nothing here" empty state MUST use
 * getTasksEnvelope() instead, so they can tell empty from unavailable.
 */
export function getTasks(filters?: TaskFilters): Task[] {
  return getTasksEnvelope(filters).data;
}

/** getTasksEnvelope() with each row's work-board projection attached. */
export function getProjectedTasks(filters?: TaskFilters): SourceEnvelope<ProjectedTask[]> {
  const env = getTasksEnvelope(filters);
  return { ...env, data: env.data.map(withProjection) };
}

/**
 * Get a single task by ID.
 */
export function getTaskById(id: string): Task | null {
  try {
    const row = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, notes, source_file
         FROM tasks WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToTask(row) : null;
  } catch (err) {
    console.error('[data/tasks] getTaskById error:', err);
    return null;
  }
}

/**
 * Get tasks filtered by status (useful for kanban columns).
 */
export function getTasksByStatus(status: string, org?: string): Task[] {
  return getTasks({ status, org });
}

/**
 * Get tasks assigned to a specific agent.
 */
export function getTasksByAgent(agentName: string, org?: string): Task[] {
  return getTasks({ agent: agentName, org });
}

/**
 * Get tasks completed today (UTC).
 */
export function getTasksCompletedTodayEnvelope(org?: string): SourceEnvelope<Task[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  // status='completed' (not just a stamped completed_at) — a recurring job
  // whose latest run failed can still carry a completed_at timestamp with
  // status='failed'; without this the count/list disagreed with the
  // status=completed&date=today filtered Tasks view by exactly those rows
  // (bug: 2026-09-03 round 2 — "Done Today" badge off by one vs the page it
  // links to).
  const conditions: string[] = ["status = 'completed'", 'completed_at >= ?'];
  const params: (string | number)[] = [todayISO];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, notes, source_file
         FROM tasks ${where}
         ORDER BY completed_at DESC`
      )
      .all(...params) as Record<string, unknown>[];

    return envelope(rows.map(rowToTask), TASKS_SOURCE);
  } catch (err) {
    console.error('[data/tasks] getTasksCompletedToday error:', err);
    return unavailable([] as Task[], TASKS_SOURCE, err);
  }
}

/**
 * Get count of in-progress tasks (for sidebar badge).
 */
export function getInProgressCount(org?: string): number {
  return getTaskCount(org, 'in_progress');
}

/**
 * Get count of tasks matching optional org/status.
 */
export function getTaskCount(org?: string, status?: string): number {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM tasks ${where}`)
      .get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  } catch (err) {
    // -1 means "unknown", not "none". Callers rendering a badge must not print
    // a confident 0 for a count they could not read.
    console.error('[data/tasks] getTaskCount error:', err);
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    assignee: (row.assignee as string) ?? undefined,
    org: row.org as string,
    project: (row.project as string) ?? undefined,
    needs_approval: row.needs_approval === 1,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) ?? undefined,
    completed_at: (row.completed_at as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
}

/** Back-compat wrapper. Prefer getTasksCompletedTodayEnvelope(). */
export function getTasksCompletedToday(org?: string): Task[] {
  return getTasksCompletedTodayEnvelope(org).data;
}

/**
 * Every non-terminal row whose projected lane is 'waiting' — blocked, failed,
 * and any status the cache holds that this build does not recognise. These rows
 * previously appeared in no Queue lane at all: the board fetched only
 * status='in_progress' and status='pending', so 35 failed and 5 blocked rows
 * were invisible on the page whose entire job is to show what needs recovery.
 */
export function getRecoveryTasksEnvelope(org?: string): SourceEnvelope<ProjectedTask[]> {
  const env = getProjectedTasks({ org });
  return { ...env, data: env.data.filter((t) => t.projection.lane === 'waiting') };
}

/**
 * Non-terminal rows with no routable owner: no assignee, an ambiguous alias, or
 * a name that resolves to neither a known person nor a known agent. Plan
 * section 4 requires these to surface rather than be silently skipped forever.
 */
export function getUnassignedRecoveryEnvelope(org?: string): SourceEnvelope<ProjectedTask[]> {
  const env = getProjectedTasks({ org });
  return { ...env, data: env.data.filter((t) => t.projection.unassigned_recovery) };
}

/** Tasks a named person owns, resolved through the shared person map. */
export function getPersonTasksEnvelope(
  person: PersonKey,
  org?: string,
): SourceEnvelope<ProjectedTask[]> {
  const env = getProjectedTasks({ person, org });
  return { ...env, data: env.data.filter((t) => t.projection.person === person) };
}
