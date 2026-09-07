// === JARVIS MOD #107 ROUND 2 tests — the Daniel lane's barge-in guard ===
// (2026-08-09)
//
// These reproduce the EXACT round-1 defect an adversarial verifier found: the
// text-lane delta/done handlers had no staleness guard, so a barge-in produced
// two distinct audible failures.
//
//   1. RESTART. Barge-in nulled the TTS stream handle. The next in-flight delta
//      of the CANCELLED response saw a null handle, read that as "no stream open
//      yet", and opened a new one — JARVIS resumed speaking the answer the user
//      had just talked over.
//   2. REPLAY. The cancelled response's terminal `.done` still carried its
//      partial text into the conversation log, where voice-panel's log-speak
//      effect said the whole abandoned reply out loud.
//
// Both come from the same modelling error: "no handle" was treated as a STATE
// meaning "nothing started", when it is ambiguous between that and "started,
// then killed". Every test below is really asserting that the lane can tell
// those two apart.
import { describe, expect, it } from 'vitest';
import { TextLane } from '../text-lane';

const R1 = 'resp_AAA';
const R2 = 'resp_BBB';

describe('TextLane — normal streaming', () => {
  it('emits complete sentences as they finish, holding the unfinished tail', () => {
    const lane = new TextLane();
    lane.begin(R1);
    expect(lane.delta('The install is confirmed. ', R1)).toEqual(['The install is confirmed.']);
    // Mid-sentence: nothing to speak yet, but it is accumulating.
    expect(lane.delta('Thursday at', R1)).toEqual([]);
    expect(lane.fullText()).toBe('The install is confirmed. Thursday at');
  });

  it('flushes the unterminated tail at done and reports that it streamed', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('Confirmed for Thursday. ', R1);
    const done = lane.done(undefined, R1);
    expect(done).not.toBeNull();
    expect(done!.streamed).toBe(true);
    expect(done!.text).toBe('Confirmed for Thursday.');
  });

  it('returns the tail so a reply with no terminal punctuation is still spoken', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('Nine in the morning', R1); // no full stop, ever
    const done = lane.done('Nine in the morning', R1);
    expect(done!.tail).toBe('Nine in the morning');
    expect(done!.streamed).toBe(true);
  });

  it('honours the 50-word spoken cap (MOD #44 parity)', () => {
    const lane = new TextLane(5);
    lane.begin(R1);
    const spoken = lane.delta('One two three four five six. Seven eight nine ten. ', R1);
    // First sentence (6 words) crosses the cap; the second must not be spoken.
    expect(spoken).toEqual(['One two three four five six.']);
  });
});

describe('TextLane — BLOCKER 2: barge-in must stop the stream', () => {
  it('DISCARDS a delta that arrives after the response was cancelled', () => {
    const lane = new TextLane();
    lane.begin(R1);
    expect(lane.delta('Let me pull that up. ', R1)).toEqual(['Let me pull that up.']);

    lane.interrupt(); // user talked over JARVIS → speech_started

    // The socket is still draining the cancelled response.
    expect(lane.delta('The answer is forty. ', R1)).toEqual([]);
    expect(lane.isLive(R1)).toBe(false);
  });

  it('a stale delta never asks the caller to open a NEW TTS turn', () => {
    // This is the restart bug stated precisely: round 1 decided whether to call
    // beginStreamReply() from `streamHandleRef === null`, which is true both
    // before the first sentence AND after a barge-in nulled it. The lane now
    // answers the real question ("is this event live?") independently.
    const lane = new TextLane();
    lane.begin(R1);
    lane.interrupt();
    for (const chunk of ['Still talking. ', 'And more. ', 'And more still. ']) {
      expect(lane.delta(chunk, R1)).toEqual([]);
    }
  });

  it('DISCARDS the terminal done of a cancelled response (no log push, no speech)', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('Checking the calendar. ', R1);
    lane.interrupt();
    expect(lane.done('Checking the calendar. It is clear until two.', R1)).toBeNull();
  });

  it('accepts the REPLACEMENT response after a barge-in', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.interrupt();
    lane.begin(R2); // the new turn the user actually asked for
    expect(lane.delta('Two o'.concat("'clock. "), R2)).toEqual(["Two o'clock."]);
    expect(lane.done(undefined, R2)).not.toBeNull();
  });
});

describe('TextLane — the nastier ordering: stale events after the NEW response opens', () => {
  // The generation counter alone does not cover this: by the time the straggler
  // arrives, a replacement response has been created and the generation matches
  // again. Only the response id separates them.
  it('drops a stale delta whose response id is not the open one', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.interrupt();
    lane.begin(R2);
    expect(lane.delta('tail of the cancelled answer. ', R1)).toEqual([]);
    expect(lane.fullText()).toBe(''); // never contaminated the new reply
  });

  it('drops a stale done whose response id is not the open one', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.interrupt();
    lane.begin(R2);
    lane.delta('The new answer. ', R2);
    expect(lane.done('cancelled text', R1)).toBeNull();
    // ...and the live response still completes normally afterwards.
    const good = lane.done(undefined, R2);
    expect(good!.text).toBe('The new answer.');
  });

  it('never merges two overlapping responses', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('First reply. ', R1);
    lane.begin(R2); // a new response opened without an explicit interrupt
    expect(lane.fullText()).toBe('');
    lane.delta('Second reply. ', R2);
    expect(lane.done(undefined, R2)!.text).toBe('Second reply.');
  });
});

describe('TextLane — closed state', () => {
  it('is not live before any response opens', () => {
    const lane = new TextLane();
    expect(lane.isLive(R1)).toBe(false);
    expect(lane.delta('anything', R1)).toEqual([]);
    expect(lane.done('anything', R1)).toBeNull();
  });

  it('is not live after done — a duplicate done is inert', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('Done here. ', R1);
    expect(lane.done(undefined, R1)).not.toBeNull();
    expect(lane.done(undefined, R1)).toBeNull();
  });

  it('interrupt advances the generation every time', () => {
    const lane = new TextLane();
    const g0 = lane.generation();
    lane.interrupt();
    lane.interrupt();
    expect(lane.generation()).toBe(g0 + 2);
  });
});

// === JARVIS MOD #107 ROUND 3 — require the response id (residual 2) =========
// Round 2 only CHECKED the id when one was present, so an id-less event was
// accepted whenever the generation happened to be back in sync — which is
// exactly the ordering the generation counter cannot separate on its own.
// GA stamps response_id on every text event, so an event without one is
// malformed rather than permissive.
describe('TextLane — the response id is required, not optional', () => {
  it('refuses an id-less delta even while a response is open', () => {
    const lane = new TextLane();
    lane.begin(R1);
    expect(lane.delta('No id on this event. ')).toEqual([]);
    expect(lane.idlessDrops()).toBe(1);
  });

  it('refuses an id-less done', () => {
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('Some text. ', R1);
    expect(lane.done('Some text.')).toBeNull();
  });

  it('counts the drops so the failure is visible, not silent', () => {
    // If OpenAI ever stopped stamping the field the lane would go quiet — that
    // has to show up on the debug line rather than being a mystery.
    const lane = new TextLane();
    lane.begin(R1);
    lane.delta('a. ');
    lane.delta('b. ');
    lane.done(undefined);
    expect(lane.idlessDrops()).toBe(3);
  });

  it('still accepts a correctly-stamped event', () => {
    const lane = new TextLane();
    lane.begin(R1);
    expect(lane.delta('Properly stamped. ', R1)).toEqual(['Properly stamped.']);
    expect(lane.idlessDrops()).toBe(0);
  });
});
