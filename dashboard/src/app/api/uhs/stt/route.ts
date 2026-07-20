// === JARVIS MOD #27 — Cosmos STT: MediaRecorder → Whisper fallback (2026-07-05) ===
// POST multipart/form-data { audio: Blob } → { transcript: string }
// Used by use-voice.ts when webkitSpeechRecognition is unavailable (iOS PWA standalone).
// Runs Whisper `base` model locally — model already cached at ~/.cache/whisper/base.pt.
import { auth } from '@/lib/auth';
import { exec, execFileSync } from 'child_process';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// === JARVIS MOD #42 — Deepgram Nova-3 primary for Cosmos STT, whisper.cpp fallback (2026-07-20) ===
// Parity with the Telegram voice path (cortextos MOD #13). Deepgram is markedly
// more accurate on proper nouns (street/agent/subdivision names) than the local
// tiny.en model. Key from DEEPGRAM_API_KEY env, else macOS Keychain
// (service 'deepgram', account 'jarvis'). Disable with CTX_DEEPGRAM_DISABLE=1.
// Any failure / absent key falls through to the whisper.cpp path unchanged.
let cachedDeepgramKey: string | null | undefined;

function resolveDeepgramKey(): string | null {
  if (cachedDeepgramKey !== undefined) return cachedDeepgramKey;
  let key = (process.env.DEEPGRAM_API_KEY || '').trim();
  if (!key) {
    try {
      key = execFileSync(
        'security',
        ['find-generic-password', '-s', 'deepgram', '-a', 'jarvis', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      key = '';
    }
  }
  cachedDeepgramKey = key || null;
  return cachedDeepgramKey;
}

async function transcribeViaDeepgram(buf: Buffer, mimeType: string): Promise<string | null> {
  const key = resolveDeepgramKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    // Deepgram accepts m4a/mp4, webm/opus, and ogg directly — no ffmpeg needed.
    const resp = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': mimeType || 'audio/mp4' },
        body: new Uint8Array(buf),
        signal: controller.signal,
      },
    );
    if (!resp.ok) {
      console.warn(`[stt] deepgram HTTP ${resp.status} — falling back to whisper`);
      return null;
    }
    const data = (await resp.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } finally {
    clearTimeout(timer);
  }
}
// === END JARVIS MOD #42 helpers ===

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return new Response('Unauthorized', { status: 401 });

  let tmpAudio: string | null = null;
  let tmpDir: string | null = null;

  try {
    const form = await req.formData();
    const audio = form.get('audio') as File | null;
    if (!audio) return Response.json({ error: 'No audio' }, { status: 400 });

    const buf = Buffer.from(await audio.arrayBuffer());

    // === JARVIS MOD #42: Deepgram Nova-3 first; on absent key / any failure,
    // fall through to the local whisper.cpp path below (unchanged). ===
    if (process.env.CTX_DEEPGRAM_DISABLE !== '1') {
      try {
        const dg = await transcribeViaDeepgram(buf, audio.type);
        if (dg) {
          console.log(`[stt] ${buf.length}b → "${dg}" (deepgram nova-3)`);
          return Response.json({ transcript: dg });
        }
      } catch (err) {
        console.warn('[stt] deepgram error — falling back to whisper:', err);
      }
    }

    // Use a session-unique temp dir so parallel requests don't clobber each other.
    tmpDir = join(tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await mkdir(tmpDir, { recursive: true });

    // iOS sends audio/mp4 (.m4a); other browsers may send webm/ogg. Whisper handles both.
    const ext = audio.type.includes('mp4') || audio.type.includes('m4a') ? 'm4a' : 'webm';
    tmpAudio = join(tmpDir, `audio.${ext}`);
    await writeFile(tmpAudio, buf);

    // === JARVIS MOD #28 (2026-07-06): whisper.cpp instead of Python whisper ===
    // The Python CLI paid ~2s of interpreter+model cold start per request on top
    // of inference. Metal-accelerated whisper-cli with the tiny.en GGML model
    // transcribes a short utterance in ~0.5s warm (benchmarked on this M5:
    // 0.56s vs 2.2s, identical transcript). ffmpeg first: iOS uploads audio/mp4,
    // and normalizing to 16k mono wav keeps whisper-cli's decoder happy.
    const wavPath = join(tmpDir, 'audio.wav');
    await execAsync(
      `/opt/homebrew/bin/ffmpeg -y -loglevel error -i "${tmpAudio}" -ar 16000 -ac 1 "${wavPath}"`,
      { timeout: 20_000 },
    );
    const modelPath =
      process.env.WHISPER_CPP_MODEL ??
      `${process.env.HOME}/.cortextos/models/ggml-tiny.en.bin`;
    await execAsync(
      `/opt/homebrew/bin/whisper-cli -m "${modelPath}" -f "${wavPath}" -oj -of "${join(tmpDir, 'audio')}" -np`,
      { timeout: 60_000 },
    );

    // whisper-cli -oj writes audio.json: { transcription: [{ text }, ...] }
    const jsonPath = join(tmpDir, `audio.json`);
    const raw = await readFile(jsonPath, 'utf8');
    const cppParsed = JSON.parse(raw) as { transcription?: { text: string }[] };
    const parsed = {
      text: (cppParsed.transcription ?? []).map((s) => s.text).join(' '),
      segments: undefined as { text: string }[] | undefined,
    };
    // === END JARVIS MOD #28 ===

    const transcript =
      parsed.text?.trim() ||
      parsed.segments?.map((s) => s.text).join(' ').trim() ||
      '';

    // MOD #39g: log every transcript — "is the loss Whisper or a client filter?"
    // must be answerable from `pm2 logs dash-cortexos` without a repro session.
    console.log(`[stt] ${buf.length}b → "${transcript}"`);

    return Response.json({ transcript });
  } catch (err) {
    console.error('[stt] Whisper error:', err);
    return Response.json({ error: 'Transcription failed', detail: String(err) }, { status: 500 });
  } finally {
    // Clean up temp files — best effort.
    if (tmpAudio) unlink(tmpAudio).catch(() => {});
    if (tmpDir) {
      // Remove the json and any other output files Whisper wrote.
      execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
    }
  }
}
// === END JARVIS MOD #27 ===
