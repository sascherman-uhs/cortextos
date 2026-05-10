/**
 * Deepgram speech-to-text transcription for Telegram voice messages.
 * Uses native fetch (Node 18+) — no extra dependencies required.
 *
 * Usage:
 *   const transcript = await transcribeVoiceFile('/path/to/voice.ogg');
 *   // returns transcript string or null if transcription fails / no key configured
 */

import * as fs from 'fs';

const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_PARAMS = '?model=nova-2&language=en&smart_format=true&punctuate=true';

/**
 * Transcribe a local audio file using Deepgram Nova-2.
 * Returns the transcript string, or null if the API key is missing or the call fails.
 */
export async function transcribeVoiceFile(filePath: string): Promise<string | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return null;
  }

  let audioData: Buffer;
  try {
    audioData = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  // Detect content type from extension
  const ext = filePath.split('.').pop()?.toLowerCase();
  const contentType = ext === 'mp3' ? 'audio/mp3'
    : ext === 'wav' ? 'audio/wav'
    : ext === 'm4a' ? 'audio/mp4'
    : 'audio/ogg'; // default for Telegram voice notes (.oga / .ogg / .opus)

  try {
    const response = await fetch(`${DEEPGRAM_API_URL}${DEEPGRAM_PARAMS}`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': contentType,
      },
      body: audioData,
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{ transcript?: string }>;
        }>;
      };
    };

    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    return transcript && transcript.trim() ? transcript.trim() : null;
  } catch {
    // Network error or parse failure — fall back to no transcript
    return null;
  }
}
