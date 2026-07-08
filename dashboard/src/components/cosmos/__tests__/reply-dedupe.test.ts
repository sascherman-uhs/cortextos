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
