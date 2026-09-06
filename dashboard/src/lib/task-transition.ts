/**
 * OS-02 shared transition service for the dashboard.
 *
 * Both branches of `/api/tasks/[id]` used to be their own little state machine:
 * the Supabase branch PATCHed a status with no version and no evidence, and the
 * native branch had a PUT that wrote the task JSON directly, bypassing the bus
 * entirely. Two stores, two vocabularies, two conflict behaviors (neither of
 * which detected a conflict), and a Kanban drag that could land on either.
 *
 * This module is the one door. It takes a canonical intent, routes it to the
 * store that owns the record, and returns ONE result shape — including a
 * conflict that carries the current record, so the UI can show what actually
 * happened and refresh rather than retrying blind over someone else's edit.
 *
 * What it will not do: approve external work, widen a task's authorization
 * scope, or mark an obligation resolved. A Kanban move is a request for a
 * validated transition, never a grant of authority (plan §3).
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import {
  sourceForTaskId,
  toCanonical,
  toNative,
  isAllowedMove,
  type CanonicalState,
  type TaskSource,
} from '@/lib/data/transition-contract';

export interface TransitionRequest {
  taskId: string;
  /** Either a canonical state or a native status. Canonical is preferred; the
   *  Kanban speaks lanes, not store vocabulary. */
  to: CanonicalState | string;
  actor: string;
  /** Optimistic concurrency. The version the caller had when it decided. */
  expectedVersion?: number;
  evidence?: Record<string, unknown>;
  reason?: string;
  org?: string;
}

export type TransitionOutcome =
  | { ok: true; version?: number; canonicalState: CanonicalState; nativeStatus: string }
  | { ok: false; status: 409; error: 'version_conflict'; current: Record<string, unknown> | null; currentVersion?: number }
  | { ok: false; status: 400 | 404 | 500; error: string; detail?: string };

function isCanonical(v: string): v is CanonicalState {
  return ['backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal'].includes(v);
}

/** Resolve the caller's `to` into both vocabularies for the owning store. */
export function resolveTarget(
  source: TaskSource,
  to: string,
): { canonical: CanonicalState; native: string } | null {
  if (isCanonical(to)) {
    const native = toNative(source, to);
    return native ? { canonical: to, native } : null;
  }
  const canonical = toCanonical(source, to);
  // A native status we do not recognise maps to `waiting`, which would silently
  // park the task. Refuse instead: the caller sent something we cannot honour.
  const roundTrip = toNative(source, canonical);
  if (canonical === 'waiting' && roundTrip !== to) return null;
  return { canonical, native: to };
}

// ---------------------------------------------------------------------------
// Supabase-backed tasks (JARVIS business tasks, surfaced as supa_<id>)
// ---------------------------------------------------------------------------

async function transitionSupabase(req: TransitionRequest): Promise<TransitionOutcome> {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_KEY;
  if (!supaUrl || !supaKey) {
    return { ok: false, status: 500, error: 'supabase_not_configured' };
  }

  const numericId = Number(req.taskId.slice(5));
  if (!Number.isFinite(numericId)) {
    return { ok: false, status: 400, error: 'invalid_task_id' };
  }

  const target = resolveTarget('jarvis_tasks', req.to);
  if (!target) return { ok: false, status: 400, error: 'unmappable_target_state', detail: req.to };

  const headers = {
    apikey: supaKey,
    Authorization: `Bearer ${supaKey}`,
    'Content-Type': 'application/json',
  };

  // Read the current version. A caller that did not supply one gets whatever is
  // current — that is a blind write and it is allowed only because the legacy
  // UI has no version to send yet; the conflict path exists for callers that do.
  let expected = req.expectedVersion;
  let current: Record<string, unknown> | null = null;
  try {
    const res = await fetch(
      `${supaUrl}/rest/v1/tasks?id=eq.${numericId}&select=*`,
      { headers, cache: 'no-store' },
    );
    const rows = res.ok ? await res.json() : [];
    current = rows[0] ?? null;
    if (!current) return { ok: false, status: 404, error: 'task_not_found' };
    if (expected === undefined) expected = Number(current.version ?? 1);
  } catch (err) {
    return { ok: false, status: 500, error: 'supabase_unreachable', detail: String(err) };
  }

  try {
    const res = await fetch(`${supaUrl}/rest/v1/rpc/task_transition`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_task_id: numericId,
        p_expected_version: expected,
        p_new_status: target.native,
        p_actor: req.actor,
        p_evidence: req.evidence ?? {},
        p_reason: req.reason ?? null,
      }),
    });
    if (!res.ok) {
      return { ok: false, status: 500, error: 'transition_rpc_failed', detail: `${res.status}` };
    }
    const out = await res.json();
    if (out?.ok === false && out?.error === 'version_conflict') {
      return {
        ok: false, status: 409, error: 'version_conflict',
        current: out.current ?? current,
        currentVersion: Number(out.current_version),
      };
    }
    if (out?.ok !== true) {
      return { ok: false, status: 500, error: String(out?.error ?? 'transition_failed') };
    }
    return {
      ok: true,
      version: Number(out.version),
      canonicalState: target.canonical,
      nativeStatus: target.native,
    };
  } catch (err) {
    return { ok: false, status: 500, error: 'supabase_unreachable', detail: String(err) };
  }
}

// ---------------------------------------------------------------------------
// CortexOS native tasks
// ---------------------------------------------------------------------------

/**
 * Native tasks go through the bus CLI, which is where the contract is enforced
 * for that store. The dashboard does not re-implement the rules and does not
 * write the task JSON itself — the PUT branch that used to do exactly that is
 * the writer that would have silently defeated the whole package.
 */
function transitionNative(req: TransitionRequest): TransitionOutcome {
  const target = resolveTarget('cortexos_tasks', req.to);
  if (!target) return { ok: false, status: 400, error: 'unmappable_target_state', detail: req.to };

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: req.org ?? '',
  };

  const script = target.native === 'completed' ? 'complete-task.sh' : 'update-task.sh';
  const args = target.native === 'completed'
    ? [req.taskId, String(req.evidence?.result ?? req.reason ?? '')]
    : [req.taskId, target.native];

  const result = spawnSync('bash', [path.join(frameworkRoot, 'bus', script), ...args], {
    encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe',
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '');
    // The bus surfaces a version conflict by name; translate it into the same
    // 409 the Supabase branch produces so the UI has one behavior to handle.
    if (/version conflict/i.test(stderr)) {
      return { ok: false, status: 409, error: 'version_conflict', current: null };
    }
    if (/not found/i.test(stderr)) {
      return { ok: false, status: 404, error: 'task_not_found' };
    }
    return { ok: false, status: 500, error: 'transition_failed', detail: stderr.slice(0, 500) };
  }

  return { ok: true, canonicalState: target.canonical, nativeStatus: target.native };
}

/** The one entry point. Routes on which store owns the record. */
export async function transitionTask(req: TransitionRequest): Promise<TransitionOutcome> {
  const source = sourceForTaskId(req.taskId);
  return source === 'jarvis_tasks' ? transitionSupabase(req) : transitionNative(req);
}

/** Cheap client-visible check the board can make before sending anything.
 *  Not a substitute for the store's own validation — proof requirements are
 *  only knowable at the boundary that holds the record. */
export function canMove(source: TaskSource, from: string, to: CanonicalState): boolean {
  return isAllowedMove(toCanonical(source, from), to);
}
