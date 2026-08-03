// === JARVIS MOD #66 — unit lock for the authoritative-counts snapshot ===
import { describe, expect, it } from 'vitest';
import { renderSnapshot } from '../live-snapshot';
import { assembleVolatileBlock } from '../identity-assembler';

describe('renderSnapshot', () => {
  const counts = { activeStagings: 21, openContracts: 23, awaitingInstall: 2 };

  it('states each number exactly once, labelled', () => {
    const out = renderSnapshot(counts);
    expect(out).toContain('Active stagings (furniture in the home right now): 21');
    expect(out).toContain('Open contracts (billing relationship live): 23');
    expect(out).toContain('2 are signed but');
    // The subset relationship must be explicit — a bare third number reads as
    // an additional group ('two MORE'), observed live 2026-08-03.
    expect(out).toContain('never add them together');
  });

  it('routes every OTHER quantity to escalation', () => {
    expect(renderSnapshot(counts)).toContain('<<ESCALATE>>');
  });

  it('renders NOTHING when the data is unavailable', () => {
    // Deliberate: a snapshot saying "unavailable" invites the model to fill the
    // gap conversationally. No snapshot leaves only the NUMBERS RULE, which
    // escalates.
    expect(renderSnapshot(null)).toBe('');
  });
});

describe('assembleVolatileBlock — the snapshot rides the UNCACHED block', () => {
  it('includes the snapshot when given one', () => {
    const block = assembleVolatileBlock(new Date(), renderSnapshot({
      activeStagings: 21, openContracts: 23, awaitingInstall: 2,
    }));
    expect(block).toContain('AUTHORITATIVE LIVE COUNTS');
    expect(block).toContain(': 21');
  });

  it('is unchanged when no snapshot is available (back-compat)', () => {
    const block = assembleVolatileBlock(new Date());
    expect(block).not.toContain('AUTHORITATIVE LIVE COUNTS');
    expect(block).toContain('Current time:');
  });

  it('never lets volatile counts reach the cached identity block', async () => {
    // The cached block is byte-stable by contract; a count in it would both
    // poison the prefix cache and serve stale numbers. It DOES name the list
    // (the NUMBERS RULE has to refer to it) — what must never appear there is
    // the data itself, so assert on the count lines, not on the heading.
    const { assembleStableIdentity } = await import('../identity-assembler');
    const stable = assembleStableIdentity('jarvis-telegram', 'uhs');
    expect(stable).toContain('NUMBERS RULE'); // the rule is cached — stable text
    expect(stable).not.toContain('Active stagings (furniture in the home right now):');
    expect(stable).not.toContain('Open contracts (billing relationship live):');
  });
});
