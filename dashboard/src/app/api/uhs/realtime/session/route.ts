// === JARVIS MOD — Realtime API session token minting (Phase 1) ===
// New file (isolated in the api/uhs/ local-mod zone). Session-authed POST.
// Mints an ephemeral client_secret from the OpenAI Realtime sessions endpoint
// and returns { token, expires_at, session_id } to the caller.
// If OPENAI_API_KEY is absent → 503. Auth failure → 401. OpenAI error → 500.
import { auth } from '@/lib/auth';
import {
  JARVIS_SYSTEM_PROMPT,
  JARVIS_REALTIME_TOOLS,
  jarvisDateAnchor,
} from '@/lib/realtime/jarvis-prompt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GA endpoint (2026): the beta '/v1/realtime/sessions' endpoint 404s now —
// ephemeral tokens are minted via '/v1/realtime/client_secrets' with a
// nested `session` body and a flat `value` field in the response.
const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets';

// === JARVIS MOD #107 — end-of-turn silence (2026-08-09) ==========================
// The single biggest lever on perceived latency that is NOT model time: server
// VAD waits this long after you stop making noise before it decides the turn is
// over. Every millisecond here is dead air the user experiences as JARVIS being
// slow. 500ms is noticeably snappier and is what the latency work wants; 800ms
// is more forgiving of mid-sentence pauses (Scott thinks out loud mid-question).
// Left at the PROVEN 800 by default — this mod is not the place to change how
// endpointing feels — but hoisted to a named constant with the trade written
// down so the experiment is a one-line edit instead of an archaeology project.
const VAD_SILENCE_DURATION_MS = 800; // try 500 for a snappier turn boundary

export async function POST(request: Request) {
  // --- Auth gate: same session check as /api/uhs/tts -------------------------
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // === JARVIS MOD #107 — engine-aware minting. The Daniel lane needs a
  // TEXT-ONLY session: OpenAI must not synthesize speech at all, because the
  // reply is spoken by ElevenLabs on the client. Verified live against the GA
  // API 2026-08-09: `output_modalities` is a TOP-LEVEL session field, ["text"]
  // is accepted (HTTP 200, echoed back in the session object), and the beta name
  // `modalities` now hard-400s with "Unknown parameter: 'session.modalities'".
  // `audio.output.voice` is also accepted alongside it, but it is omitted here —
  // asking for a voice we will never play is a lie in the session object, and
  // the next person reading it would reasonably conclude OpenAI is speaking.
  let engine = 'realtime';
  try {
    const body = (await request.json()) as { engine?: string };
    if (body?.engine === 'realtime-el') engine = 'realtime-el';
  } catch {
    // No body / bad JSON — keep the audio-speaking default. Callers predating
    // this mod send no body at all, and they must keep working unchanged.
  }
  const textOnly = engine === 'realtime-el';

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
          // === JARVIS MOD #104 — date anchor. The session was minted with no
          // notion of what day it is, so "this year" / "last month" had nothing
          // to resolve against and the model demanded explicit dates (IMG_5108:
          // "the count must come from the system, not optimism" — to its own
          // CFO, about the phrase "this year"). The anchor is minted fresh per
          // session; the per-turn tonal cue re-stamps it so long sessions and
          // midnight rollovers stay correct. ===
          instructions: `${jarvisDateAnchor()}\n\n${JARVIS_SYSTEM_PROMPT}`,
          // === JARVIS MOD #51 — register tools so the voice model can reach
          // the real JARVIS brain (calendar/CRM/MLS) instead of guessing. ===
          tools: JARVIS_REALTIME_TOOLS,
          tool_choice: 'auto',
          // === END JARVIS MOD #51 ===
          // === MOD #107: text-only for the Daniel lane. Function calling is
          // unaffected — verified in the GA docs and by the live mint:
          // function_call items still arrive as response.done output items. ===
          ...(textOnly ? { output_modalities: ['text'] } : {}),
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                silence_duration_ms: VAD_SILENCE_DURATION_MS,
                prefix_padding_ms: 300,
              },
              transcription: { model: 'whisper-1' },
            },
            // Input transcription is still needed on BOTH lanes (it is how the
            // user's own words reach the log and the sign-off detector); only
            // the OUTPUT half is dropped for the text-only engine.
            ...(textOnly
              ? {}
              : {
                  output: {
                    voice: process.env.OPENAI_REALTIME_VOICE ?? 'shimmer',
                  },
                }),
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
