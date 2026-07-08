// === JARVIS MOD #36 — voice-turn.ts unit lock (smooth-voice Tier 6:
// "lock in the behavior with tests… especially the stop-talking word lists,
// so a future change can't silently re-break it"). ===
import { describe, expect, it } from 'vitest';
import {
  FAST_HANGOVER_MS,
  SLOW_HANGOVER_MS,
  VETO_HANGOVER_MS,
  chooseHangoverMs,
  containsWakeWord,
  isSignoff,
  wakeMatch,
} from '../voice-turn';

describe('wakeMatch', () => {
  it('matches jarvis / hey jarvis / okay jarvis, case+punct-insensitive', () => {
    expect(wakeMatch('Jarvis, pull the schedule')).toEqual({
      woke: true,
      remainder: 'pull the schedule',
    });
    expect(wakeMatch('hey jarvis what time is it').woke).toBe(true);
    expect(wakeMatch('OKAY JARVIS. status report').remainder).toBe('status report');
  });
  it('bare wake yields empty remainder', () => {
    expect(wakeMatch('hey jarvis')).toEqual({ woke: true, remainder: '' });
  });
  it('does not fire mid-sentence or on other speech', () => {
    expect(wakeMatch('I told jarvis about it').woke).toBe(false);
    expect(wakeMatch('the install crew is here').woke).toBe(false);
  });
  it('containsWakeWord finds the name anywhere (barge-in path)', () => {
    expect(containsWakeWord('um Jarvis stop')).toBe(true);
    expect(containsWakeWord('nothing to see')).toBe(false);
  });
});

describe('chooseHangoverMs (layered end-of-turn)', () => {
  it('fast path when the recognizer finalized', () => {
    expect(
      chooseHangoverMs({ hasFinalTail: true, transcript: 'what is on the calendar' }),
    ).toBe(FAST_HANGOVER_MS);
  });
  it('slow path when not finalized', () => {
    expect(
      chooseHangoverMs({ hasFinalTail: false, transcript: 'what is on the calendar' }),
    ).toBe(SLOW_HANGOVER_MS);
  });
  it('trailing conjunction / filler / comma vetoes an early cut', () => {
    for (const t of ['check the schedule and', 'so I was thinking um', 'first this,']) {
      expect(chooseHangoverMs({ hasFinalTail: true, transcript: t })).toBe(
        VETO_HANGOVER_MS,
      );
    }
  });
});

describe('isSignoff (conservative — bias toward replying)', () => {
  const yes = [
    'thanks',
    "thanks, that's all",
    'sounds good',
    'perfect, thank you',
    'got it, thanks',
    'okay will do',
    "great, I'll send that",
    'goodnight',
  ];
  const no = [
    // questions / requests veto
    'thanks, but can you also check the calendar?',
    'thanks — what about the Daly contract?',
    'cool, one more thing',
    // commands veto (not self-commit)
    'great, send that email',
    'perfect, schedule it for friday',
    // continuations veto
    'okay so the revenue is up this month',
    'great, the meeting went well and they want a proposal',
    // look-alikes must not trip word lists
    "we'll see about that tomorrow",
    // too long to be a goodbye
    'thanks for that, now let me tell you about the new listing on sable ridge',
  ];
  it.each(yes)('accepts: %s', (t) => expect(isSignoff(t, true)).toBe(true));
  it.each(no)('vetoes: %s', (t) => expect(isSignoff(t, false || true)).toBe(false));
  it('never swallows the first thing said (no agent turn yet)', () => {
    expect(isSignoff('thanks', false)).toBe(false);
  });
});
