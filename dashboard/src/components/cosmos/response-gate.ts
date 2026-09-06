// === JARVIS MOD #107 — ResponseGate: the response.create race guard, extracted
// (2026-08-09) ===
// NEW FILE. Pure logic, no DOM/React/fetch — same reasoning as turn-guard.ts
// (MOD #85) and voice-turn.ts (MOD #36): the repo's vitest run has no jsdom, so
// anything that touches RTCDataChannel is only reachable from Playwright.
// Pulling the rule out here is what makes it unit-testable at all.
//
// The rule (originally MOD #51 fix, living in two loose refs inside
// use-realtime-voice): OpenAI rejects a `response.create` sent while a prior
// response is still in flight ("conversation_already_has_active_response"), and
// a rejected create means JARVIS never answers that turn. Worse, the failure is
// sticky: if the two flags are left believing a response is active — which is
// exactly what the old `error` event handler did, and what a stop press during a
// tool call did — the guard swallows the NEXT create too, and every one after
// that. JARVIS goes permanently mute with no visible cause. That is the bug this
// module exists to make impossible to reintroduce, and the reason `clear()` is
// its own named operation rather than an inline pair of assignments.
//
// Lifecycle, in the order the data channel actually emits it:
//   request()      — a create is wanted. TRUE = send it now; FALSE = the gate
//                    deferred it and will hand it back from close().
//   markActive()   — `response.created` arrived. Server VAD auto-creates
//                    responses we never asked for, so the gate must learn about
//                    them too or it will happily race one.
//   closeForTool() — `response.done` carrying function_call items. The response
//                    is closed but the TURN continues; the deferred slot must be
//                    left alone because the tool continuation will request().
//   close()        — `response.done` ending the turn. TRUE = a deferred create
//                    is owed; send it now (the gate has already re-armed).
//   clear()        — error, barge-in, stop press, session teardown. The only
//                    escape from a stuck-active gate.

// === MOD #107 ROUND 2 — the gate now tracks WHICH response is open. ===========
// Round-1 defect (adversarial verify): a stale `response.done` — the terminal
// event of a response that was cancelled by a barge-in — arrived AFTER the new
// turn's `response.created` and called close() for the wrong response. That
// cleared `active` while a genuinely in-flight response was still running, so
// the next requestResponse() sent a create into an active conversation, the
// server answered 400 `conversation_already_has_active_response`, and (because
// round 1 made the error handler speak) the user now HEARD the race.
//
// Fix: markActive() records the response id, and close()/closeForTool() only
// act when the done's id matches the open one. An id we never saw is ignored.
// A create we issued before `response.created` has no id yet (the server
// assigns it), so a null active id accepts any done — that is the pre-existing
// behaviour and the only safe default while the id is genuinely unknown.

export interface ResponseGateSnapshot {
  active: boolean;
  deferred: boolean;
  activeId: string | null;
}

// === MOD #107 ROUND 3 — closing the null-id window ===========================
// Round 2 left a real hole: between our `request()` (active = true, id still
// null because the server assigns it) and the arriving `response.created`, a
// stale done was accepted, because `owns()` treats a null activeId as "cannot
// rule it out". That stale done could close the gate AND consume + re-arm a
// deferred create — the same wrong-response corruption round 2 set out to fix,
// just in a narrower window.
//
// `retiredIds` closes it precisely: every id this gate has ever had open is
// remembered when it is cleared or closed. A done for a RETIRED id is provably
// stale — we saw that response created, and we saw it end — so it is refused
// regardless of what the gate currently has open.
//
// The residual (documented, not hidden): a done for a response we never saw
// created, arriving inside the null-id window, is still accepted. That is
// genuinely unknowable from the client, and the alternative — refusing dones
// while the id is unknown — would wedge the gate, which is the single failure
// this module exists to prevent. There is a test for both halves.
const MAX_RETIRED_IDS = 32;

export class ResponseGate {
  private active = false;
  private deferred = false;
  private activeResponseId: string | null = null;
  private retiredIds: string[] = [];

  private retire(id: string | null): void {
    if (!id || this.retiredIds.includes(id)) return;
    this.retiredIds.push(id);
    if (this.retiredIds.length > MAX_RETIRED_IDS) this.retiredIds.shift();
  }

  /** True while a response is believed to be in flight. */
  isActive(): boolean {
    return this.active;
  }

  /** True while exactly one create is queued behind the active response. */
  isDeferred(): boolean {
    return this.deferred;
  }

  /**
   * Ask to send `response.create`.
   * @returns true when the caller should send it immediately; false when the
   *          gate has deferred it (at most one is ever held — a second request
   *          while deferred collapses into the same slot rather than queueing
   *          a backlog of turns the user has long since moved past).
   */
  request(): boolean {
    if (this.active) {
      this.deferred = true;
      return false;
    }
    this.active = true;
    return true;
  }

  /** The id of the response believed to be in flight (null when unknown). */
  activeId(): string | null {
    return this.activeResponseId;
  }

  /** `response.created` — including responses server VAD opened on its own. */
  markActive(responseId: string | null = null): void {
    this.active = true;
    this.activeResponseId = responseId;
  }

  /**
   * Does a `response.done` / error carrying `responseId` belong to the response
   * this gate has open? A done for anything else is a straggler from a
   * cancelled or superseded response and must not touch the gate.
   */
  owns(responseId?: string | null): boolean {
    if (!responseId) return true; // no id to check against — pre-MOD-#107b behaviour
    // MOD #107 ROUND 3: a response we have already finished with is provably
    // stale, even during the null-id window.
    if (this.retiredIds.includes(responseId)) return false;
    if (this.activeResponseId === null) return true; // create issued, id not yet known
    return this.activeResponseId === responseId;
  }

  /** Diagnostic seam: has this gate already finished with `responseId`? */
  isRetired(responseId: string): boolean {
    return this.retiredIds.includes(responseId);
  }

  /**
   * `response.done` that carried function_call items. Closes the response
   * WITHOUT consuming the deferred slot: the tool continuation issues its own
   * request() once every function_call_output has landed.
   * @returns false when the done belonged to some other (stale) response.
   */
  closeForTool(responseId?: string | null): boolean {
    if (!this.owns(responseId)) return false;
    this.retire(responseId ?? this.activeResponseId);
    this.active = false;
    this.activeResponseId = null;
    return true;
  }

  /**
   * `response.done` ending the turn.
   * @returns true when a deferred create is owed — the gate has already marked
   *          itself active again, so the caller only has to send. A done from a
   *          stale response returns false and changes NOTHING (round-2 fix).
   */
  close(responseId?: string | null): boolean {
    if (!this.owns(responseId)) return false;
    this.retire(responseId ?? this.activeResponseId);
    this.active = false;
    this.activeResponseId = null;
    if (this.deferred) {
      this.deferred = false;
      this.active = true;
      return true;
    }
    return false;
  }

  /**
   * Hard reset. Required on: the `error` event (the server abandoned the
   * response and will never send its `done`), barge-in, the stop control, and
   * session teardown. Without it the gate stays active forever and every later
   * create is swallowed.
   */
  clear(): void {
    // MOD #107 ROUND 3: the cancelled response is retired here — this is the
    // barge-in path, and its terminal done is exactly the straggler that used
    // to close the gate for the response that REPLACED it.
    this.retire(this.activeResponseId);
    this.active = false;
    this.deferred = false;
    this.activeResponseId = null;
  }

  snapshot(): ResponseGateSnapshot {
    return { active: this.active, deferred: this.deferred, activeId: this.activeResponseId };
  }
}
// === END JARVIS MOD #107 ===
