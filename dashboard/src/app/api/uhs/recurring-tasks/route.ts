import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// UHS Recurring Tasks API
// Lives at /api/uhs/recurring-tasks — new file, never overwritten by upstream.
// ---------------------------------------------------------------------------

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

function supaHeaders() {
  return {
    apikey: SUPA_KEY ?? '',
    Authorization: `Bearer ${SUPA_KEY ?? ''}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function isConfigured(): boolean {
  return !!(SUPA_URL && SUPA_KEY);
}

// ---------------------------------------------------------------------------
// GET /api/uhs/recurring-tasks
// Returns all recurring_tasks rows enriched with last 5 task instances.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest) {
  if (!isConfigured()) {
    return Response.json(
      { error: 'SUPABASE_URL / SUPABASE_KEY not configured' },
      { status: 500 },
    );
  }

  try {
    // Fetch all recurring tasks
    const rtRes = await fetch(
      `${SUPA_URL}/rest/v1/recurring_tasks?order=id.asc`,
      { headers: supaHeaders(), cache: 'no-store' },
    );
    if (!rtRes.ok) {
      const err = await rtRes.text();
      throw new Error(`recurring_tasks fetch failed: ${err}`);
    }
    const recurringTasks = await rtRes.json();

    // For each, fetch the last 5 run instances from tasks table
    const enriched = await Promise.all(
      recurringTasks.map(async (rt: Record<string, unknown>) => {
        try {
          const runsRes = await fetch(
            `${SUPA_URL}/rest/v1/tasks?payload->>recurring_task_id=eq.${rt.id}&select=id,type,status,created_at,completed_at,error&order=created_at.desc&limit=5`,
            { headers: supaHeaders(), cache: 'no-store' },
          );
          const runs = runsRes.ok ? await runsRes.json() : [];
          return { ...rt, recent_runs: runs };
        } catch {
          return { ...rt, recent_runs: [] };
        }
      }),
    );

    return Response.json(enriched);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/uhs/recurring-tasks] GET error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/uhs/recurring-tasks?id=N  — toggle enabled or update description
// Body: { enabled?: boolean, description?: string, overnight_approved?: boolean }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  if (!isConfigured()) {
    return Response.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  // Next.js 16: searchParams from URL constructor is synchronous (not the page param)
  const id = searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return Response.json({ error: 'Invalid or missing id param' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Build the updates object
  const rtUpdates: Record<string, unknown> = {};
  if (typeof body.enabled === 'boolean') rtUpdates.enabled = body.enabled;

  // Payload sub-fields (description, overnight_approved) require fetching
  // the existing payload, merging, and writing back.
  const payloadUpdates: Record<string, unknown> = {};
  if (typeof body.description === 'string') payloadUpdates.description = body.description;
  if (typeof body.overnight_approved === 'boolean')
    payloadUpdates.overnight_approved = body.overnight_approved;

  try {
    if (Object.keys(payloadUpdates).length > 0) {
      // Fetch current payload
      const fetchRes = await fetch(
        `${SUPA_URL}/rest/v1/recurring_tasks?id=eq.${id}&select=payload`,
        { headers: supaHeaders(), cache: 'no-store' },
      );
      if (!fetchRes.ok) throw new Error('Failed to fetch current payload');
      const rows = await fetchRes.json();
      const existingPayload = rows[0]?.payload ?? {};
      rtUpdates.payload = { ...existingPayload, ...payloadUpdates };
    }

    if (Object.keys(rtUpdates).length === 0) {
      return Response.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const patchRes = await fetch(
      `${SUPA_URL}/rest/v1/recurring_tasks?id=eq.${id}`,
      {
        method: 'PATCH',
        headers: supaHeaders(),
        body: JSON.stringify(rtUpdates),
      },
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      throw new Error(`Supabase PATCH failed: ${err}`);
    }

    // Return the updated row
    const updatedRes = await fetch(
      `${SUPA_URL}/rest/v1/recurring_tasks?id=eq.${id}`,
      { headers: supaHeaders(), cache: 'no-store' },
    );
    const updated = updatedRes.ok ? (await updatedRes.json())[0] : null;
    return Response.json({ success: true, task: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/uhs/recurring-tasks] PATCH error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/uhs/recurring-tasks?id=N  — hard-delete a recurring task
// Child task instances (tasks.payload.recurring_task_id) are left as orphans,
// which is intentional — they remain as historical run records.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  if (!isConfigured()) {
    return Response.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return Response.json({ error: 'Invalid or missing id param' }, { status: 400 });
  }

  try {
    const delRes = await fetch(
      `${SUPA_URL}/rest/v1/recurring_tasks?id=eq.${id}`,
      { method: 'DELETE', headers: supaHeaders() },
    );
    if (!delRes.ok) {
      const err = await delRes.text();
      throw new Error(`Supabase DELETE failed: ${err}`);
    }
    return Response.json({ success: true, deleted_id: Number(id) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/uhs/recurring-tasks] DELETE error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
