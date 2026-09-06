'use client';

// === JARVIS MOD #77 — think-time stop-control decision (2026-08-03) ===
// Extracted from voice-panel.tsx so the rule is testable without a DOM. The
// live dev server is pinned to the REALTIME lane by shared config
// (NEXT_PUBLIC_CTX_REALTIME_VOICE=1 in ~/.cortextos/default/dashboard.env),
// which I must not change and cannot override per-request — so the branch
// where a cancel IS available cannot be exercised through the browser here.
// This module is how that branch gets real coverage.

import type { VoiceState } from './use-voice';

export type MicMode = 'idle' | 'listening' | 'stop-reply';

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
 * `canCancelReply` is capability detection, NOT lane detection: the control
 * lights up for whichever hook exposes a cancel. use-realtime-voice currently
 * exposes none, so on that lane the button stays disabled during think-time
 * exactly as it did before — no crash, no dead affordance that lies about
 * being clickable.
 */
export function micControl({
  displayState,
  supported,
  canCancelReply,
}: {
  displayState: VoiceState;
  supported: boolean;
  canCancelReply: boolean;
}): MicControl {
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
