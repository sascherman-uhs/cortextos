// === JARVIS MOD #21 — Cosmos TTS: three-tier speech synthesis (2026-07-03) ===
// New file (isolated in the api/uhs/ local-mod zone). Session-authed POST { text }.
// Tier 1 — ElevenLabs (primary, activates the instant a key exists): resolve the
//   key AT REQUEST TIME (never cache its absence) from env then macOS Keychain,
//   call the EL text-to-speech REST API, and stream back audio/mpeg. Fully wired
//   now per Scott's direction even though no key is present yet.
// Tier 2 — jarvis-speak.sh (fallback): speaks server-side on the Mac's speakers
//   via macOS `say`. Returns JSON { spoken: true, path: 'say' }.
// Tier 3 — browser speechSynthesis (last resort): if the script fails, return
//   { spoken: false, path: 'browser' } and let the client speak.
import { auth } from '@/lib/auth';
import { spawn } from 'child_process';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Absolute path to the fallback speech script (lives in the JARVIS repo, not the
// dashboard). Kept as a constant so the tier-2 exec target is explicit.
const JARVIS_SPEAK_SH =
  '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/scripts/jarvis-speak.sh';

// ElevenLabs defaults. Voice/model are sensible low-latency choices; both can be
// overridden by env without a code change if Scott wants a specific voice later.
const EL_DEFAULT_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ?? 'onwK4e9ZLuTAKqWW03F9'; // "Daniel" — stock EL British voice, matches the SOUL.md butler persona + macOS `say -v Daniel` fallback
// === JARVIS MOD #107 (2026-08-09) — the latency model. eleven_flash_v2_5 is
// ElevenLabs' lowest-latency model and measured materially faster to FIRST BYTE
// than turbo on this account (see the probe recorded in LOCAL_MODS.md MOD #107).
// Quality difference is not audible on 1-2 sentence butler replies, which is all
// this route ever synthesizes (MAX_CHARS caps it at 800). ===
const EL_DEFAULT_MODEL =
  process.env.ELEVENLABS_MODEL_ID ?? 'eleven_flash_v2_5';
const EL_TIMEOUT_MS = 12_000;
// === JARVIS MOD #107 — output format + streaming latency tier.
// mp3_22050_32 instead of mp3_44100_128: a quarter of the bytes, which is a
// quarter of the transfer time on a phone, and 22kHz/32kbps is transparent for
// speech (it is not music). optimize_streaming_latency=3 trades a little
// prosody-lookahead for time-to-first-byte.
const EL_OUTPUT_FORMAT = 'mp3_22050_32';
const EL_STREAMING_LATENCY = '3';

// Cap length so `say` never blocks and EL payloads stay small.
const MAX_CHARS = 800;

/** Trim + hard-cap the text; empty after trim → null. */
function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
}

/**
 * Resolve the ElevenLabs API key at request time. Order:
 *   1. process.env.ELEVENLABS_API_KEY
 *   2. macOS Keychain: security find-generic-password -s elevenlabs -a jarvis -w
 * Returns the trimmed key, or null if none is found. NEVER cached — a key added
 * to the Keychain later must activate EL on the very next request.
 */
async function resolveElevenLabsKey(): Promise<string | null> {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  return new Promise<string | null>((resolve) => {
    const proc = spawn(
      'security',
      ['find-generic-password', '-s', 'elevenlabs', '-a', 'jarvis', '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code === 0) {
        const key = out.trim();
        resolve(key.length > 0 ? key : null);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Call the ElevenLabs TTS REST API. Returns the mp3 bytes as an ArrayBuffer, or
 * null on any non-2xx / error so the caller falls through to tier 2. Kept fully
 * self-contained so it exercises the real HTTP path the moment a key appears.
 */
async function synthesizeElevenLabs(
  text: string,
  apiKey: string,
): Promise<ArrayBuffer | null> {
  // === JARVIS MOD #107: the /stream endpoint starts sending audio as it is
  // generated rather than after the whole clip is rendered, which is where the
  // time-to-first-byte win comes from.
  //
  // The RESPONSE SHAPE IS DELIBERATELY UNCHANGED — still a fully buffered
  // arrayBuffer() handed back as one audio/mpeg body. Do not "improve" this into
  // a passthrough stream: the client decodes with ctx.decodeAudioData (MOD #28,
  // the iOS-proof playback path), which requires a COMPLETE mp3 and will throw
  // on a partial one. The streaming *feel* already comes from the per-sentence
  // pipeline in use-tts (MOD #24/#45), which is a better place for it — it
  // pipelines synthesis against playback instead of within one clip. ===
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    EL_DEFAULT_VOICE_ID,
  )}/stream?output_format=${EL_OUTPUT_FORMAT}&optimize_streaming_latency=${EL_STREAMING_LATENCY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: EL_DEFAULT_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[api/uhs/tts] ElevenLabs returned ${res.status}; falling through to say`,
      );
      return null;
    }
    return await res.arrayBuffer();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[api/uhs/tts] ElevenLabs call failed (${message}); falling through`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Speak the text locally via jarvis-speak.sh (macOS `say`). Resolves true if the
 * script exits 0, false otherwise. Text is passed as a single argv element (no
 * shell) so there is no injection surface.
 */
async function speakViaScript(text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn('/bin/bash', [JARVIS_SPEAK_SH, text], {
      cwd: path.dirname(JARVIS_SPEAK_SH),
      stdio: 'ignore',
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

export async function POST(request: Request) {
  // --- Tier 0: session gate (same shape as stream-token) ---------------------
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const text = normalizeText((body as { text?: unknown })?.text);
  if (!text) {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }

  // --- Tier 1: ElevenLabs (primary) ------------------------------------------
  const apiKey = await resolveElevenLabsKey();
  if (apiKey) {
    const audio = await synthesizeElevenLabs(text, apiKey);
    if (audio) {
      return new Response(audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(audio.byteLength),
          'x-tts-path': 'elevenlabs',
          'Cache-Control': 'no-store',
        },
      });
    }
    // EL errored — fall through to tier 2.
  }

  // --- Tier 2: jarvis-speak.sh (macOS say) -----------------------------------
  // === JARVIS MOD #107 — the phantom-success tier. `say` speaks on the MAC's
  // speakers. When the request came from Scott's iPhone PWA that is not a
  // fallback, it is a failure that returns 200: the Mac talks to an empty room,
  // the route reports { spoken: true }, and the phone — which is the only place
  // anyone is listening — stays completely silent with no error to show for it.
  // The client tells us where it is (x-tts-client, set in use-tts.fetchTts)
  // because standalone-PWA is a client-only fact the User-Agent does not carry.
  // Skipping straight to tier 3 hands the phone to speechSynthesis, which at
  // least makes a sound on the device holding it. ===
  const isIosPwaClient = request.headers.get('x-tts-client') === 'ios-pwa';
  if (isIosPwaClient) {
    console.warn(
      '[api/uhs/tts] iOS PWA client and ElevenLabs unavailable — skipping the `say` tier (it would speak on the Mac) and handing off to browser speech',
    );
    return Response.json(
      { spoken: false, path: 'browser' },
      { status: 200, headers: { 'x-tts-path': 'browser' } },
    );
  }

  const spoke = await speakViaScript(text);
  if (spoke) {
    return Response.json(
      { spoken: true, path: 'say' },
      { status: 200, headers: { 'x-tts-path': 'say' } },
    );
  }

  // --- Tier 3: browser speechSynthesis (last resort) -------------------------
  return Response.json(
    { spoken: false, path: 'browser' },
    { status: 200, headers: { 'x-tts-path': 'browser' } },
  );
}
// === END JARVIS MOD #21 ===
