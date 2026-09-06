// === JARVIS MOD #54 — voice turn latency sink ===
// New file (isolated in the api/uhs/ local-mod zone). Session-authed POST.
// Appends one client-measured turn to the SAME fastpath-metrics.jsonl the
// Haiku fast path writes (MOD #34), so a single file answers "how fast is
// JARVIS" across both voice engines. Entries carry event:'turn_latency' so
// existing readers that filter on event:'reply'/'escalate' are unaffected.
//
// Read-only-ish by design: this route only ever appends a metrics line. A
// failure here returns 200 with logged:false — instrumentation must never
// surface as a user-visible error on the voice path.
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { auth } from '@/lib/auth';
import { getLogDir } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Metrics land in the fast path's own log so both engines share one file. */
const METRICS_AGENT = 'jarvis-telegram';
/** Anything above this is a stalled turn or a clock glitch, not a latency. */
const MAX_PLAUSIBLE_MS = 120_000;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    path?: string;
    firstAudioMs?: number;
    transcriptMs?: number;
    signoff?: boolean;
    tool?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const voicePath = body.path === 'realtime' || body.path === 'fastpath' ? body.path : null;
  const firstAudioMs = Number(body.firstAudioMs);
  if (!voicePath || !Number.isFinite(firstAudioMs) || firstAudioMs < 0 || firstAudioMs > MAX_PLAUSIBLE_MS) {
    return Response.json({ error: 'Invalid metrics payload' }, { status: 400 });
  }

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event: 'turn_latency',
    voice_path: voicePath,
    // The Trillion-spec number: user stopped talking → first audible word.
    time_since_user_stopped_talking_ms: firstAudioMs,
  };
  if (Number.isFinite(Number(body.transcriptMs))) {
    entry.transcript_ms = Math.round(Number(body.transcriptMs));
  }
  if (body.signoff) entry.signoff = true;
  if (typeof body.tool === 'string' && body.tool) entry.tool = body.tool.slice(0, 40);

  try {
    const logDir = getLogDir(METRICS_AGENT);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'fastpath-metrics.jsonl'),
      JSON.stringify(entry) + '\n',
    );
    return Response.json({ logged: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/uhs/voice/metrics] append failed: ${message}`);
    return Response.json({ logged: false });
  }
}

export async function GET() {
  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
// === END JARVIS MOD #54 ===
