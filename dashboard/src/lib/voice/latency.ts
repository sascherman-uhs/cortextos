// === JARVIS MOD #54 — client-side voice turn latency instrumentation ===
// New file. TRILLION-BAR.md "Voice UX": *instrument
// `time_since_user_stopped_talking`* — the only latency number that matches
// what a person actually feels. Server-side timing (MOD #34/#45's `latencyMs`,
// `ttfsMs`) starts when the request lands, which silently omits endpointing,
// upload, and audio-start — on the Realtime path that omitted portion is most
// of the wait.
//
// So the measurement starts in the browser at the moment the VAD says the user
// stopped talking, and stops at the first audible word. Both paths report
// through here into the SAME logs/<agent>/fastpath-metrics.jsonl the fast path
// already writes, so one file answers "how fast is JARVIS" regardless of which
// voice engine served the turn.
//
// Fire-and-forget by construction: a metrics failure must never delay or break
// a reply, so every call is unawaited and every error is swallowed.
// === END header ===

export type VoicePath = 'realtime' | 'fastpath';

export interface TurnLatency {
  /** Which voice engine served the turn. */
  path: VoicePath;
  /** ms from user-stopped-talking to the first audible word. THE number. */
  firstAudioMs: number;
  /** ms from user-stopped-talking to the user's transcript being available. */
  transcriptMs?: number;
  /** True when the turn was a deterministic sign-off (MOD #53) — no model call. */
  signoff?: boolean;
  /** True when the turn required a tool round-trip. */
  tool?: string;
}

/**
 * Report one turn's latency. Fire-and-forget: never awaited, never throws.
 * Also mirrored onto `window.__cosmosStats.lastTurnLatency` so the UI sparkline
 * (and Playwright) can read it without touching the log file.
 */
export function reportTurnLatency(entry: TurnLatency): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as unknown as { __cosmosStats?: Record<string, unknown> };
    w.__cosmosStats = { ...(w.__cosmosStats ?? {}), lastTurnLatency: entry };
    void fetch('/api/uhs/voice/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* instrumentation must never break the reply path */
  }
}

/**
 * Turn-clock for one voice turn.
 *
 * `stop()` is called at the VAD end-of-turn boundary and `firstAudio()` at the
 * first audible word — but the events that mark those moments can arrive out of
 * order or twice per turn (Realtime emits both an audio-buffer start and a
 * transcript delta; either may be first). The clock therefore records only the
 * FIRST of each and ignores repeats, so a turn can never report twice or
 * report a negative duration.
 */
export class TurnClock {
  private stoppedAt: number | null = null;
  private reported = false;
  private transcriptMs: number | undefined;

  /** User stopped talking. Starts the clock. */
  stop(now = performance.now()): void {
    this.stoppedAt = now;
    this.reported = false;
    this.transcriptMs = undefined;
  }

  /** The user's transcript landed (a secondary, diagnostic number). */
  transcript(now = performance.now()): void {
    if (this.stoppedAt === null || this.transcriptMs !== undefined) return;
    this.transcriptMs = Math.round(now - this.stoppedAt);
  }

  /** First audible word. Reports exactly once per turn; later calls no-op. */
  firstAudio(meta: Omit<TurnLatency, 'firstAudioMs' | 'transcriptMs'>, now = performance.now()): void {
    if (this.stoppedAt === null || this.reported) return;
    this.reported = true;
    reportTurnLatency({
      ...meta,
      firstAudioMs: Math.round(now - this.stoppedAt),
      ...(this.transcriptMs !== undefined ? { transcriptMs: this.transcriptMs } : {}),
    });
  }

  /** True when a turn is in flight and has not yet reported. */
  get pending(): boolean {
    return this.stoppedAt !== null && !this.reported;
  }
}
// === END JARVIS MOD #54 ===
