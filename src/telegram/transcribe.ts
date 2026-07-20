/**
 * Voice transcription via local whisper.cpp (whisper-cli).
 *
 * Returns null on any failure (binary missing, model missing, timeout,
 * empty output). The caller treats null as "no transcript available" and
 * the agent still receives the .ogg path — agents capable of running
 * whisper themselves can do so.
 *
 * Disable entirely with CTX_TELEGRAM_NO_TRANSCRIBE=1.
 * Override binaries / model with CTX_WHISPER_BIN, CTX_FFMPEG_BIN,
 * CTX_WHISPER_MODEL.
 * Override transcription language with CTX_WHISPER_LANG (passed via
 * whisper-cli's `-l` flag). Default is 'auto' (auto-detect). Note: `.en`
 * models (e.g. ggml-tiny.en.bin) are English-only — the lang flag has no
 * effect there. Use a multilingual model (no `.en` suffix) for non-English
 * audio.
 */
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 60_000;

// [UHS MOD #13] Deepgram Nova-3 as primary transcriber with whisper.cpp fallback.
// Key resolves from DEEPGRAM_API_KEY env, else macOS Keychain (service 'deepgram',
// account 'jarvis' — installed via scripts/install-deepgram-key-from-clipboard.sh in
// the uhsJARVIS repo). Disable with CTX_DEEPGRAM_DISABLE=1. If no key or any failure,
// transcribeVoice() falls through to the original local whisper path below.
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

async function transcribeViaDeepgram(
  oggPath: string,
  log: (line: string) => void,
  timeoutMs: number,
): Promise<string | null> {
  const key = resolveDeepgramKey();
  if (!key) return null;

  const audio = fs.readFileSync(oggPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Telegram voice notes are OGG/Opus, which Deepgram accepts directly (no ffmpeg).
    const resp = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/ogg' },
        body: audio,
        signal: controller.signal,
      },
    );
    if (!resp.ok) {
      log(`[transcribe] deepgram HTTP ${resp.status} — falling back to whisper`);
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

function resolveModelPath(): string {
  if (process.env.CTX_WHISPER_MODEL) return process.env.CTX_WHISPER_MODEL;
  return path.join(os.homedir(), '.cortextos', 'models', 'ggml-tiny.en.bin');
}

function resolveBin(envVar: string, fallback: string): string {
  return process.env[envVar] || fallback;
}

function resolveLang(): string {
  return process.env.CTX_WHISPER_LANG || 'auto';
}

export interface TranscribeOptions {
  timeoutMs?: number;
  modelPath?: string;
  log?: (line: string) => void;
}

/**
 * Transcribe a Telegram voice .ogg file. Returns the trimmed transcript
 * text, or null if transcription was unavailable / failed.
 */
export async function transcribeVoice(
  oggPath: string,
  opts: TranscribeOptions = {},
): Promise<string | null> {
  if (process.env.CTX_TELEGRAM_NO_TRANSCRIBE === '1') return null;
  if (!oggPath || !fs.existsSync(oggPath)) return null;

  const log = opts.log || (() => {});

  // [UHS MOD #13] Try Deepgram Nova-3 first; on absent key / any failure, fall
  // through to the local whisper.cpp path below (unchanged original behavior).
  if (process.env.CTX_DEEPGRAM_DISABLE !== '1') {
    try {
      const dg = await transcribeViaDeepgram(oggPath, log, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (dg) {
        log('[transcribe] via Deepgram nova-3');
        return dg;
      }
    } catch (err) {
      log(`[transcribe] deepgram error (${(err as Error).message}) — falling back to whisper`);
    }
  }

  const modelPath = opts.modelPath || resolveModelPath();
  const ffmpegBin = resolveBin('CTX_FFMPEG_BIN', 'ffmpeg');
  const whisperBin = resolveBin('CTX_WHISPER_BIN', 'whisper-cli');
  const lang = resolveLang();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!fs.existsSync(modelPath)) {
    log(`[transcribe] model not found at ${modelPath} — skipping; run scripts/install-whisper-model.sh to enable transcription`);
    return null;
  }

  const wavPath = oggPath.replace(/\.ogg$/i, '.wav');
  const ffmpegOk = await runProcess(
    ffmpegBin,
    ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
    timeoutMs,
  );
  if (!ffmpegOk.ok) {
    log(`[transcribe] ffmpeg failed (${ffmpegOk.reason}) — skipping`);
    return null;
  }

  try {
    const whisper = await runProcess(
      whisperBin,
      ['-m', modelPath, '-f', wavPath, '-l', lang, '-nt', '-np'],
      timeoutMs,
      true,
    );
    if (!whisper.ok) {
      log(`[transcribe] whisper-cli failed (${whisper.reason}) — skipping`);
      return null;
    }
    const text = (whisper.stdout || '').trim();
    if (!text) {
      log('[transcribe] whisper-cli produced empty output — skipping');
      return null;
    }
    return text;
  } finally {
    if (fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore cleanup error */ }
    }
  }
}

interface ProcessResult {
  ok: boolean;
  reason?: string;
  stdout?: string;
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number,
  capture = false,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const settle = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let proc;
    try {
      proc = spawn(bin, args, {
        stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch (err) {
      return settle({ ok: false, reason: `spawn-error: ${(err as Error).message}` });
    }

    if (capture && proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    }
    proc.on('error', (err) => settle({ ok: false, reason: `error: ${err.message}` }));
    proc.on('close', (code) => {
      if (code === 0) return settle({ ok: true, stdout });
      settle({ ok: false, reason: `exit-${code}`, stdout });
    });
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
}
