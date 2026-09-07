// === JARVIS MOD #107 ROUND 3 — ToolReplyReconciler: deterministic suppression
// of the tool answer's SSE echo (2026-08-09) ===
// NEW FILE. Pure logic — no DOM, no React, no fetch. Same reasoning as
// turn-guard.ts / response-gate.ts / text-lane.ts.
//
// WHY ROUND 2's FIX WAS ONLY PROBABILISTIC
// The tool route finds its answer by tailing outbound-messages.jsonl, the same
// file the SSE route tails. Round 2 threaded the reply's id back on the tool's
// HTTP response and registered it in the dedupe set — which works ONLY if that
// response reaches the browser before the SSE stream pushes the same line.
// It does not always:
//
//     log write at T
//       ├─ SSE server polls every 1000ms  → client sees it at T .. T+1000ms
//       └─ tool route polls every 500ms   → HTTP response at T .. T+500ms+RTT
//
// The windows overlap. When SSE wins, the dedupe set is still empty and round-1
// behaviour returns: the model speaks its paraphrase and the raw Telegram text
// is spoken on top of it. Round 2's code comment ("registered BEFORE
// function_call_output") guarded against the wrong competitor entirely — the
// race is against the LOG WRITE, not against the model's reply.
//
// THE FIX: stop racing. While a tool dispatch is in flight, an outbound line is
// not delivered immediately — it is HELD for a short reconciliation window. If
// the tool response then claims that id, the line is dropped (the model is
// already saying it in its own words). If the window closes without a claim,
// the line was never the tool's answer and is released down the normal path.
// Ordering stops mattering, which is what makes the closure deterministic
// rather than ~75% likely.
//
// The window is deliberately SHORT and independent of the tool's own 35s
// budget: the two events we are ordering are both consequences of one log
// write, so they are always within ~1s of each other. Holding an unrelated
// briefing or alert for the length of a slow lookup would be a worse bug than
// the one being fixed.

/** How long an outbound line is held while a tool dispatch is in flight. */
export const RECONCILE_WINDOW_MS = 3_000;
/** Bound on remembered claims, so a long session cannot grow this forever. */
const MAX_CLAIMS = 64;

export interface BufferedReply {
  id: string;
  text: string;
  /** When the line was offered (ms epoch). */
  ts: number;
}

export type OfferOutcome =
  /** Not the tool's answer (or nothing in flight) — deliver it normally. */
  | 'release'
  /** Held pending reconciliation; it will come back from resolve()/flushExpired(). */
  | 'buffered'
  /** It IS the tool's answer, already claimed — never speak it. */
  | 'dropped';

export class ToolReplyReconciler {
  private inFlight = 0;
  private buffer: BufferedReply[] = [];
  /** Ids the tool claimed BEFORE the SSE line arrived (the common ordering). */
  private claimed = new Set<string>();

  /** Number of tool dispatches currently in flight. */
  dispatchesInFlight(): number {
    return this.inFlight;
  }

  /** Lines currently held for reconciliation. */
  pendingCount(): number {
    return this.buffer.length;
  }

  /** A tool dispatch has started. Call BEFORE the fetch. */
  beginDispatch(): void {
    this.inFlight += 1;
  }

  /**
   * An outbound line arrived (SSE or backfill), having already passed the
   * ordinary dedupe gate.
   */
  offer(id: string, text: string, now: number = Date.now()): OfferOutcome {
    if (this.claimed.has(id)) {
      // Tool response won the race and already claimed this id.
      this.claimed.delete(id);
      return 'dropped';
    }
    if (this.inFlight > 0) {
      this.buffer.push({ id, text, ts: now });
      return 'buffered';
    }
    return 'release';
  }

  /**
   * A tool dispatch finished.
   * @param replyId the outbound line the tool consumed as its answer, if any
   *        (absent on the timeout path and on fast lanes, which never touch the
   *        outbound log).
   * @returns lines that are now free to deliver, in arrival order.
   */
  resolveDispatch(replyId?: string | null, now: number = Date.now()): BufferedReply[] {
    if (this.inFlight > 0) this.inFlight -= 1;

    if (replyId) {
      const idx = this.buffer.findIndex((b) => b.id === replyId);
      if (idx >= 0) {
        // SSE won the race — we were holding the tool's own answer. Drop it.
        this.buffer.splice(idx, 1);
      } else {
        // Tool won the race — claim the id so the SSE line is dropped on arrival.
        this.claimed.add(replyId);
        if (this.claimed.size > MAX_CLAIMS) {
          const oldest = this.claimed.values().next().value;
          if (oldest !== undefined) this.claimed.delete(oldest);
        }
      }
    }

    // Anything still held once no dispatch is outstanding was never the tool's
    // answer — release it all, in order.
    if (this.inFlight === 0) return this.drain();
    // Dispatches remain in flight, but lines that have already waited out the
    // window cannot belong to a dispatch that started after them.
    return this.flushExpired(now);
  }

  /**
   * Release lines whose reconciliation window has closed, even while a dispatch
   * is still running. This is the safety valve that keeps a 35s ask_jarvis from
   * silencing an unrelated alert for 35 seconds.
   */
  flushExpired(now: number = Date.now()): BufferedReply[] {
    if (this.buffer.length === 0) return [];
    const ready: BufferedReply[] = [];
    const held: BufferedReply[] = [];
    for (const b of this.buffer) {
      (now - b.ts >= RECONCILE_WINDOW_MS ? ready : held).push(b);
    }
    this.buffer = held;
    return ready;
  }

  /** Release everything immediately (no dispatch outstanding). */
  private drain(): BufferedReply[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /**
   * Barge-in, stop control, server error, session teardown.
   *
   * === MOD #107 ROUND 4 — reset() no longer DESTROYS what it was holding. ===
   * Round 3 dropped the buffer on the floor. That silently deleted business
   * mail: a held line is by definition one the tool did NOT claim — an alert, a
   * briefing, Scott texting from his phone — and its id is already in
   * voice-panel's `seen` set (shouldSurfaceReply marks ids it passes), so
   * backfill can never resurface it. An alert landing 100ms before a barge-in
   * was therefore lost FOREVER, with no trace anywhere in the UI.
   *
   * Barge-in cancels the MODEL'S reply. It does not cancel the world. So the
   * held lines are handed back for normal delivery instead — the caller
   * re-offers them through the same path they would have taken had the tool
   * dispatch never been in flight.
   *
   * @returns the unclaimed held lines, in arrival order, for re-delivery.
   */
  reset(): BufferedReply[] {
    const orphaned = this.buffer;
    this.inFlight = 0;
    this.buffer = [];
    this.claimed.clear();
    return orphaned;
  }
}
// === END JARVIS MOD #107 ROUND 3 ===
