// JARVIS MOD #45 — Phase 3 sentence-streaming unit tests
//
// Invariants:
//  1. Only COMPLETE sentences flush; the unfinished tail always stays in rest.
//  2. Decimal numbers / mid-token periods never split a sentence.
//  3. Any '<' in the buffer freezes extraction (escalation-sentinel safety —
//     no fragment of an `<<ESCALATE>>` turn may ever be spoken).
//  4. Too-short sentences merge forward instead of spawning a TTS round-trip.
//  5. Feeding a reply chunk-by-chunk yields the same sentences as one pass.

import { describe, it, expect } from 'vitest';
import { extractSentences } from '../stream-sentences';

describe('extractSentences', () => {
  it('flushes a complete sentence and keeps the unfinished tail', () => {
    const r = extractSentences('Calendar is clear until two. After that the Daly ins');
    expect(r.sentences).toEqual(['Calendar is clear until two.']);
    expect(r.rest).toBe('After that the Daly ins');
  });

  it('holds everything when no boundary has landed yet', () => {
    const r = extractSentences('Three showings this week and zero calls so');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('Three showings this week and zero calls so');
  });

  it('does not split on decimals or mid-number periods', () => {
    const r = extractSentences('The list price is $1.5 million as of today. Second part com');
    expect(r.sentences).toEqual(['The list price is $1.5 million as of today.']);
    expect(r.rest).toBe('Second part com');
  });

  it('freezes extraction when the buffer contains < (escalation safety)', () => {
    expect(extractSentences('Real sentence here. <<ESCA').sentences).toEqual([]);
    expect(extractSentences('<<ESCALATE>>').sentences).toEqual([]);
    expect(extractSentences('a < b holds. more text ').sentences).toEqual([]);
  });

  it('short answer-first sentences flush immediately (the whole point)', () => {
    const r = extractSentences('Done. Invoice sent and QuickBooks agrees with itself. tail');
    expect(r.sentences).toEqual(['Done.', 'Invoice sent and QuickBooks agrees with itself.']);
    expect(r.rest).toBe('tail');
    expect(extractSentences('Las Vegas. The office has st').sentences).toEqual(['Las Vegas.']);
  });

  it('degenerate fragments still merge forward, not flushed alone', () => {
    const r = extractSentences('A. no');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('A. no');
  });

  it('chunked feeding matches single-pass extraction', () => {
    const full =
      'Forty-one days on market with one showing a week. ' +
      'The price is not wrong; the conversation about it is overdue. ' +
      'Want more detail?';
    const single = extractSentences(full);
    const allSingle = [...single.sentences, single.rest.trim()].filter(Boolean);

    const chunks = full.match(/.{1,7}/g) as string[];
    let pending = '';
    const streamed: string[] = [];
    for (const c of chunks) {
      pending += c;
      const { sentences, rest } = extractSentences(pending);
      streamed.push(...sentences);
      pending = rest;
    }
    const allStreamed = [...streamed, pending.trim()].filter(Boolean);
    expect(allStreamed.join(' ')).toBe(allSingle.join(' '));
    expect(streamed.length).toBeGreaterThanOrEqual(2);
  });

  it('question and exclamation marks are boundaries', () => {
    const r = extractSentences('Shall I make it actually ready? I thought so! nex');
    expect(r.sentences).toEqual(['Shall I make it actually ready?', 'I thought so!']);
    expect(r.rest).toBe('nex');
  });
});
