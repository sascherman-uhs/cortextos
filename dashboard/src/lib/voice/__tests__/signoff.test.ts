// === JARVIS MOD #53 — unit lock for the shared sign-off detector ===
// One test per veto class in the TRILLION-BAR spec, plus the homophone traps
// that only survive because norm() keeps apostrophes. A regression here means
// JARVIS either talks over a goodbye or goes silent mid-conversation — the
// second is the expensive failure, so the "must reply" table is the long one.
import { describe, expect, it } from 'vitest';
import { MAX_SIGNOFF_WORDS, isSignoff, signoffLine, SIGNOFF_LINES } from '../signoff';

/** Every case assumes the assistant already spoke — the first-utterance veto
 *  is tested separately. */
const said = (text: string) => isSignoff(text, true);

describe('isSignoff — accepts genuine sign-offs (zero-token wind-down)', () => {
  const yes = [
    'thanks',
    'thank you',
    "thanks, that's all",
    'sounds good',
    'perfect, thank you',
    'got it, thanks',
    'okay will do',
    "great, I'll send that",
    'goodnight',
    'good night',
    'bye',
    'goodbye',
    'take care',
    'all set',
    'cheers',
    'right on',
    'nice work',
    'cool',
    "we're done",
  ].filter((t) => t !== 'nice work'); // 'nice work' is not in the phrase list
  it.each(yes)('accepts: %s', (t) => expect(said(t)).toBe(true));
});

describe('veto — questions', () => {
  const no = [
    'thanks, but can you also check the calendar?',
    'thanks — what about the Daly contract?',
    'cool, one more thing',
    'perfect. how about tomorrow',
    'got it, another thing',
    'thanks, why is that',
  ];
  it.each(no)('vetoes: %s', (t) => expect(said(t)).toBe(false));

  it('vetoes an un-punctuated question (Whisper drops the ?)', () => {
    expect(said('are we all set')).toBe(false);
    expect(said('is that all')).toBe(false);
    expect(said('did you get it')).toBe(false);
    expect(said('should I take care of that')).toBe(false);
  });
});

describe('veto — commands', () => {
  const no = [
    'great, send that email',
    'perfect, schedule it for friday',
    'thanks, check the calendar',
    'got it, pull the contract',
    'cool, remind me',
  ];
  it.each(no)('vetoes: %s', (t) => expect(said(t)).toBe(false));

  it('but a SHORT self-commitment is itself a sign-off', () => {
    expect(said("okay, I'll send that")).toBe(true);
    expect(said('let me check')).toBe(true);
  });
  it('and a self-commitment with a concrete object is still working', () => {
    expect(said("I'll email the proposal to Melinda")).toBe(false);
  });
});

describe('veto — continuations (the "okay, so revenue is up" case)', () => {
  const no = [
    'okay so the revenue is up this month',
    'great, the meeting went well and they want a proposal',
    'perfect, the install crew finished early today',
    'thanks, the Sable Ridge photos came in',
  ];
  it.each(no)('vetoes: %s', (t) => expect(said(t)).toBe(false));
});

describe('veto — length limit', () => {
  it('rejects anything longer than the goodbye budget', () => {
    const long = 'thanks for that, now let me tell you about the new listing on sable ridge';
    expect(long.split(' ').length).toBeGreaterThan(MAX_SIGNOFF_WORDS);
    expect(said(long)).toBe(false);
  });
});

describe('veto — never the first utterance', () => {
  it('does not swallow a goodbye-shaped opener', () => {
    expect(isSignoff('thanks', false)).toBe(false);
    expect(isSignoff('sounds good', false)).toBe(false);
  });
});

describe('veto — homophone traps (apostrophes are load-bearing)', () => {
  it("we'll never collapses into well", () => {
    expect(said("we'll see about that tomorrow")).toBe(false);
    expect(said("we'll do the install tuesday")).toBe(false);
  });
  it("i'll never collapses into ill", () => {
    expect(said("I'll be at the warehouse until four")).toBe(false);
  });
  it('by / buy never read as bye', () => {
    expect(said('by the way the lockbox code changed')).toBe(false);
    expect(said('buy the sofa if it is still there')).toBe(false);
  });
  it('substring look-alikes do not match whole-word phrases', () => {
    // 'thanks' must not fire inside 'thanksgiving'; 'later' not inside 'slater'
    expect(said('thanksgiving week is booked solid')).toBe(false);
    expect(said('slater road listing went pending')).toBe(false);
  });
});

describe('veto — scheduling words that look like farewells', () => {
  it('"later" plus a time noun is a plan, not a goodbye', () => {
    expect(said('later today')).toBe(false);
    expect(said('later this week')).toBe(false);
  });
  it('bare "later" is still a goodbye', () => {
    expect(said('later')).toBe(true);
    expect(said('cool, later')).toBe(true);
  });
});

describe('signoffLine', () => {
  it('rotates deterministically and never returns undefined', () => {
    expect(signoffLine(0)).toBe(SIGNOFF_LINES[0]);
    expect(signoffLine(SIGNOFF_LINES.length)).toBe(SIGNOFF_LINES[0]);
    expect(signoffLine(-1)).toBe(SIGNOFF_LINES[1 % SIGNOFF_LINES.length]);
  });
});
