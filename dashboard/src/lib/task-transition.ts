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
  legalTransitionsFrom,
  resolveInteractivePath,
  checkReady,
  missingContractFields,
  type CanonicalState,
  type TaskSource,
} from '@/lib/data/transition-contract';

/**
 * Every transition that reaches this module came from a person at the board or
 * from an HTTP client acting as one. That makes it INTERACTIVE, and interactive
 * transitions are contract-enforced regardless of the per-source shadow flag:
 * the flag exists to migrate legacy background writers one at a time, not to let
 * a dashboard click bypass the rules (plan §4, §12).
 *
 * This is a constant on purpose. It is never read from the request body, a
 * header, or a query parameter — a caller cannot downgrade itself to `writer`
 * and buy the shadow window, because nothing on the wire is consulted. The only
 * way to get `writer` treatment is to be a process that calls the bus CLI
 * without `--origin`, which is exactly the population being migrated.
 */
const ORIGIN = 'interactive' as const;

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
  /**
   * Contract fields the person supplied inline for a record that predates the
   * contract. The UPGRADE path: the task stops being legacy and every later
   * transition is judged on the merits.
   */
  fields?: {
    outcome?: string;
    acceptanceCriteria?: string[];
    humanAccountableId?: string;
    agentRoleId?: string;
  };
  /**
   * The person's explicit waiver of fields a legacy record never had. The
   * FALLBACK path. Audited, never silent, and powerless over dependencies, the
   * state graph, or the completion proof gate.
   */
  grandfather?: { actor?: string; reason?: string };
  /**
   * The native status the caller believes the record is in, from the board's
   * own projection. Used only to CHOOSE a route; the owning store re-reads the
   * canonical record and refuses the move if this was stale, so a wrong guess
   * costs a refusal, never a bad write.
   */
  fromNativeStatus?: string;
}

export type TransitionOutcome =
  | { ok: true; version?: number; canonicalState: CanonicalState; nativeStatus: string }
  | { ok: false; status: 409; error: 'version_conflict'; current: Record<string, unknown> | null; currentVersion?: number }
  | {
      ok: false;
      status: 422;
      error: 'contract_violation';
      /** A sentence for the person, naming what is legal from here. */
      message: string;
      detail?: string;
      violation: string;
      legalTransitions: CanonicalState[];
      /** Contract fields the record does not have. Present so the board can
       *  offer the form that supplies them instead of a dead end. */
      missing?: string[];
      /** The record predates the contract and is missing required fields. */
      legacy?: boolean;
      /** A human may waive these particular gaps on this record. */
      waivable?: boolean;
      /** What the person can actually do about it, in order of preference. */
      remedies?: ('supply_fields' | 'grandfather')[];
    }
  | { ok: false; status: 400 | 404 | 500; error: string; detail?: string };

/** Human words for a canonical state, so a refusal reads as a sentence rather
 *  than an enum dump. Kept deliberately close to the lane names on the board. */
function stateLabel(state: string): string {
  return state.replace(/_/g, ' ');
}

/** Turn a contract refusal into the one shape the API and the board render. */
export function contractRefusal(
  from: CanonicalState | string,
  to: CanonicalState | string,
  violation: string,
  detail?: string,
  extra: { missing?: string[]; legacy?: boolean; waivable?: boolean } = {},
): Extract<TransitionOutcome, { status: 422 }> {
  const legal = legalTransitionsFrom(from as CanonicalState);
  const reason =
    violation === 'illegal_transition'
      ? `"${stateLabel(String(from))}" cannot move to "${stateLabel(String(to))}".`
      : `${detail ?? violation}`;
  const options = legal.length
    ? ` Legal moves from "${stateLabel(String(from))}": ${legal.map(stateLabel).join(', ')}.`
    : ` Nothing can move out of "${stateLabel(String(from))}" — it is a terminal state.`;

  // A refusal that only names the rule leaves the person stuck. When the record
  // is simply missing information, say which information and what they can do
  // about it — that is the difference between a wall and a form.
  // A refusal of the waiver itself is about the waiver, not about the record's
  // gaps — say so rather than repeating the missing-fields sentence.
  if (violation.startsWith('missing_grandfather')) {
    return {
      ok: false,
      status: 422,
      error: 'contract_violation',
      message: detail ?? 'A waiver has to name a person and record why.',
      detail,
      violation,
      legalTransitions: legal,
      ...(extra.missing?.length ? { missing: extra.missing } : {}),
      ...(extra.legacy !== undefined ? { legacy: extra.legacy } : {}),
      ...(extra.waivable !== undefined ? { waivable: extra.waivable } : {}),
      remedies: ['supply_fields', 'grandfather'],
    };
  }

  const missing = extra.missing ?? [];
  const remedies: ('supply_fields' | 'grandfather')[] = missing.length
    ? extra.waivable ? ['supply_fields', 'grandfather'] : ['supply_fields']
    : [];
  const guidance = missing.length
    ? ` This task is missing ${missing.join(' and ')}.`
      + (extra.legacy
        ? ' It predates the work contract, so nothing ever asked for them —'
          + ' supply them now and the task moves as ordinary contract work.'
        : ' It was created under the work contract, so these have to be filled in.')
    : '';

  return {
    ok: false,
    status: 422,
    error: 'contract_violation',
    message: missing.length
      ? `This move was refused by the work contract.${guidance}`
      : `This move was refused by the work contract. ${reason}${options}`,
    detail,
    violation,
    legalTransitions: legal,
    ...(missing.length ? { missing } : {}),
    ...(extra.legacy !== undefined ? { legacy: extra.legacy } : {}),
    ...(extra.waivable !== undefined ? { waivable: extra.waivable } : {}),
    ...(remedies.length ? { remedies } : {}),
  };
}

/**
 * The cheap legality half, applied before anything is written.
 *
 * Completion is a TWO-step contract move (doing -> verify -> done), so a
 * request to finish work that is under way is judged on that path rather than
 * on the single hop `doing -> done`, which the contract rightly does not list.
 * The proof each leg costs is checked by the store's own boundary.
 */
export function interactiveLegalityRefusal(
  from: CanonicalState,
  to: CanonicalState,
): Extract<TransitionOutcome, { status: 422 }> | null {
  return resolveInteractivePath(from, to) ? null : contractRefusal(from, to, 'illegal_transition');
}

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

  // The version the caller read. There is deliberately NO fallback to the
  // current version: substituting it turned every versionless call into a
  // blind write over whoever got there first, which is precisely the failure
  // optimistic concurrency exists to prevent. transitionTask() refuses a
  // request without one before we ever get here.
  const expected = req.expectedVersion;
  let current: Record<string, unknown> | null = null;
  try {
    const res = await fetch(
      `${supaUrl}/rest/v1/tasks?id=eq.${numericId}&select=*`,
      { headers, cache: 'no-store' },
    );
    const rows = res.ok ? await res.json() : [];
    current = rows[0] ?? null;
    if (!current) return { ok: false, status: 404, error: 'task_not_found' };
  } catch (err) {
    return { ok: false, status: 500, error: 'supabase_unreachable', detail: String(err) };
  }

  // The RPC is a compare-and-set, not a validator: it will happily write any
  // status it is handed. For this store the dashboard IS the boundary, so the
  // legality of the move AND the proof each leg costs are checked HERE, before
  // any write, using the same fixture the core validator reads.
  const fromCanonical = toCanonical('jarvis_tasks', String(current.status ?? ''));

  // One gesture, possibly several legs. "Start" on a backlog card is a request
  // to go through Ready, not a request to invent a backlog -> doing edge.
  const path = resolveInteractivePath(fromCanonical, target.canonical);
  if (!path) return contractRefusal(fromCanonical, target.canonical, 'illegal_transition');

  const item = supabaseContractItem(current, req.fields);

  // Gate the Ready leg before writing anything. A refusal here carries what the
  // record is missing, so the board can offer the form rather than a wall.
  let grandfathered: { waived: string[]; actor: string; reason: string } | null = null;
  if (path.includes('ready')) {
    const ready = checkReady(item, {
      grandfather: req.grandfather ? { actor: req.grandfather.actor ?? req.actor, ...req.grandfather } : undefined,
    });
    if (!ready.ok) {
      return contractRefusal(fromCanonical, 'ready', ready.error ?? 'contract_violation', ready.detail, {
        missing: ready.missing,
        legacy: ready.legacy,
        waivable: ready.waivable,
      });
    }
    if (ready.grandfathered) {
      grandfathered = {
        waived: ready.waived ?? [],
        actor: req.grandfather?.actor ?? req.actor,
        reason: req.grandfather?.reason ?? '',
      };
    }
  }

  // Upgrading a record or recording a waiver has to happen in the same
  // compare-and-set as the move it authorises, which is what task_transition_v2
  // exists for. An install that has not run migration 005 says so plainly
  // rather than half-writing anything.
  const needsV2 = Boolean(grandfathered) || fieldPatch(req.fields) !== null;

  let version = expected as number;
  let lastNative = String(current.status ?? '');
  for (const [index, hop] of path.entries()) {
    const native = toNative('jarvis_tasks', hop);
    if (!native) return { ok: false, status: 400, error: 'unmappable_target_state', detail: hop };
    // The upgrade and the waiver belong to the leg that needed them — the first
    // one — and must not be replayed on every hop.
    const first = index === 0;
    const useV2 = needsV2 && first;
    const body: Record<string, unknown> = {
      p_task_id: numericId,
      p_expected_version: version,
      p_new_status: native,
      p_actor: req.actor,
      p_evidence: hop === target.canonical ? (req.evidence ?? {}) : {},
      p_reason: hop === target.canonical ? (req.reason ?? null) : `leg of ${fromCanonical} -> ${target.canonical}`,
    };
    if (useV2) {
      body.p_fields = fieldPatch(req.fields);
      body.p_grandfather = grandfathered
        ? { ...grandfathered, was_missing: missingContractFields(supabaseContractItem(current)) }
        : null;
      body.p_canonical_to = hop;
    }

    try {
      const res = await fetch(`${supaUrl}/rest/v1/rpc/${useV2 ? 'task_transition_v2' : 'task_transition'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (useV2 && (res.status === 404 || res.status === 400)) {
          return {
            ok: false, status: 500, error: 'legacy_path_unavailable',
            detail:
              'This task needs the legacy-work path (migration 005_legacy_grandfather.sql), which is not installed '
              + 'on this database. Nothing was changed.',
          };
        }
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
      version = Number(out.version);
      lastNative = native;
    } catch (err) {
      return { ok: false, status: 500, error: 'supabase_unreachable', detail: String(err) };
    }
  }

  return {
    ok: true,
    version,
    canonicalState: target.canonical,
    nativeStatus: lastNative,
  };
}

/**
 * The contract's view of a Supabase task row.
 *
 * `outcome` falls back to the payload title, the same default the native store
 * uses at creation: the title IS the stated outcome for ordinary work, and
 * pretending otherwise would make every row fail a check it actually passes.
 * Fields the caller is supplying right now are folded in, so the gate judges the
 * record as it will stand after the write rather than as it stands before it.
 */
export function supabaseContractItem(
  row: Record<string, unknown>,
  fields?: TransitionRequest['fields'],
): Record<string, unknown> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const criteria = Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [];
  const supplied = (fields?.acceptanceCriteria ?? []).filter((c) => String(c ?? '').trim().length > 0);
  return {
    outcome: fields?.outcome?.trim() || row.outcome || payload.title || null,
    agent_role_id: fields?.agentRoleId?.trim() || row.agent_role_id || null,
    human_accountable_id: fields?.humanAccountableId?.trim() || row.human_accountable_id || null,
    acceptance_criteria: supplied.length ? supplied : criteria,
    contract_version: row.contract_version ?? null,
  };
}

/** The subset of columns the inline form may write, or null when it writes
 *  nothing. Deliberately not a general task editor. */
export function fieldPatch(fields: TransitionRequest['fields']): Record<string, unknown> | null {
  if (!fields) return null;
  const patch: Record<string, unknown> = {};
  if (fields.outcome?.trim()) patch.outcome = fields.outcome.trim();
  const criteria = (fields.acceptanceCriteria ?? [])
    .map((c) => String(c ?? '').trim())
    .filter((c) => c.length > 0);
  if (criteria.length) patch.acceptance_criteria = criteria;
  if (fields.humanAccountableId?.trim()) patch.human_accountable_id = fields.humanAccountableId.trim();
  if (fields.agentRoleId?.trim()) patch.agent_role_id = fields.agentRoleId.trim();
  return Object.keys(patch).length ? patch : null;
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

  // One gesture, possibly several legs — the core bus judges each on its own
  // terms. Completion still goes through complete-task.sh, which owns the
  // doing -> verify -> done pair; everything else walks the resolved path.
  if (target.native !== 'completed') {
    const from = toCanonical('cortexos_tasks', String(currentNativeStatus(req) ?? ''));
    const path = resolveInteractivePath(from, target.canonical);
    if (path && path.length > 1) return transitionNativePath(req, path, frameworkRoot, env);
  }

  const script = target.native === 'completed' ? 'complete-task.sh' : 'update-task.sh';
  const args = target.native === 'completed'
    ? [req.taskId, String(req.evidence?.result ?? req.reason ?? '')]
    : [req.taskId, target.native];
  if (target.native !== 'completed') args.push('--canonical', target.canonical, '--actor', req.actor);
  // Optimistic concurrency reaches the core bus, which compares it under the
  // task lock and throws a version conflict. Before this the dashboard read a
  // version, sent it to this function, and dropped it on the floor at the CLI
  // boundary — so native tasks were blind writes no matter what the UI sent.
  if (req.expectedVersion !== undefined) {
    args.push('--expected-version', String(req.expectedVersion));
  }
  const legacyArgs = legacyPathArgs(req);
  args.push(...legacyArgs);

  // Completion carries the evidence the contract asks for. The verifier is the
  // person who clicked, recorded by name — that is a true statement about who
  // signed this off, and it is the only part of the proof a UI action can
  // honestly supply. Acceptance-check results are NOT invented here: a task
  // that declares acceptance criteria and has no recorded results is refused,
  // which is the whole point of "no verified Done without proof".
  if (target.native === 'completed' && req.evidence && Object.keys(req.evidence).length > 0) {
    args.push('--evidence', JSON.stringify(req.evidence));
  }
  // Interactive origin: enforced regardless of the source's shadow flag.
  args.push('--origin', ORIGIN);

  const result = spawnSync('bash', [path.join(frameworkRoot, 'bus', script), ...args], {
    encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe',
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '');
    // A contract refusal comes back as a structured line so the board can name
    // the rule and the legal moves rather than showing "transition failed".
    const refusal = parseContractRefusal(stderr);
    if (refusal) return refusal;
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

/**
 * The current native status of a native task, read from the SQLite projection.
 *
 * A projection is good enough to CHOOSE a route: the core bus re-reads the
 * canonical record under a lock and refuses the move if the projection was
 * stale, so a wrong guess here costs a refusal, never a bad write.
 */
function currentNativeStatus(req: TransitionRequest): string | null {
  if (req.fromNativeStatus) return req.fromNativeStatus;
  return null;
}

/** Flags that carry the inline-supplied fields and the recorded waiver to the
 *  core bus, which owns the audit. Empty when this is an ordinary move. */
function legacyPathArgs(req: TransitionRequest): string[] {
  const args: string[] = [];
  const patch = req.fields;
  if (patch && (patch.outcome || patch.acceptanceCriteria?.length || patch.humanAccountableId || patch.agentRoleId)) {
    args.push('--fields', JSON.stringify(patch));
  }
  if (req.grandfather) {
    args.push('--grandfather', JSON.stringify({ actor: req.grandfather.actor ?? req.actor, reason: req.grandfather.reason }));
  }
  return args;
}

/**
 * Walk a multi-leg path against the native store, one bus call per leg.
 *
 * Legs are separate transitions on purpose: each is validated, versioned and
 * journalled in its own right, so the history reads "backlog -> ready (waived
 * by scott, reason ...)" then "ready -> doing" rather than a single hop that
 * quietly skipped the gate. A refused leg stops the walk and the earlier legs
 * stand, which is the honest outcome — they were legal and they happened.
 */
function transitionNativePath(
  req: TransitionRequest,
  legs: CanonicalState[],
  frameworkRoot: string,
  env: NodeJS.ProcessEnv,
): TransitionOutcome {
  let last: TransitionOutcome = { ok: false, status: 500, error: 'empty_path' };
  for (const [index, hop] of legs.entries()) {
    const native = toNative('cortexos_tasks', hop);
    if (!native) return { ok: false, status: 400, error: 'unmappable_target_state', detail: hop };
    const args = [req.taskId, native, '--canonical', hop, '--origin', ORIGIN, '--actor', req.actor];
    // The upgrade and the waiver belong to the leg that needed them — and so
    // does the version. Only the first leg is compared against what the caller
    // read; later legs follow versions this walk has just created.
    if (index === 0) {
      args.push(...legacyPathArgs(req));
      if (req.expectedVersion !== undefined) {
        args.push('--expected-version', String(req.expectedVersion));
      }
    }
    const result = spawnSync('bash', [path.join(frameworkRoot, 'bus', 'update-task.sh'), ...args], {
      encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe',
    });
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '');
      const refusal = parseContractRefusal(stderr);
      if (refusal) return refusal;
      if (/version conflict/i.test(stderr)) {
        return { ok: false, status: 409, error: 'version_conflict', current: null };
      }
      if (/not found/i.test(stderr)) return { ok: false, status: 404, error: 'task_not_found' };
      return { ok: false, status: 500, error: 'transition_failed', detail: stderr.slice(0, 500) };
    }
    last = { ok: true, canonicalState: hop, nativeStatus: native };
  }
  return last;
}

/**
 * Read the CLI's structured refusal line. The CLI prints
 * `CONTRACT_REFUSED {json}` on stderr and exits non-zero; anything else on
 * stderr is an ordinary failure and is left alone.
 */
export function parseContractRefusal(
  stderr: string,
): Extract<TransitionOutcome, { status: 422 }> | null {
  const line = stderr.split('\n').find((l) => l.startsWith('CONTRACT_REFUSED '));
  if (!line) return null;
  try {
    const payload = JSON.parse(line.slice('CONTRACT_REFUSED '.length)) as {
      from?: string; to?: string; error?: string; detail?: string;
      missing?: string[]; legacy?: boolean; waivable?: boolean;
    };
    return contractRefusal(
      payload.from ?? 'unknown',
      payload.to ?? 'unknown',
      payload.error ?? 'contract_violation',
      payload.detail,
      { missing: payload.missing, legacy: payload.legacy, waivable: payload.waivable },
    );
  } catch {
    return null;
  }
}

/** The one entry point. Routes on which store owns the record.
 *
 *  A request with no expectedVersion is refused here rather than being given
 *  the current version to write over. Both stores implement compare-and-set
 *  correctly; the only way a concurrent change was ever lost was a caller that
 *  did not say what it had read, so that case fails closed. */
export async function transitionTask(req: TransitionRequest): Promise<TransitionOutcome> {
  if (req.expectedVersion === undefined) {
    return {
      ok: false,
      status: 400,
      error: 'expected_version_required',
      detail:
        'This move did not say which version of the task it was made against, so it was refused '
        + 'rather than written over whatever changed since. Reload the task and try again.',
    };
  }
  const source = sourceForTaskId(req.taskId);
  return source === 'jarvis_tasks' ? transitionSupabase(req) : transitionNative(req);
}

/** Cheap client-visible check the board can make before sending anything.
 *  Not a substitute for the store's own validation — proof requirements are
 *  only knowable at the boundary that holds the record. */
export function canMove(source: TaskSource, from: string, to: CanonicalState): boolean {
  return isAllowedMove(toCanonical(source, from), to);
}
