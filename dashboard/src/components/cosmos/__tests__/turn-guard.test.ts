// === JARVIS MOD #85/#86/#87 tests — the barge-in contract (2026-08-03) ===
// These simulate the ORDERING that actually broke in production: work started
// for turn N, an interrupt landing mid-flight, and the turn-N promise resolving
// AFTERWARDS. AbortController cannot un-resolve a promise, so "late arrival is
// inert" is a property of the guard, not of fetch — which is exactly why it is
// testable here without a DOM.
import { describe, expect, it, vi } from 'vitest';
import { TurnGuard } from '../turn-guard';

describe('TurnGuard — turn identity', () => {
  it('starts at turn 0 and advances one per begin()', () => {
    const g = new TurnGuard();
    expect(g.current()).toBe(0);
    expect(g.begin()).toBe(1);
    expect(g.begin()).toBe(2);
    expect(g.current()).toBe(2);
  });

  it('treats only the newest turn as current', () => {
    const g = new TurnGuard();
    const first = g.begin();
    expect(g.isCurrent(first)).toBe(true);
    const second = g.begin();
    expect(g.isCurrent(first)).toBe(false);
    expect(g.isCurrent(second)).toBe(true);
  });
});

describe('TurnGuard — abort registry', () => {
  it('aborts every in-flight controller on begin()', () => {
    const g = new TurnGuard();
    const turn = g.begin();
    const a = new AbortController();
    const b = new AbortController();
    expect(g.track(turn, a)).toBe(true);
    expect(g.track(turn, b)).toBe(true);
    expect(g.stats().inFlight).toBe(2);

    g.begin(); // barge-in

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(g.stats().inFlight).toBe(0);
  });

  it('refuses to track a stale turn and aborts the controller immediately', () => {
    // This is the MOD #85 fix: runElevenLabsPipeline used to prefetch the NEXT
    // sentence on its way out of an interrupted turn, opening a fresh
    // ElevenLabs request for audio the user had already talked over.
    const g = new TurnGuard();
    const stale = g.begin();
    g.begin(); // barge-in
    const late = new AbortController();

    expect(g.track(stale, late)).toBe(false);
    expect(late.signal.aborted).toBe(true);
    expect(g.stats().inFlight).toBe(0);
  });

  it('abortInFlight() stops work WITHOUT advancing the turn', () => {
    // Mute mid-utterance takes this path: nothing new is starting, so a turn
    // that legitimately resumes must not be discarded.
    const g = new TurnGuard();
    const turn = g.begin();
    const ac = new AbortController();
    g.track(turn, ac);

    g.abortInFlight();

    expect(ac.signal.aborted).toBe(true);
    expect(g.current()).toBe(turn);
    expect(g.isCurrent(turn)).toBe(true);
  });

  it('release() drops a settled controller so the registry does not grow', () => {
    const g = new TurnGuard();
    const turn = g.begin();
    const ac = new AbortController();
    g.track(turn, ac);
    g.release(ac);
    expect(g.stats().inFlight).toBe(0);
  });
});

describe('TurnGuard — queue flush and stale-segment drop', () => {
  it('flushes the queue on begin()', () => {
    const g = new TurnGuard<string>();
    const turn = g.begin();
    g.enqueue(turn, 'seg-1');
    g.enqueue(turn, 'seg-2');
    expect(g.depth()).toBe(2);

    g.begin(); // barge-in

    expect(g.depth()).toBe(0);
  });

  it('drops an enqueue from a superseded turn', () => {
    const g = new TurnGuard<string>();
    const stale = g.begin();
    const live = g.begin();

    expect(g.enqueue(stale, 'interrupted-audio')).toBe(false);
    expect(g.depth()).toBe(0);

    expect(g.enqueue(live, 'current-audio')).toBe(true);
    expect(g.depth()).toBe(1);
  });

  it('does not let a superseded pipeline consume the NEW turn queue', () => {
    // The MOD #85 queue bug: `push(buf); await playSegment(); pop();` — a
    // barge-in between the push and the pop replaced the array, so the pop
    // landed on the NEW turn's buffer.
    const g = new TurnGuard<string>();
    const stale = g.begin();
    g.enqueue(stale, 'old-audio');

    const live = g.begin();
    g.enqueue(live, 'new-audio');

    expect(g.dequeue(stale)).toBeUndefined(); // stale pop is inert
    expect(g.depth()).toBe(1); // new turn's item is untouched
    expect(g.dequeue(live)).toBe('new-audio');
  });
});

describe('TurnGuard — parked waiters (MOD #87)', () => {
  it('wakes a parked loop on begin() so it can observe the new turn', () => {
    const g = new TurnGuard();
    const turn = g.begin();
    const wake = vi.fn();
    g.park(turn, wake);
    expect(g.stats().parked).toBe(1);

    g.begin();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(g.stats().parked).toBe(0);
  });

  it('advances the turn id BEFORE waking, so the waiter sees the interrupt', () => {
    const g = new TurnGuard();
    const turn = g.begin();
    let sawStale: boolean | null = null;
    g.park(turn, () => {
      sawStale = !g.isCurrent(turn);
    });

    g.begin();

    expect(sawStale).toBe(true);
  });

  it('wakes immediately when parking an already-stale turn', () => {
    // A loop that parks in the same tick an interrupt lands must not suspend.
    const g = new TurnGuard();
    const stale = g.begin();
    g.begin();
    const wake = vi.fn();

    g.park(stale, wake);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(g.stats().parked).toBe(0);
  });

  it('unpark() removes the waiter so a normal completion leaks nothing', () => {
    const g = new TurnGuard();
    const turn = g.begin();
    const wake = vi.fn();
    const unpark = g.park(turn, wake);

    unpark();
    g.begin();

    expect(wake).not.toHaveBeenCalled();
    expect(g.stats().parked).toBe(0);
  });

  it('a throwing waiter does not block the others', () => {
    const g = new TurnGuard();
    const turn = g.begin();
    const second = vi.fn();
    g.park(turn, () => { throw new Error('waiter blew up'); });
    g.park(turn, second);

    expect(() => g.begin()).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('barge-in simulation — late fetch resolution after interrupt', () => {
  /** Stand-in for fetchTts: resolves only when the test says so. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('a segment fetch that resolves AFTER the interrupt never plays', async () => {
    const g = new TurnGuard<string>();
    const played: string[] = [];
    const turn = g.begin();
    const ac = new AbortController();
    g.track(turn, ac);
    const inFlight = deferred<string>();

    // The pipeline: await the bytes, then re-check before playing.
    const pipeline = (async () => {
      const bytes = await inFlight.promise;
      if (!g.isCurrent(turn)) return; // ← the guard that makes abort sufficient
      g.enqueue(turn, bytes);
      played.push(bytes);
      g.dequeue(turn);
    })();

    g.begin(); // BARGE-IN while the fetch is in flight
    inFlight.resolve('sentence-2.mp3'); // bytes land afterwards anyway
    await pipeline;

    expect(played).toEqual([]);
    expect(g.depth()).toBe(0);
    expect(ac.signal.aborted).toBe(true);
  });

  it('the same fetch DOES play when no interrupt happened', async () => {
    // Control: proves the assertion above is the interrupt's doing, not a
    // pipeline that never plays anything.
    const g = new TurnGuard<string>();
    const played: string[] = [];
    const turn = g.begin();
    const inFlight = deferred<string>();

    const pipeline = (async () => {
      const bytes = await inFlight.promise;
      if (!g.isCurrent(turn)) return;
      g.enqueue(turn, bytes);
      played.push(bytes);
      g.dequeue(turn);
    })();

    inFlight.resolve('sentence-2.mp3');
    await pipeline;

    expect(played).toEqual(['sentence-2.mp3']);
    expect(g.depth()).toBe(0);
  });

  it('an interrupted stream loop exits instead of hanging on its next sentence', async () => {
    // MOD #87. The loop suspends waiting for the next streamed sentence; the
    // producer is aborted and never calls end(). Before the guard, the only
    // things that could resolve it were push()/end(), so it hung forever.
    const g = new TurnGuard<string>();
    const turn = g.begin();
    const st = { queue: ['first'] as string[], closed: false, notify: null as null | (() => void) };
    const wake = () => { const n = st.notify; st.notify = null; n?.(); };
    const unpark = g.park(turn, () => { st.closed = true; wake(); });
    let exited = false;
    const consumed: string[] = [];

    const loop = (async () => {
      try {
        let i = 0;
        for (;;) {
          while (i >= st.queue.length && !st.closed) {
            await new Promise<void>((res) => { st.notify = res; });
          }
          if (i >= st.queue.length && st.closed) return;
          if (!g.isCurrent(turn)) return;
          consumed.push(st.queue[i]);
          i += 1;
        }
      } finally {
        unpark();
        exited = true;
      }
    })();

    // Let it drain 'first' and park waiting for sentence 2.
    await Promise.resolve();
    await Promise.resolve();
    expect(g.stats().parked).toBe(1);

    g.begin(); // BARGE-IN — the reply stream is aborted, end() never comes

    await loop;
    expect(exited).toBe(true);
    expect(consumed).toEqual(['first']);
    expect(g.stats().parked).toBe(0);
  });

  it('a sentence pushed after the interrupt is refused by the handle', async () => {
    // The reply reader can deliver already-buffered lines for a beat after the
    // abort; appending them would grow a queue nobody consumes — and, on the
    // real path, the first such line would OPEN a new TTS turn.
    const g = new TurnGuard<string>();
    const turn = g.begin();
    const queue: string[] = [];
    const push = (s: string) => {
      if (!g.isCurrent(turn)) return;
      queue.push(s);
    };

    push('kept');
    g.begin();
    push('arrived-after-barge-in');

    expect(queue).toEqual(['kept']);
  });
});
