// === JARVIS MOD — Realtime API session token minting (Phase 1) ===
// New file (isolated in the api/uhs/ local-mod zone). Session-authed POST.
// Mints an ephemeral client_secret from the OpenAI Realtime sessions endpoint
// and returns { token, expires_at, session_id } to the caller.
// If OPENAI_API_KEY is absent → 503. Auth failure → 401. OpenAI error → 500.
import { auth } from '@/lib/auth';
import { JARVIS_SYSTEM_PROMPT } from '@/lib/realtime/jarvis-prompt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPENAI_REALTIME_SESSIONS_URL =
  'https://api.openai.com/v1/realtime/sessions';

export async function POST() {
  // --- Auth gate: same session check as /api/uhs/tts -------------------------
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // --- API key guard ---------------------------------------------------------
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: 'Realtime API not configured' },
      { status: 503 },
    );
  }

  // --- Mint ephemeral session token via OpenAI Realtime sessions API ---------
  try {
    const res = await fetch(OPENAI_REALTIME_SESSIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:
          process.env.OPENAI_REALTIME_MODEL ??
          'gpt-4o-realtime-preview-2024-12-17',
        voice: process.env.OPENAI_REALTIME_VOICE ?? 'shimmer',
        instructions: JARVIS_SYSTEM_PROMPT,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          silence_duration_ms: 800,
          prefix_padding_ms: 300,
        },
        input_audio_transcription: { model: 'whisper-1' },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[api/uhs/realtime/session] OpenAI returned ${res.status}: ${body}`,
      );
      return Response.json(
        { error: `OpenAI error: ${res.status}` },
        { status: 500 },
      );
    }

    const data = (await res.json()) as {
      id: string;
      client_secret: { value: string; expires_at: number };
    };

    return Response.json(
      {
        token: data.client_secret.value,
        expires_at: data.client_secret.expires_at,
        session_id: data.id,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/uhs/realtime/session] Unexpected error: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
// === END JARVIS MOD ===
