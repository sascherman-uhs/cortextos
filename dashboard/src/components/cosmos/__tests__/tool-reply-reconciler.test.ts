// === JARVIS MOD #107 ROUND 3 tests — deterministic tool-echo suppression ===
// (2026-08-09)
//
// Round 2 threaded the reply id back on the tool's HTTP response and called it
// closed. It was not: the tool route and the SSE stream are two independent
// readers of ONE log write, and their delivery windows overlap —
//
//     log write at T
//       ├─ SSE server polls every 1000ms  → client sees it at T .. T+1000ms
//       └─ tool route polls every 500ms   → HTTP response at T .. T+500ms+RTT
//
// so SSE wins a meaningful fraction of the time, and when it does the dedupe set
// is still empty and round-1 behaviour returns (the raw Telegram text spoken on
// top of the model's paraphrase). Round 2's comment claimed the registration
// happened "BEFORE function_call_output", which guards against the model's reply
// — the wrong competitor entirely.
//
// EVERY ordering is therefore tested explicitly. That is the point of the
// module: the outcome must not depend on who wins.
import { describe, expect, it } from 'vitest';
import { ToolReplyReconciler, RECONCILE_WINDOW_MS } from '../tool-reply-reconciler';

const TOOL_REPLY = 'msg-tool-answer';
const OTHER = 'msg-unrelated';

describe('ToolReplyReconciler — no dispatch in flight', () => {
  it('releases immediately when nothing is pending', () => {
    const r = new ToolReplyReconciler();
    expect(r.offer(OTHER, 'Overnight run finished.')).toBe('release');
    expect(r.pendingCount()).toBe(0);
  });
});

describe('ToolReplyReconciler — TOOL beats SSE (the common ordering)', () => {
  it('claims the id up front and drops the echo when it arrives', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    // HTTP response lands first, carrying the id of the line it consumed.
    expect(r.resolveDispatch(TOOL_REPLY)).toEqual([]);
    // ...then the SSE stream pushes that same line.
    expect(r.offer(TOOL_REPLY, 'Forty installs year to date.')).toBe('dropped');
  });

  it('drops the echo exactly ONCE — a later line reusing the id is not swallowed', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.resolveDispatch(TOOL_REPLY);
    expect(r.offer(TOOL_REPLY, 'first')).toBe('dropped');
    expect(r.offer(TOOL_REPLY, 'second')).toBe('release');
  });
});

describe('ToolReplyReconciler — SSE beats TOOL (the ordering round 2 lost)', () => {
  it('holds the line, then drops it when the tool claims that id', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    // The SSE stream delivers the answer BEFORE the tool's HTTP response.
    expect(r.offer(TOOL_REPLY, 'Forty installs year to date.')).toBe('buffered');
    expect(r.pendingCount()).toBe(1);
    // The tool response finally lands and claims it — it is never spoken.
    expect(r.resolveDispatch(TOOL_REPLY)).toEqual([]);
    expect(r.pendingCount()).toBe(0);
  });

  it('REGRESSION: without buffering, an SSE-first line would be spoken', () => {
    // Round 2 in one line: with nothing in flight (i.e. no reconciliation), an
    // early SSE line releases straight through and gets spoken on top of the
    // model's paraphrase.
    const r = new ToolReplyReconciler();
    expect(r.offer(TOOL_REPLY, 'Forty installs year to date.')).toBe('release');
  });
});

describe('ToolReplyReconciler — unrelated traffic during a dispatch', () => {
  it('releases a line the tool did not claim, in arrival order', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.offer(OTHER, 'Overnight run finished.');
    r.offer('msg-alert', 'Lockbox battery low.');
    const released = r.resolveDispatch(TOOL_REPLY); // tool's own line never arrived via SSE
    expect(released.map((b) => b.id)).toEqual([OTHER, 'msg-alert']);
  });

  it('drops ONLY the tool line and releases the rest', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.offer(OTHER, 'Overnight run finished.');
    r.offer(TOOL_REPLY, 'Forty installs year to date.');
    r.offer('msg-alert', 'Lockbox battery low.');
    const released = r.resolveDispatch(TOOL_REPLY);
    expect(released.map((b) => b.id)).toEqual([OTHER, 'msg-alert']);
  });
});

describe('ToolReplyReconciler — the tool never produced a reply', () => {
  it('releases everything when the dispatch times out (pending:true, no id)', () => {
    // The 35s-budget path returns { pending: true } and NO replyId, because the
    // answer does not exist yet. Nothing may be suppressed on that path — the
    // late answer is exactly what deliverLateReply is waiting to speak.
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.offer(OTHER, 'Something else entirely.');
    const released = r.resolveDispatch(undefined);
    expect(released.map((b) => b.id)).toEqual([OTHER]);
  });

  it('releases everything when a fast lane resolves (fast lanes never touch the log)', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.offer(OTHER, 'unrelated');
    expect(r.resolveDispatch(null).map((b) => b.id)).toEqual([OTHER]);
  });
});

describe('ToolReplyReconciler — the safety valve', () => {
  it('does NOT hold an unrelated line for the length of a slow lookup', () => {
    // An ask_jarvis can run 35s. Silencing an alert for 35 seconds would be a
    // worse bug than the double answer this module fixes.
    const r = new ToolReplyReconciler();
    const t0 = 1_000_000;
    r.beginDispatch();
    expect(r.offer(OTHER, 'Lockbox battery low.', t0)).toBe('buffered');
    expect(r.flushExpired(t0 + RECONCILE_WINDOW_MS - 1)).toEqual([]); // still inside the window
    const released = r.flushExpired(t0 + RECONCILE_WINDOW_MS);
    expect(released.map((b) => b.id)).toEqual([OTHER]);
    expect(r.pendingCount()).toBe(0);
    // The dispatch is still running — the valve did not end it.
    expect(r.dispatchesInFlight()).toBe(1);
  });

  it('resolveDispatch flushes expired lines while other dispatches continue', () => {
    const r = new ToolReplyReconciler();
    const t0 = 2_000_000;
    r.beginDispatch();
    r.beginDispatch();
    r.offer(OTHER, 'old line', t0);
    r.offer('msg-fresh', 'fresh line', t0 + RECONCILE_WINDOW_MS);
    const released = r.resolveDispatch(undefined, t0 + RECONCILE_WINDOW_MS);
    expect(released.map((b) => b.id)).toEqual([OTHER]); // fresh one still held
    expect(r.dispatchesInFlight()).toBe(1);
    expect(r.pendingCount()).toBe(1);
  });
});

describe('ToolReplyReconciler — concurrent dispatches', () => {
  it('keeps buffering until the LAST dispatch resolves', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.beginDispatch();
    r.offer(OTHER, 'unrelated');
    expect(r.resolveDispatch('msg-a')).toEqual([]); // one still in flight
    expect(r.pendingCount()).toBe(1);
    expect(r.resolveDispatch('msg-b').map((b) => b.id)).toEqual([OTHER]);
  });

  it('drops each dispatch\'s own echo independently', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.beginDispatch();
    r.offer('msg-a', 'answer A');
    r.offer('msg-b', 'answer B');
    r.offer(OTHER, 'unrelated');
    expect(r.resolveDispatch('msg-a')).toEqual([]);
    expect(r.resolveDispatch('msg-b').map((b) => b.id)).toEqual([OTHER]);
  });
});

describe('ToolReplyReconciler — barge-in', () => {
  // === MOD #107 ROUND 4: the contract CHANGED here, and the old version of
  // this test was asserting the bug. Round 3's reset() dropped the buffer on
  // the floor, and this test called that correct ("speaking them afterwards is
  // what barge-in exists to prevent"). It is not: a held line is by definition
  // one the tool did NOT claim — an alert, a briefing, Scott texting in — and
  // its id is ALREADY in voice-panel's `seen` set, so backfill can never bring
  // it back. A business alert landing 100ms before a barge-in was deleted
  // permanently, with no trace in the UI. Barge-in cancels the model's reply,
  // not the world.
  it('reset() HANDS BACK held lines instead of destroying them', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.offer(OTHER, 'Lockbox battery low.');
    const orphaned = r.reset();
    expect(orphaned.map((b) => b.id)).toEqual([OTHER]);
    expect(orphaned[0].text).toBe('Lockbox battery low.');
  });

  it('reset() still clears state and forgets claims', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.resolveDispatch(TOOL_REPLY); // claim recorded
    r.beginDispatch();
    r.offer(OTHER, 'held');
    r.reset();
    expect(r.pendingCount()).toBe(0);
    expect(r.dispatchesInFlight()).toBe(0);
    expect(r.resolveDispatch(undefined)).toEqual([]);
    // A claim made before the reset must not silence a later, unrelated line.
    expect(r.offer(TOOL_REPLY, 'new conversation')).toBe('release');
  });

  it('returns nothing when there was nothing held', () => {
    const r = new ToolReplyReconciler();
    expect(r.reset()).toEqual([]);
    r.beginDispatch();
    expect(r.reset()).toEqual([]);
  });

  it('preserves arrival order across several orphaned lines', () => {
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    r.offer('msg-1', 'first');
    r.offer('msg-2', 'second');
    r.offer('msg-3', 'third');
    expect(r.reset().map((b) => b.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('an orphaned line is NOT recoverable any other way — hence the hand-back', () => {
    // The reason this matters, stated as a test: once offer() has returned
    // 'buffered', voice-panel has already marked the id seen. Nothing else in
    // the system will ever present that line again.
    const seen = new Set<string>();
    const r = new ToolReplyReconciler();
    r.beginDispatch();
    seen.add(OTHER); // shouldSurfaceReply marks every id it passes
    expect(r.offer(OTHER, 'Lockbox battery low.')).toBe('buffered');
    const orphaned = r.reset();
    expect(seen.has(OTHER)).toBe(true); // backfill will skip it forever
    expect(orphaned).toHaveLength(1); // ...so this hand-back is the only path
  });
});
