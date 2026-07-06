// === JARVIS MOD #27 — Cosmos STT: MediaRecorder → Whisper fallback (2026-07-05) ===
// POST multipart/form-data { audio: Blob } → { transcript: string }
// Used by use-voice.ts when webkitSpeechRecognition is unavailable (iOS PWA standalone).
// Runs Whisper `base` model locally — model already cached at ~/.cache/whisper/base.pt.
import { auth } from '@/lib/auth';
import { exec } from 'child_process';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
