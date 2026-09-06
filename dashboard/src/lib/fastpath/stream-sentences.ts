// cortextOS Dashboard — streaming sentence extractor (JARVIS MOD #45, Phase 3)
//
// Pure helper shared by the server fast-path stream (fast-reply) and the
// client NDJSON consumer (use-voice). Given an accumulating text buffer,
// pulls out COMPLETE sentences and returns the unfinished remainder, so the
// first sentence of a reply can be spoken while the rest is still generating.
//
// Safety rule: if the buffer contains '<' anywhere, extraction stops and
// everything is held in `rest`. The fast-path escalation sentinel is
// `<<ESCALATE>>` — a reply that will escalate must never leak a spoken
// fragment, and voice replies are markdown/URL-free by the VOICE_CUE rules,
// so a literal '<' in normal speech is not a real loss.

/** Minimum sentence length worth flushing on its own. Deliberately tiny:
 *  "Las Vegas." / "Done." are the answer-first beat the whole feature exists
 *  to fire early (streamed:0 on exactly those replies is what a 12-char
 *  threshold caused in live testing). Only degenerate "A."-style fragments
 *  merge forward. */
const MIN_FLUSH_CHARS = 4;

export interface ExtractResult {
  /** Complete sentences ready to speak, in order. */
  sentences: string[];
  /** Unfinished tail — pass back in as the prefix of the next buffer. */
  rest: string;
}

/**
 * Extract complete sentences from `buffer`. A sentence is complete when its
 * terminal punctuation (., !, ?, …) is followed by whitespace. The final
 * segment (no trailing whitespace after punctuation yet) always stays in
 * `rest` — the stream may still be mid-sentence ("$1.5" must not split).
 */
export function extractSentences(buffer: string): ExtractResult {
  if (buffer.includes('<')) return { sentences: [], rest: buffer };

  const parts = buffer.split(/(?<=[.!?…])\s+/);
  if (parts.length <= 1) return { sentences: [], rest: buffer };

  const rest = parts.pop() as string;
  const sentences: string[] = [];
  let carry = '';
  for (const p of parts) {
    const merged = carry ? `${carry} ${p}` : p;
    if (merged.trim().length < MIN_FLUSH_CHARS) {
      carry = merged;
    } else {
      sentences.push(merged.trim());
      carry = '';
    }
  }
  // A too-short leftover prepends to the unfinished tail rather than flushing.
  return { sentences, rest: carry ? `${carry} ${rest}` : rest };
}
