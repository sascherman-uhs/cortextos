// === JARVIS MOD #38 — reply dedupe unit tests (2026-07-07) ===
// Locks the single decision point that prevents a fast-lane reply from being
// SPOKEN TWICE (once from the synchronous POST response, once from the SSE echo
// of the same outbound-messages.jsonl line). A regression here = JARVIS talks
// over himself on every voice turn, so these rules are worth pinning.
import { describe, it, expect } from 'vitest';
import { shouldSurfaceReply } from '../reply-dedupe';

function mk(overrides: Partial<Parameters<typeof shouldSurfaceReply>[0]> = {}) {
  return {
    id: 'mobile-reply-1',
    text: 'All agents online.',
    seen: new Set<string>(),
    fastReplyIds: new Set<string>(),
    sentTurns: 1,
    ...overrides,
  };
}

describe('shouldSurfaceReply', () => {
  it('surfaces a normal fresh full-lane reply', () => {
    expect(shouldSurfaceReply(mk())).toBe(true);
  });

  it('skips a reply already delivered by the fast lane (no double-speak)', () => {
    const fastReplyIds = new Set(['mobile-reply-1']);
    expect(shouldSurfaceReply(mk({ fastReplyIds }))).toBe(false);
  });

  it('skips a line with no id', () => {
    expect(shouldSurfaceReply(mk({ id: undefined }))).toBe(false);
  });

  it('skips a line already seen this session', () => {
    const seen = new Set(['mobile-reply-1']);
    expect(shouldSurfaceReply(mk({ seen }))).toBe(false);
  });

  it('marks the id as seen even when it skips (fast-lane id never re-considered)', () => {
    const seen = new Set<string>();
    const fastReplyIds = new Set(['mobile-reply-1']);
    shouldSurfaceReply(mk({ seen, fastReplyIds }));
    expect(seen.has('mobile-reply-1')).toBe(true);
  });

  it('skips pre-existing history when no turn has been sent (seed mode)', () => {
    expect(shouldSurfaceReply(mk({ sentTurns: 0 }))).toBe(false);
  });

  it('skips an empty-text line', () => {
    expect(shouldSurfaceReply(mk({ text: '' }))).toBe(false);
    expect(shouldSurfaceReply(mk({ text: undefined }))).toBe(false);
  });

  it('does not re-surface the same id on a second call (idempotent via seen)', () => {
    const seen = new Set<string>();
    const first = shouldSurfaceReply(mk({ seen }));
    const second = shouldSurfaceReply(mk({ seen }));
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

// === JARVIS MOD #107 ROUND 2 — the tool-originated reply echo (BLOCKER 1) ====
// These simulate the exact production path an adversarial verifier found
// answering every tool-backed question TWICE.
//
// The mechanism: /api/uhs/realtime/tool finds its answer by TAILING
// logs/jarvis-telegram/outbound-messages.jsonl — the SAME file
// api/messages/stream/[agent] tails and pushes over SSE. So the answer the model
// just spoke (as its own paraphrase) ALSO arrives at voice-panel moments later
// as an ordinary outbound line. Rule 2 exists to stop precisely that, but it can
// only fire if the id is in `fastReplyIds` — and round 1's tool route parsed
// only `text` off the jsonl line, threw the identity away, and returned nothing
// the client could register. The SSE echo sailed through and the log-speak
// effect said the raw Telegram text on top of the spoken answer.
//
// The fix is entirely about IDENTITY, so it is entirely testable here: given the
// id, this module already does the right thing. What follows locks the contract
// the tool route must honour — including the id-shape agreement, which is the
// part most likely to silently rot.
describe('shouldSurfaceReply — MOD #107 round 2: tool-originated replies', () => {
  /** Exactly how api/messages/stream/[agent]/route.ts derives the SSE id. */
  const sseIdFor = (entry: { message_id?: string; timestamp?: string | number }) =>
    entry.message_id || `out-${entry.timestamp}`;

  it('drops the SSE echo of an answer the tool route already consumed', () => {
    const seen = new Set<string>();
    const fastReplyIds = new Set<string>();
    const line = { message_id: 'msg-9f2a', timestamp: 1786284937, text: 'Forty installs year to date.' };

    // 1. tool route tails the log, returns { output, replyId } —
    // 2. the lane registers it BEFORE posting function_call_output.
    fastReplyIds.add(sseIdFor(line));

    // 3. the SSE stream pushes the very same line a beat later.
    const surfaced = shouldSurfaceReply({
      id: sseIdFor(line),
      text: line.text,
      seen,
      fastReplyIds,
      sentTurns: 1,
    });

    // It must NOT be spoken — the model already answered in its own words.
    expect(surfaced).toBe(false);
    expect(seen.has('msg-9f2a')).toBe(true);
  });

  it('REGRESSION: without the id the echo gets through and is spoken twice', () => {
    // This is round 1 verbatim: the tool route returned no replyId, so nothing
    // could be registered. Kept as an executable statement of the defect.
    const line = { message_id: 'msg-9f2a', timestamp: 1786284937, text: 'Forty installs year to date.' };
    const surfaced = shouldSurfaceReply({
      id: sseIdFor(line),
      text: line.text,
      seen: new Set<string>(),
      fastReplyIds: new Set<string>(), // ← nothing registered
      sentTurns: 1,
    });
    expect(surfaced).toBe(true); // the second, duplicate answer
  });

  it('agrees with the SSE id shape for legacy lines that carry no message_id', () => {
    // The fallback is not cosmetic: older outbound lines have no message_id, and
    // if the two sides derived different ids the dedupe set would never match.
    const legacy = { timestamp: 1786284999, text: 'The calendar is clear until two.' };
    const fastReplyIds = new Set([sseIdFor(legacy)]);
    expect(fastReplyIds.has('out-1786284999')).toBe(true);
    expect(
      shouldSurfaceReply({
        id: sseIdFor(legacy),
        text: legacy.text,
        seen: new Set<string>(),
        fastReplyIds,
        sentTurns: 1,
      }),
    ).toBe(false);
  });

  it('still surfaces an UNRELATED outbound line while a tool reply is deduped', () => {
    // The suppression must be surgical. A briefing, an alert, or Scott texting
    // JARVIS from his phone is not the tool's answer and must still come through.
    const seen = new Set<string>();
    const fastReplyIds = new Set(['msg-tool']);
    expect(
      shouldSurfaceReply({ id: 'msg-tool', text: 'tool answer', seen, fastReplyIds, sentTurns: 1 }),
    ).toBe(false);
    expect(
      shouldSurfaceReply({ id: 'msg-other', text: 'Overnight run finished.', seen, fastReplyIds, sentTurns: 1 }),
    ).toBe(true);
  });

  it('deduping a late reply the lane SPOKE keeps a later backfill sweep quiet', () => {
    // deliverLateReply consumes the reply and registers its id; backfill reads
    // the same outbound log from the top on every reconnect and must not
    // re-surface the raw text under the spoken paraphrase.
    const seen = new Set<string>();
    const fastReplyIds = new Set<string>();
    const id = 'msg-late-7';
    fastReplyIds.add(id); // deliverLateReply(text, id)
    for (let sweep = 0; sweep < 3; sweep++) {
      expect(
        shouldSurfaceReply({ id, text: 'Forty.', seen, fastReplyIds, sentTurns: 2 }),
      ).toBe(false);
    }
  });
});
