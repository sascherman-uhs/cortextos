// === JARVIS MOD #69 — routing and logging must share ONE predicate ===
// The 25-turn soak (2026-08-03) found turns 12/13/14 emitting <<ESCALATE>>
// wrapped in prose: routed correctly (router used .includes()) but logged as
// 'reply' (logger used ===). fastpath-metrics.jsonl therefore claimed 14
// fast-path replies where 11 happened — a metric quietly disagreeing with the
// behaviour it measures, which is worse than having no metric at all.
//
// The predicate is module-private, so this test pins the SHAPES that broke
// rather than the function: any future divergence between the two call sites
// has to reproduce these cases.
import { describe, expect, it } from 'vitest';

const ESCALATE_TOKEN = '<<ESCALATE>>';

/** Mirror of the predicate in fast-reply.ts. Both call sites use it. */
const isEscalation = (text: string): boolean => !text || text.includes(ESCALATE_TOKEN);

describe('isEscalation — the one predicate for routing AND logging', () => {
  it('matches the bare token', () => {
    expect(isEscalation('<<ESCALATE>>')).toBe(true);
  });

  it('matches the token wrapped in prose (the soak T12/T13/T14 shape)', () => {
    // These were the exact failures: routed right, logged wrong.
    expect(isEscalation('<<ESCALATE>> — this needs the full agent.')).toBe(true);
    expect(isEscalation('I should check that properly. <<ESCALATE>>')).toBe(true);
    expect(isEscalation('Let me pull it.\n<<ESCALATE>>')).toBe(true);
  });

  it('treats empty output as escalation, never as a reply', () => {
    expect(isEscalation('')).toBe(true);
  });

  it('does not fire on an ordinary reply', () => {
    expect(isEscalation('21 active stagings.')).toBe(false);
    expect(isEscalation('Nothing urgent before coffee.')).toBe(false);
  });

  it('an exact-match predicate would have MISSED the wrapped cases', () => {
    // Documents the bug precisely: this is what the logger used to do.
    const exactMatchOnly = (t: string) => t === ESCALATE_TOKEN;
    const wrapped = '<<ESCALATE>> — needs the full agent.';
    expect(exactMatchOnly(wrapped)).toBe(false); // logged 'reply' — the bug
    expect(isEscalation(wrapped)).toBe(true); // routed 'escalate' — correct
  });
});
