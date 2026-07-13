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
// Sign-off phrases: one must ACTUALLY be present.
const SIGNOFF_PHRASES = [
  'thanks', 'thank you', 'got it', 'sounds good', 'will do', 'perfect',
  'cool', 'bye', 'goodbye', 'good night', 'goodnight', 'right on',
  "that's all", 'that is all', "we're done", 'all set', 'take care',
  'later', 'cheers', 'good work', 'well done', 'i will do that', "i'll do that",
];
// Any of these anywhere = the person wants something back → reply normally.
const QUESTION_WORDS = [
  'can you', 'could you', 'would you', 'will you', 'how', 'what', 'why',
  'when', 'where', 'who', 'one more', 'another thing', 'what about',
  'how about', 'also', 'but',
];
// Imperative command verbs = an instruction, not a farewell…
const COMMAND_VERBS = [
  'send', 'draft', 'email', 'schedule', 'run', 'check', 'create', 'update',
  'make', 'pull', 'show', 'give', 'add', 'remove', 'delete', 'fix', 'find',
  'look', 'get', 'call', 'text', 'remind',
];
// …unless the person is committing to do it THEMSELVES.
const SELF_COMMIT_RE = /\b(i'll|i will|i'm going to|i am going to|i can|let me)\b/;
// A SHORT self-commitment is itself a sign-off form ("great, I'll send that"):
// optional positive lead + I'll/let me + verb + optional bare pronoun object.
// A concrete object ("I'll email the proposal to Melinda") does NOT match —
// that's the person still working, engage normally.
const SELF_COMMIT_SIGNOFF_RE =
  /^(?:(?:ok|okay|great|perfect|cool|alright|all right|sounds good|got it|right on|yeah)[,!]?\s+)?(?:i'll|i will|let me|i'm going to|i can)\s+\w+(?:\s+(?:that|it|them|those|this|now))?$/;

const MAX_SIGNOFF_WORDS = 8;

/**
 * Conservative sign-off detector. Bias: when unsure, REPLY (return false).
 * @param text        the (wake-stripped) utterance
 * @param hadAgentTurn only end a conversation the assistant was actually part of
 */
export function isSignoff(text: string, hadAgentTurn: boolean): boolean {
  if (!hadAgentTurn) return false; // never swallow the very first thing said
  const t = norm(text);
  if (!t) return false;
  if (text.includes('?')) return false; // questions veto
  const words = t.split(' ');
  if (words.length > MAX_SIGNOFF_WORDS) return false; // real goodbyes are brief

  // Short self-commitment ("great, I'll send that") is a sign-off in itself.
  if (SELF_COMMIT_SIGNOFF_RE.test(t)) return true;

  // Otherwise a sign-off phrase must actually be present.
  if (!SIGNOFF_PHRASES.some((p) => t.includes(p))) return false;

  // Question-ish content vetoes.
  if (QUESTION_WORDS.some((q) => new RegExp(`\\b${q}\\b`).test(t))) return false;

  // Commands veto — unless the speaker is committing to do it themselves.
  const selfCommit = SELF_COMMIT_RE.test(t);
  if (!selfCommit && COMMAND_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(t))) {
    return false;
  }

  // Continuation veto: a leading positive followed by substantial new content
  // ("great, the meeting went well") is the person still talking. If after
  // removing all signoff phrases + fillers there's still meat, reply normally.
  let residue = t;
  for (const p of SIGNOFF_PHRASES) residue = residue.split(p).join(' ');
  residue = residue
    .replace(/\b(ok|okay|great|awesome|alright|all right|yeah|yes|no|so|and|for|now|then|sir|jarvis)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (residue.split(' ').filter(Boolean).length > 2) return false;

  return true;
}

// Short spoken sign-off lines (local, canned — a goodbye costs no agent call).
export const SIGNOFF_LINES = [
  'Very good, sir.',
  'Until next time, sir.',
  'I shall be here.',
  'Standing by.',
];
// === END JARVIS MOD #36 (voice-turn.ts) ===
