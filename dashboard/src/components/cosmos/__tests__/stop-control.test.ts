// === JARVIS MOD #77 — think-time stop control (2026-08-03) ===
// The live server runs the REALTIME lane, so the branch where a cancel exists
// cannot be clicked through in a browser here. These lock it instead.

import { describe, it, expect } from 'vitest';
import { micControl, isThinking } from '../stop-control';
import type { VoiceState } from '../use-voice';

const ALL: VoiceState[] = [
  'dormant',
  'wakeListening',
  'idle',
  'listening',
  'processing',
  'responding',
  'speaking',
];

describe('isThinking', () => {
  it('covers BOTH think-time states, not just processing', () => {
    expect(isThinking('processing')).toBe(true);
    expect(isThinking('responding')).toBe(true);
  });

  it('is false for every other state', () => {
    for (const s of ALL.filter((x) => x !== 'processing' && x !== 'responding')) {
      expect(isThinking(s)).toBe(false);
    }
  });
});

describe('micControl — cancel available (legacy lane)', () => {
  const withCancel = (displayState: VoiceState) =>
    micControl({ displayState, supported: true, canCancelReply: true });

  it('offers a live stop control through the whole think-time window', () => {
    for (const s of ['processing', 'responding'] as VoiceState[]) {
      const c = withCancel(s);
      expect(c.mode).toBe('stop-reply');
      expect(c.disabled).toBe(false); // the entire point: NOT disabled
      expect(c.ariaLabel).toBe('Stop generating');
    }
  });

  it('still reads as the listening control while the mic is hot', () => {
    expect(withCancel('listening')).toEqual({
      mode: 'listening',
      disabled: false,
      ariaLabel: 'Stop listening',
    });
  });

  it('does not hijack speaking — barge-in there is already the mic press', () => {
    expect(withCancel('speaking').mode).toBe('idle');
    expect(withCancel('speaking').disabled).toBe(false);
  });

  it('is a normal mic button at rest', () => {
    for (const s of ['idle', 'dormant', 'wakeListening'] as VoiceState[]) {
      expect(withCancel(s).mode).toBe('idle');
      expect(withCancel(s).disabled).toBe(false);
    }
  });
});

describe('micControl — no cancel exposed (realtime lane)', () => {
  const noCancel = (displayState: VoiceState) =>
    micControl({ displayState, supported: true, canCancelReply: false });

  it('never claims a stop control it cannot honour', () => {
    for (const s of ALL) expect(noCancel(s).mode).not.toBe('stop-reply');
  });

  it('keeps the pre-existing disabled-during-think-time behaviour', () => {
    expect(noCancel('processing').disabled).toBe(true);
    expect(noCancel('responding').disabled).toBe(true);
  });

  it('is unaffected at rest and while listening', () => {
    expect(noCancel('idle').disabled).toBe(false);
    expect(noCancel('listening').mode).toBe('listening');
  });
});

describe('micControl — unsupported', () => {
  it('is disabled in every state, and never a stop control', () => {
    for (const s of ALL) {
      const c = micControl({ displayState: s, supported: false, canCancelReply: true });
      expect(c.disabled).toBe(true);
    }
  });
});
