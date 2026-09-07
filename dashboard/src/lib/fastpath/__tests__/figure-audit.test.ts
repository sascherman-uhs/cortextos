// === JARVIS MOD #68 — regression corpus from the 25-turn persona soak ===
// Every string below is a VERBATIM fast-path reply from the 2026-08-03 soak
// (.planning/jarvis-aaa/critic-wave3/persona-soak.md). The fabricated ones
// must flag; the grounded ones must stay clean. Pinning the real transcript
// means a future prompt change is measured against what actually went wrong,
// not against invented examples of what might.
import { describe, expect, it } from 'vitest';
import { auditFigures, extractFigures, numbersIn } from '../figure-audit';

/** The authoritative snapshot in force during the soak. */
const SNAPSHOT = [21, 23, 2];

// Pinned to the soak date. auditFigures treats TODAY's own weekday/month as
// grounded (the uncached block states the current Pacific date every turn), so
// leaving `now` to default to the real clock made these cases calendar-flaky:
// T7 asserts "september" is flagged, which is false every September, and T10
// asserts "friday" is flagged, which is false every Friday. The two tests below
// under "today's own date is a legitimate known" already pin this same instant;
// this helper simply never did.
const SOAK_NOW = new Date('2026-08-03T18:00:00Z'); // Monday in Pacific

const clean = (reply: string, allowedText = '') =>
  auditFigures(reply, SNAPSHOT, allowedText, SOAK_NOW).unsourced;

describe('the six fabrication turns — every one must flag', () => {
  it('T1: calibration lines spoken as data (the worst case)', () => {
    // "Calendar's clear until 2" is lifted verbatim from VOICE_CUE.md's
    // example set; "two showings" is a remix of another calibration line.
    const flagged = clean(
      "Nothing urgent. Two showings lined up for Sable Ridge today, one inquiry came in overnight. Calendar's clear until 2.",
    );
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.map((f) => f.text)).toContain('one');
  });

  it('T3: invented market stats', () => {
    const flagged = clean(
      "21 active stagings right now. Vegas market's flat — inventory up, days on market creeping toward 45, buyer inquiry volume down.",
    );
    expect(flagged.map((f) => f.text)).toContain('45');
    // …but the grounded 21 in the same sentence must NOT be flagged.
    expect(flagged.map((f) => f.text)).not.toContain('21');
  });

  it('T4: invented overdue count', () => {
    expect(clean('Five days now. Call them today.').map((f) => f.text)).toContain('five');
  });

  it('T7: invented weather and crew hours', () => {
    const flagged = clean(
      "115 degrees kills productivity — crews work 5 AM to noon, then it's done. Budget two days per job instead of one until September.",
    );
    const kinds = flagged.map((f) => f.kind);
    expect(kinds).toContain('temperature');
    expect(kinds).toContain('time');
    expect(flagged.map((f) => f.text)).toContain('september');
  });

  it('T9: invented utilization percentage', () => {
    const flagged = clean(
      "You're at 21 active stagings with one warehouse — that's 70% utilization.",
    );
    expect(flagged.map((f) => f.kind)).toContain('percent');
    expect(flagged.map((f) => f.text)).not.toContain('21');
  });

  it('T10: invented conversation history', () => {
    const flagged = clean('Not yet. Last check was Friday — they said "end of week."');
    expect(flagged.map((f) => f.text)).toContain('friday');
  });
});

describe('the grounded turns — must stay clean', () => {
  it('T2/T8/T19: the bare count', () => {
    expect(clean('21 active stagings.')).toHaveLength(0);
  });

  it('T5: the full subset answer, spelled and numeric', () => {
    expect(
      clean('23 open contracts. Two of those are signed but not yet installed — the other 21 are your active stagings.'),
    ).toHaveLength(0);
  });

  it('a reply with no figures at all', () => {
    expect(clean("Nothing urgent. I'd call them before the day gets away from you.")).toHaveLength(0);
  });
});

describe('figures grounded by a tool result are allowed', () => {
  const toolText =
    '7748 Boca Raton Dr, Kim Pedersen: staged July 21, paid through August 20, and notice to terminate by August 10.';

  it('repeats a tool-sourced date without flagging', () => {
    expect(clean('Notice is due August 10. Give them the heads-up today.', toolText)).toHaveLength(0);
  });
  it('still flags a figure the tool never returned', () => {
    expect(
      clean('Notice is due August 10, and they are 45 days on market.', toolText).map((f) => f.text),
    ).toContain('45');
  });
});

describe("figures Scott himself supplied are fair to repeat", () => {
  it('does not flag a number quoted back from the user', () => {
    const userSaid = "I'm thinking of dropping our minimum to fifteen hundred.";
    expect(clean('No. Fifteen hundred wins volume and loses margin.', userSaid)).toHaveLength(0);
  });
});

describe('idioms are not figures', () => {
  it.each([
    'One moment, sir.',
    'Always one step ahead.',
    'That is one thing I can confirm.',
    'First things first.',
  ])('ignores: %s', (line) => {
    expect(clean(line)).toHaveLength(0);
  });
});

describe('extraction mechanics', () => {
  it('classifies units rather than double-counting the bare digit', () => {
    const kinds = extractFigures('70% utilization at 115 degrees by 5 PM').map((f) => f.kind);
    expect(kinds).toContain('percent');
    expect(kinds).toContain('temperature');
    expect(kinds).toContain('time');
    expect(kinds.filter((k) => k === 'number')).toHaveLength(0);
  });
  it('treats "may" as a month only with a day number', () => {
    expect(extractFigures('That may be worth doing').some((f) => f.kind === 'month')).toBe(false);
    expect(extractFigures('Install is May 12').some((f) => f.kind === 'month')).toBe(true);
  });
  it('numbersIn reads both digits and spelled forms', () => {
    const n = numbersIn('two of the 21 are pending');
    expect(n.has(2)).toBe(true);
    expect(n.has(21)).toBe(true);
  });
});

// === MOD #68b — instrument corrections found while measuring the mini-soak ===
describe('compound numerals score once, at their real value', () => {
  it('"twenty-one active stagings" is grounded, not two fabrications', () => {
    expect(clean('Twenty-one active stagings, all on track.')).toHaveLength(0);
  });
  it('hyphen or space both parse', () => {
    expect(clean('twenty one active stagings')).toHaveLength(0);
  });
  it('an ungrounded compound still flags', () => {
    expect(clean('Days on market are forty-five.').map((f) => f.text)).toContain('forty-five');
  });
});

describe('"one" as a pronoun is not a count', () => {
  it.each([
    "Second warehouse solves nothing if the first one's half empty.",
    "That's a pull-it conversation, not a voice one.",
    'Which one do you mean?',
  ])('ignores: %s', (line) => {
    expect(clean(line)).toHaveLength(0);
  });
  it('but a counted noun still flags', () => {
    expect(clean('One vendor invoice is overdue.').map((f) => f.text)).toContain('one');
  });
});

describe("today's own date is a legitimate known", () => {
  const MONDAY = new Date('2026-08-03T18:00:00Z'); // Monday in Pacific
  it('does not flag the current weekday', () => {
    expect(auditFigures("That's the usual Monday stack.", SNAPSHOT, '', MONDAY).unsourced).toHaveLength(0);
  });
  it('still flags a DIFFERENT weekday', () => {
    expect(
      auditFigures('Last I had was Friday.', SNAPSHOT, '', MONDAY).unsourced.map((f) => f.text),
    ).toContain('friday');
  });
});
