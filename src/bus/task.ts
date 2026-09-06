import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Task, Priority, TaskStatus, BusPaths, StaleTaskReport, ArchiveReport } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomDigits } from '../utils/random.js';
import { validatePriority, validateTaskId } from '../utils/validate.js';
import { logEvent } from './event.js';
import {
  mutateTask,
  acquireLease,
  readMeta,
  appendTaskEvent,
  withTaskLock,
  LeaseHeldError,
  type TaskContractMeta,
} from './task-store.js';
import { supersedeMessagesForTask, type SupersedeCause } from './inbox-supersede.js';
import { toCanonical, toNative, guardTransition, checkTransition, effectiveMode, ContractViolation, loadContract, missingContractFields, isLegacyItem, type CanonicalState, type Evidence, type GrandfatherRequest, type TransitionOrigin } from './task-contract.js';

/**
 * Create a new task. Identical JSON format to bash create-task.sh.
 */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: {
    description?: string;
    assignee?: string;
    priority?: Priority;
    project?: string;
    needsApproval?: boolean;
    dueDate?: string;
    blockedBy?: string[];
    blocks?: string[];
    /** OS-02 accountability. Every field is optional so no existing caller
     *  breaks; a task created without them is non-dispatchable and surfaces in
     *  the unassigned-recovery queue rather than being quietly routed. */
    contract?: {
      outcome?: string;
      humanAccountableId?: string;
      agentRoleId?: string;
      acceptanceCriteria?: unknown[];
      authorizationScope?: string;
      attemptLimit?: number;
      impactClass?: string;
      workType?: string;
    };
  } = {},
): string {
  const {
    description = '',
    assignee = agentName,
    priority = 'normal',
    project = '',
    needsApproval = false,
    dueDate = '',
    blockedBy = [],
    blocks = [],
    contract = {},
  } = options;

  validatePriority(priority);

  const epoch = Date.now();
  // 8 digits: same-millisecond collision probability is ~1e-8 instead of ~1e-3.
  // Two createTask calls in the same ms with a 3-digit suffix collided in CI
  // (run 25618845172), making the new task's id equal to its declared blocker
  // and tripping detectCycleOrThrow with "X ultimately blocks itself via X".
  const rand = randomDigits(8);
  const taskId = `task_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Dependency validation FIRST — a cycle must never be allowed to
  // leave partial state on disk. Earlier iteration wrote the task
  // JSON before detectCycleOrThrow ran, so a failed cycle check left
  // a dangling task with a one-way edge and no symmetric peer update.
  // Order is now: validate → write task → mutate peers → audit. The
  // cycle walker gets a `virtual` description of the not-yet-written
  // task so chains that pass through it are still detectable.
  const virtualTask = { id: taskId, blocked_by: blockedBy };
  if (blockedBy.length) detectCycleOrThrow(paths, taskId, blockedBy, virtualTask);
  if (blocks.length) {
    for (const downId of blocks) detectCycleOrThrow(paths, downId, [taskId], virtualTask);
  }

  const task: Task = {
    id: taskId,
    title,
    description,
    type: 'agent',
    needs_approval: needsApproval,
    status: 'pending',
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
    ...(blockedBy.length ? { blocked_by: [...blockedBy] } : {}),
    ...(blocks.length ? { blocks: [...blocks] } : {}),
  };

  // OS-02 accountability fields. Additive: a reader that predates the contract
  // ignores them, and `readMeta` supplies these same defaults for a legacy file
  // that never had them. `outcome` defaults to the title rather than being left
  // empty, because "Ready requires a stated outcome" must be satisfiable by an
  // ordinary create-task call rather than only by a contract-aware caller.
  const contractFields: Record<string, unknown> = {
    version: 1,
    // The marker that says this record was created UNDER the contract, so its
    // required fields are enforced with no legacy path available. Structural,
    // not chronological (see isLegacyItem in task-contract.ts).
    contract_version: loadContract().contract_version,
    fence_token: 0,
    lease_owner: null,
    lease_expires_at: null,
    canonical_state: toCanonical('cortexos_tasks', 'pending'),
    source_ref: `cortexos_tasks:${taskId}`,
    author: agentName,
    outcome: contract.outcome ?? title,
    human_accountable_id: contract.humanAccountableId ?? null,
    agent_role_id: contract.agentRoleId ?? null,
    acceptance_criteria: contract.acceptanceCriteria ?? [],
    dependency_ids: [...blockedBy],
    authorization_scope: contract.authorizationScope ?? null,
    attempt_limit: contract.attemptLimit ?? null,
    impact_class: contract.impactClass ?? null,
    work_type: contract.workType ?? 'work',
    evidence_recorded: false,
  };
  Object.assign(task as unknown as Record<string, unknown>, contractFields);

  const taskFilePath = join(paths.taskDir, `${taskId}.json`);
  ensureDir(paths.taskDir);
  atomicWriteSync(taskFilePath, JSON.stringify(task));
  appendTaskEvent(paths, taskFilePath, taskId, {
    version: 1,
    event: 'created',
    actor: agentName,
    payload: { title, assignee, priority, canonical_state: 'backlog' },
  });

  // Cycle-safe now: validation already passed, so symmetric-edge
  // maintenance is just mutating peer JSONs.
  for (const depId of blockedBy) addSymmetricEdge(paths, depId, 'blocks', taskId);
  for (const downId of blocks) addSymmetricEdge(paths, downId, 'blocked_by', taskId);

  appendTaskAudit(paths, taskId, { event: 'create', agent: agentName, to: 'pending', note: title });

  return taskId;
}

/**
 * Mutate an existing task to add an edge to its blocks/blocked_by list.
 * No-op if the peer id is already present. Used to maintain symmetric
 * edges when a new task declares its dependencies.
 */
function addSymmetricEdge(
  paths: BusPaths,
  taskId: string,
  field: 'blocks' | 'blocked_by',
  peerId: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return; // Peer task missing — surfaced at resolution time.
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
    const list = task[field] ?? [];
    if (!list.includes(peerId)) {
      task[field] = [...list, peerId];
      atomicWriteSync(filePath, JSON.stringify(task));
    }
  } catch { /* best-effort */ }
}

/**
 * Walk the dependency DAG rooted at `newTaskId` depth-first along its
 * proposed `blocked_by` edges and throw if the walk re-enters
 * `newTaskId`. Only checks the `blocked_by` direction — cycles are
 * topologically symmetric, so walking one direction catches them all.
 *
 * `virtual` lets the caller describe a task that does not yet exist
 * on disk (the task being created). Without this, running the check
 * BEFORE the task JSON is written would miss cycles that pass
 * through the new task itself.
 */
function detectCycleOrThrow(
  paths: BusPaths,
  newTaskId: string,
  initialBlockers: string[],
  virtual?: { id: string; blocked_by: string[] },
): void {
  const seen = new Set<string>();
  const stack = [...initialBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === newTaskId) {
      throw new Error(`Dependency cycle: ${newTaskId} ultimately blocks itself via ${cur}`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (virtual && cur === virtual.id) {
      if (virtual.blocked_by.length) stack.push(...virtual.blocked_by);
      continue;
    }
    const filePath = findTaskFile(paths, cur);
    if (!filePath) continue; // Missing peer is not a cycle, just a dangling ref.
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
      if (task.blocked_by?.length) stack.push(...task.blocked_by);
    } catch { /* skip */ }
  }
}

/**
 * Resolve blockers for `taskId`: returns the list of tasks in its
 * `blocked_by` that are NOT yet completed. Empty list = good to go.
 * A missing peer is reported as `{ id, status: 'missing' }` so callers
 * can distinguish "dependency cleared" from "dependency references a
 * task that no longer exists".
 */
export function checkTaskDependencies(
  paths: BusPaths,
  taskId: string,
): Array<{ id: string; status: TaskStatus | 'missing' }> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return [];
  let task: Task;
  try { task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task; }
  catch { return []; }
  const deps = task.blocked_by ?? [];
  const open: Array<{ id: string; status: TaskStatus | 'missing' }> = [];
  for (const depId of deps) {
    const depPath = findTaskFile(paths, depId);
    if (!depPath) { open.push({ id: depId, status: 'missing' }); continue; }
    try {
      const dep = JSON.parse(readFileSync(depPath, 'utf-8')) as Task;
      if (dep.status !== 'completed') open.push({ id: depId, status: dep.status });
    } catch {
      open.push({ id: depId, status: 'missing' });
    }
  }
  return open;
}

/**
 * Find the on-disk path of a task file by ID, supporting cross-org lookup.
 *
 * cortextOS's standard dispatch pattern is an orchestrator in one org
 * filing tasks that get assigned to specialists in other orgs. Before
 * this helper existed, updateTask
 * and completeTask hardcoded `join(paths.taskDir, taskId + '.json')` — which
 * points at the CURRENT agent's org tasks dir — so the specialist could not
 * drive the lifecycle of any task that was filed from a sibling org. Every
 * cross-org assignment required a manual workaround dance where the filer
 * ran update/complete on behalf of the assignee.
 *
 * This helper fixes that by using a two-tier lookup:
 *
 *   1. Fast path: check the caller's OWN org tasks dir first. Most tasks
 *      live there and this check pays zero scan cost when it hits.
 *   2. Fallback: scan every sibling org under `<ctxRoot>/orgs/*` for a
 *      matching task file. Only runs when the fast path missed, so
 *      same-org operations take no perf hit.
 *
 * Task IDs are generated as `task_<epoch_ms>_<3digit_random>` so real
 * collisions are effectively impossible — but if the scan ever finds the
 * same ID in multiple orgs (e.g. due to a bug in ID generation or a manual
 * file copy), we warn loudly naming the task ID, the match count, AND the
 * org names so an operator can investigate without having to grep the IDs
 * themselves. We still return the first match and keep operations flowing;
 * erroring on a theoretical collision would be worse UX than the warn.
 *
 * Exported because the helper is a useful primitive for any future caller
 * that needs cross-org task lookup (e.g. a hypothetical `get-task` command,
 * task-graph visualization, or cross-org list-tasks flag).
 */
export function findTaskFile(paths: BusPaths, taskId: string): string | null {
  // Reject path-traversal task ids before they reach any join() below. This is
  // the chokepoint for updateTask/claimTask/completeTask/checkTaskDependencies.
  validateTaskId(taskId);
  // Fast path: same-org lookup.
  const sameOrg = join(paths.taskDir, `${taskId}.json`);
  if (existsSync(sameOrg)) return sameOrg;

  // Fallback: cross-org scan.
  const orgsRoot = join(paths.ctxRoot, 'orgs');
  const matches: Array<{ path: string; org: string }> = [];
  try {
    for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(orgsRoot, entry.name, 'tasks', `${taskId}.json`);
      if (existsSync(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    return null; // orgs/ missing or unreadable
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(', ');
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). ` +
      `Operating on the first match in org '${matches[0].org}'. ` +
      `Review task ID generation if this recurs.`,
    );
  }
  return matches[0].path;
}

/**
 * Update a task's status. Matches bash update-task.sh behavior, with the
 * cross-org fallback from findTaskFile so an assignee in one org can drive
 * the lifecycle of a task filed by an orchestrator in a sibling org.
 */
export function updateTask(
  paths: BusPaths,
  taskId: string,
  status: TaskStatus,
  options: TransitionOptions = {},
): void {
  transitionTask(paths, taskId, status, options);
}

/** Everything a contract-aware caller may bring to a transition. All optional,
 *  so `updateTask(paths, id, status)` still works exactly as before. */
export interface TransitionOptions {
  /** Who is doing this. Defaults to the task's current assignee. */
  actor?: string;
  /** Proof. Required to leave `doing`, and to reach `done`. */
  evidence?: Evidence;
  /** Optimistic concurrency: refuse if the task has moved since you read it. */
  expectedVersion?: number;
  /** Lease proof, for a worker that claimed this task. */
  fenceToken?: number;
  reason?: string;
  /** Ids of dependencies the caller knows are still open. */
  unsatisfiedDependencies?: string[];
  /**
   * Where this transition came from.
   *
   * This module IS the legacy writer surface — the bus CLI, the agent fleet and
   * the shell scripts all land here — so an omitted origin means `writer` and
   * keeps honouring the per-source shadow flag. That is the migration window
   * plan §4 asks for, and nothing else in-process is a human.
   *
   * A human-facing boundary must say so explicitly: the dashboard's transition
   * service passes `interactive` as a constant it never reads off the wire, and
   * the CLI forwards `--origin interactive` for it. Interactive transitions are
   * enforced regardless of the flag. The pure guard in task-contract.ts defaults
   * the other way — enforced — so a NEW caller that forgets to declare an
   * origin fails closed rather than silently inheriting the writer's window.
   */
  origin?: TransitionOrigin;
  /**
   * Contract fields a human supplied at the boundary for a record that never
   * had them. This is the UPGRADE path: the task stops being legacy, and every
   * later transition is judged on the merits like any other. Written under the
   * same lock as the transition and recorded as its own journal event.
   */
  fields?: {
    outcome?: string;
    acceptanceCriteria?: unknown[];
    humanAccountableId?: string;
    agentRoleId?: string;
  };
  /**
   * A named human's explicit waiver of the fields a legacy record is missing.
   * The FALLBACK path, used when the information genuinely is not available.
   * Marks the task, so its completion gate can never read an empty acceptance
   * list as "nothing to check".
   */
  grandfather?: GrandfatherRequest;
  /**
   * The canonical state this transition is really aiming at.
   *
   * Needed because the native vocabulary is coarser than the canonical one:
   * `backlog` and `ready` are both `pending`, and `doing` and `verify` are both
   * `in_progress`. Deriving the target from the native word alone would judge a
   * backlog -> ready move as a no-op and skip the Ready gate entirely. Refused
   * if it does not map back to the native status being written, so it can never
   * be used to claim a state the store is not actually in.
   */
  canonicalState?: CanonicalState;
  /** Suppress the legacy `tasks/audit/` line for a step that a higher-level
   *  operation will log itself. The OS-02 event journal always records it; this
   *  only keeps the old audit log reading exactly as it did before, so existing
   *  consumers of `readTaskAudit` see no new entries. */
  suppressLegacyAudit?: boolean;
}

/**
 * The one native-task transition path. Validates against the OS-02 contract,
 * then writes under a lock with a version bump and a journal entry.
 *
 * The status argument stays in the NATIVE vocabulary. Callers all over the
 * codebase and the bus shell scripts pass 'completed' / 'blocked'; rewriting
 * them to canonical words would be exactly the enum rewrite plan §3 forbids.
 * The canonical state is derived and stored alongside, never instead.
 */
export function transitionTask(
  paths: BusPaths,
  taskId: string,
  status: TaskStatus,
  options: TransitionOptions = {},
): { version: number; canonicalState: CanonicalState } {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  let produced!: { version: number; canonicalState: CanonicalState };
  let previousStatus: TaskStatus | undefined;
  // Journal entries this transition earns beyond the status change itself.
  // Filled inside the mutation and written under the same lock and version.
  const journal: { event: string; payload?: Record<string, unknown> }[] = [];
  let beforeMissing: string[] = [];

  const result = mutateTask(
    paths,
    filePath,
    taskId,
    {
      actor: options.actor ?? 'unknown',
      event: options.canonicalState ? `status:${options.canonicalState}` : `status:${status}`,
      expectedVersion: options.expectedVersion,
      fenceToken: options.fenceToken,
      canonicalState: options.canonicalState,
      extraEvents: journal,
    },
    (task, meta) => {
      previousStatus = task.status as TaskStatus;
      const from = meta.canonical_state ?? toCanonical('cortexos_tasks', previousStatus);
      const to = options.canonicalState ?? toCanonical('cortexos_tasks', status);
      if (options.canonicalState && toNative('cortexos_tasks', options.canonicalState) !== status) {
        throw new Error(
          `canonicalState ${options.canonicalState} does not map to native status '${status}'`,
        );
      }

      // The upgrade path. Fields a human just supplied are applied BEFORE the
      // contract is consulted, so the transition is judged on the record as it
      // now stands rather than on the gap the person just closed. Stamping
      // contract_version is what stops this task ever taking the legacy path
      // again — the point of the upgrade path is that the system improves one
      // touched task at a time.
      beforeMissing = missingContractFields(contractItemFrom(task, meta));
      const wasLegacy = isLegacyItem(contractItemFrom(task, meta));
      const supplied = applyContractFields(task, options.fields);
      if (supplied.length) {
        task.contract_version = loadContract().contract_version;
        journal.push({
          event: 'legacy_upgraded',
          payload: {
            actor: options.actor ?? 'unknown',
            supplied,
            was_missing: beforeMissing,
            was_legacy: wasLegacy,
            from,
            to,
          },
        });
      }

      // Validate against the contract. In shadow mode this logs and returns;
      // in enforced mode it throws before anything is written.
      const result = guardTransition(
        'cortexos_tasks',
        from,
        to,
        contractItemFrom(task, readMeta(task)),
        options.evidence ?? {},
        {
          unsatisfied_dependencies: options.unsatisfiedDependencies,
          grandfather: options.grandfather,
        },
        { origin: options.origin ?? 'writer' },
      );

      // The fallback path. The waiver is a fact about this record from now on,
      // not a one-off exemption that evaporates with the request.
      if (result.grandfathered) {
        task.legacy_grandfathered = true;
        task.legacy_grandfather = {
          actor: options.grandfather?.actor ?? options.actor ?? 'unknown',
          reason: options.grandfather?.reason ?? '',
          waived: result.waived ?? [],
          was_missing: beforeMissing,
          at: new Date().toISOString(),
          from,
          to,
        };
        journal.push({ event: 'legacy_grandfathered', payload: task.legacy_grandfather as Record<string, unknown> });
      }

      task.status = status;
      if (options.evidence && Object.keys(options.evidence).length > 0) {
        task.evidence = options.evidence;
        task.evidence_recorded = true;
      }
      if (options.reason) task.transition_reason = options.reason;
      if (to === 'done' || to === 'cancelled' || to === 'failed_terminal') {
        // A terminal state releases the lease: nothing should still be holding
        // a claim on work that is over.
        task.lease_owner = null;
        task.lease_expires_at = null;
      }
      produced = { version: meta.version + 1, canonicalState: to };
    },
  );

  const task = result.task as unknown as Task;

  // fix8 — work that is over must not still be sitting in somebody's inbox as
  // an instruction.
  //
  // Every door into a native task transition lands here: the bus CLI, the
  // agent fleet, the shell wrappers, and the dashboard (which spawns the CLI).
  // So this is the one place that has to know a task has just ended, and the
  // one place a cancelled assignment stops reading as live work.
  //
  // Best-effort by design: the transition itself is already durable on disk.
  // Failing the move now would report a cancel that did not happen, which is a
  // worse lie than a pointer we failed to sweep. The failure is loud on stderr
  // and the swept count is journalled, so neither outcome is silent.
  if (produced.canonicalState === 'done'
    || produced.canonicalState === 'cancelled'
    || produced.canonicalState === 'failed_terminal') {
    try {
      const swept = supersedeMessagesForTask(paths, {
        taskId,
        cause: produced.canonicalState as SupersedeCause,
        actor: options.actor ?? task.assigned_to ?? 'unknown',
        reason: options.reason ?? null,
        title: task.title ?? null,
      });
      if (swept.length > 0) {
        appendTaskEvent(paths, filePath, taskId, {
          version: produced.version,
          event: 'messages_superseded',
          actor: options.actor ?? task.assigned_to ?? 'unknown',
          payload: {
            cause: produced.canonicalState,
            count: swept.length,
            messages: swept.map((m) => ({ agent: m.agent, queue: m.queue, id: m.messageId, moved_to: m.movedTo })),
          },
        });
      }
    } catch (err) {
      console.error(
        `[bus/task] ${taskId} reached ${produced.canonicalState} but its inbox pointers could not be superseded: ${err}`,
      );
    }
  }

  if (options.suppressLegacyAudit) return produced;
  appendTaskAudit(paths, taskId, {
    event: 'update',
    agent: options.actor ?? task.assigned_to ?? 'unknown',
    from: previousStatus,
    to: status,
  });
  return produced;
}

/** Record that a task has reached `verify`: it has an artifact, but has not yet
 *  passed its acceptance checks or been signed off by an independent verifier. */
function markVerify(
  paths: BusPaths,
  filePath: string,
  taskId: string,
  actor: string,
  evidence: Evidence,
  options: TransitionOptions,
  from: CanonicalState = 'doing',
): void {
  // This leg used to write with no contract check at all, which is how a
  // `pending` task could be marched straight into verify by a UI click: the
  // only guard ran on the SECOND leg, after the first had already been
  // persisted. Validate before anything is written, so a refused completion
  // leaves the record exactly as it was.
  {
    const snapshot = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    guardTransition(
      'cortexos_tasks',
      from,
      'verify',
      contractItemFrom(snapshot, readMeta(snapshot)),
      evidence,
      {},
      { origin: options.origin ?? 'writer' },
    );
  }
  mutateTask(
    paths,
    filePath,
    taskId,
    {
      actor,
      event: 'status:verify',
      fenceToken: options.fenceToken,
      canonicalState: 'verify',
      payload: { evidence },
    },
    (task) => {
      task.status = 'in_progress';
      task.evidence = evidence;
      task.evidence_recorded = Object.keys(evidence).length > 0;
    },
  );
}

/**
 * Write contract fields a human supplied onto the stored record.
 *
 * Only the fields the contract actually requires, and only ones with a value:
 * this is the inline "fill in what is missing" form, not a general task editor,
 * and it must not become a second way to rewrite a task's ownership by accident.
 * Returns the names of what it wrote, for the journal.
 */
function applyContractFields(
  task: Record<string, unknown>,
  fields: {
    outcome?: string;
    acceptanceCriteria?: unknown[];
    humanAccountableId?: string;
    agentRoleId?: string;
  } | undefined,
): string[] {
  if (!fields) return [];
  const written: string[] = [];
  if (typeof fields.outcome === 'string' && fields.outcome.trim()) {
    task.outcome = fields.outcome.trim();
    written.push('outcome');
  }
  if (Array.isArray(fields.acceptanceCriteria)) {
    const criteria = fields.acceptanceCriteria
      .map((c) => (typeof c === 'string' ? c.trim() : c))
      .filter((c) => (typeof c === 'string' ? c.length > 0 : c != null));
    if (criteria.length) {
      task.acceptance_criteria = criteria;
      written.push('acceptance_criteria');
    }
  }
  if (typeof fields.humanAccountableId === 'string' && fields.humanAccountableId.trim()) {
    task.human_accountable_id = fields.humanAccountableId.trim();
    written.push('human_accountable_id');
  }
  if (typeof fields.agentRoleId === 'string' && fields.agentRoleId.trim()) {
    task.agent_role_id = fields.agentRoleId.trim();
    written.push('agent_role_id');
  }
  return written;
}

/** Build the contract's view of a task from the stored record. */
function contractItemFrom(task: Record<string, unknown>, meta: TaskContractMeta) {
  return {
    outcome: (meta.outcome ?? (task.title as string)) || undefined,
    type: (meta.work_type ?? 'work') as 'work' | 'obligation' | 'improvement',
    impact_class: (meta.impact_class ?? undefined) as never,
    author: meta.author ?? undefined,
    agent_role_id: meta.agent_role_id ?? undefined,
    human_accountable_id: meta.human_accountable_id ?? undefined,
    acceptance_criteria: meta.acceptance_criteria ?? [],
    dependency_ids: meta.dependency_ids ?? [],
    // Absence of contract_version is what makes a record legacy; carrying it
    // through is what lets the contract tell old work from new.
    contract_version: meta.contract_version ?? null,
    legacy_grandfathered: meta.legacy_grandfathered === true,
  };
}

/** Canonical state currently recorded for a task, for readers that want the
 *  new vocabulary without re-deriving the mapping. */
export function canonicalStateOf(paths: BusPaths, taskId: string): CanonicalState | null {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return null;
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    return readMeta(task).canonical_state ?? toCanonical('cortexos_tasks', task.status as string);
  } catch {
    return null;
  }
}

/** Native status a store will accept for a canonical state. Exported so the
 *  dashboard's Kanban can move a card by canonical lane without inventing the
 *  mapping a second time. */
export function nativeStatusFor(canonical: CanonicalState): string | undefined {
  return toNative('cortexos_tasks', canonical);
}

/**
 * One audit entry written to a task's append-only JSONL log. Every
 * status transition, claim, and completion emits one of these so the
 * full lifecycle can be replayed from disk.
 */
export interface TaskAuditEntry {
  ts: string; // ISO 8601
  event: 'create' | 'claim' | 'update' | 'complete';
  agent: string; // who caused the event
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
}

/**
 * Append one audit line to `<taskDir>/audit/<taskId>.jsonl`. Uses
 * appendFileSync so concurrent writers each get O_APPEND semantics on
 * POSIX — partial interleaving at the sub-line level is possible on
 * some filesystems for lines over PIPE_BUF, but our entries are
 * ~200 bytes, comfortably under the 4096-byte atomicity bound.
 *
 * Best-effort: a failing audit write never blocks the caller. The
 * audit log is an observability aid, not the source of truth.
 */
export function appendTaskAudit(
  paths: BusPaths,
  taskId: string,
  entry: Omit<TaskAuditEntry, 'ts'>,
): void {
  // Validate before the try so a traversal id is rejected loudly rather than
  // swallowed by the audit-never-blocks catch below.
  validateTaskId(taskId);
  try {
    const auditDir = join(paths.taskDir, 'audit');
    ensureDir(auditDir);
    const line: TaskAuditEntry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...entry,
    };
    appendFileSync(join(auditDir, `${taskId}.jsonl`), JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Never block a real operation on audit-log write failure.
  }
}

/**
 * Read all audit entries for a task in write-order. Returns empty
 * array if no audit log exists. Corrupt lines are skipped so a
 * partially-written line (rare: write crashed mid-line) does not
 * block history replay of surrounding entries.
 */
export function readTaskAudit(
  paths: BusPaths,
  taskId: string,
): TaskAuditEntry[] {
  validateTaskId(taskId);
  const path = join(paths.taskDir, 'audit', `${taskId}.jsonl`);
  if (!existsSync(path)) return [];
  const entries: TaskAuditEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed) as TaskAuditEntry); } catch { /* skip corrupt */ }
  }
  return entries;
}

/**
 * Atomically claim a task for an agent. Prevents two agents from double-
 * picking the same task — a race that previously could happen because
 * `update-task <id> in_progress` was a read-modify-write with no lock.
 *
 * Mechanism: write a companion claim-lock file via the POSIX O_EXCL
 * path (`writeFileSync` with `flag: 'wx'`). The first writer wins; the
 * second gets EEXIST and claimTask throws "already claimed by X". Only
 * after the lock is taken do we flip the task's status + assigned_to.
 *
 * Re-claiming a task you already own is idempotent (returns the task
 * without mutation). Claiming a non-pending task is rejected with a
 * message that names the current status so operators can diagnose.
 *
 * Claim-lock files live at `<taskDir>/.claims/<taskId>.claim` and carry
 * `<agent>\t<iso8601>` for audit. A later compaction pass can prune
 * claim-locks for completed tasks; for now they are append-only.
 */
export function claimTask(
  paths: BusPaths,
  taskId: string,
  agent: string,
  leaseSeconds = 900,
): Task {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  let task: Task;
  try {
    task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
  } catch (err) {
    throw new Error(`Task ${taskId} claim failed (unreadable): ${err}`);
  }

  const claimsDir = join(paths.taskDir, '.claims');
  ensureDir(claimsDir);
  const claimPath = join(claimsDir, `${taskId}.claim`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Idempotency: if this agent already owns the claim, succeed silently.
  if (existsSync(claimPath)) {
    try {
      const owner = readFileSync(claimPath, 'utf-8').split('\t')[0];
      if (owner === agent) {
        return task;
      }
      throw new Error(
        `Task ${taskId} already claimed by ${owner} (current status=${task.status})`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Task ${taskId} already claimed`)) throw err;
      // Unreadable claim file — fall through and try the exclusive write.
    }
  }

  if (task.status !== 'pending') {
    throw new Error(
      `Task ${taskId} is not pending (status=${task.status}); cannot claim`,
    );
  }

  // Atomic: O_EXCL fails if the file exists, giving us true mutual
  // exclusion even under concurrent claims from two agents.
  try {
    writeFileSync(claimPath, `${agent}\t${now}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Someone else won the race — read the winner and surface it.
    let owner = 'unknown';
    try { owner = readFileSync(claimPath, 'utf-8').split('\t')[0]; } catch { /* stays 'unknown' */ }
    if (owner === agent) return task; // Benign race with self — treat as idempotent success.
    throw new Error(`Task ${taskId} already claimed by ${owner}`);
  }

  // Lock held — take the accountability lease under the task lock. The claim
  // file gives mutual exclusion between two simultaneous claimers; the lease
  // gives EXPIRY and a fence token, which the claim file never had. Without the
  // fence, a worker whose process hung past its lease could wake up and write
  // over the worker that legitimately took over.
  try {
    lastGrant = acquireLease(paths, filePath, taskId, agent, leaseSeconds, Date.now, 'in_progress');
  } catch (err) {
    // Roll back the claim so a retry can succeed; we never want a ghost
    // lock surviving a write failure on the task JSON itself.
    try { unlinkSync(claimPath); } catch { /* best-effort */ }
    if (err instanceof LeaseHeldError) throw err;
    throw new Error(`Task ${taskId} claim commit failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'claim', agent, from: task.status, to: 'in_progress' });
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
}

/**
 * The lease grant from the most recent successful `claimTask` in this process.
 *
 * `claimTask` returns a `Task` and dozens of call sites depend on that shape,
 * so the fence token is exposed here rather than by widening the return type.
 * A worker that intends to report progress should prefer `claimTaskWithLease`,
 * which hands back both.
 */
let lastGrant: { fenceToken: number; leaseExpiresAt: string; checkpoint: Record<string, unknown> } | null = null;

export function claimTaskWithLease(
  paths: BusPaths,
  taskId: string,
  agent: string,
  leaseSeconds = 900,
): { task: Task; fenceToken: number; leaseExpiresAt: string; checkpoint: Record<string, unknown> } {
  const task = claimTask(paths, taskId, agent, leaseSeconds);
  if (!lastGrant) throw new Error(`Task ${taskId} claimed without a lease grant`);
  return { task, ...lastGrant };
}

/**
 * Complete a task. Sets status to done, completed_at, and optional result.
 * Matches bash complete-task.sh behavior, with the cross-org fallback from
 * findTaskFile so an assignee in one org can complete a task filed by an
 * orchestrator in a sibling org.
 *
 * Side-effect: emits a `task/task_completed` event on the activity feed so
 * completions are visible on the dashboard without agents having to follow
 * every complete-task call with a separate log-event. The event is written
 * best-effort — a failing event write never unblocks task completion from
 * persisting to disk.
 */
export function completeTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
  options: TransitionOptions = {},
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  let taskOrg: string = '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    taskOrg = task.org || '';
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }

  // Completion is now a two-step contract move, not one write.
  //
  // doing -> verify costs an artifact; verify -> done costs recorded acceptance
  // results and a verifier who is not the author. A caller with no evidence
  // lands the task in VERIFY and stops there — visibly incomplete rather than
  // falsely done. That is the entire point of the package: an agent asserting
  // success is not the same event as the work being verified.
  const evidence: Evidence = { ...(options.evidence ?? {}) };
  if (result && evidence.result === undefined && evidence.artifact === undefined) {
    evidence.result = result;
  }

  const actor = options.actor ?? assignee ?? 'unknown';
  const current = canonicalStateOf(paths, taskId) ?? 'doing';

  // Step 1: reach verify. Costs an artifact.
  if (current !== 'verify' && current !== 'done') {
    markVerify(paths, filePath, taskId, actor, evidence, options, current);
  }

  // Step 2: verify -> done. Costs recorded acceptance results and an
  // independent verifier for code/external/high-impact work.
  const snapshot = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const check = checkTransition(
    'verify',
    'done',
    contractItemFrom(snapshot, readMeta(snapshot)),
    evidence,
  );

  if (!check.ok) {
    // Journalled so the gap is visible on the board and in the recovery queue
    // instead of being swallowed by a cheerful "completed".
    appendTaskEvent(paths, filePath, taskId, {
      version: readMeta(snapshot).version,
      event: 'verify:incomplete',
      actor,
      payload: { error: check.error, detail: check.detail, evidence },
    });
    if (effectiveMode('cortexos_tasks', options.origin ?? 'writer') === 'enforced') {
      // A structured refusal, so the CLI (and through it the dashboard) can
      // tell a person WHAT is missing instead of a generic failure. The task is
      // left where it actually is — in verify — and the message says so.
      const violation = new ContractViolation('cortexos_tasks', check, 'verify', 'done');
      violation.message += ` Task ${taskId} remains in verify.`;
      throw violation;
    }
    console.warn(
      `[task-contract:shadow:writer] cortexos_tasks: ${taskId} completed without proof (${check.error}). ` +
      `Under enforcement this would stay in verify.`,
    );
  }

  transitionTask(paths, taskId, 'completed', {
    actor,
    evidence,
    // Optimistic concurrency reaches the completion path too. Dropping it here
    // made every dashboard completion a blind write over whatever an agent had
    // recorded since the record was read.
    expectedVersion: options.expectedVersion,
    fenceToken: options.fenceToken,
    origin: options.origin,
    suppressLegacyAudit: true,
  });
  withTaskLock(filePath, () => {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (result) task.result = result;
    task.completed_at = task.updated_at;
    atomicWriteSync(filePath, JSON.stringify(task));
  });
  appendTaskAudit(paths, taskId, { event: 'complete', agent: assignee || 'unknown', from: prevStatus, to: 'completed', note: result });

  // Activity-feed event. Best-effort — the task is already persisted.
  if (assignee) {
    try {
      // Cross-org completion (caller's org ≠ task's org) is allowed via
      // findTaskFile, but the caller's `paths.analyticsDir` is scoped to
      // the caller's org. Rewrite the analytics path to the task's actual
      // org so dashboards/metrics see the completion under the right tree.
      // Only rewrite analyticsDir when the resolved task path is in the
      // nested cross-org layout: <ctxRoot>/orgs/<org>/tasks/<taskId>.json.
      // Flat/single-org test harnesses use <ctxRoot>/tasks + <ctxRoot>/analytics
      // and should keep the caller-provided analyticsDir unchanged.
      const pathOrgMatch = filePath.match(/[\\/]orgs[\\/](?<org>[^\\/]+)[\\/]tasks[\\/]/);
      const fileOrg = pathOrgMatch?.groups?.org || '';
      const eventPaths: BusPaths = fileOrg
        ? { ...paths, analyticsDir: join(paths.ctxRoot, 'orgs', fileOrg, 'analytics') }
        : paths;
      logEvent(eventPaths, assignee, taskOrg, 'task', 'task_completed', 'info', {
        task_id: taskId,
        ...(result ? { result } : {}),
      });
    } catch {
      // Never let observability break task completion.
    }
  }
}

/**
 * List tasks with optional filters.
 * Matches bash list-tasks.sh behavior.
 */
export function listTasks(
  paths: BusPaths,
  filters?: {
    agent?: string;
    status?: TaskStatus;
    priority?: Priority;
    respectDeps?: boolean;
  },
): Task[] {
  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      const task: Task = JSON.parse(content);

      // Apply filters
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (task.archived) continue;

      tasks.push(task);
    } catch {
      // Skip corrupt files
    }
  }

  const sorted = tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (!filters?.respectDeps) return sorted;

  // DAG-aware ordering: unblocked tasks first, blocked ones after, with
  // the secondary order preserving created_at DESC within each bucket.
  // "Blocked" = any blocked_by entry resolves to non-completed.
  const byId = new Map<string, Task>();
  for (const t of sorted) byId.set(t.id, t);
  const isBlocked = (t: Task): boolean => {
    for (const depId of t.blocked_by ?? []) {
      const dep = byId.get(depId);
      // Out-of-list deps are checked on-disk via checkTaskDependencies,
      // but the list-view only considers in-list tasks for speed.
      if (!dep) continue;
      if (dep.status !== 'completed') return true;
    }
    return false;
  };
  const unblocked: Task[] = [];
  const blocked: Task[] = [];
  for (const t of sorted) (isBlocked(t) ? blocked : unblocked).push(t);
  return [...unblocked, ...blocked];
}

/**
 * Helper: read all task JSON files from a directory (non-recursive).
 */
function readAllTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      tasks.push(JSON.parse(content));
    } catch {
      // Skip corrupt files
    }
  }
  return tasks;
}

/**
 * Check for stale tasks. Matches bash check-stale-tasks.sh behavior.
 */
export function checkStaleTasks(paths: BusPaths): StaleTaskReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_IN_PROGRESS = 7200;   // 2 hours
  const STALE_PENDING = 86400;      // 24 hours
  const STALE_HUMAN = 86400;        // 24 hours

  const report: StaleTaskReport = {
    stale_in_progress: [],
    stale_pending: [],
    stale_human: [],
    overdue: [],
  };

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Skip completed/done tasks
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    const updatedEpoch = Math.floor(new Date(task.updated_at).getTime() / 1000);
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - updatedEpoch;
    const createdAge = nowEpoch - createdEpoch;

    // Stale in_progress: updated_at > 2 hours ago
    if (task.status === 'in_progress' && age > STALE_IN_PROGRESS) {
      report.stale_in_progress.push(task);
    }

    // Stale pending: created_at > 24 hours ago
    if (task.status === 'pending' && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }

    // Human tasks: assigned to "human" or "user", or in human-tasks project
    if (
      (['human', 'user'].includes(task.assigned_to ?? '') ||
        task.project === 'human-tasks') &&
      createdAge > STALE_HUMAN
    ) {
      report.stale_human.push(task);
    }

    // Overdue: has due_date and it's in the past
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1000);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }

  return report;
}

/**
 * Archive completed tasks older than 7 days. Matches bash archive-tasks.sh behavior.
 */
export function archiveTasks(paths: BusPaths, dryRun: boolean = false): ArchiveReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ARCHIVE_AGE = 604800; // 7 days

  let archived = 0;
  let skipped = 0;

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Only archive completed tasks
    if (task.status !== 'completed') continue;

    if (!task.completed_at) {
      skipped++;
      continue;
    }

    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1000);
    const age = nowEpoch - completedEpoch;

    if (age > ARCHIVE_AGE) {
      // task.id comes from the file's JSON body and is used to build the
      // rename source/dest below; a tampered id must not escape the task tree.
      try { validateTaskId(task.id); } catch { skipped++; continue; }
      if (!dryRun) {
        const archiveDir = join(paths.taskDir, 'archive');
        ensureDir(archiveDir);

        // Mark as archived
        task.archived = true;
        const srcPath = join(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));

        // Move to archive
        renameSync(srcPath, join(archiveDir, `${task.id}.json`));

        // fix8 — archiving moves the record out of the active list, so any
        // message still naming it points at work nobody is going to pick up.
        // Most of these were already superseded when the task completed; this
        // catches whatever was sent in the seven days since, including the
        // dashboard's own completion notice.
        try {
          supersedeMessagesForTask(paths, {
            taskId: task.id,
            cause: 'archived',
            actor: 'archive-tasks',
            reason: 'the task was archived out of the active list',
            title: task.title ?? null,
          });
        } catch (err) {
          console.error(`[bus/task] archive ${task.id}: inbox pointers not superseded: ${err}`);
        }
      }
      archived++;
    }
  }

  return { archived, skipped, dry_run: dryRun };
}

/**
 * Semantic compaction of old completed tasks (beads-inspired). Each
 * eligible task becomes a one-line summary entry in a monthly
 * `archive-YYYY-MM.jsonl` file (bucketed by the task's completed_at
 * month), and the active task JSON is removed to keep the task board
 * small. The audit log (audit/<id>.jsonl) is intentionally preserved
 * so full lifecycle history survives compaction.
 *
 * Guards (a task is SKIPPED if any of the following holds):
 *   - status !== 'completed'
 *   - completed_at missing OR completed_at within the cutoff window
 *   - the task is still listed in some OTHER task's `blocked_by` where
 *     that other task is not yet completed (compaction must not
 *     orphan dependency references for unresolved dependents)
 *
 * No LLM calls. The "summary" is just title + result + key metadata;
 * callers supply clean result strings via `complete-task --result`.
 *
 * Idempotent: running twice over the same data does nothing the
 * second time because eligible tasks have already been removed.
 */
export interface CompactTasksReport {
  archived: Array<{ id: string; archive_file: string }>;
  skipped: Array<{ id: string; reason: string }>;
  dry_run: boolean;
}

export function compactTasks(
  paths: BusPaths,
  options: { olderThanDays?: number; dryRun?: boolean } = {},
): CompactTasksReport {
  const { olderThanDays = 30, dryRun = false } = options;
  const report: CompactTasksReport = { archived: [], skipped: [], dry_run: dryRun };
  const cutoffMs = Date.now() - olderThanDays * 86400_000;

  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  } catch {
    return report;
  }

  // First pass: load every task so we can check cross-task dependency
  // references without re-reading files per candidate.
  const tasks: Task[] = [];
  for (const f of files) {
    try { tasks.push(JSON.parse(readFileSync(join(taskDir, f), 'utf-8')) as Task); }
    catch { /* skip corrupt */ }
  }

  // Build a "still-needed" set: the TRANSITIVE blocker closure of
  // every open task. A completed blocker must survive compaction as
  // long as ANY open task has it in its blocked_by chain — not just
  // direct parents. With A <- B <- C and C open, the direct-only
  // guard preserved B but archived A, leaving B with a dangling
  // reference to an archived task. Phase 4 directive was
  // "still in the blocked_by chain of a pending task" — the
  // full-chain reading is the correct one.
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const stillNeededAsBlocker = new Set<string>();
  const stack: string[] = [];
  for (const t of tasks) {
    if (t.status === 'completed') continue;
    for (const blockerId of t.blocked_by ?? []) stack.push(blockerId);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    if (stillNeededAsBlocker.has(cur)) continue;
    stillNeededAsBlocker.add(cur);
    const parent = byId.get(cur);
    if (parent?.blocked_by?.length) stack.push(...parent.blocked_by);
  }

  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completed_at) { report.skipped.push({ id: task.id, reason: 'no completed_at timestamp' }); continue; }
    const completedMs = new Date(task.completed_at).getTime();
    if (isNaN(completedMs) || completedMs > cutoffMs) {
      report.skipped.push({ id: task.id, reason: 'completed_at within cutoff' });
      continue;
    }
    if (stillNeededAsBlocker.has(task.id)) {
      report.skipped.push({ id: task.id, reason: 'still referenced by an open task\'s blocked_by chain' });
      continue;
    }

    // task.id (from the file's JSON body) is used to unlink the source file
    // below; a tampered id must not delete a file outside the task tree.
    try { validateTaskId(task.id); } catch { report.skipped.push({ id: String(task.id), reason: 'invalid task id (path-traversal guard)' }); continue; }

    const yyyymm = task.completed_at.substring(0, 7); // YYYY-MM
    // completed_at is from the JSON body and feeds the archive filename below;
    // reject anything that isn't a literal YYYY-MM so a tampered timestamp can't
    // traverse out of the task tree via the archive path.
    if (!/^\d{4}-\d{2}$/.test(yyyymm)) {
      report.skipped.push({ id: String(task.id), reason: 'invalid completed_at (path-traversal guard)' });
      continue;
    }
    const archiveFile = `archive-${yyyymm}.jsonl`;
    const archivePath = join(taskDir, archiveFile);
    const entry = {
      id: task.id,
      title: task.title,
      org: task.org,
      assigned_to: task.assigned_to,
      completed_at: task.completed_at,
      archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      result: task.result ?? '',
    };

    if (!dryRun) {
      try {
        appendFileSync(archivePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
        unlinkSync(join(taskDir, `${task.id}.json`));
        // fix8 — compaction unlinks the record on purpose. Anything still
        // naming the id is now a pointer into nothing, which is exactly the
        // ghost fix7 documented. Superseded rather than deleted: `deleteTask`
        // would take the audit log with it, and compaction preserves that log
        // deliberately so the lifecycle history survives.
        try {
          supersedeMessagesForTask(paths, {
            taskId: task.id,
            cause: 'compacted',
            actor: 'compact-tasks',
            reason: `summarised into ${archiveFile} and removed from the active list`,
            title: task.title ?? null,
          });
        } catch (err) {
          console.error(`[bus/task] compact ${task.id}: inbox pointers not superseded: ${err}`);
        }
      } catch (err) {
        report.skipped.push({ id: task.id, reason: `archive write failed: ${err}` });
        continue;
      }
    }
    report.archived.push({ id: task.id, archive_file: archiveFile });
  }

  return report;
}

/**
 * Find stale human-assigned tasks. Matches bash check-human-tasks.sh behavior.
 */
export function checkHumanTasks(paths: BusPaths): Task[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD = 86400; // 24 hours

  const tasks = readAllTasks(paths.taskDir);
  const result: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    if (task.assigned_to !== 'human' && task.assigned_to !== 'user') continue;

    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - createdEpoch;

    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }

  return result;
}
