// === JARVIS MOD #107 tests — the response.create race guard (2026-08-09) ===
// These lock the ORDERINGS that actually broke a live conversation. The failure
// they all share is the same one: the gate is left believing a response is in
// flight, so every later response.create is swallowed and JARVIS goes
// PERMANENTLY MUTE with nothing on screen to explain it. That is why almost
// every assertion below ends by proving the gate can still issue a create.
//
// Pure logic on purpose (no DOM, no RTCDataChannel) — same reasoning as
// turn-guard.test.ts: vitest here runs without jsdom, so a rule that lives
// inside the data-channel callback is unreachable to unit tests. Extracting it
// is what makes it testable at all.
import { describe, expect, it } from 'vitest';
import { ResponseGate } from '../response-gate';

describe('ResponseGate — the basic contract', () => {
  it('sends immediately when idle', () => {
    const g = new ResponseGate();
    expect(g.isActive()).toBe(false);
    expect(g.request()).toBe(true);
    expect(g.isActive()).toBe(true);
  });

  it('defers a create issued while a response is in flight', () => {
    const g = new ResponseGate();
    expect(g.request()).toBe(true);
    expect(g.request()).toBe(false); // the race the guard exists to stop
    expect(g.isDeferred()).toBe(true);
  });

  it('holds at most ONE deferred create, never a backlog of stale turns', () => {
    const g = new ResponseGate();
    g.request();
    g.request();
    g.request();
    g.request();
    expect(g.isDeferred()).toBe(true);
    expect(g.close()).toBe(true); // exactly one comes back out
    expect(g.isDeferred()).toBe(false);
    expect(g.close()).toBe(false); // and nothing more
  });

  it('learns about responses the server opened on its own (server VAD)', () => {
    const g = new ResponseGate();
    g.markActive(); // 'response.created' with no request() of ours
    expect(g.request()).toBe(false); // must NOT race it
    expect(g.isDeferred()).toBe(true);
  });
});

describe('ResponseGate — deferred create fires after done', () => {
  it('hands the deferred create back from close(), already re-armed', () => {
    const g = new ResponseGate();
    g.request(); // turn 1 in flight
    g.request(); // user typed while JARVIS was answering
    expect(g.close()).toBe(true);
    // close() re-arms so the caller only has to SEND. If it did not, the
    // caller's send would be untracked and the next response.created would be
    // the only thing marking it active — a window in which a third create could
    // race through.
    expect(g.isActive()).toBe(true);
  });

  it('reports nothing owed when no create was deferred', () => {
    const g = new ResponseGate();
    g.request();
    expect(g.close()).toBe(false);
    expect(g.isActive()).toBe(false);
    expect(g.request()).toBe(true); // idle again
  });
});

describe('ResponseGate — the error event (MOD #107, critics 2f)', () => {
  // THE bug: the old handler logged the error and set 'wakeListening', leaving
  // both flags untouched. The server had abandoned that response and would never
  // send its response.done, so the gate stayed active forever.
  it('clear() releases a gate the server abandoned mid-response', () => {
    const g = new ResponseGate();
    g.request();
    expect(g.request()).toBe(false); // stuck: everything defers behind it
    g.clear();
    expect(g.isActive()).toBe(false);
    expect(g.isDeferred()).toBe(false);
    expect(g.request()).toBe(true); // JARVIS can speak again
  });

  it('without clear(), an errored response mutes every later turn', () => {
    // Documents the regression precisely: no response.done is ever coming.
    const g = new ResponseGate();
    g.request();
    for (let turn = 0; turn < 5; turn++) {
      expect(g.request()).toBe(false);
    }
  });

  it('clear() also drops a create that was queued behind the errored one', () => {
    const g = new ResponseGate();
    g.request();
    g.request();
    expect(g.isDeferred()).toBe(true);
    g.clear();
    // The deferred create belonged to a conversation state that no longer
    // exists; replaying it would answer a question against a broken turn.
    expect(g.isDeferred()).toBe(false);
    expect(g.close()).toBe(false);
  });
});

describe('ResponseGate — tool round-trips', () => {
  it('closeForTool() ends the response but keeps the turn going', () => {
    const g = new ResponseGate();
    g.request(); // model turn opens
    g.closeForTool(); // response.done carrying function_call items
    expect(g.isActive()).toBe(false);
    // The tool continuation issues its own create once the outputs land.
    expect(g.request()).toBe(true);
  });

  it('closeForTool() does NOT consume a deferred create', () => {
    // A user turn arriving mid-tool-call must survive the tool round-trip: the
    // continuation's own request() is what re-opens the response, and the
    // deferred user turn is then owed at the NEXT close().
    const g = new ResponseGate();
    g.request();
    g.request(); // user spoke while the tool was running
    g.closeForTool();
    expect(g.isDeferred()).toBe(true);
    expect(g.request()).toBe(true); // tool continuation
    expect(g.close()).toBe(true); // and the user's turn is still owed
  });

  it('barge-in mid-tool-call leaves a gate that can still answer', () => {
    // Stop pressed (or the user talked over JARVIS) while a 35s ask_jarvis was
    // in flight. The tool fetch is superseded by the TurnGuard elsewhere; the
    // gate's job is simply not to stay wedged.
    const g = new ResponseGate();
    g.request();
    g.closeForTool();
    g.request(); // tool continuation opened a new response
    g.clear(); // barge-in
    expect(g.snapshot()).toEqual({ active: false, deferred: false, activeId: null });
    expect(g.request()).toBe(true);
  });

  it('stop-during-tool-call ordering: a LATE tool continuation cannot wedge it', () => {
    // Ordering that actually happens: stop lands, THEN the aborted-but-already-
    // resolved tool promise resumes and (before MOD #107's isCurrent check) sent
    // its create. Even if one slips through, the gate must not be permanently
    // stuck — the next response.done clears it.
    const g = new ResponseGate();
    g.request();
    g.closeForTool();
    g.clear(); // stop pressed
    const lateCreate = g.request(); // straggler from the dead tool call
    expect(lateCreate).toBe(true);
    expect(g.close()).toBe(false);
    expect(g.request()).toBe(true); // the NEXT real turn still works
  });
});

describe('ResponseGate — snapshot', () => {
  it('reports both flags for diagnostics', () => {
    const g = new ResponseGate();
    expect(g.snapshot()).toEqual({ active: false, deferred: false, activeId: null });
    g.request();
    expect(g.snapshot()).toEqual({ active: true, deferred: false, activeId: null });
    g.markActive('resp_A');
    g.request();
    expect(g.snapshot()).toEqual({ active: true, deferred: true, activeId: 'resp_A' });
  });
});

// === JARVIS MOD #107 ROUND 2 — response identity (smaller defect a) =========
// The round-1 gate had no idea WHICH response it had open, so the terminal
// `response.done` of a response a barge-in had cancelled could arrive AFTER the
// replacement response's `response.created` and call close() for the wrong one.
// That cleared `active` while a genuinely in-flight response was still running;
// the next requestResponse() then sent a create into an active conversation, the
// server replied 400 conversation_already_has_active_response — and because
// round 1 also made the error handler speak, the user HEARD the race.
describe('ResponseGate — stale response.done ordering', () => {
  it('ignores a done for a response it does not have open', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.clear(); // barge-in cancels A
    g.request();
    g.markActive('resp_B'); // the replacement turn is now in flight

    // A's terminal done finally drains out of the socket.
    expect(g.close('resp_A')).toBe(false);
    // B must be untouched — this is the whole defect.
    expect(g.isActive()).toBe(true);
    expect(g.activeId()).toBe('resp_B');
  });

  it('REGRESSION: an unguarded close would free the gate for the wrong response', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_B');
    g.close(); // round-1 behaviour: no id, closes whatever is open
    expect(g.isActive()).toBe(false); // ← B wrongly freed
    // ...and the next create races the response that is still really running.
    expect(g.request()).toBe(true);
  });

  it('closes normally when the done matches the open response', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    expect(g.close('resp_A')).toBe(false); // closed, nothing deferred
    expect(g.isActive()).toBe(false);
    expect(g.activeId()).toBeNull();
  });

  it('hands back a deferred create only for the matching done', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.request(); // user turn arrives mid-response
    expect(g.close('resp_STALE')).toBe(false); // straggler: nothing happens
    expect(g.isDeferred()).toBe(true); // the user's turn is still owed
    expect(g.close('resp_A')).toBe(true); // and lands on the real done
  });

  it('accepts any done while the id is genuinely unknown (create not yet acked)', () => {
    // Between request() and response.created the server has not assigned an id
    // yet. Refusing a done here would wedge the gate — the exact failure this
    // whole module exists to prevent — so an unknown id stays permissive.
    const g = new ResponseGate();
    g.request();
    expect(g.activeId()).toBeNull();
    expect(g.close('resp_WHATEVER')).toBe(false);
    expect(g.isActive()).toBe(false);
  });

  it('closeForTool is guarded the same way', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.clear();
    g.request();
    g.markActive('resp_B');
    expect(g.closeForTool('resp_A')).toBe(false);
    expect(g.isActive()).toBe(true);
    expect(g.closeForTool('resp_B')).toBe(true);
    expect(g.isActive()).toBe(false);
  });

  it('owns() is the shared predicate for done AND error routing', () => {
    // The error handler uses the same test to decide whether a server error
    // aborted the live turn (speak + clear) or is unrelated noise (log only).
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    expect(g.owns('resp_A')).toBe(true);
    expect(g.owns('resp_OTHER')).toBe(false);
    expect(g.owns(undefined)).toBe(true); // no id supplied — cannot rule it out
  });

  it('clear() forgets the active response id', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.clear();
    expect(g.snapshot()).toEqual({ active: false, deferred: false, activeId: null });
  });
});

// === JARVIS MOD #107 ROUND 3 — the null-id window (residual 1) ==============
// Round 2's owns() treated a null activeId as "cannot rule it out", which left a
// real hole: between our request() and the server's response.created, a stale
// done was accepted, closed the gate, and could consume + re-arm a deferred
// create. retiredIds closes it — an id this gate has already finished with is
// provably stale no matter what is currently open.
describe('ResponseGate — retired ids close the null-id window', () => {
  it('refuses a stale done that lands between request() and response.created', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.clear();          // barge-in cancels A (A is retired here)
    g.request();        // new turn — active, but the server has not assigned an id yet
    expect(g.activeId()).toBeNull();

    // A's terminal done arrives inside the null-id window.
    expect(g.close('resp_A')).toBe(false);
    expect(g.isActive()).toBe(true);   // the new turn survives
  });

  it('REGRESSION: without retirement the stale done consumes a deferred create', () => {
    // Statement of the round-2 residual: the deferred create is silently
    // consumed and re-armed by a response that no longer exists, so the user's
    // real turn is answered against the wrong conversation state.
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.request();                 // user turn deferred behind A
    expect(g.isDeferred()).toBe(true);
    // A retired id can no longer do this:
    g.clear();
    g.request();
    expect(g.close('resp_A')).toBe(false);
  });

  it('retires on close() as well as clear()', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.close('resp_A');
    expect(g.isRetired('resp_A')).toBe(true);
    g.request();                       // next turn, id not yet known
    expect(g.close('resp_A')).toBe(false); // duplicate done is inert
    expect(g.isActive()).toBe(true);
  });

  it('retires on closeForTool() too', () => {
    const g = new ResponseGate();
    g.request();
    g.markActive('resp_A');
    g.closeForTool('resp_A');
    expect(g.isRetired('resp_A')).toBe(true);
    expect(g.close('resp_A')).toBe(false);
  });

  it('DOCUMENTED RESIDUAL: a done for a response we never saw created is still accepted', () => {
    // This is genuinely unknowable from the client — we have no record of that
    // response at all. The alternative (refusing every done while the id is
    // unknown) would wedge the gate, which is the ONE failure this module exists
    // to prevent, so the permissive branch is deliberate.
    const g = new ResponseGate();
    g.request();                    // id unknown
    expect(g.close('resp_NEVER_SEEN')).toBe(false); // closes, nothing deferred
    expect(g.isActive()).toBe(false);
  });

  it('bounds the retired set so a long session cannot grow it forever', () => {
    const g = new ResponseGate();
    for (let i = 0; i < 100; i++) {
      g.request();
      g.markActive(`resp_${i}`);
      g.close(`resp_${i}`);
    }
    expect(g.isRetired('resp_99')).toBe(true);
    expect(g.isRetired('resp_0')).toBe(false); // evicted — bounded memory
  });
});
