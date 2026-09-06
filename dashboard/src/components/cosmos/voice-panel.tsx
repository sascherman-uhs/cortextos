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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// === JARVIS MOD #56/#55: the one warm accent + the one easing curve ===
import { GOLD, GOLD_RGB, COOL_TEXT, COOL_DIM, COOL_LINE, CYAN, PURPLE } from './palette';
// MOD #76: the stop-reply border — cool, brighter than idle chrome so the
// control reads as actionable without borrowing the reserved gold accent.
const STOP_LINE = 'rgba(148,214,216,0.6)';
// === JARVIS MOD #107: the failure accent. Deliberately NOT gold (reserved for
// listening, MOD #56) and not the cool chrome — a broken voice engine has to be
// distinguishable at a glance from a deliberately-off one. ===
const ERROR_LINE = 'rgba(224,90,74,0.85)';
import { EASE, DUR_BASE } from './motion';
// === JARVIS MOD #77: think-time stop-control decision (testable, no DOM) ===
import { micControl } from './stop-control';
// === END MOD #77 ===
// === END JARVIS MOD #56/#55 ===
// === JARVIS MOD #50 — OpenAI Realtime voice hook (feature-flagged) ===
import { useRealtimeVoice, type VoiceEngine, type RealtimeEngine } from './use-realtime-voice';
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
// === JARVIS MOD #107 ROUND 3 — the agent is a parameter now, so the E2E suite
// can be pointed at a throwaway log instead of Scott's real one. ===
import { resolveVoiceAgent } from './voice-agent';

// === JARVIS MOD #107 — 3-way engine select (2026-08-09) =====================
// MOD #50's boolean could only express "OpenAI voice or browser STT", which is
// two of the three lanes that now exist. NEXT_PUBLIC_CTX_VOICE_ENGINE is the
// real selector:
//   'legacy'      — browser STT + the fast-path agent + ElevenLabs (pre-MOD-#50).
//   'realtime'    — OpenAI Realtime, OpenAI's voice over the WebRTC audio track.
//   'realtime-el' — OpenAI Realtime for the brain, text-only session, replies
//                   streamed sentence-by-sentence into ElevenLabs "Daniel".
// Back-compat is deliberate and load-bearing: NEXT_PUBLIC_CTX_REALTIME_VOICE=1
// lives in shared config (~/.cortextos/default/dashboard.env) and other surfaces
// read it, so it still maps to 'realtime' whenever the new var is unset.
function resolveEngine(): VoiceEngine {
  const raw = process.env.NEXT_PUBLIC_CTX_VOICE_ENGINE;
  if (raw === 'legacy' || raw === 'realtime' || raw === 'realtime-el') return raw;
  return process.env.NEXT_PUBLIC_CTX_REALTIME_VOICE === '1' ? 'realtime' : 'legacy';
}
const ENGINE: VoiceEngine = resolveEngine();
const USE_REALTIME = ENGINE !== 'legacy';
/**
 * Does the shared ElevenLabs/`say` engine own the spoken voice on this lane?
 * On 'realtime' it must NOT: OpenAI already speaks the reply over the audio
 * track, and firing the local engine on the same text is the double-voice bug
 * MOD #50 fixed. On 'realtime-el' it MUST: the session is text-only, so the
 * local engine is the ONLY thing that can speak — which is precisely why the
 * blanket `if (USE_REALTIME) return` had to become a per-engine question.
 */
const LOCAL_TTS_OWNS_VOICE = ENGINE === 'legacy' || ENGINE === 'realtime-el';

// === END MOD #107 / MOD #50 ===

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
  // === JARVIS MOD #107: failure says so, and says what to do about it. ===
  error: 'Voice unavailable — tap to retry',
};

export function VoicePanel({
  onStateChange,
  onAmplitudeChange,
  onTtsAmplitudeChange,
}: VoicePanelProps) {
  // === JARVIS MOD #50 / #107: both hooks are still called unconditionally
  // (rules of hooks), but only ONE is now live. Before MOD #107 both opened
  // getUserMedia and the legacy lane ran a full shadow conversation against
  // /api/messages/send — doubling agent traffic, and on iOS causing the OS to
  // silently mute one of two concurrent captures of the same microphone. The
  // `enabled` flag makes the unselected hook completely inert. ===
  // MOD #107 ROUND 3: resolved once per mount rather than at module load, so a
  // client-side navigation that changes the override is honoured and a cached
  // module can never pin a stale agent.
  const VOICE_AGENT = useMemo(() => resolveVoiceAgent(), []);

  const voiceLegacy = useVoice({ enabled: ENGINE === 'legacy' });
  const voiceRealtime = useRealtimeVoice({
    enabled: USE_REALTIME,
    engine: (USE_REALTIME ? ENGINE : 'realtime') as RealtimeEngine,
  });
  const voice = USE_REALTIME ? voiceRealtime : voiceLegacy;
  // === END MOD #50 / #107 ===
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
    // === JARVIS MOD #76: build-bargein's reply cancel. OPTIONAL on the
    // interface — use-realtime-voice satisfies the same shape and exposes no
    // cancel, so absence is a supported state, not an error. ===
    interruptReply,
    // === JARVIS MOD #38: ids already delivered via the synchronous fast lane ===
    fastReplyIdsRef,
    // === END MOD #38 ===
    // === JARVIS MOD #104: pending-lookup ledger (chips) + late-answer delivery.
    // Both OPTIONAL — only the Realtime lane implements them. ===
    pendingLookups,
    deliverLateReply,
    // === END MOD #104 ===
    // === JARVIS MOD #107: manual recovery from a failed session ===
    retry,
    // === END MOD #107 ===
    // === JARVIS MOD #107 ROUND 3: single entry point for outbound lines ===
    offerOutboundReply,
    // === END MOD #107 ROUND 3 ===
  } = voice;

  // === JARVIS MOD #21: TTS — speak new agent replies through the three-tier route ===
  // === JARVIS MOD #24: also pull interrupt() for barge-in (mic press / new turn) ===
  const { muted, toggleMute, speak, interrupt, ttsAmplitude, speaking, lastError, beginStreamReply, setLatencyPath } = useTts();

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
      // === JARVIS MOD #45 (Phase 3): streaming reply surface ===
      beginStreamReply,
      markSpoken: (id: string) => spokenIdsRef.current.add(id),
      // === END MOD #45 ===
      // === JARVIS MOD #107: the lane tags its own turns in the metrics file. ===
      setLatencyPath,
    });
  }, [bindTts, interrupt, speak, beginStreamReply, setLatencyPath]);
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
    // === JARVIS MOD #50 fix / MOD #107 rewire: on 'realtime' OpenAI already
    // speaks its own replies over the WebRTC audio track, and firing the shared
    // ElevenLabs/say engine on the same finalized transcript spoke every reply
    // twice. On 'realtime-el' the opposite is true — the session is text-only,
    // so this effect is the ONLY thing that can voice a reply that arrived
    // outside the streaming path (critics' 3c: an unconsumed LATE reply reaches
    // pushAgentReply and, under the old blanket return, was silently swallowed —
    // logged, never spoken). Replies already streamed sentence-by-sentence are
    // markSpoken()'d by the lane before pushAgentReply, so they are skipped here
    // and never double-spoken.
    if (!LOCAL_TTS_OWNS_VOICE) return;
    // === END MOD #50 fix / MOD #107 ===
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
  // === JARVIS MOD #47: file upload state ===
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  // === END MOD #47 ===
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
      const res = await fetch(`/api/messages/history/${VOICE_AGENT}?limit=20`, {
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
          // === JARVIS MOD #104: if a slow lookup is owed an answer, hand the
          // reply to the live Realtime conversation so JARVIS SPEAKS it
          // unprompted (the spoken transcript lands in the log via the data
          // channel). Only when no lookup is pending — or no live session —
          // does the raw text surface here directly. ===
          // === MOD #107 ROUND 3: ONE entry point. The lane decides whether to
          // deliver now, hold the line while a tool dispatch reconciles, or drop
          // it as the echo of an answer the model is already speaking. Only a
          // lane with no reconciler (legacy) falls through to the old path. ===
          if (!offerOutboundReply?.(it.id as string, it.text as string)) {
            if (!deliverLateReply?.(it.text as string, it.id as string)) {
              pushAgentReply(it.text as string, it.id as string);
            }
          }
          // === END MOD #104 ===
          surfaced += 1;
        }
        // === END MOD #38 ===
      }
    } catch {
      /* transient — next reconnect/backfill will retry */
    }
    return surfaced;
  }, [pushAgentReply, deliverLateReply, offerOutboundReply, VOICE_AGENT]);
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
        `/api/messages/stream/${VOICE_AGENT}?token=${encodeURIComponent(token)}`,
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
          // === JARVIS MOD #104: pending lookup → inject and speak (see backfill) ===
          // === MOD #107 ROUND 3: see the backfill path above. ===
          if (!offerOutboundReply?.(id, parsed.text as string)) {
            if (!deliverLateReply?.(parsed.text as string, id)) {
              pushAgentReply(parsed.text as string, id);
            }
          }
          // === END MOD #104 ===
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
  }, [pushAgentReply, deliverLateReply, offerOutboundReply, backfill, VOICE_AGENT]);

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

  // === JARVIS MOD #47: file upload handler ===
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so the same file can be re-selected if needed
    e.target.value = '';
    setUploadState('uploading');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/uhs/upload', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUploadState('done');
      // Flash "sent" briefly, then back to idle
      setTimeout(() => setUploadState('idle'), 2500);
    } catch {
      setUploadState('error');
      setTimeout(() => setUploadState('idle'), 3000);
    }
  }, []);
  // === END MOD #47 ===

  // === JARVIS MOD #104 — living transcript: auto-scroll ======================
  // The 2026-08-04 demo (IMG_5108) showed the log frozen on the first three
  // messages for four and a half minutes: no auto-scroll existed anywhere, and
  // at max-h-28 everything after message three rendered below the fold. The
  // container now follows the conversation — unless the user has deliberately
  // scrolled up to read history, in which case we leave them alone until they
  // return to (near) the bottom.
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const handleLogScroll = useCallback(() => {
    const el = logScrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useEffect(() => {
    const el = logScrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [log, interim, pendingLookups]);
  // === END MOD #104 ===

  // === JARVIS MOD #60 — ONE mic-state source of truth (2026-08-03) ===
  // The status line read `openMic` (the wake-word toggle) and printed it as
  // "mic off", while the mic BUTTON read `state === 'listening'` — two
  // different concepts rendered with the same word, so the two halves of the
  // same control row routinely disagreed (critic defect #2). Everything that
  // renders mic state now derives from this one object, and the wake toggle is
  // labelled as its own thing rather than as "the mic".
  const micStatus = useMemo(() => {
    const listening = displayState === 'listening';
    return {
      displayState,
      listening,
      /** Capturing right now — this is what the button's warm state means. */
      hot: listening,
      /** Wake-word armed: hot mic waiting for its name, but not capturing a turn. */
      armed: openMic && !listening && displayState !== 'dormant',
      openMic,
      supported,
      label: supported
        ? STATE_LABEL[displayState]
        : 'Voice not supported — use the box below',
    };
  }, [displayState, openMic, supported]);
  const micActive = micStatus.hot;

  // === JARVIS MOD #76 — think-time stop control (2026-08-03) ===
  // The mic button was `disabled` for the whole of state === 'processing', so
  // during agent think-time the user had NO way out of a slow turn: the button
  // was dead, and wake-word barge-in is gated on isSpeaking, which is false
  // before the first audible word. build-bargein's own spec documents the gap
  // (jarvis-bargein.spec.ts G4 interrupts by SPEAKING AGAIN because "the mic
  // control is disabled ... during think-time the button is not a barge-in
  // surface at all").
  const control = micControl({
    displayState,
    supported,
    canCancelReply: typeof interruptReply === 'function',
    // === MOD #107: capability detection — only the Realtime lane can fail into
    // a state a retry can repair. ===
    canRetry: typeof retry === 'function',
  });
  const stopThinking = control.mode === 'stop-reply';
  const retryMode = control.mode === 'retry';

  const handleStopThinking = useCallback(() => {
    // Three parts, and all three are required:
    //   interruptReply — supersedes the in-flight reply via the TurnGuard, so a
    //     late-landing answer cannot speak or move the machine afterwards.
    //   interrupt      — drops anything already queued for that reply's audio.
    //   stopListening  — the STATE transition. interruptReply deliberately does
    //     NOT touch state, and its abort lands in a .catch() gated on
    //     replyGuard.isCurrent(gen), which is already false by then. Every other
    //     caller in use-voice pairs the cancel with a transition ("the barge-in
    //     already put the machine in 'listening'"); calling it bare would strand
    //     the panel on "JARVIS is thinking…" — the spinner limbo this control
    //     exists to prevent.
    interruptReply?.();
    interrupt();
    stopListening();
  }, [interruptReply, interrupt, stopListening]);
  // === END JARVIS MOD #76 ===

  // === JARVIS MOD #107: recover from a failed session. The tap is also a user
  // gesture, so it re-runs the iOS audio/media unlock on the way through — a
  // session that died with the screen locked is exactly the case where the
  // AudioContext has drifted to `suspended` too. ===
  const handleRetry = useCallback(() => {
    unlockSharedAudio();
    retry?.();
  }, [retry]);

  // Status dot: gold only while listening; cool everywhere else (MOD #56).
  // MOD #107: failure is the one other place the palette breaks cool — red.
  const dotColor = micStatus.listening
    ? GOLD
    : displayState === 'error'
      ? ERROR_LINE
      : displayState === 'processing' || displayState === 'responding'
        ? PURPLE
        : displayState === 'speaking'
          ? CYAN
          : COOL_DIM;
  // === END JARVIS MOD #60 ===

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
      <div
        className="pointer-events-auto w-full max-w-xl rounded-2xl border p-3 shadow-2xl backdrop-blur-xl md:p-4"
        style={{
          background: 'rgba(10,20,28,0.62)',
          borderColor: COOL_LINE,
          color: COOL_TEXT,
        }}
      >
        {/* Conversation log — MOD #104: taller (it is the centerpiece of a demo,
            112px hid everything past message three) + auto-scroll (ref above). */}
        <div
          ref={logScrollRef}
          onScroll={handleLogScroll}
          className="mb-3 max-h-56 space-y-2 overflow-y-auto pr-1 md:max-h-96"
          data-testid="cosmos-log"
        >
          {log.length === 0 && (
            <p className="text-center text-xs" style={{ color: `${COOL_DIM}99` }}>
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
                    : 'text-left text-sm text-[#7fe3d8]'
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
          {/* === JARVIS MOD #104: outstanding slow lookups, visible. Parallel
              question-juggling only reads as competence if you can SEE the
              balls in the air; each chip resolves into a spoken answer when
              the late reply lands (deliverLateReply). === */}
          {(pendingLookups ?? []).map((p) => (
            <PendingChip key={p.id} question={p.question} ts={p.ts} escalated={p.escalated} />
          ))}
          {/* === END MOD #104 === */}
        </div>

        {/* Live interim transcript */}
        {interim && (
          <p className="mb-2 truncate text-center text-xs italic text-[#EDE8DF]/70">
            {interim}
          </p>
        )}

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* === JARVIS MOD #56 — the ONE warm moment (2026-08-03).
              Was backwards: gold at rest, flat cream while listening. Now the
              idle button is cool glass, and LISTENING is the only place UHS
              gold appears — gold border + fill + stop-square glyph + 24px gold
              glow + the 1.4s expanding pulse ring (cosmos-pulse-ring). === */}
          <button
            onClick={retryMode ? handleRetry : stopThinking ? handleStopThinking : handleMicPress}
            disabled={control.disabled}
            aria-label={control.ariaLabel}
            data-testid="cosmos-mic"
            data-listening={micActive ? 'true' : 'false'}
            data-mode={control.mode}
            className={[
              // === JARVIS MOD #25: bigger tap target on phones (h-14/w-14 ≈ 56px),
              // reverting to the desktop 44px at md+ so desktop is unchanged. ===
              'relative flex h-14 w-14 md:h-11 md:w-11 shrink-0 items-center justify-center rounded-full border',
              !supported ? 'opacity-40' : '',
            ].join(' ')}
            style={{
              // MOD #76: the stop-reply state is COOL. Gold stays reserved for
              // listening — a cancel affordance is not the warm accent, and
              // spending gold here would undo the point of MOD #56.
              borderColor: micActive ? GOLD : retryMode ? ERROR_LINE : stopThinking ? STOP_LINE : COOL_LINE,
              background: micActive
                ? `rgba(${GOLD_RGB}, 0.14)`
                : retryMode
                  ? 'rgba(224,90,74,0.14)'
                  : stopThinking
                    ? 'rgba(148,214,216,0.12)'
                    : 'rgba(16,26,34,0.6)',
              color: micActive ? GOLD : retryMode ? '#F2A99C' : stopThinking ? COOL_TEXT : COOL_DIM,
              boxShadow: micActive
                ? `0 0 24px rgba(${GOLD_RGB}, 0.5)`
                : retryMode
                  ? '0 0 18px rgba(224,90,74,0.28)'
                  : stopThinking
                    ? '0 0 18px rgba(148,214,216,0.22)'
                    : 'none',
              transition: `border-color ${DUR_BASE}ms ${EASE}, background-color ${DUR_BASE}ms ${EASE}, color ${DUR_BASE}ms ${EASE}, box-shadow ${DUR_BASE}ms ${EASE}`,
            }}
          >
            {/* 1.4s expanding pulse ring — listening only */}
            {micActive && (
              <span
                aria-hidden="true"
                className="cosmos-pulse-ring"
                style={{ borderColor: `rgba(${GOLD_RGB}, 0.55)` }}
              />
            )}
            {retryMode ? (
              // MOD #107: retry glyph — a failed session's only useful action.
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            ) : micActive || stopThinking ? (
              // Stop square — listening, and (MOD #76) cancelling a reply
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2.5" />
              </svg>
            ) : (
              // Simple mic glyph (no icon dep needed here)
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
              </svg>
            )}
          </button>

          <span
            className="flex flex-1 items-center gap-2 text-sm"
            style={{ color: `${COOL_TEXT}cc` }}
            data-testid="cosmos-status"
          >
            {/* === JARVIS MOD #60: 10px status dot — same source as the button === */}
            <span
              aria-hidden="true"
              data-testid="cosmos-status-dot"
              className={micStatus.listening ? 'cosmos-dot-pulse' : ''}
              style={{
                width: 10,
                height: 10,
                borderRadius: 9999,
                background: dotColor,
                boxShadow: micStatus.listening ? `0 0 10px rgba(${GOLD_RGB}, 0.8)` : 'none',
                transition: `background-color ${DUR_BASE}ms ${EASE}, box-shadow ${DUR_BASE}ms ${EASE}`,
                flexShrink: 0,
              }}
            />
            {/* === JARVIS MOD #36: label follows displayState (incl. 'speaking') === */}
            <span className="truncate">{micStatus.label}</span>
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

          {/* === JARVIS MOD #31: one-tap audio pipeline check ===
              === JARVIS MOD #51: legacy-mode only — in Realtime mode the
              OpenAI session owns ALL speech on this surface (Scott's one-voice
              rule, 2026-07-26); firing the ElevenLabs/say engine here would be
              a second voice. === */}
          {/* === MOD #107: the check belongs to whoever owns the voice, not to
              "is this the realtime lane". On 'realtime-el' the ElevenLabs
              pipeline IS the voice, so the one-tap audio check is exactly as
              diagnostic there as it is on legacy. === */}
          {LOCAL_TTS_OWNS_VOICE && (
          <button
            onClick={handleVoiceTest}
            aria-label="Test JARVIS voice"
            data-testid="cosmos-voice-test"
            title="Play a test line through the voice pipeline"
            className="shrink-0 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs text-[#EDE8DF]/70 transition-colors hover:bg-white/10"
          >
            Test voice
          </button>
          )}
          {/* === END JARVIS MOD #31 / MOD #51 === */}

          {/* === JARVIS MOD #47: file/photo upload — sends to JARVIS inbox + Telegram === */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,.pdf,.doc,.docx,.csv,.txt,.html"
            className="hidden"
            aria-hidden="true"
            onChange={handleUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label={uploadState === 'uploading' ? 'Uploading…' : uploadState === 'done' ? 'Sent to JARVIS' : 'Attach file or photo'}
            title="Share a photo, video, or file with JARVIS"
            disabled={uploadState === 'uploading'}
            data-testid="cosmos-upload"
            className={[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors',
              uploadState === 'done'
                ? 'border-[#2DD4A8]/60 bg-[#2DD4A8]/10 text-[#2DD4A8]'
                : uploadState === 'error'
                  ? 'border-red-400/50 bg-red-400/10 text-red-400'
                  : uploadState === 'uploading'
                    ? 'animate-pulse border-[#5eead4]/40 bg-[#5eead4]/10 text-[#7fe3d8]'
                    : 'border-white/20 bg-white/5 text-[#EDE8DF]/50 hover:bg-white/10 hover:text-[#EDE8DF]/80',
            ].join(' ')}
          >
            {uploadState === 'uploading' ? (
              // Spinner-ish — simple animated dot
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" strokeOpacity="0.3" />
                <path d="M12 3a9 9 0 0 1 9 9" />
              </svg>
            ) : uploadState === 'done' ? (
              // Checkmark
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              // Paperclip
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            )}
          </button>
          {/* === END MOD #47 === */}

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
                : 'border-[#5eead4]/40 bg-[#5eead4]/10 text-[#7fe3d8] hover:bg-[#5eead4]/20',
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
        <MicDebugLine status={micStatus} engine={ENGINE} />
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
            className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-[#EDE8DF] placeholder:text-[#EDE8DF]/30 focus:border-[#5eead4]/60 focus:outline-none"
          />
          <button
            onClick={handleSynthSend}
            data-testid="synth-send"
            className="rounded-lg border border-[#2dd4bf]/45 bg-[#2dd4bf]/15 px-3 py-1.5 text-sm text-[#9df0e3] hover:bg-[#2dd4bf]/25"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
// === END JARVIS MOD #20 ===

// === JARVIS MOD #104 — pending-lookup chip ==================================
// One dim, left-aligned line per outstanding ask_jarvis question: what's being
// chased and for how long. Ticks once a second (local state — the ledger array
// itself only changes on dispatch/resolve/escalate). Escalated = the "genuinely
// stuck" line has been spoken; the chip dims further rather than nagging.
function PendingChip({ question, ts, escalated }: { question: string; ts: number; escalated: boolean }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.round((Date.now() - ts) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - ts) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [ts]);
  const short = question.length > 60 ? `${question.slice(0, 57)}…` : question;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const clock = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
  return (
    <div className="text-left text-xs" data-testid="cosmos-pending">
      <span
        className={[
          'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5',
          escalated
            ? 'border-amber-300/25 bg-amber-300/5 text-amber-200/50'
            : 'border-white/10 bg-white/5 text-[#EDE8DF]/55',
        ].join(' ')}
      >
        <span className="cosmos-dot-pulse inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
        <span className="italic">still chasing: {short}</span>
        <span className="tabular-nums opacity-70">· {clock}</span>
      </span>
    </div>
  );
}
// === END MOD #104 ===

// === JARVIS MOD #39 — on-phone mic diagnostics (2026-07-08) ===
// Polls window.__cosmosStats (the existing seam) at 2Hz and renders one dim
// line: mic on/off · audio-context state · live VAD energy vs threshold ·
// last wake-gate decision. MOD #31's rule generalized: every silent failure
// mode of the audio pipeline must be readable off the phone screen.
// === JARVIS MOD #60: takes the SAME derived status object the mic button and
// the status dot render from, so the debug line can no longer contradict the
// control next to it. "mic" now means capture state (hot/armed/off) and the
// wake-word toggle is reported separately as `wake`. ===
// === JARVIS MOD #107: engine-aware. The line reported micCtxState / vadEnergy /
// wakeGate — every one of which is written ONLY by the legacy open-mic engine.
// On the Realtime lanes (the ones that actually run) it therefore printed a row
// of em-dashes forever, which reads exactly like a dead pipeline and told you
// nothing about the pipeline that was really running. Each lane now reports its
// own vitals: WebRTC connection state, data-channel state, shared-AudioContext
// state, and the last error — the four things that distinguish "connecting",
// "connected but muted", and "dead" on a phone with no console.
interface MicStatus {
  listening: boolean;
  hot: boolean;
  armed: boolean;
  openMic: boolean;
}

function MicDebugLine({ status, engine }: { status: MicStatus; engine: VoiceEngine }) {
  const { hot, armed, openMic } = status;
  const [line, setLine] = useState('');
  useEffect(() => {
    const read = () => {
      const s = (window as unknown as {
        __cosmosStats?: {
          micCtxState?: string;
          ctxState?: string;
          vadEnergy?: number;
          openMicError?: string | null;
          wakeGate?: { lastDecision?: string; lastUtterance?: string };
          rtcState?: string;
          dcState?: string;
          iceState?: string;
          rtcError?: string | null;
          reconnects?: number;
          ttsPath?: string | null;
          textIdlessDrops?: number;
        };
      }).__cosmosStats;
      const mic = hot ? 'hot' : armed ? 'armed' : 'off';
      // MOD #39d / #107: build stamp — "does the gray line say v107?" instantly
      // answers whether the installed PWA pulled fresh JS (iOS staleness lore).
      // BUMPED with this mod on purpose: an unchanged stamp is how a stale PWA
      // masquerades as a working one.
      const head = `v107 · ${engine} · mic ${mic} · wake ${openMic ? 'on' : 'off'}`;

      if (engine === 'legacy') {
        const ctxState = s?.micCtxState ?? '—';
        const vad = s?.vadEnergy !== undefined ? s.vadEnergy.toFixed(3) : '—';
        const err = s?.openMicError ? ` · ERR ${s.openMicError}` : '';
        const gate = s?.wakeGate?.lastDecision
          ? ` · ${s.wakeGate.lastDecision}: “${(s.wakeGate.lastUtterance ?? '').slice(0, 32)}”`
          : '';
        setLine(`${head} · audio ${ctxState} · vad ${vad}${err}${gate}`);
        return;
      }

      const rtc = s?.rtcState ?? '—';
      const dc = s?.dcState ?? '—';
      const ice = s?.iceState ?? '—';
      const ctx = s?.ctxState ?? s?.micCtxState ?? '—';
      const rec = s?.reconnects ? ` · retry ${s.reconnects}` : '';
      const tts = engine === 'realtime-el' ? ` · tts ${s?.ttsPath ?? '—'}` : '';
      const err = s?.rtcError ? ` · ERR ${String(s.rtcError).slice(0, 48)}` : '';
      // MOD #107 ROUND 4: the TextLane id requirement's failure mode. If OpenAI
      // ever stops stamping response_id on text events the lane goes SILENT —
      // and a silent JARVIS that looks healthy is the exact failure this line
      // was written to kill. A non-zero count here is the tell.
      const idless = s?.textIdlessDrops ? ` · idless-drop ${s.textIdlessDrops}` : '';
      setLine(`${head} · rtc ${rtc} · dc ${dc} · ice ${ice} · audio ${ctx}${tts}${rec}${idless}${err}`);
    };
    read();
    const t = setInterval(read, 500);
    return () => clearInterval(t);
  }, [hot, armed, openMic, engine]);
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
