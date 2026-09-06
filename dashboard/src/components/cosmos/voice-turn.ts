// === JARVIS MOD #36 — open-mic turn logic: wake gate, endpointing, sign-off ===
// New file (isolated, pure functions — no React, no DOM). Implements the
// deterministic turn-taking rules from the recovered Trillion `smooth-voice`
// prompt (vault/external/trillion-prompts/smooth-voice.md), Tiers 2 + 5:
//
//  - wakeMatch():        "jarvis" / "hey jarvis" prefix gate for open-mic turns.
//  - chooseHangoverMs(): layered fast/slow end-of-turn detection — quick when
//                        the recognizer confirmed a final phrase, patient when
//                        not, extra-patient when the transcript trails off
//                        mid-thought ("…and", "…um", trailing comma).
//  - isSignoff():        conservative natural-goodbye detector. Failure modes
//                        are asymmetric: silence-when-a-reply-was-wanted reads
//                        as broken, so EVERY veto biases toward replying.
//
// Tuning is one-line-change by design (word lists + consts below) per the
// smooth-voice guidance: "capture the misses as you find them."
// === END header ===

// --- End-of-turn hangovers (ms of VAD silence before we take the turn) -------
/** Recognizer just finalized a phrase — a short confirm window is enough. */
export const FAST_HANGOVER_MS = 400;
/** No final result yet (noisy room / trailing off) — be patient. */
export const SLOW_HANGOVER_MS = 950;
/** Transcript shape says "mid-thought" — extra patience so we never cut in. */
export const VETO_HANGOVER_MS = 1800;
/** Mic energy above this (0..1 RMS-ish avg) counts as speech for VAD. */
export const SPEECH_THRESHOLD = 0.055;
/** After JARVIS finishes speaking, no wake word needed for this long. */
export const FOLLOW_UP_MS = 8000;

// Trailing words that signal the speaker is mid-thought, not done.
const TRAIL_WORDS = [
  'and', 'but', 'so', 'or', 'because', 'then', 'also', 'plus',
  'um', 'uh', 'like', 'well', 'i', 'the', 'a', 'an', 'to', 'with',
];

/** Normalize for word matching: lowercase, strip punctuation EXCEPT apostrophes
 *  (so "i'll" never collapses into "ill", "we'll" never into "well"). */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!;:"“”()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Wake gate ---------------------------------------------------------------
// Punctuation-tolerant: Whisper habitually writes "Hey, Jarvis." — the comma
// after the greeting must not defeat the gate (found live 2026-07-08: Scott's
// first real-mic test produced zero sends). Also tolerate common Whisper
// mis-hearings of the name (same fix class as "Cleo"=Claude): Jervis, Javis,
// Jarvus, Jarves, Jarvas — AND of the greeting: "Hey" comes back as "A",
// "Hay", "Eh", or "Hi" (found live 2026-07-12: "A Jarvis" discarded on-phone).
const WAKE_NAME = '(?:jarvis|jervis|javis|jarvus|jarves|jarvas)';
const WAKE_RE = new RegExp(
  `^(?:hey|ok|okay|a|hay|eh|hi)?[,.!]?\\s*${WAKE_NAME}\\b[,.!?]?\\s*`,
  'i'
);

export interface WakeMatch {
  woke: boolean;
  /** The utterance with the wake prefix stripped ('' for a bare "hey jarvis"). */
  remainder: string;
}

/** Case/punctuation-insensitive "jarvis" / "hey jarvis" prefix gate. */
export function wakeMatch(text: string): WakeMatch {
  // Whisper decorates transcripts with junk lead-ins — ">> Hey Jarvis…", "- Hey
  // Jarvis…" — which defeated the ^-anchored gate (two live misses 2026-07-12,
  // "dead silence"). Strip any leading non-letter noise before matching.
  const trimmed = text.trim().replace(/^[^a-zA-Z]+/, '');
  const m = trimmed.match(WAKE_RE);
  if (!m) return { woke: false, remainder: trimmed };
  return { woke: true, remainder: trimmed.slice(m[0].length).trim() };
}

/** True when the wake word appears anywhere in the text — used for barge-in
 *  detection on the INTERIM transcript while JARVIS is speaking. */
const CONTAINS_WAKE_RE = new RegExp(`\\b${WAKE_NAME}\\b`, 'i');
export function containsWakeWord(text: string): boolean {
  return CONTAINS_WAKE_RE.test(text);
}

// --- Layered end-of-turn detection (smooth-voice Tier 2) ----------------------
export interface HangoverInput {
  /** The recognizer marked the latest result final (desktop Web Speech only). */
  hasFinalTail: boolean;
  /** Current utterance transcript (may be interim). */
  transcript: string;
}

export function chooseHangoverMs({ hasFinalTail, transcript }: HangoverInput): number {
  const t = transcript.trim().toLowerCase();
  // Transcript-shape veto: trailing comma or mid-thought word → extra patience.
  if (/,$/.test(t)) return VETO_HANGOVER_MS;
  const lastWord = norm(t).split(' ').pop() ?? '';
  if (TRAIL_WORDS.includes(lastWord)) return VETO_HANGOVER_MS;
  return hasFinalTail ? FAST_HANGOVER_MS : SLOW_HANGOVER_MS;
}

// --- Natural-goodbye detection (smooth-voice Tier 5) ---------------------------
// === JARVIS MOD #53 (2026-08-03): the detector MOVED to
// `src/lib/voice/signoff.ts` so the Realtime path and the server send route can
// reach the same answer. Re-exported here so every MOD #36/#39 caller and the
// existing unit lock keep importing from voice-turn unchanged. ===
export { isSignoff, SIGNOFF_LINES, signoffLine, MAX_SIGNOFF_WORDS } from '@/lib/voice/signoff';
// === END JARVIS MOD #53 ===

// === END JARVIS MOD #36 (voice-turn.ts) ===
