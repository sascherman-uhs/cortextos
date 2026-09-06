// === JARVIS MOD — Realtime API session token minting (Phase 1) ===
// New file (isolated in the api/uhs/ local-mod zone). Session-authed POST.
// Mints an ephemeral client_secret from the OpenAI Realtime sessions endpoint
// and returns { token, expires_at, session_id } to the caller.
// If OPENAI_API_KEY is absent → 503. Auth failure → 401. OpenAI error → 500.
import { auth } from '@/lib/auth';
import { JARVIS_SYSTEM_PROMPT, JARVIS_REALTIME_TOOLS } from '@/lib/realtime/jarvis-prompt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GA endpoint (2026): the beta '/v1/realtime/sessions' endpoint 404s now —
// ephemeral tokens are minted via '/v1/realtime/client_secrets' with a
// nested `session` body and a flat `value` field in the response.
const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets';

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

  // --- Mint ephemeral client secret via OpenAI Realtime GA API ---------------
  try {
    const res = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1',
          instructions: JARVIS_SYSTEM_PROMPT,
          // === JARVIS MOD #51 — register tools so the voice model can reach
          // the real JARVIS brain (calendar/CRM/MLS) instead of guessing. ===
          tools: JARVIS_REALTIME_TOOLS,
          tool_choice: 'auto',
          // === END JARVIS MOD #51 ===
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                silence_duration_ms: 800,
                prefix_padding_ms: 300,
              },
              transcription: { model: 'whisper-1' },
            },
            output: {
              voice: process.env.OPENAI_REALTIME_VOICE ?? 'shimmer',
            },
          },
        },
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
      value: string;
      expires_at: number;
      session: { id: string };
    };

    return Response.json(
      {
        token: data.value,
        expires_at: data.expires_at,
        session_id: data.session?.id,
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
