'use client';

// === JARVIS MOD #77 — think-time stop-control decision (2026-08-03) ===
// Extracted from voice-panel.tsx so the rule is testable without a DOM.
//
// === JARVIS MOD #107 CORRECTION (2026-08-09) ===
// The paragraph that used to sit here said the Realtime lane exposes no cancel,
// so the stop-reply branch could not be exercised in a browser. That stopped
// being true with MOD #101, which added interruptReply() to use-realtime-voice
// — the LIVE lane has had a working cancel for six days, and the stale comment
// was actively misleading anyone deciding whether this branch needs browser
// coverage. Both lanes now expose a cancel; `canCancelReply` remains capability
// detection rather than lane detection, which is why nothing here had to change
// when the capability appeared.

import type { VoiceState } from './use-voice';

export type MicMode = 'idle' | 'listening' | 'stop-reply' | 'retry';

export interface MicControl {
  mode: MicMode;
  /** True only when the button does nothing useful — keeps it out of the tab order. */
  disabled: boolean;
  ariaLabel: string;
}

/**
 * Think-time is BOTH machine states between the send and the first audible
 * word: 'processing' ("Sending…") and 'responding' ("JARVIS is thinking…").
 * Gating on 'processing' alone would leave the longer half of the wait
 * uncancellable, which is the bug this control exists to fix.
 */
export function isThinking(displayState: VoiceState): boolean {
  return displayState === 'processing' || displayState === 'responding';
}

/**
 * Decide what the mic button is right now.
 *
 * `canCancelReply` / `canRetry` are capability detection, NOT lane detection:
 * the control lights up for whichever hook exposes the member. A lane that
 * exposes neither degrades to a disabled button — no crash, and no dead
 * affordance that lies about being clickable.
 *
 * MOD #107: 'error' outranks everything. A failed session cannot listen and has
 * nothing to cancel, so the only useful thing the button can be is the way back
 * — leaving it disabled (which is what an unhandled state did) means the user's
 * only recovery is a reload they have no reason to know about.
 */
export function micControl({
  displayState,
  supported,
  canCancelReply,
  canRetry = false,
}: {
  displayState: VoiceState;
  supported: boolean;
  canCancelReply: boolean;
  canRetry?: boolean;
}): MicControl {
  if (displayState === 'error') {
    return {
      mode: 'retry',
      disabled: !supported || !canRetry,
      ariaLabel: 'Retry voice connection',
    };
  }

  const listening = displayState === 'listening';
  const thinking = !listening && isThinking(displayState);
  const stopReply = thinking && canCancelReply;

  if (stopReply) {
    return { mode: 'stop-reply', disabled: !supported, ariaLabel: 'Stop generating' };
  }
  if (listening) {
    return { mode: 'listening', disabled: !supported, ariaLabel: 'Stop listening' };
  }
  return {
    mode: 'idle',
    // Think-time with no cancel available is the one case that stays dead.
    disabled: !supported || thinking,
    ariaLabel: 'Start voice input',
  };
}
// === END JARVIS MOD #77 ===
