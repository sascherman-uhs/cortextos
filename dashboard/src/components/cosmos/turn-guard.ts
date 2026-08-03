// === JARVIS MOD #85 — TurnGuard: turn identity, abort registry, queue,
// parked-waiter registry (2026-08-03) ===
// NEW FILE. Deliberately pure: no DOM, no React, no fetch. The repo runs vitest
// with no jsdom/testing-library, so anything touching AudioContext or fetch is
// only reachable from Playwright — extracting the barge-in contract into plain
// logic is what makes it unit-testable at all (same reasoning as voice-turn.ts
// under MOD #36).
//
// The contract, from TRILLION-BAR "Voice UX": an interrupt must
//   (a) abort every in-flight request belonging to the interrupted turn,
//   (b) flush the ready-but-unplayed queue,
//   (c) wake every loop parked waiting on more input so it can observe the
//       interrupt and exit instead of hanging forever,
//   (d) make every LATE arrival from the interrupted turn a no-op.
//
// (d) is the one that actually bites in production. AbortController does not
// un-schedule a promise that already resolved, and it cannot stop code that
// runs AFTER an await resumes. So every resume point must re-ask "am I still
// the live turn?" — that question is `isCurrent`, and issuing new work is
// `track`/`enqueue`, both of which refuse stale ids rather than trusting the
// caller to have checked.

export interface TurnGuardStats {
  turnId: number;
  inFlight: number;
  queueDepth: number;
  parked: number;
}

export class TurnGuard<T = unknown> {
  private turnId = 0;
  private aborters = new Set<AbortController>();
  private queue: T[] = [];
  private waiters = new Set<() => void>();

  /** The live turn id. */
  current(): number {
    return this.turnId;
  }

  /** True while `id` is still the live turn. False the instant a barge-in lands. */
  isCurrent(id: number): boolean {
    return id === this.turnId;
  }

  /**
   * Barge-in. Aborts in-flight work, flushes the queue, wakes parked loops, and
   * advances the turn id so every late arrival from the old turn is refused.
   * Returns the NEW id — the caller stamps its work with it.
   */
  begin(): number {
    this.abortInFlight();
    this.flush();
    // Advance BEFORE waking: a waiter that inspects current()/isCurrent()
    // synchronously inside its wake callback must already see the new turn.
    this.turnId += 1;
    this.wakeAll();
    return this.turnId;
  }

  /**
   * Stop current work WITHOUT advancing the turn (mute mid-utterance, unmount).
   * Distinct from begin(): nothing new is starting, so the id must not move or
   * an in-flight turn that legitimately resumes would be wrongly discarded.
   */
  abortInFlight(): void {
    for (const ac of this.aborters) {
      try {
        ac.abort();
      } catch {
        /* already aborted */
      }
    }
    this.aborters.clear();
  }

  /**
   * Register an AbortController for turn `id`. Returns false — and aborts the
   * controller immediately — when `id` is already stale, so a caller that fires
   * a request from a superseded pipeline never reaches the network.
   */
  track(id: number, ac: AbortController): boolean {
    if (!this.isCurrent(id)) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
      return false;
    }
    this.aborters.add(ac);
    return true;
  }

  /** Drop a settled controller (success or failure) from the registry. */
  release(ac: AbortController): void {
    this.aborters.delete(ac);
  }

  /** Queue a ready-but-unplayed item. Stale turns are dropped, not queued. */
  enqueue(id: number, item: T): boolean {
    if (!this.isCurrent(id)) return false;
    this.queue.push(item);
    return true;
  }

  /**
   * Remove the oldest queued item for turn `id`. A stale id is a no-op — this
   * is what stops a superseded pipeline from consuming the NEW turn's queue
   * when its own queue was flushed out from under it.
   */
  dequeue(id: number): T | undefined {
    if (!this.isCurrent(id)) return undefined;
    return this.queue.shift();
  }

  /** Hard queue flush (drops everything, any turn). */
  flush(): void {
    this.queue.length = 0;
  }

  depth(): number {
    return this.queue.length;
  }

  /**
   * Park a loop that is waiting for more input. `wake` is invoked on the next
   * begin() so the loop resumes, sees a stale id, and exits — without this a
   * stream loop awaiting its next sentence stays suspended forever when the
   * producer is aborted and never closes. Parking a stale id wakes immediately.
   * Returns an unpark fn for the normal (non-interrupt) resume path.
   */
  park(id: number, wake: () => void): () => void {
    if (!this.isCurrent(id)) {
      wake();
      return () => {};
    }
    this.waiters.add(wake);
    return () => {
      this.waiters.delete(wake);
    };
  }

  /** Wake and clear every parked waiter. */
  wakeAll(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const wake of pending) {
      try {
        wake();
      } catch {
        /* a waiter that throws must not block the rest */
      }
    }
  }

  stats(): TurnGuardStats {
    return {
      turnId: this.turnId,
      inFlight: this.aborters.size,
      queueDepth: this.queue.length,
      parked: this.waiters.size,
    };
  }
}
// === END JARVIS MOD #85 ===
