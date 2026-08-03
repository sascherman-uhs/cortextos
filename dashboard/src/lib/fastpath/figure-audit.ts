// === JARVIS MOD #68 — unsourced-figure auditor ===
// New file. The 25-turn persona soak (2026-08-03,
// .planning/jarvis-aaa/critic-wave3/persona-soak.md) found the fast path
// inventing business figures in 6 of its first 10 turns — "days on market
// creeping toward 45", "115 degrees, crews work 5 AM to noon", "70%
// utilization", "Last check was Friday". Every one was delivered with total
// composure, and several were lifted straight from the SOUL.md calibration
// lines that the prompt explicitly labels style-not-data.
//
// MOD #66's NUMBERS RULE already stopped fabrication when Scott ASKS for a
// figure. It did not stop figures VOLUNTEERED as conversational texture,
// because a decorative number doesn't feel like a data claim to the model.
// MOD #67 sharpens the rule; this file is how we KNOW whether it worked.
//
// Deliberately an OBSERVER, not a gate. It logs; it never edits or suppresses
// a reply. A regex cannot reliably tell "21 active stagings" (grounded) from
// "roughly 21 I'd guess" (not), and silently eating a correct sentence is a
// worse failure than logging a false positive. Its job is to make fabrication
// VISIBLE in fastpath-metrics.jsonl instead of requiring a hand-run 25-turn
// soak to discover — the silent-failure class again.
// === END header ===

/** Spelled cardinals the model actually uses in speech. */
const SPELLED: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/** Temporal words that assert a specific fact when spoken about the business
 *  ("last check was Friday", "5 AM to noon"). */
const WEEKDAYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
];

/**
 * Idioms where a number word carries no factual claim. Checked as whole
 * phrases so "one moment" passes while "one inquiry came in" does not.
 */
const IDIOMS = [
  'one moment', 'one second', 'one step ahead', 'one of', 'one thing',
  'no one', 'one way', 'for one', 'one more time', 'at one point',
  'a hundred percent', 'one hundred percent', 'second to none',
  'first', 'once', 'one-on-one', 'day one',
];

export type FigureKind = 'number' | 'percent' | 'temperature' | 'time' | 'weekday' | 'month';

export interface Figure {
  /** The literal text matched, as spoken. */
  text: string;
  kind: FigureKind;
  /** Numeric value when one could be parsed. */
  value?: number;
}

export interface AuditResult {
  /** Figures with no backing in the allowed sources. Empty = clean turn. */
  unsourced: Figure[];
  /** Every figure found, sourced or not. */
  all: Figure[];
}

/** Pull every numeric token out of a source string so tool replies can ground
 *  the figures they mention ("paid through August 20" grounds both). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  for (const [word, val] of Object.entries(SPELLED)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) out.add(val);
  }
  return out;
}

function stripIdioms(lower: string): string {
  let out = lower;
  for (const idiom of IDIOMS) out = out.split(idiom).join(' ');
  return out;
}

/** Compound spelled numerals: "twenty-one" is ONE figure worth 21, not a 20
 *  and a 1. Counted separately it looked like two fabrications in a sentence
 *  that was actually quoting the snapshot correctly. */
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const UNITS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const COMPOUND_RE = new RegExp(`\\b(${TENS.join('|')})[\\s-](${UNITS.join('|')})\\b`, 'g');

/** `one` is far more often a pronoun than a count ("the first one's empty",
 *  "not a voice one"). Treat it as a claim only when a noun follows it. */
const PRONOUN_ONE_RE = /\bone\b(?=\s*(?:'s|s\b|of\b|that\b|who\b|which\b|,|\.|$))/g;
const DETERMINED_ONE_RE = /\b(?:the|that|this|which|first|second|last|next|no|any|each|every|only)\s+one\b/g;

/** Extract the specific figures a reply asserts. */
export function extractFigures(reply: string): Figure[] {
  const found: Figure[] = [];
  let lower = stripIdioms(reply.toLowerCase());

  // Compound numerals first, so "twenty-one" is scored once, as 21.
  lower = lower.replace(COMPOUND_RE, (_m, tens: string, unit: string) => {
    found.push({
      text: `${tens}-${unit}`,
      kind: 'number',
      value: SPELLED[tens] + SPELLED[unit],
    });
    return ' ';
  });
  // Then drop pronoun uses of "one" so they are never read as a count.
  lower = lower.replace(DETERMINED_ONE_RE, ' ').replace(PRONOUN_ONE_RE, ' ');

  // Percentages and temperatures first — they are numbers with a unit, and
  // matching them here keeps the bare-number pass from double-reporting.
  const consumed: Array<[number, number]> = [];
  const claim = (re: RegExp, kind: FigureKind) => {
    for (const m of lower.matchAll(re)) {
      consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
      found.push({ text: m[0].trim(), kind, value: Number(m[1]) });
    }
  };
  claim(/(\d+(?:\.\d+)?)\s*(?:%|percent)/g, 'percent');
  claim(/(\d+)\s*(?:degrees|°)/g, 'temperature');
  claim(/(\d{1,2})(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)/g, 'time');

  const inConsumed = (i: number) => consumed.some(([s, e]) => i >= s && i < e);

  // Bare digits.
  for (const m of lower.matchAll(/\d+(?:\.\d+)?/g)) {
    if (inConsumed(m.index ?? 0)) continue;
    found.push({ text: m[0], kind: 'number', value: Number(m[0]) });
  }
  // Spelled cardinals.
  for (const [word, val] of Object.entries(SPELLED)) {
    for (const m of lower.matchAll(new RegExp(`\\b${word}\\b`, 'g'))) {
      if (inConsumed(m.index ?? 0)) continue;
      found.push({ text: word, kind: 'number', value: val });
    }
  }
  // Named days and months.
  for (const day of WEEKDAYS) {
    if (new RegExp(`\\b${day}\\b`).test(lower)) found.push({ text: day, kind: 'weekday' });
  }
  for (const mo of MONTHS) {
    // 'may' is far more often the verb — require a following day number.
    const re = mo === 'may' ? /\bmay\s+\d{1,2}\b/ : new RegExp(`\\b${mo}\\b`);
    if (re.test(lower)) found.push({ text: mo, kind: 'month' });
  }
  return found;
}

/**
 * Audit one reply against everything it was allowed to know.
 *
 * @param reply         the model's text
 * @param allowedNumbers figures from the live snapshot (the authoritative counts)
 * @param allowedText    text the model legitimately saw this conversation —
 *                       tool results, agent replies, and the user's own words
 *                       (a figure Scott himself said is fair to repeat back)
 */
export function auditFigures(
  reply: string,
  allowedNumbers: Iterable<number> = [],
  allowedText = '',
  now: Date = new Date(),
): AuditResult {
  const allowed = new Set<number>(allowedNumbers);
  for (const n of numbersIn(allowedText)) allowed.add(n);
  // TODAY is legitimately known — the uncached block states the current
  // Pacific date every turn, so "that's the usual Monday stack" on a Monday is
  // grounded, not invented. Counting it as fabrication was an instrument bug.
  const todayWords = now
    .toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })
    .toLowerCase();
  const allowedLower = `${allowedText.toLowerCase()} ${todayWords}`;

  const all = extractFigures(reply);
  const unsourced = all.filter((f) => {
    if (f.value !== undefined && allowed.has(f.value)) return false;
    // Temporal tokens ground only on a literal appearance in a real source.
    if (f.kind === 'weekday' || f.kind === 'month') return !allowedLower.includes(f.text);
    return true;
  });
  return { unsourced, all };
}

/** Convenience for metrics: a compact, log-safe summary. */
export function summarizeUnsourced(result: AuditResult): string[] {
  return result.unsourced.map((f) => `${f.kind}:${f.text}`);
}
// === END JARVIS MOD #68 ===
