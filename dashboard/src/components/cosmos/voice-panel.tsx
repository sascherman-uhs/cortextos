// === JARVIS MOD #20 — Cosmos voice loop: frosted transcript panel (2026-07-03) ===
// New file (isolated). Owns:
//  - the useVoice hook (STT + amplitude + state machine),
//  - the outbound SSE lifecycle: fetch a 5-min token from /api/uhs/stream-token,
//    open EventSource on /api/messages/stream/jarvis-telegram?token=..., and on
//    error (incl. token expiry) re-fetch a token and reopen,
//  - reply routing: outbound lines are the agent's replies (they ALSO land in
//    Scott's real Telegram — expected). We show a baseline of pre-existing
//    outbound history as already-seen, then surface anything new as a reply.
//  - hidden Playwright hooks (synth-transcript / synth-send) feeding the exact
//    same send path as the mic.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoice, type VoiceState } from './use-voice';
// === JARVIS MOD #21 — Cosmos TTS playback ===
import { useTts } from './use-tts';
// === END JARVIS MOD #21 ===
// === JARVIS MOD #25 — iOS audio unlock on the primary (mic) gesture ===
import { unlockSharedAudio } from './audio-unlock';
// === END JARVIS MOD #25 ===
// === JARVIS MOD #38 — single decision point for SSE/backfill reply surfacing ===
import { shouldSurfaceReply } from './reply-dedupe';
// === END JARVIS MOD #38 ===

interface VoicePanelProps {
  /** Lets the parent Scene mirror voice state → orb color, amplitude → breathing. */
  onStateChange?: (state: VoiceState) => void;
  onAmplitudeChange?: (amplitude: number) => void;
  // === JARVIS MOD #21: TTS playback amplitude → orb breathing while speaking ===
  onTtsAmplitudeChange?: (amplitude: number) => void;
  // === END JARVIS MOD #21 ===
}

const STATE_LABEL: Record<VoiceState, string> = {
  // === JARVIS MOD #36: open-mic states ===
  dormant: 'Mic off',
  wakeListening: 'Say "Jarvis"…',
  idle: 'Tap to speak',
  listening: 'Listening…',
  processing: 'Sending…',
  responding: 'JARVIS is thinking…',
  speaking: 'JARVIS is speaking…',
  // === END MOD #36 ===
};

export function VoicePanel({
  onStateChange,
  onAmplitudeChange,
  onTtsAmplitudeChange,
}: VoicePanelProps) {
  const voice = useVoice();
  const {
    state,
    supported,
    amplitude,
    interim,
    log,
    startListening,
    stopListening,
    sendText,
    pushAgentReply,
    // === JARVIS MOD #33: the hook's counter — incremented by EVERY send path ===
    sentTurnsRef,
    // === END JARVIS MOD #33 ===
    // === JARVIS MOD #36: open-mic surface ===
    openMic,
    toggleOpenMic,
    bindTts,
    notifyTtsSpeaking,
    // === END MOD #36 ===
    // === JARVIS MOD #38: ids already delivered via the synchronous fast lane ===
    fastReplyIdsRef,
    // === END MOD #38 ===
  } = voice;

  // === JARVIS MOD #21: TTS — speak new agent replies through the three-tier route ===
  // === JARVIS MOD #24: also pull interrupt() for barge-in (mic press / new turn) ===
  const { muted, toggleMute, speak, interrupt, ttsAmplitude, speaking, lastError } = useTts();

  // === JARVIS MOD #36: wire the TTS bridge into the open-mic engine —
  // wake-word barge-in needs interrupt()+isSpeaking(); wake-ack/sign-off lines
  // are LOCAL speech (no agent round-trip). speakingRef avoids re-binding. ===
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = speaking;
    notifyTtsSpeaking(speaking);
  }, [speaking, notifyTtsSpeaking]);
  useEffect(() => {
    bindTts({
      interrupt,
      isSpeaking: () => speakingRef.current,
      speakLocal: (text: string) => void speak(text),
    });
  }, [bindTts, interrupt, speak]);
  // Effective state for the orb + label: TTS playback overrides the machine.
  const displayState: VoiceState = speaking ? 'speaking' : state;
  // === END MOD #36 ===

  // === JARVIS MOD #31: one-tap audio pipeline check. Runs INSIDE the tap
  // gesture (unlock + unmute + speak), so it isolates faults on the phone:
  // hear it → delivery problem; silent → the lastError line says why. ===
  const handleVoiceTest = useCallback(() => {
    unlockSharedAudio();
    if (muted) toggleMute();
    void speak('Voice check, sir. If you can hear this, the audio pipeline is alive and well.');
  }, [muted, toggleMute, speak]);
  // === END JARVIS MOD #31 ===
  // Track which reply ids we've already spoken so a re-render never double-speaks.
  const spokenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    onTtsAmplitudeChange?.(ttsAmplitude);
  }, [ttsAmplitude, onTtsAmplitudeChange]);
  useEffect(() => {
    // Speak only the most recent, not-yet-spoken agent line. Speaking is a no-op
    // while muted (and no /api/uhs/tts call fires) — enforced inside useTts.
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.role !== 'agent') continue;
      if (!spokenIdsRef.current.has(entry.id)) {
        spokenIdsRef.current.add(entry.id);
        void speak(entry.text);
      }
      break; // only consider the latest agent entry
    }
  }, [log, speak]);
  // === END JARVIS MOD #21 ===

  const [synthValue, setSynthValue] = useState('');
  const esRef = useRef<EventSource | null>(null);
  // Baseline: outbound lines seen at connect time are pre-existing history,
  // not replies to this session. Once we've sent at least one turn, new
  // outbound lines are treated as replies.
  // === JARVIS MOD #33: panel-local counter REMOVED — it only counted typed
  // sends, so voice-only sessions gated every reply out as history. The gate
  // now reads sentTurnsRef from useVoice (incremented inside sendText). ===
  const seenIdsRef = useRef<Set<string>>(new Set());
  const closedRef = useRef(false);

  // Bubble state + amplitude up to the Scene for the orb.
  // === JARVIS MOD #36: the scene sees displayState ('speaking' while TTS plays). ===
  useEffect(() => {
    onStateChange?.(displayState);
  }, [displayState, onStateChange]);
  // === END MOD #36 ===
  useEffect(() => {
    onAmplitudeChange?.(amplitude);
  }, [amplitude, onAmplitudeChange]);

  // === JARVIS MOD #30 (2026-07-06): history backfill — the missed-reply fix ===
  // The SSE tail only delivers lines written WHILE connected. iOS suspends the
  // PWA the instant the screen locks or the user app-switches, and JARVIS takes
  // 10-40s to think — so the reply routinely lands while the stream is dead and
  // was never re-delivered (silent app, reply visible in Telegram). Backfill
  // from /api/messages/history on every (re)connect and on visibility resume.
  // First call (before any send) runs in seed mode: marks existing outbound ids
  // as seen WITHOUT speaking them, so history is never replayed aloud.
  const backfill = useCallback(async (): Promise<number> => {
    let surfaced = 0;
    try {
      const res = await fetch('/api/messages/history/jarvis-telegram?limit=20', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return 0;
      const items = (await res.json()) as {
        id?: string;
        direction?: string;
        text?: string;
      }[];
      for (const it of items) {
        if (it.direction !== 'outbound') continue;
        // === JARVIS MOD #38: shared decision point (marks seen, skips
        // fast-lane-delivered ids, keeps the MOD #33 sent-turn gate). ===
        if (
          shouldSurfaceReply({
            id: it.id,
            text: it.text,
            seen: seenIdsRef.current,
            fastReplyIds: fastReplyIdsRef.current,
            sentTurns: sentTurnsRef.current,
          })
        ) {
          pushAgentReply(it.text as string, it.id as string);
          surfaced += 1;
        }
        // === END MOD #38 ===
      }
    } catch {
      /* transient — next reconnect/backfill will retry */
    }
    return surfaced;
  }, [pushAgentReply]);
  // === END JARVIS MOD #30 ===

  // --- Outbound SSE lifecycle ------------------------------------------------
  const openStream = useCallback(async () => {
    if (closedRef.current) return;
    try {
      const res = await fetch('/api/uhs/stream-token');
      if (!res.ok) {
        // Retry shortly (auth may be mid-refresh).
        setTimeout(() => openStream(), 3000);
        return;
      }
      const { token } = (await res.json()) as { token: string };
      if (closedRef.current) return;

      const es = new EventSource(
        `/api/messages/stream/jarvis-telegram?token=${encodeURIComponent(token)}`,
      );
      esRef.current = es;

      // === JARVIS MOD #30: catch anything written while we were disconnected.
      // (Seed mode on first connect; speaks only post-send replies after that.) ===
      void backfill();
      // === END JARVIS MOD #30 ===

      es.onmessage = (evt) => {
        let parsed: { id?: string; text?: string; direction?: string };
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          return;
        }
        const id = parsed.id ?? `out-${Date.now()}`;
        // === JARVIS MOD #38: shared decision point — also skips replies the
        // synchronous fast lane already spoke (same outbound line echoes here). ===
        if (
          shouldSurfaceReply({
            id,
            text: parsed.text,
            seen: seenIdsRef.current,
            fastReplyIds: fastReplyIdsRef.current,
            sentTurns: sentTurnsRef.current,
          })
        ) {
          pushAgentReply(parsed.text as string, id);
        }
        // === END MOD #38 ===
      };

      es.onerror = () => {
        // EventSource auto-reconnects on transient errors, but a 401 (expired
        // 5-min token) is terminal for this connection — close and re-mint.
        es.close();
        esRef.current = null;
        if (!closedRef.current) {
          setTimeout(() => openStream(), 1000);
        }
      };
    } catch {
      if (!closedRef.current) setTimeout(() => openStream(), 3000);
    }
  }, [pushAgentReply]);

  useEffect(() => {
    closedRef.current = false;
    openStream();
    // === JARVIS MOD #30: iOS resume — the suspended PWA's EventSource is dead
    // but onerror may not fire for up to a heartbeat (30s). On visibility
    // resume, tear the stream down and reopen immediately (openStream also
    // backfills), so a reply that landed during the suspension speaks within
    // ~1s of the user returning to the app. ===
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || closedRef.current) return;
      esRef.current?.close();
      esRef.current = null;
      openStream();
    };
    document.addEventListener('visibilitychange', onVisible);
    // === END JARVIS MOD #30 ===
    // === JARVIS MOD #32 (2026-07-06): zombie-stream safety net. iOS/proxies can
    // sever the SSE connection WITHOUT firing onerror — EventSource believes
    // it's open, no reconnect fires, and if the user never backgrounds the app
    // the visibility backfill never runs either (observed live: reply written
    // 9s after the question, app foregrounded and silent for 3+ minutes).
    // Poll backfill every 20s while visible; if the poll surfaces a reply the
    // stream should have delivered, the stream is a zombie — bounce it. ===
    const pollTimer = setInterval(async () => {
      if (closedRef.current || document.visibilityState !== 'visible') return;
      const missed = await backfill();
      if (missed > 0 && !closedRef.current) {
        esRef.current?.close();
        esRef.current = null;
        openStream();
      }
    }, 20_000);
    // === END JARVIS MOD #32 ===
    return () => {
      closedRef.current = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(pollTimer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [openStream, backfill]);

  // Wrap send so we can bump the "sends pending" gate for reply routing.
  const doSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      // === JARVIS MOD #24: a new user turn cuts off any reply still being spoken ===
      interrupt();
      // === END JARVIS MOD #24 ===
      sendText(text); // sendText increments sentTurnsRef itself (MOD #33)
    },
    [sendText, interrupt],
  );

  // === JARVIS MOD #24: mic press = barge-in. Pressing the mic while JARVIS is
  // speaking must cut him off cleanly (stop audio + abort in-flight synth) BEFORE
  // we start listening, so the reply doesn't talk over the new turn. ===
  const handleMicPress = useCallback(() => {
    // === JARVIS MOD #25: the mic tap is a user gesture — unlock iOS audio here so
    // JARVIS' first reply is audible on a phone (belt-and-suspenders with PwaBoot). ===
    unlockSharedAudio();
    // === END JARVIS MOD #25 ===
    if (state === 'listening') {
      stopListening();
    } else {
      interrupt();
      startListening();
    }
  }, [state, stopListening, interrupt, startListening]);
  // === END JARVIS MOD #24 ===

  const handleSynthSend = useCallback(() => {
    const v = synthValue.trim();
    if (!v) return;
    doSend(v);
    setSynthValue('');
  }, [synthValue, doSend]);

  const micActive = state === 'listening';

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-8"
      // === JARVIS MOD #25: respect the notch/home-indicator safe areas on mobile.
      // Falls back to the Tailwind px-4/pb-8 when env() insets are 0 (desktop). ===
      style={{
        paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))',
        paddingLeft: 'calc(1rem + env(safe-area-inset-left))',
        paddingRight: 'calc(1rem + env(safe-area-inset-right))',
      }}
    >
      <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-white/15 bg-[#2D2928]/60 p-4 text-[#EDE8DF] shadow-2xl backdrop-blur-xl">
        {/* Conversation log */}
        <div
          className="mb-3 max-h-48 space-y-2 overflow-y-auto pr-1"
          data-testid="cosmos-log"
        >
          {log.length === 0 && (
            <p className="text-center text-xs text-[#CFB383]/50">
              Ask JARVIS anything.
            </p>
          )}
          {log.map((entry) => (
            <div
              key={entry.id}
              className={
                entry.role === 'user'
                  ? 'text-right text-sm text-[#EDE8DF]'
                  : entry.role === 'heard'
                    ? 'text-right text-xs italic text-[#EDE8DF]/35'
                    : 'text-left text-sm text-[#CFB383]'
              }
              data-testid={
                entry.role === 'agent'
                  ? 'cosmos-reply'
                  : entry.role === 'heard'
                    ? 'cosmos-heard'
                    : 'cosmos-user'
              }
            >
              <span className="inline-block rounded-lg bg-white/5 px-3 py-1.5">
                {entry.role === 'heard' ? `heard: “${entry.text}” — say “Hey JARVIS…”` : entry.text}
              </span>
            </div>
          ))}
        </div>

        {/* Live interim transcript */}
        {interim && (
          <p className="mb-2 truncate text-center text-xs italic text-[#EDE8DF]/70">
            {interim}
          </p>
        )}

        {/* Controls row */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleMicPress}
            disabled={!supported || state === 'processing'}
            aria-label={micActive ? 'Stop listening' : 'Start voice input'}
            data-testid="cosmos-mic"
            className={[
              // === JARVIS MOD #25: bigger tap target on phones (h-14/w-14 ≈ 56px),
              // reverting to the desktop 44px at md+ so desktop is unchanged. ===
              'flex h-14 w-14 md:h-11 md:w-11 shrink-0 items-center justify-center rounded-full border transition-colors',
              micActive
                ? 'animate-pulse border-[#F5F0E6] bg-[#F5F0E6]/20 text-[#F5F0E6]'
                : 'border-[#CFB383]/50 bg-[#CFB383]/10 text-[#CFB383] hover:bg-[#CFB383]/20',
              !supported ? 'opacity-40' : '',
            ].join(' ')}
          >
            {/* Simple mic glyph (no icon dep needed here) */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
          </button>

          <span className="flex-1 text-sm text-[#EDE8DF]/80" data-testid="cosmos-status">
            {/* === JARVIS MOD #36: label follows displayState (incl. 'speaking') === */}
            {supported ? STATE_LABEL[displayState] : 'Voice not supported — use the box below'}
          </span>

          {/* === JARVIS MOD #36: open-mic toggle — the privacy control. ON = hot
              mic waiting for "Jarvis"; OFF = tap-to-talk only (pre-mod flow). === */}
          <button
            onClick={toggleOpenMic}
            aria-label={openMic ? 'Disable open mic' : 'Enable open mic'}
            aria-pressed={openMic}
            data-testid="cosmos-open-mic"
            title={openMic ? 'Open mic ON — say "Jarvis"' : 'Open mic OFF — tap to talk'}
            className={[
              'flex h-9 shrink-0 items-center justify-center rounded-full border px-3 text-xs transition-colors',
              openMic
                ? 'border-[#2DD4A8]/60 bg-[#2DD4A8]/10 text-[#2DD4A8] hover:bg-[#2DD4A8]/20'
                : 'border-white/20 bg-white/5 text-[#EDE8DF]/40 hover:bg-white/10',
            ].join(' ')}
          >
            {openMic ? '"Hey Jarvis" ON' : 'Enable "Hey Jarvis"'}
          </button>
          {/* === END MOD #36 === */}

          {/* === JARVIS MOD #31: one-tap audio pipeline check === */}
          <button
            onClick={handleVoiceTest}
            aria-label="Test JARVIS voice"
            data-testid="cosmos-voice-test"
            title="Play a test line through the voice pipeline"
            className="shrink-0 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs text-[#EDE8DF]/70 transition-colors hover:bg-white/10"
          >
            Test voice
          </button>
          {/* === END JARVIS MOD #31 === */}

          {/* === JARVIS MOD #21: TTS mute toggle (persisted in localStorage) === */}
          <button
            onClick={toggleMute}
            aria-label={muted ? 'Unmute JARVIS voice' : 'Mute JARVIS voice'}
            aria-pressed={muted}
            data-testid="cosmos-mute"
            title={muted ? 'JARVIS voice muted' : 'JARVIS voice on'}
            className={[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors',
              muted
                ? 'border-white/20 bg-white/5 text-[#EDE8DF]/40'
                : 'border-[#CFB383]/50 bg-[#CFB383]/10 text-[#CFB383] hover:bg-[#CFB383]/20',
            ].join(' ')}
          >
            {muted ? (
              // Muted speaker glyph
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              // Speaker-on glyph
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
          </button>
          {/* === END JARVIS MOD #21 === */}
        </div>

        {/* === JARVIS MOD #31: on-phone diagnostics — no console on iOS, so the
            audio pipeline's last failure (and the mute state) must be VISIBLE. === */}
        {(lastError || muted) && (
          <p className="mt-2 text-xs" data-testid="cosmos-tts-error">
            {muted && <span className="text-amber-300/80">Voice muted — tap the speaker icon. </span>}
            {lastError && <span className="text-red-400/90">Audio: {lastError}</span>}
          </p>
        )}
        {/* === END JARVIS MOD #31 === */}

        {/* === JARVIS MOD #39: mic-debug line — the mic pipeline's live state,
            always visible (dim). A suspended AudioContext + dead VAD was
            indistinguishable from "working" on 2026-07-08; never again. === */}
        <MicDebugLine openMic={openMic} />
        {/* === END JARVIS MOD #39 === */}

        {/* Hidden Playwright test hooks — feed the EXACT same send path as voice.
            Kept visually minimal but not display:none so tests can interact. */}
        <div className="mt-3 flex items-center gap-2 opacity-60">
          <input
            type="text"
            value={synthValue}
            onChange={(e) => setSynthValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSynthSend();
            }}
            placeholder="Type a message…"
            data-testid="synth-transcript"
            className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-[#EDE8DF] placeholder:text-[#EDE8DF]/30 focus:border-[#CFB383]/50 focus:outline-none"
          />
          <button
            onClick={handleSynthSend}
            data-testid="synth-send"
            className="rounded-lg border border-[#9E7331]/60 bg-[#9E7331]/20 px-3 py-1.5 text-sm text-[#CFB383] hover:bg-[#9E7331]/30"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
// === END JARVIS MOD #20 ===

// === JARVIS MOD #39 — on-phone mic diagnostics (2026-07-08) ===
// Polls window.__cosmosStats (the existing seam) at 2Hz and renders one dim
// line: mic on/off · audio-context state · live VAD energy vs threshold ·
// last wake-gate decision. MOD #31's rule generalized: every silent failure
// mode of the audio pipeline must be readable off the phone screen.
function MicDebugLine({ openMic }: { openMic: boolean }) {
  const [line, setLine] = useState('');
  useEffect(() => {
    const read = () => {
      const s = (window as unknown as {
        __cosmosStats?: {
          micCtxState?: string;
          vadEnergy?: number;
          openMicError?: string | null;
          wakeGate?: { lastDecision?: string; lastUtterance?: string };
        };
      }).__cosmosStats;
      const ctxState = s?.micCtxState ?? '—';
      const vad = s?.vadEnergy !== undefined ? s.vadEnergy.toFixed(3) : '—';
      const err = s?.openMicError ? ` · ERR ${s.openMicError}` : '';
      const gate = s?.wakeGate?.lastDecision
        ? ` · ${s.wakeGate.lastDecision}: “${(s.wakeGate.lastUtterance ?? '').slice(0, 32)}”`
        : '';
      // MOD #39d: build stamp — "does the gray line say v39g?" instantly
      // answers whether the installed PWA pulled fresh JS (iOS staleness lore).
      setLine(
        `v39i · mic ${openMic ? 'on' : 'off'} · audio ${ctxState} · vad ${vad}${err}${gate}`,
      );
    };
    read();
    const t = setInterval(read, 500);
    return () => clearInterval(t);
  }, [openMic]);
  return (
    <p
      className="mt-1 truncate text-[10px] text-[#EDE8DF]/30"
      data-testid="mic-debug"
    >
      {line}
    </p>
  );
}
// === END JARVIS MOD #39 ===
