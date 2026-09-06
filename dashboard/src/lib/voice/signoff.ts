// === JARVIS MOD #53 — shared deterministic sign-off (goodbye) detector ===
// New file. The detector was born inside `components/cosmos/voice-turn.ts`
// (MOD #36) where only the browser fast path could reach it. Three surfaces
// now need the SAME answer, so the logic lives here and voice-turn.ts
// re-exports it for its existing callers:
//
//   1. the open-mic fast path  (use-voice.ts, unchanged behavior)
//   2. the OpenAI Realtime path (use-realtime-voice.ts — MOD #53)
//   3. the server send route    (/api/messages/send — defense in depth for
//      typed turns and any client that never ran the client-side check)
//
// Contract (TRILLION-BAR.md "Voice UX"): a pure sign-off costs ZERO model
// tokens. The check runs BEFORE any LLM call and is deterministic — no model
// is asked "was that a goodbye?", because that question costs exactly what
// the check is meant to save.
//
// Bias is asymmetric and deliberate: staying silent when a reply was wanted
// reads as broken, while one extra "Very good, sir" reads as polite. EVERY
// ambiguity therefore resolves to `false` (reply normally).
// === END header ===

/** Sign-off phrases — one must ACTUALLY be present (word-boundary matched, so
 *  "thanks" fires on "thanks a lot" but never inside "thanksgiving"). */
const SIGNOFF_PHRASES = [
  'thanks', 'thank you', 'got it', 'sounds good', 'will do', 'perfect',
  'cool', 'bye', 'goodbye', 'good night', 'goodnight', 'right on',
  "that's all", 'that is all', "we're done", 'all set', 'take care',
  'later', 'cheers', 'good work', 'well done', 'i will do that', "i'll do that",
];

/** Any of these anywhere = the person wants something back → reply normally. */
const QUESTION_WORDS = [
  'can you', 'could you', 'would you', 'will you', 'how', 'what', 'why',
  'when', 'where', 'who', 'one more', 'another thing', 'what about',
  'how about', 'also', 'but',
];

/** Interrogative openers — a question that lost its question mark in
 *  transcription ("is that all set", "are we done here"). Whisper drops '?'
 *  routinely, so punctuation alone is not a sufficient question signal. */
const INTERROGATIVE_OPENERS = [
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'should', 'shall',
  'can', 'could', 'would', 'will', 'have', 'has', 'am',
];

/** Imperative command verbs = an instruction, not a farewell… */
const COMMAND_VERBS = [
  'send', 'draft', 'email', 'schedule', 'run', 'check', 'create', 'update',
  'make', 'pull', 'show', 'give', 'add', 'remove', 'delete', 'fix', 'find',
  'look', 'get', 'call', 'text', 'remind',
];

/** …unless the person is committing to do it THEMSELVES. */
const SELF_COMMIT_RE = /\b(i'll|i will|i'm going to|i am going to|i can|let me)\b/;

/** A SHORT self-commitment is itself a sign-off form ("great, I'll send that"):
 *  optional positive lead + I'll/let me + verb + optional bare pronoun object.
 *  A concrete object ("I'll email the proposal to Melinda") does NOT match —
 *  that's the person still working, so engage normally. */
const SELF_COMMIT_SIGNOFF_RE =
  /^(?:(?:ok|okay|great|perfect|cool|alright|all right|sounds good|got it|right on|yeah)[,!]?\s+)?(?:i'll|i will|let me|i'm going to|i can)\s+\w+(?:\s+(?:that|it|them|those|this|now))?$/;

/** Time nouns that turn a farewell word into a scheduling word:
 *  "later" is a goodbye; "later today" is an appointment. */
const TIME_NOUNS = [
  'today', 'tonight', 'tomorrow', 'morning', 'afternoon', 'evening', 'week',
  'month', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'am', 'pm', "o'clock",
];

/** Skipped when looking for the time noun after a farewell word. */
const DETERMINERS = ['this', 'that', 'next', 'the', 'on', 'in', 'at'];

/** Real goodbyes are brief. Anything longer is a person still talking. */
export const MAX_SIGNOFF_WORDS = 8;

/**
 * Normalize for word matching: lowercase, strip punctuation EXCEPT apostrophes.
 *
 * The apostrophe is load-bearing, not cosmetic — it is the ONLY thing keeping
 * the recognizer's homophones apart. Strip it and "we'll" collapses into
 * "well" and "i'll" into "ill", which silently converts working sentences into
 * sign-off matches. Every homophone test in the suite fails without this.
 */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!;:"“”()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary presence test. Escapes regex metacharacters in `phrase`. */
function hasPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystack);
}

/**
 * Conservative sign-off detector. Bias: when unsure, REPLY (return false).
 *
 * @param text         the (wake-stripped) utterance
 * @param hadAgentTurn only end a conversation the assistant was actually part
 *                     of — the very first thing said is never swallowed
 */
export function isSignoff(text: string, hadAgentTurn: boolean): boolean {
  if (!hadAgentTurn) return false; // never swallow the very first thing said
  const t = norm(text);
  if (!t) return false;
  if (text.includes('?')) return false; // explicit question vetoes
  const words = t.split(' ');
  if (words.length > MAX_SIGNOFF_WORDS) return false;

  // Un-punctuated question ("are we good", "is that all set") vetoes.
  if (INTERROGATIVE_OPENERS.includes(words[0])) return false;

  // Short self-commitment ("great, I'll send that") is a sign-off in itself.
  if (SELF_COMMIT_SIGNOFF_RE.test(t)) return true;

  // Otherwise a sign-off phrase must actually be present, as a whole word.
  const matched = SIGNOFF_PHRASES.filter((p) => hasPhrase(t, p));
  if (matched.length === 0) return false;

  // Scheduling veto: "later"/"good night" followed by a time noun is a plan,
  // not a farewell ("talk later today", "cool, tomorrow then").
  for (const p of matched) {
    const after = t.split(new RegExp(`(?:^|\\s)${p}(?:\\s|$)`))[1] ?? '';
    // Skip determiners so "later THIS week" is caught alongside "later today".
    const nextWord = after.trim().split(' ').find((w) => !DETERMINERS.includes(w)) ?? '';
    if (TIME_NOUNS.includes(nextWord)) return false;
  }

  // Question-ish content vetoes.
  if (QUESTION_WORDS.some((q) => hasPhrase(t, q))) return false;

  // Commands veto — unless the speaker is committing to do it themselves.
  const selfCommit = SELF_COMMIT_RE.test(t);
  if (!selfCommit && COMMAND_VERBS.some((v) => hasPhrase(t, v))) {
    return false;
  }

  // Continuation veto: a leading positive followed by substantial new content
  // ("great, the meeting went well") is the person still talking. If after
  // removing every sign-off phrase + filler there is still meat, reply.
  let residue = t;
  for (const p of SIGNOFF_PHRASES) residue = residue.split(p).join(' ');
  residue = residue
    .replace(/\b(ok|okay|great|awesome|alright|all right|yeah|yes|no|so|and|for|now|then|sir|jarvis)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (residue.split(' ').filter(Boolean).length > 2) return false;

  return true;
}

/** Short spoken sign-off lines (local, canned — a goodbye costs no model call). */
export const SIGNOFF_LINES = [
  'Very good, sir.',
  'Until next time, sir.',
  'I shall be here.',
  'Standing by.',
];

/** Deterministic pick so callers can rotate without sharing state. */
export function signoffLine(index: number): string {
  return SIGNOFF_LINES[Math.abs(index) % SIGNOFF_LINES.length];
}
// === END JARVIS MOD #53 ===
