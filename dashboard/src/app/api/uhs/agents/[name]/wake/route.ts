// === JARVIS MOD #17 — Per-agent Wake API route (2026-07-03) ===
// Isolation zone: api/uhs/ is the established local-mod home so upstream
// api/agents/[name]/ stays untouched. Mirrors the auth/validation shape of
// api/agents/[name]/lifecycle/route.ts EXACTLY, but dispatches the IPC `wake`
// command (fast-checker wake, replaces SIGUSR1) instead of a lifecycle op.
import { NextRequest } from 'next/server';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

function isValidName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

// ---------------------------------------------------------------------------
// POST /api/uhs/agents/[name]/wake - Wake an agent's fast checker
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const ipc = new IPCClient(instanceId);

  try {
    const ipcResult = await ipc.send({ type: 'wake', agent: decoded });

    if (!ipcResult.success) {
      console.error(`[api/uhs/agents/${decoded}/wake] POST IPC error:`, ipcResult.error);
      return Response.json(
        { error: `Failed to wake agent: ${ipcResult.error ?? 'unknown IPC error'}` },
        { status: 500 },
      );
    }

    return Response.json({
      success: true,
      agent: decoded,
      output: String(ipcResult.data ?? 'Woke fast checker'),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/uhs/agents/${decoded}/wake] POST error:`, message);
    return Response.json({ error: 'Failed to wake agent' }, { status: 500 });
  }
}
// === END JARVIS MOD #17 ===
