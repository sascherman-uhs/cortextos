import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTaskById } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { transitionTask } from '@/lib/task-transition';
import { sourceForTaskId, toCanonical, type CanonicalState } from '@/lib/data/transition-contract';
import { offeredActions } from '@/lib/tasks/offered-actions';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

// Reject IDs that look like path traversal attempts
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// Agent names must be lowercase alphanumeric + underscore/hyphen.
// Used to guard against path traversal and shell metacharacters before
// passing values into bus shell scripts as positional arguments.
function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && /^[a-z0-9_-]+$/.test(name) && name.length <= 64;
}

// A person's name, reduced to something safe to record as an actor/verifier in
// the task journal and to pass as a positional CLI argument. Returns undefined
// when there is nothing usable, so the caller can fall back.
function sanitizeActor(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : undefined;
}

// Cap free-text fields (note, outputSummary) to a safe upper bound before
// forwarding them as positional args to bus scripts.
const MAX_FREE_TEXT_LEN = 2000;
function capText(value: unknown, max = MAX_FREE_TEXT_LEN): string {
  return String(value ?? '').slice(0, max);
}

// ---------------------------------------------------------------------------
// GET /api/tasks/[id] - Get a single task by ID
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    const task = getTaskById(id);
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    // The canonical state the OWNING store holds, not the one the SQLite
    // projection infers. They can disagree: a native record carrying
    // canonical_state 'failed_terminal' has native status 'pending', which the
    // projection reads as 'backlog'. The detail sheet derives its buttons from
    // this, so guessing here is how it came to offer moves the contract
    // refuses. Falls back to the projection only when the record states none.
    let canonicalState: CanonicalState | null = null;

    // Enrich with outputs from the source JSON file (outputs are not synced to SQLite)
    if (task.source_file && fs.existsSync(task.source_file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(task.source_file, 'utf-8'));
        if (Array.isArray(raw.outputs)) {
          task.outputs = raw.outputs;
        }
        if (typeof raw.canonical_state === 'string' && raw.canonical_state) {
          canonicalState = raw.canonical_state as CanonicalState;
        }
      } catch { /* non-fatal — outputs are optional */ }
    }

    // UHS MOD #7 (extends MOD #6) — for supa_ tasks, enrich with recurring task info
    if (id.startsWith('supa_')) {
      const supaId = id.slice(5);
      const supaUrl = process.env.SUPABASE_URL;
      const supaKey = process.env.SUPABASE_KEY;
      if (supaUrl && supaKey) {
        const sbHeaders = {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          'Content-Type': 'application/json',
        };
        try {
          // Fetch payload + result + error for full task context
          const payloadRes = await fetch(
            `${supaUrl}/rest/v1/tasks?id=eq.${supaId}&select=payload,result,error,version,canonical_state`,
            { headers: sbHeaders, cache: 'no-store' },
          );
          if (payloadRes.ok) {
            const rows = await payloadRes.json();
            const payload = rows[0]?.payload ?? {};
            // The owning store's version wins over the SQLite projection, which
            // can lag a sync cycle. The detail view sends this back as
            // expectedVersion, so a stale number here is a blind write.
            if (Number.isFinite(Number(rows[0]?.version))) {
              Object.assign(task, { version: Number(rows[0].version) });
            }
            if (typeof rows[0]?.canonical_state === 'string' && rows[0].canonical_state) {
              canonicalState = rows[0].canonical_state as CanonicalState;
            }
            const rtId = payload.recurring_task_id;
            // Pass result + error through to the task object
            if (rows[0]?.result !== undefined) {
              Object.assign(task, { supaResult: rows[0].result });
            }
            if (rows[0]?.error !== undefined && rows[0].error !== null) {
              Object.assign(task, { supaError: rows[0].error });
            }
            if (rtId) {
              // Fetch the recurring_task definition
              const rtRes = await fetch(
                `${supaUrl}/rest/v1/recurring_tasks?id=eq.${rtId}&select=id,name,schedule,enabled`,
                { headers: sbHeaders, cache: 'no-store' },
              );
              // Fetch last 5 sibling runs
              const runsRes = await fetch(
                `${supaUrl}/rest/v1/tasks?payload->>recurring_task_id=eq.${rtId}&select=id,type,status,created_at,completed_at,error&order=created_at.desc&limit=5`,
                { headers: sbHeaders, cache: 'no-store' },
              );
              const [rtRows, runsRows] = await Promise.all([
                rtRes.ok ? rtRes.json() : [],
                runsRes.ok ? runsRes.json() : [],
              ]);
              const rt = rtRows[0];
              if (rt) {
                Object.assign(task, {
                  recurring_task_id: rt.id,
                  recurring_name: rt.name,
                  recurring_schedule: rt.schedule,
                  recurring_enabled: rt.enabled,
                  recent_runs: runsRows,
                });
              }
            }
          }
        } catch { /* non-fatal — recurring info is optional */ }
      }
    }

    // The moves this record may actually make, derived from the contract and
    // filtered to what PATCH can express. The client renders these rather than
    // keeping a second table of buttons that can drift out of agreement.
    const source = sourceForTaskId(id);
    const from = canonicalState ?? toCanonical(source, task.status);
    Object.assign(task, {
      canonicalState: from,
      offeredActions: offeredActions(source, from),
    });

    return Response.json(task);
  } catch (err) {
    console.error('[api/tasks/[id]] GET error:', err);
    return Response.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/[id] - Delete a task
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  // Supabase-sourced tasks live only in SQLite — no JSON file on disk.
  if (id.startsWith('supa_')) {
    const supabaseId = id.slice(5);
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_KEY;

    if (!supaUrl || !supaKey) {
      return Response.json(
        { error: 'SUPABASE_URL / SUPABASE_KEY not configured in .env.local' },
        { status: 500 },
      );
    }

    try {
      const sbRes = await fetch(
        `${supaUrl}/rest/v1/tasks?id=eq.${supabaseId}`,
        {
          method: 'DELETE',
          headers: {
            apikey: supaKey,
            Authorization: `Bearer ${supaKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
        },
      );

      if (!sbRes.ok) {
        const errText = await sbRes.text();
        throw new Error(`Supabase DELETE failed ${sbRes.status}: ${errText}`);
      }

      db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      return Response.json({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api/tasks/[id]] supa_ DELETE error:', message);
      return Response.json({ error: `Failed to delete task: ${message}` }, { status: 500 });
    }
  }

  // Delete the task file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    await fs.default.unlink(taskFile);
    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] DELETE error:', err);
    return Response.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/tasks/[id] - Edit task fields (title, description, assignee, priority)
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { title, description, assignee, priority } = body as {
    title?: string;
    description?: string;
    assignee?: string;
    priority?: string;
  };

  if (title !== undefined && (!title || title.trim().length === 0)) {
    return Response.json({ error: 'Title cannot be empty' }, { status: 400 });
  }
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    return Response.json({ error: 'Invalid priority' }, { status: 400 });
  }
  if (assignee !== undefined && !isValidAgentName(assignee)) {
    return Response.json({ error: 'Invalid assignee' }, { status: 400 });
  }

  // ---------------------------------------------------------------------------
  // UHS MOD #11 — drag-to-agent routing for Supabase-sourced tasks.
  // supa_ tasks live only in SQLite (source_file = 'supabase://tasks/{id}'),
  // so the JSON-file path below can't touch them. Mirror the PATCH supa_ branch:
  // PATCH Supabase assigned_to, mirror SQLite assignee, then fire the agent
  // wakeup (this is the "auto-route → wake the agent" mechanic of L6-01).
  // ---------------------------------------------------------------------------
  if (id.startsWith('supa_')) {
    const supabaseId = id.slice(5);
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_KEY;

    if (!supaUrl || !supaKey) {
      return Response.json(
        { error: 'SUPABASE_URL / SUPABASE_KEY not configured in .env.local' },
        { status: 500 },
      );
    }

    // For supa_ tasks the only field the routing UI changes is the assignee.
    // Other PUT fields (title/description/priority) for supa_ tasks are out of
    // scope here and handled elsewhere; if no assignee is supplied, no-op.
    if (assignee === undefined) {
      return Response.json({ success: true });
    }

    try {
      const sbHeaders = {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        'Content-Type': 'application/json',
      };

      // Read current assignee + title so we only wake on an actual change.
      let oldAssignee: string | undefined;
      let taskTitle = task.title;
      try {
        const cur = await fetch(
          `${supaUrl}/rest/v1/tasks?id=eq.${supabaseId}&select=assigned_to,payload`,
          { headers: sbHeaders, cache: 'no-store' },
        );
        if (cur.ok) {
          const rows = await cur.json();
          oldAssignee = rows[0]?.assigned_to ?? undefined;
          taskTitle = rows[0]?.payload?.title ?? taskTitle;
        }
      } catch { /* non-fatal — fall back to local title */ }

      const sbRes = await fetch(
        `${supaUrl}/rest/v1/tasks?id=eq.${supabaseId}`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ assigned_to: assignee }),
        },
      );
      if (!sbRes.ok) {
        const errText = await sbRes.text();
        throw new Error(`Supabase PATCH failed ${sbRes.status}: ${errText}`);
      }

      // Mirror immediately in SQLite so the board reflects the move pre-sync.
      db.prepare(
        `UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?`,
      ).run(assignee, new Date().toISOString(), id);

      // Fire the agent wakeup — only when the assignee actually changed and is
      // a real agent (not human/user). assignee passed isValidAgentName above.
      if (assignee !== oldAssignee && assignee !== 'human' && assignee !== 'user') {
        try {
          const notifyMsg = capText(`Task routed to you: [${id}] ${taskTitle}`);
          // Build the script path as a string — the file-based PUT branch below
          // re-declares a block-scoped `path`, which would shadow the top-level
          // import across this whole function.
          spawnSync(
            'bash',
            [
              `${getFrameworkRoot()}/bus/send-message.sh`,
              assignee,
              'normal',
              notifyMsg,
            ],
            { timeout: 5000, stdio: 'pipe', env: { ...process.env, CTX_FRAMEWORK_ROOT: getFrameworkRoot(), CTX_ROOT: getCTXRoot(), CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default', CTX_AGENT_NAME: 'dashboard', CTX_ORG: task?.org || '' } },
          );
        } catch { /* non-fatal — assignment still persisted */ }
      }

      return Response.json({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api/tasks/[id]] supa_ PUT error:', message);
      return Response.json({ error: `Failed to update task: ${message}` }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // OS-02: field edits go through the same locked, versioned write path the bus
  // uses. The previous implementation read the task JSON, mutated it in memory
  // and renamed a temp file over it — no lock, no version, no journal entry.
  // Any concurrent agent write in that window was lost, and nothing recorded
  // that a human had edited the task at all. This was the writer that would
  // have quietly defeated the whole contract.
  // ---------------------------------------------------------------------------
  const { editTaskFields } = await import('@/lib/task-edit');
  const editResult = editTaskFields({
    taskId: id,
    org: task.org || '',
    actor: 'dashboard',
    expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
    fields: {
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(assignee !== undefined ? { assigned_to: assignee } : {}),
      ...(priority !== undefined ? { priority } : {}),
    },
  });

  if (!editResult.ok) {
    if (editResult.status === 409) {
      return Response.json(
        {
          error: 'version_conflict',
          message:
            'This task changed while you were editing it. The current record is shown below — review it and try again.',
          current: editResult.current,
          currentVersion: editResult.currentVersion,
        },
        { status: 409 },
      );
    }
    console.error('[api/tasks/[id]] PUT error:', editResult.error, editResult.detail ?? '');
    return Response.json({ error: editResult.error, detail: editResult.detail }, { status: editResult.status });
  }

  // Notify the new assignee if it changed. `assignee` was validated against the
  // agent-name whitelist above, and the message body is capped before it is
  // passed as a positional arg to the bus script (which quotes "$3").
  if (
    assignee &&
    assignee !== editResult.previousAssignee &&
    assignee !== 'human' &&
    assignee !== 'user' &&
    isValidAgentName(assignee)
  ) {
    try {
      const notifyMsg = capText(`Task reassigned to you: [${id}] ${editResult.title}`);
      spawnSync(
        'bash',
        [path.join(getFrameworkRoot(), 'bus', 'send-message.sh'), assignee, 'normal', notifyMsg],
        {
          timeout: 5000,
          stdio: 'pipe',
          env: {
            ...process.env,
            CTX_FRAMEWORK_ROOT: getFrameworkRoot(),
            CTX_ROOT: getCTXRoot(),
            CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
            CTX_AGENT_NAME: 'dashboard',
            CTX_ORG: task.org || '',
          },
        },
      );
    } catch { /* non-fatal — the assignment is already persisted */ }
  }

  try { syncAll(); } catch { /* best-effort */ }
  return Response.json({ success: true, version: editResult.version });
}

// ---------------------------------------------------------------------------
// PATCH /api/tasks/[id] - Update task status via bus scripts
//
// Body: { status, note?, blockedBy?, outputSummary? }
// - status=completed -> delegates to complete-task.sh
// - other statuses   -> delegates to update-task.sh
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, note, blockedBy, outputSummary } = body as {
    status?: string;
    note?: string;
    blockedBy?: string;
    outputSummary?: string;
  };

  if (!status || !VALID_STATUSES.includes(status)) {
    return Response.json(
      { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  // blockedBy is forwarded as a positional arg to update-task.sh. It should
  // either be absent or match the agent-name / task-id shape. Reject anything
  // containing shell metacharacters or path traversal.
  if (blockedBy !== undefined && blockedBy !== null && blockedBy !== '') {
    if (typeof blockedBy !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(blockedBy) || blockedBy.length > 128) {
      return Response.json({ error: 'Invalid blockedBy' }, { status: 400 });
    }
  }

  // Look up task's org to pass CTX_ORG to bus script
  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // OS-02: one transition service for both stores.
  //
  // The Supabase and native branches used to be separate state machines with
  // separate conflict behavior — neither of which actually detected a conflict.
  // Both now go through the same call, return the same shape, and answer a
  // concurrent edit with a 409 carrying the current record so the board can
  // show what happened and refresh instead of overwriting somebody's work.
  // ---------------------------------------------------------------------------
  const expectedVersion =
    typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;

  // Who is doing this. The signed-in person if there is one — the contract asks
  // for a NAMED verifier, and 'dashboard' names a program, not a person. Never
  // taken from the request body for anything that matters; body.actor is only a
  // hint and must still pass the agent-name whitelist.
  const session = await auth().catch(() => null);
  const sessionActor = sanitizeActor(session?.user?.name);
  const actor =
    sessionActor ??
    (typeof body.actor === 'string' && isValidAgentName(body.actor) ? body.actor : 'dashboard');

  const suppliedEvidence =
    body.evidence && typeof body.evidence === 'object' && !Array.isArray(body.evidence)
      ? { ...(body.evidence as Record<string, unknown>) }
      : {};
  if (suppliedEvidence.result === undefined && outputSummary) {
    suppliedEvidence.result = capText(outputSummary);
  }
  if (suppliedEvidence.result === undefined && suppliedEvidence.artifact === undefined && note) {
    suppliedEvidence.result = capText(note);
  }
  if (status === 'completed') {
    // The person who clicked Complete IS the verifier, and recording that is a
    // true statement. What is NOT invented here is acceptance-check results: a
    // task that declares acceptance criteria with no recorded results stays
    // refused (plan §12 — no verified Done without proof).
    if (suppliedEvidence.verifier === undefined) suppliedEvidence.verifier = actor;
    if (suppliedEvidence.verification_method === undefined) {
      suppliedEvidence.verification_method = 'human_review';
    }
  }
  const evidence = Object.keys(suppliedEvidence).length > 0 ? suppliedEvidence : undefined;

  // NOTE: `origin` is deliberately NOT read from the body. This is an HTTP
  // caller acting for a human, so the transition service marks it interactive
  // and the contract is enforced regardless of the per-source shadow flag.
  const outcome = await transitionTask({
    taskId: id,
    to: status,
    actor,
    expectedVersion,
    evidence,
    reason: note ? capText(note) : undefined,
    org: task.org || '',
  });

  if (!outcome.ok) {
    if (outcome.status === 422) {
      // A move the work contract refuses. 422 rather than 500: the request was
      // well formed, the rules said no. The board renders `message` in its
      // live-region alert, which names the legal moves.
      return Response.json(
        {
          error: outcome.error,
          message: outcome.message,
          detail: outcome.detail,
          violation: outcome.violation,
          legalTransitions: outcome.legalTransitions,
        },
        { status: 422 },
      );
    }
    if (outcome.status === 409) {
      return Response.json(
        {
          error: 'version_conflict',
          message:
            'This task changed while you were looking at it. The current state is shown below — review it and try again.',
          current: outcome.current,
          currentVersion: outcome.currentVersion,
        },
        { status: 409 },
      );
    }
    console.error('[api/tasks/[id]] PATCH transition failed:', outcome.error, outcome.detail ?? '');
    return Response.json(
      { error: outcome.error, detail: outcome.detail },
      { status: outcome.status },
    );
  }

  // Mirror the Supabase result into SQLite so the board reflects it before the
  // next sync. SQLite is a projection; this is a cache refresh, not authority.
  if (id.startsWith('supa_')) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?, version = ? WHERE id = ?`,
    ).run(
      outcome.nativeStatus,
      now,
      outcome.nativeStatus === 'completed' ? now : null,
      outcome.version ?? 1,
      id,
    );
    return Response.json({
      success: true,
      version: outcome.version,
      canonicalState: outcome.canonicalState,
    });
  }

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: task.org || '',
  };

  try {
    // Notify the task creator when a task is completed or status changes significantly.
    // This is how agents find out their blocked tasks can be unblocked.
    if (task?.source_file) {
      try {
        const fs = await import('fs/promises');
        const raw = await fs.default.readFile(task.source_file, 'utf-8');
        const taskData = JSON.parse(raw);
        const createdBy: string | undefined = taskData.created_by;
        // Only notify agents (not 'dashboard', 'human', etc.) and only when
        // the recipient name passes the agent-name whitelist — prevents
        // passing crafted names into the bus CLI.
        const agentNames = new Set(['dashboard', 'human', 'user']);
        if (createdBy && !agentNames.has(createdBy) && isValidAgentName(createdBy)) {
          const rawMsg = status === 'completed'
            ? `Human task completed by user: [${id}] ${task.title} - you can now unblock your work`
            : `Task status updated to ${status}: [${id}] ${task.title}`;
          const msg = capText(rawMsg);
          spawnSync(
            'node',
            [
              path.join(frameworkRoot, 'dist', 'cli.js'),
              'bus', 'send-message', createdBy, 'normal', msg,
            ],
            { timeout: 5000, stdio: 'pipe', env },
          );
        }
      } catch { /* non-fatal */ }
    }

    // Trigger sync so subsequent reads reflect the update
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    return Response.json({
      success: true,
      version: outcome.version,
      canonicalState: outcome.canonicalState,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/tasks/[id]] PATCH error:', message);
    return Response.json(
      { error: 'Failed to update task' },
      { status: 500 },
    );
  }
}
