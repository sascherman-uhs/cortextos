'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  ConversationEntry,
  PendingLookup,
  TtsBridge,
  VoiceState,
  UseVoiceResult,
} from './use-voice';
// === JARVIS MOD #53 — shared deterministic goodbye detector (see
// src/lib/voice/signoff.ts). The fast path has had this since MOD #36; the
// Realtime path was answering "thanks" with a full model turn. ===
import { isSignoff, signoffLine } from '@/lib/voice/signoff';
// === JARVIS MOD #54 — per-turn latency instrumentation ===
import { TurnClock } from '@/lib/voice/latency';
// === JARVIS MOD #64 — per-turn tonal checkpoint for the Realtime lane ===
import {
  buildTonalCueEvents,
  JARVIS_TONAL_CUE_ITEM_PREFIX,
} from '@/lib/realtime/jarvis-prompt';
// === JARVIS MOD #100 — same barge-in bookkeeping the legacy lane uses
// (MOD #85). The HTTP fallback and (MOD #107) the tool round-trip both need it. ===
import { TurnGuard } from './turn-guard';
// === JARVIS MOD #107 — the response.create race guard, extracted + tested ===
import { ResponseGate } from './response-gate';
// === JARVIS MOD #107 — never a private AudioContext again (MOD #39 lesson):
// one born without a gesture reads all-zeros forever on iOS. ===
import {
  getSharedAudioContext,
  resumeSharedAudio,
  registerMediaElement,
  primeMediaElement,
  silentMediaSource,
} from './audio-unlock';
// === JARVIS MOD #107 ROUND 2 — the Daniel lane's streaming accumulator, with a
// barge-in generation. Pure + unit-tested (text-lane.ts / text-lane.test.ts);
// round 1 kept this state in loose refs inside the data-channel switch, which is
// exactly why its missing staleness guard was untestable and shipped. ===
import { TextLane } from './text-lane';
// === JARVIS MOD #107 ROUND 3 — deterministic suppression of the tool answer's
// SSE echo. Round 2 raced the log write and lost ~25% of the time. ===
import { ToolReplyReconciler } from './tool-reply-reconciler';
// === MOD #107 ROUND 3 — one agent constant across history / stream / send. ===
import { resolveVoiceAgent } from './voice-agent';

// GA WebRTC calls endpoint (2026): no model query param — the model is
// already baked into the ephemeral client secret minted server-side.
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const OPEN_MIC_KEY = 'cosmos-realtime-open-mic';

// === JARVIS MOD #107 — engine selection =====================================
// 'realtime'    — OpenAI speaks over the WebRTC audio track (the MOD #50 lane).
// 'realtime-el' — the session is minted text-only (output_modalities:['text'],
//                 verified against the GA API 2026-08-09) and the reply text is
//                 streamed sentence-by-sentence into the ElevenLabs "Daniel"
//                 pipeline that use-tts already owns. Same brain, JARVIS' voice.
export type RealtimeEngine = 'realtime' | 'realtime-el';
/** The full 3-way selector, including the pre-MOD-#50 browser-STT lane. */
export type VoiceEngine = 'legacy' | RealtimeEngine;

export interface RealtimeVoiceOptions {
  /**
   * MOD #107, PHASE −1 — the dual-engine mic fix. voice-panel mounts BOTH this
   * hook and useVoice (rules of hooks: neither can be called conditionally), and
   * before this flag BOTH opened getUserMedia and BOTH ran a conversation. The
   * legacy lane's handleUtterance POSTed its own `[Cosmos]` turns to
   * /api/messages/send, doubling agent traffic; and on iOS two concurrent
   * captures of the same device means one of them gets silently muted, picked
   * nondeterministically by the OS. When `enabled` is false every effect,
   * engine start and send inside this hook is a no-op — the hook is mounted but
   * inert.
   */
  enabled?: boolean;
  engine?: RealtimeEngine;
}

// === MOD #107 — reconnect backoff. iOS kills WebRTC on screen lock and proxies
// drop long-lived peer connections; before this the session simply died and the
// only recovery was toggling the mic off and on. ===
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** ICE 'disconnected' often self-heals; only escalate to a full restart after this. */
const ICE_RECOVERY_GRACE_MS = 5_000;
/** Public STUN so a peer behind symmetric NAT can still gather a reflexive candidate. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
/**
 * MOD #107 — a late reply is only ever the answer to a lookup that OUTLIVED the
 * 35s tool budget (anything faster resolves its ledger entry synchronously, in
 * the tool handler). So a ledger entry younger than this cannot be the one an
 * inbound line is answering, and consuming it would put an unrelated Telegram
 * message in JARVIS' mouth as though it were the answer.
 */
const MIN_LATE_REPLY_AGE_MS = 2_000;

function mergeStats(patch: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.__cosmosStats = { ...(window.__cosmosStats ?? {}), ...patch } as Window['__cosmosStats'];
}

export function useRealtimeVoice(options: RealtimeVoiceOptions = {}): UseVoiceResult {
  const enabled = options.enabled ?? true;
  const engine: RealtimeEngine = options.engine ?? 'realtime';

  const [state, setState] = useState<VoiceState>('dormant');
  const [supported, setSupported] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [interim, setInterim] = useState('');
  const [log, setLog] = useState<ConversationEntry[]>([]);
  const [openMic, setOpenMic] = useState(false);

  const openMicRef = useRef(false);
  const sentTurnsRef = useRef(0);
  const fastReplyIdsRef = useRef<Set<string>>(new Set());
  const ttsBridgeRef = useRef<TtsBridge | null>(null);
  const sessionStartingRef = useRef(false);

  // === MOD #107 — latest-value mirrors for the data-channel callbacks, which
  // are bound once per session and would otherwise close over the mount-time
  // values. Synced in an effect declared BEFORE the session effect so ordering
  // is deterministic under StrictMode's double-invoke. ===
  const enabledRef = useRef(enabled);
  const engineRef = useRef<RealtimeEngine>(engine);
  useEffect(() => {
    enabledRef.current = enabled;
    engineRef.current = engine;
  }, [enabled, engine]);

  // === JARVIS MOD #100 — guard for the HTTP fallback reply ====================
  const replyGuardRef = useRef<TurnGuard | null>(null);
  if (!replyGuardRef.current) replyGuardRef.current = new TurnGuard();
  const replyGuard = replyGuardRef.current;
  // === END MOD #100 ===

  // === JARVIS MOD #107 — tool-call guard (critics' Phase 2h) ==================
  // The tool fetch had NO AbortController and no generation check, so the stop
  // button could not stop a 35s ask_jarvis: the fetch ran to completion and then
  // pushed a function_call_output and a response.create into a conversation the
  // user had already abandoned — JARVIS narrating the answer to a cancelled
  // question. Every dispatch batch now stamps a generation; interruptReply() and
  // stopSession() supersede it, which both aborts the fetches and makes the
  // resume points inert (AbortController cannot un-resolve an already-resolved
  // promise — that is why isCurrent() is checked again after the await).
  const toolGuardRef = useRef<TurnGuard | null>(null);
  if (!toolGuardRef.current) toolGuardRef.current = new TurnGuard();
  const toolGuard = toolGuardRef.current;
  // === END MOD #107 ===

  // === JARVIS MOD #51 fix / MOD #107 — response.create race guard.
  // The two loose refs are now one ResponseGate (see response-gate.ts): same
  // rule, but `clear()` is a named operation, so the error path and the stop
  // path can no longer forget half of it and mute JARVIS permanently. ===
  const gateRef = useRef<ResponseGate | null>(null);
  if (!gateRef.current) gateRef.current = new ResponseGate();
  const gate = gateRef.current;

  // === JARVIS MOD #53 — goodbye state. ===
  const hadAgentTurnRef = useRef(false);
  const signoffIdxRef = useRef(0);

  // === JARVIS MOD #104 — pending-lookup ledger =================================
  const pendingRef = useRef<PendingLookup[]>([]);
  const [pendingLookups, setPendingLookups] = useState<PendingLookup[]>([]);
  const syncPending = useCallback(() => {
    setPendingLookups([...pendingRef.current]);
  }, []);
  const addPending = useCallback((id: string, question: string) => {
    pendingRef.current.push({ id, question, ts: Date.now(), escalated: false });
    syncPending();
  }, [syncPending]);
  const resolvePending = useCallback((id: string) => {
    pendingRef.current = pendingRef.current.filter((p) => p.id !== id);
    syncPending();
  }, [syncPending]);
  const clearPending = useCallback(() => {
    pendingRef.current = [];
    setPendingLookups([]);
  }, []);
  // === END MOD #104 ===

  // === JARVIS MOD #54 — one clock per turn (see src/lib/voice/latency.ts). ===
  const turnClockRef = useRef(new TurnClock());
  const turnToolRef = useRef<string | undefined>(undefined);

  // WebRTC refs
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // Amplitude refs — MOD #107: the context is the SHARED one, never closed.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ampSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animFrameRef = useRef<number>(0);

  // === MOD #107 — reconnect bookkeeping ===
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const iceRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startSessionRef = useRef<() => Promise<void>>(async () => {});
  const scheduleReconnectRef = useRef<(reason: string) => void>(() => {});

  // === MOD #107 ROUND 2 — the Daniel (text) lane. All the accumulator state and
  // the barge-in generation now live in the TextLane object; only the TTS stream
  // handle (a React-lifetime thing) stays here. ===
  const laneRef = useRef<TextLane | null>(null);
  if (!laneRef.current) laneRef.current = new TextLane();
  const lane = laneRef.current;
  const streamHandleRef = useRef<{ push: (s: string) => void; end: () => void } | null>(null);
  const replyIdRef = useRef<string | null>(null);

  // === MOD #107 ROUND 3 — tool-reply reconciliation (see tool-reply-reconciler.ts) ===
  const reconcilerRef = useRef<ToolReplyReconciler | null>(null);
  if (!reconcilerRef.current) reconcilerRef.current = new ToolReplyReconciler();
  const reconciler = reconcilerRef.current;
  // Late-bound so the tool continuation (bound once per session, inside the data
  // channel handler) always reaches the CURRENT delivery implementation.
  const deliverOutboundRef = useRef<(id: string, text: string) => void>(() => {});

  const requestResponse = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    if (!gate.request()) return; // deferred — response.done will fire it
    dc.send(JSON.stringify({ type: 'response.create' }));
  }, [gate]);

  // === JARVIS MOD #64 — per-turn tonal checkpoint (positional recency) ======
  const cueItemIdRef = useRef<string | null>(null);
  const cueSeqRef = useRef(0);
  const refreshTonalCue = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    cueSeqRef.current += 1;
    const nextId = `${JARVIS_TONAL_CUE_ITEM_PREFIX}${cueSeqRef.current}`;
    for (const evt of buildTonalCueEvents(nextId, cueItemIdRef.current)) {
      dc.send(JSON.stringify(evt));
    }
    cueItemIdRef.current = nextId;
  }, []);
  // === END MOD #64 ===

  // Check for getUserMedia support on mount
  useEffect(() => {
    const sup = typeof navigator.mediaDevices?.getUserMedia === 'function';
    setSupported(sup);
    if (!sup && enabled) {
      mergeStats({ voicePath: engine, rtcState: 'unsupported' });
    }
  }, [enabled, engine]);

  // Hydrate open-mic preference from localStorage
  useEffect(() => {
    if (!supported || !enabled) return;
    const stored = localStorage.getItem(OPEN_MIC_KEY);
    const on = stored === null ? true : stored === '1';
    setOpenMic(on);
  }, [supported, enabled]);

  const stopAmplitude = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    try {
      ampSourceRef.current?.disconnect();
    } catch {
      /* already disconnected */
    }
    ampSourceRef.current = null;
    analyserRef.current = null;
    // === MOD #107: do NOT close() the context. It is the SHARED, gesture-
    // unlocked one (audio-unlock.ts). Closing it is unrecoverable — every later
    // TTS segment and every VAD analyser on the page reads silence forever,
    // which is the MOD #39 regression in a different costume. ===
    setAmplitude(0);
  }, []);

  const startAmplitude = useCallback((stream: MediaStream) => {
    try {
      const ctx = getSharedAudioContext();
      if (!ctx) return;
      resumeSharedAudio();
      mergeStats({ ctxState: ctx.state });
      const source = ctx.createMediaStreamSource(stream);
      ampSourceRef.current = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = Math.min(1, sum / data.length / 255);
        setAmplitude(avg);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Amplitude is cosmetic — non-fatal
    }
  }, []);

  const pushAgentReply = useCallback((text: string, id: string) => {
    if (!text.trim()) return;
    // MOD #53: the detector only ends a conversation JARVIS was part of.
    hadAgentTurnRef.current = true;
    setLog((prev) => {
      if (prev.some((e) => e.id === id)) return prev;
      return [...prev, { id, role: 'agent', text, ts: Date.now() }];
    });
    setState('wakeListening');
  }, []);

  /**
   * MOD #107 ROUND 2: abandon the Daniel lane's in-progress reply AND advance
   * its generation, so every still-in-flight delta of the cancelled response is
   * discarded rather than mistaken for the start of a new one.
   *
   * Round 1 nulled `streamHandleRef` and nothing else. A null handle is
   * ambiguous — "nothing started yet" vs "started, then killed" — and the delta
   * handler read it as the former, so it called beginStreamReply() again and
   * JARVIS resumed the answer the user had just talked over. TextLane.interrupt()
   * removes the ambiguity; the handle nulling here is now only bookkeeping.
   */
  const resetTextLane = useCallback(() => {
    lane.interrupt();
    streamHandleRef.current = null;
    replyIdRef.current = null;
  }, [lane]);

  const stopSession = useCallback(() => {
    sessionStartingRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (iceRecoveryTimerRef.current) {
      clearTimeout(iceRecoveryTimerRef.current);
      iceRecoveryTimerRef.current = null;
    }

    // MOD #107: supersede any in-flight tool round-trip so its continuation
    // cannot post a function_call_output into a conversation that no longer
    // exists (and so its fetch is actually aborted, not merely ignored).
    toolGuard.begin();

    const dc = dcRef.current;
    if (dc) {
      dc.onmessage = null;
      dc.onopen = null;
      dc.onclose = null;
      dc.onerror = null;
      dc.close();
    }
    dcRef.current = null;

    if (pcRef.current) {
      mergeStats({ voicePath: engineRef.current, rtcState: pcRef.current.connectionState });
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.ontrack = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    micStreamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    micStreamRef.current = null;

    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.pause();
    }

    stopAmplitude();
    setInterim('');
    setAmplitude(0);
    gate.clear();
    // MOD #64: the conversation dies with the session — forget the cue item so
    // the next session never tries to delete an id the server doesn't know.
    cueItemIdRef.current = null;
    // === MOD #107 (critics' 3e): every piece of per-conversation state resets
    // together. Leaving these behind meant a reconnected session inherited the
    // previous one's goodbye latch (`hadAgentTurn` true → the first thing said
    // in the NEW session could be swallowed as a sign-off), its sign-off
    // rotation, its sent-turn count (which gates late replies), its fast-reply
    // id set, and its cue sequence. ===
    cueSeqRef.current = 0;
    hadAgentTurnRef.current = false;
    signoffIdxRef.current = 0;
    sentTurnsRef.current = 0;
    fastReplyIdsRef.current = new Set();
    resetTextLane();
    // MOD #107 ROUND 4: surface anything held rather than dropping it — see
    // interruptReply. A session ending is not a reason to eat a business alert.
    for (const r of reconciler.reset()) deliverOutboundRef.current(r.id, r.text);
    // MOD #104: pending lookups die with the session too.
    clearPending();
    mergeStats({ dcState: 'closed' });
  }, [stopAmplitude, gate, toolGuard, clearPending, resetTextLane, reconciler]);

  // === MOD #107 — classified, retryable session failure ======================
  // The old catch set state 'dormant' unconditionally. 'dormant' is the label
  // for "mic off" — so a transient token 500, a dropped Wi-Fi, or a permission
  // prompt the user dismissed all rendered as a deliberately disabled mic, with
  // no retry and nothing on screen saying why. Now: mic-permission denial is
  // terminal-but-visible-and-retryable (re-prompting on a timer would be
  // hostile), and everything else backs off and reconnects on its own.
  const failSession = useCallback(
    (reason: string, opts: { retryable: boolean; spoken?: string }) => {
      mergeStats({ voicePath: engineRef.current, rtcState: 'failed', rtcError: reason });
      setState('error');
      if (opts.spoken) ttsBridgeRef.current?.speakLocal(opts.spoken);
      if (opts.retryable) scheduleReconnectRef.current(reason);
    },
    [],
  );

  const startSession = useCallback(async () => {
    if (!enabledRef.current) return;
    if (sessionStartingRef.current || pcRef.current) return;
    sessionStartingRef.current = true;
    setState('processing');

    // bail() is called after each await to abort gracefully if openMic was
    // toggled off (or stopSession called, or the lane disabled) while in flight.
    const bail = (): boolean =>
      !openMicRef.current || !sessionStartingRef.current || !enabledRef.current;

    const activeEngine = engineRef.current;

    try {
      // Step 1: Get ephemeral token. MOD #107: the engine goes with it — the
      // Daniel lane needs a text-only session (output_modalities:['text']).
      const tokenRes = await fetch('/api/uhs/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: activeEngine }),
      });
      if (bail()) { sessionStartingRef.current = false; return; }
      if (!tokenRes.ok) throw new Error(`token-fetch-${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token: string; expires_at?: string };
      if (bail()) { sessionStartingRef.current = false; return; }

      // Step 2: Create RTCPeerConnection (MOD #107: with a STUN server —
      // without one, a peer that cannot gather a server-reflexive candidate
      // never connects at all on some mobile networks).
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        mergeStats({ voicePath: activeEngine, rtcState: pc.connectionState });
        if (pcRef.current !== pc) return; // superseded
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed'
        ) {
          scheduleReconnectRef.current(`rtc-${pc.connectionState}`);
        } else if (pc.connectionState === 'connected') {
          reconnectAttemptsRef.current = 0;
        }
      };

      // MOD #107: ICE 'disconnected' is usually a blip. Try an in-place ICE
      // restart first and only escalate to a full re-mint if it doesn't heal.
      // Honest limitation: the GA /realtime/calls endpoint is a ONE-SHOT SDP
      // exchange with no renegotiation channel, so restartIce() can only recover
      // using candidates already gathered — the grace timer is what actually
      // saves the session in the common case.
      pc.oniceconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        mergeStats({ iceState: pc.iceConnectionState });
        if (pc.iceConnectionState === 'disconnected') {
          try {
            pc.restartIce();
          } catch {
            /* not supported — the grace timer still covers us */
          }
          if (!iceRecoveryTimerRef.current) {
            iceRecoveryTimerRef.current = setTimeout(() => {
              iceRecoveryTimerRef.current = null;
              if (pcRef.current !== pc) return;
              if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
                scheduleReconnectRef.current('ice-disconnected');
              }
            }, ICE_RECOVERY_GRACE_MS);
          }
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          if (iceRecoveryTimerRef.current) {
            clearTimeout(iceRecoveryTimerRef.current);
            iceRecoveryTimerRef.current = null;
          }
        }
      };

      // Step 3: Get mic stream
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (micErr) {
        const name = (micErr as { name?: string })?.name ?? 'MicError';
        // A denied/dismissed permission must NOT auto-retry — re-prompting on a
        // timer is hostile and iOS suppresses repeat prompts anyway. It gets
        // spoken + visible messaging and a manual retry affordance instead.
        const denied = name === 'NotAllowedError' || name === 'SecurityError';
        sessionStartingRef.current = false;
        stopSession();
        failSession(`mic-${name}`, {
          retryable: !denied,
          spoken: denied
            ? 'I cannot hear you, sir — microphone access is blocked. Allow it in your browser settings, then tap the mic.'
            : undefined,
        });
        return;
      }
      if (bail()) {
        stream.getTracks().forEach((t) => t.stop());
        sessionStartingRef.current = false;
        return;
      }
      micStreamRef.current = stream;

      // MOD #107: the OS can revoke the track (device switch, another app taking
      // the mic, iOS interruption). Before this, the session stayed "up" with a
      // dead microphone — indistinguishable from JARVIS ignoring you.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (micStreamRef.current !== stream) return;
          scheduleReconnectRef.current('mic-track-ended');
        };
      });

      // Step 4: Add audio track
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // Step 5: Create data channel
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      // Step 6: Data channel message handler
      dc.onmessage = (e: MessageEvent<string>) => {
        let msg: {
          type?: string;
          delta?: string;
          transcript?: string;
          text?: string;
          // MOD #107 ROUND 2: GA text/lifecycle events carry the id of the
          // response they belong to. It is the only way to tell a straggler from
          // a cancelled response apart from the live one.
          response_id?: string;
        };
        try {
          msg = JSON.parse(e.data) as typeof msg;
        } catch {
          return;
        }

        switch (msg.type) {
          // GA renamed these from response.audio_transcript.* (beta) to
          // response.output_audio_transcript.* — see developers.openai.com
          // /api/docs/guides/realtime-conversations.
          case 'response.output_audio_transcript.delta': {
            turnClockRef.current.firstAudio({ path: 'realtime', tool: turnToolRef.current });
            if (typeof msg.delta === 'string') {
              setInterim((prev) => prev + msg.delta);
            }
            break;
          }
          case 'output_audio_buffer.started': {
            turnClockRef.current.firstAudio({ path: 'realtime', tool: turnToolRef.current });
            break;
          }
          case 'response.output_audio_transcript.done': {
            const finalText = (msg as { transcript?: string }).transcript?.trim();
            if (finalText) {
              const id = `realtime-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              pushAgentReply(finalText, id);
            }
            setInterim('');
            setState('wakeListening');
            break;
          }

          // === JARVIS MOD #107 — THE DANIEL LANE ==============================
          // Text-only session (Phase 0 verified: output_modalities:['text'] is a
          // top-level session field on the GA API; the legacy `modalities` name
          // 400s). Deltas are fed through the SAME extractSentences the fast
          // path uses and pushed into use-tts's beginStreamReply — the streaming
          // ElevenLabs consumer that has been built and hardened since MOD #45
          // but was dead code on this lane (voice-panel's early return).
          // Mirrors use-voice.ts:575-596 exactly, including the 50-word cap and
          // markSpoken(replyId) before pushAgentReply.
          case 'response.output_text.delta': {
            if (typeof msg.delta !== 'string' || !msg.delta) break;
            // MOD #107 ROUND 2: TextLane returns [] for any event belonging to a
            // superseded generation or a different response, so a cancelled
            // reply can no longer open a fresh TTS turn on its way out.
            const sentences = lane.delta(msg.delta, msg.response_id);
            if (sentences.length === 0 && !lane.isLive(msg.response_id)) {
              // MOD #107 ROUND 4: publish the id-less drop count. The TextLane
              // id requirement trades "wrong text spoken" for "no text spoken"
              // if OpenAI ever stops stamping response_id — and an invisible
              // silence is exactly the failure shape the debug line exists to
              // kill. Surfacing it here is what makes that trade honest.
              mergeStats({ textIdlessDrops: lane.idlessDrops() });
              break;
            }
            setInterim(lane.fullText());
            for (const s of sentences) {
              if (!streamHandleRef.current) {
                streamHandleRef.current = ttsBridgeRef.current?.beginStreamReply?.() ?? null;
              }
              streamHandleRef.current?.push(s);
            }
            break;
          }
          case 'response.output_text.done': {
            // MOD #107 ROUND 2: null = this is the terminal event of a response
            // the user already talked over (or that a stop/error abandoned).
            // Round 1 pushed its partial text straight into the log, where the
            // log-speak effect said the whole abandoned reply out loud.
            const finished = lane.done(msg.text, msg.response_id);
            if (!finished) {
              mergeStats({ textIdlessDrops: lane.idlessDrops() }); // MOD #107 R4
              break;
            }
            if (finished.tail) {
              if (!streamHandleRef.current) {
                streamHandleRef.current = ttsBridgeRef.current?.beginStreamReply?.() ?? null;
              }
              streamHandleRef.current?.push(finished.tail);
            }
            streamHandleRef.current?.end();
            streamHandleRef.current = null;
            const id =
              replyIdRef.current ??
              `realtime-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            replyIdRef.current = null;
            setInterim('');
            if (finished.text) {
              // Already spoken incrementally — log it without letting
              // voice-panel's log effect speak it a second time.
              if (finished.streamed) ttsBridgeRef.current?.markSpoken?.(id);
              pushAgentReply(finished.text, id);
            } else {
              setState('wakeListening');
            }
            break;
          }
          // === END MOD #107 Daniel lane ======================================

          case 'response.created': {
            // Server VAD auto-creates responses too — track every response, not
            // just client-initiated ones, or the guard doesn't actually hold.
            // MOD #107 ROUND 2: record WHICH response, so a stale done cannot
            // close this one out from under it.
            const createdId =
              (msg as unknown as { response?: { id?: string } }).response?.id ?? null;
            gate.markActive(createdId);
            // Opening a response ends any previous one WITHOUT advancing the
            // barge-in generation (nothing was interrupted — the prior reply
            // simply finished or was already abandoned).
            lane.begin(createdId);
            streamHandleRef.current = null;
            replyIdRef.current = `realtime-agent-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 7)}`;
            break;
          }
          case 'input_audio_buffer.speech_started': {
            // === MOD #107 — barge-in on the Daniel lane. On the audio lane
            // OpenAI cuts its own speech server-side; on this lane the audio is
            // OURS, so we must cancel the generation AND stop the ElevenLabs
            // pipeline ourselves. Clearing BOTH gate flags is load-bearing:
            // cancelling without clearing leaves the guard believing a response
            // is in flight and it swallows the next one — permanent mute
            // (MOD #101's note, now enforced by ResponseGate.clear()).
            if (engineRef.current === 'realtime-el') {
              const channel = dcRef.current;
              if (channel?.readyState === 'open' && gate.isActive()) {
                channel.send(JSON.stringify({ type: 'response.cancel' }));
              }
              gate.clear();
              resetTextLane();
              ttsBridgeRef.current?.interrupt();
            }
            setState('listening');
            setInterim('');
            break;
          }
          case 'input_audio_buffer.speech_stopped': {
            // MOD #54: THE measurement origin — everything after this is wait.
            turnClockRef.current.stop();
            turnToolRef.current = undefined;
            // MOD #107: useTts measures first-audible against this same marker
            // (recordFirstAudible reads __cosmosStats.lastUserStopMs), and only
            // sendText ever wrote it — so on the Daniel lane every SPOKEN turn
            // reported no latency at all.
            mergeStats({ lastUserStopMs: performance.now() });
            setState('processing');
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            // GA shape is flat: { type, item_id, content_index, transcript }.
            const userText = (msg as { transcript?: string }).transcript?.trim() ?? '';
            if (userText) {
              turnClockRef.current.transcript();
              // === MOD #107 (critics' 3b) — a turn counts as SENT when a real
              // transcript arrives, not when speech merely stopped. MOD #104
              // incremented on speech_stopped, so a cough, a door, or the tail
              // of JARVIS' own audio opened the late-reply gate (reply-dedupe
              // rule 3 reads this counter) and unrelated outbound Telegram lines
              // started surfacing as replies in a conversation nobody had.
              sentTurnsRef.current += 1;
              const uid = `realtime-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              setLog((prev) => {
                if (prev.some((entry) => entry.text === userText && entry.role === 'user')) return prev;
                return [...prev, { id: uid, role: 'user', text: userText, ts: Date.now() }];
              });

              // === JARVIS MOD #53 — goodbye detection on the Realtime path ===
              if (isSignoff(userText, hadAgentTurnRef.current)) {
                const channel = dcRef.current;
                if (channel?.readyState === 'open' && gate.isActive()) {
                  channel.send(JSON.stringify({ type: 'response.cancel' }));
                }
                gate.clear();
                resetTextLane();
                const line = signoffLine(signoffIdxRef.current);
                signoffIdxRef.current += 1;
                ttsBridgeRef.current?.interrupt();
                ttsBridgeRef.current?.speakLocal(line);
                turnClockRef.current.firstAudio({ path: engineRef.current, signoff: true });
                setInterim('');
                setState('wakeListening');
                break;
              }
              // === END JARVIS MOD #53 ===
            }
            break;
          }
          case 'response.done': {
            const doneResponse = (msg as unknown as {
              response?: {
                id?: string;
                output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
              };
            }).response;
            const doneId = doneResponse?.id ?? msg.response_id ?? null;
            // === MOD #107 ROUND 2 (smaller defect a): a done from a response
            // this gate does not have open is a straggler — the terminal event
            // of something a barge-in cancelled, arriving AFTER the replacement
            // response was created. Round 1 let it call close(), which cleared
            // `active` for the genuinely in-flight response; the next create
            // then raced it into a server 400, and (because round 1 also made
            // the error handler speak) the user HEARD the race.
            if (!gate.owns(doneId)) {
              mergeStats({ rtcNote: `ignored stale response.done ${doneId ?? '(no id)'}` });
              break;
            }
            // === JARVIS MOD #51 — tool bridge: the model called a function. ===
            const output = doneResponse?.output;
            const calls = (output ?? []).filter((o) => o.type === 'function_call' && o.call_id && o.name);
            if (calls.length > 0) {
              // The response is closed but the TURN continues — do not consume
              // the deferred slot; the continuation below issues its own request.
              gate.closeForTool(doneId);
              turnToolRef.current = calls.map((c) => c.name).filter(Boolean).join('+');
              setState('responding');
              // === MOD #107 (Phase 2h): one generation per dispatch batch. ===
              const toolGen = toolGuard.begin();
              void (async () => {
                await Promise.all(
                  calls.map(async (call) => {
                    let result = 'The tool call could not be completed.';
                    // === MOD #104 — ledger entry BEFORE the fetch. ===
                    let ledgerId: string | null = null;
                    if (call.name === 'ask_jarvis' && call.call_id) {
                      let q = 'that lookup';
                      try {
                        const parsed = JSON.parse(call.arguments ?? '{}') as { question?: string };
                        if (parsed.question?.trim()) q = parsed.question.trim();
                      } catch { /* keep placeholder */ }
                      ledgerId = call.call_id;
                      addPending(ledgerId, q);
                    }
                    let stillPending = false;
                    // === MOD #107 ROUND 3: the dispatch is now IN FLIGHT, so any
                    // outbound line the SSE stream delivers from here on is held
                    // for reconciliation instead of being spoken immediately.
                    // Opened BEFORE the fetch, because the log write this races
                    // can land the instant the brain answers.
                    const isAskJarvis = call.name === 'ask_jarvis';
                    if (isAskJarvis) reconciler.beginDispatch();
                    let toolReplyId: string | undefined;
                    const ac = new AbortController();
                    // Refuses to fire at all for a superseded generation.
                    if (!toolGuard.track(toolGen, ac)) return;
                    try {
                      const res = await fetch('/api/uhs/realtime/tool', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: call.name, arguments: call.arguments ?? '{}' }),
                        signal: ac.signal,
                      });
                      if (res.ok) {
                        const payload = (await res.json()) as {
                          output?: string;
                          pending?: boolean;
                          replyId?: string;
                        };
                        if (payload.output) result = payload.output;
                        stillPending = payload.pending === true;
                        // === MOD #107 ROUND 2 (BLOCKER 1) — suppress the SSE
                        // echo of the answer we just consumed. The tool route
                        // finds its answer by tailing outbound-messages.jsonl,
                        // the SAME file the SSE stream tails — so this exact
                        // reply is ALSO about to arrive at voice-panel as an
                        // ordinary outbound line. Round 1 never learned its id,
                        // so the dedupe set (MOD #38 rule 2) could not contain
                        // it: the model spoke its paraphrase and then the
                        // log-speak effect spoke the raw Telegram text on top.
                        // Every tool-backed question was answered TWICE.
                        //
                        // Registered BEFORE the function_call_output goes out,
                        // because the SSE line can beat the model's reply.
                        if (payload.replyId) fastReplyIdsRef.current.add(payload.replyId);
                        toolReplyId = payload.replyId;
                      } else {
                        result = `The tool call failed with status ${res.status}.`;
                      }
                    } catch {
                      // Abort (stop pressed) or network failure — either way the
                      // isCurrent check below decides whether anything is said.
                    } finally {
                      toolGuard.release(ac);
                    }
                    // === MOD #107 ROUND 3: close this dispatch's reconciliation
                    // window. If the SSE stream beat the HTTP response, the
                    // tool's own answer is sitting in the buffer and is dropped
                    // here; anything else that arrived during the dispatch was
                    // never the tool's answer and is released now. Ordering
                    // between the two no longer changes the outcome.
                    if (isAskJarvis) {
                      const released = reconciler.resolveDispatch(toolReplyId);
                      if (toolGuard.isCurrent(toolGen)) {
                        for (const r of released) deliverOutboundRef.current(r.id, r.text);
                      }
                    }
                    // MOD #107: the await has resumed — the stop button may have
                    // landed while we were out. An aborted fetch cannot un-resolve
                    // itself, so THIS is the check that actually stops a 35s tool
                    // call from narrating a cancelled lookup.
                    if (!toolGuard.isCurrent(toolGen)) return;
                    if (ledgerId && !stillPending) resolvePending(ledgerId);
                    const channel = dcRef.current;
                    if (channel?.readyState === 'open') {
                      channel.send(
                        JSON.stringify({
                          type: 'conversation.item.create',
                          item: {
                            type: 'function_call_output',
                            call_id: call.call_id,
                            output: JSON.stringify({ result }),
                          },
                        }),
                      );
                    }
                  }),
                );
                if (!toolGuard.isCurrent(toolGen)) return;
                requestResponse();
              })();
              break;
            }
            // === END JARVIS MOD #51 ===

            // === JARVIS MOD #64 — move the tonal cue to the tail. ===
            refreshTonalCue();

            // A response finished with no pending tool calls — if a turn arrived
            // while we were busy, the gate hands the deferred create back here.
            if (gate.close(doneId)) {
              const dcNow = dcRef.current;
              // close() already re-armed the gate, so send directly rather than
              // going back through request() (which would defer against itself).
              if (dcNow?.readyState === 'open') {
                dcNow.send(JSON.stringify({ type: 'response.create' }));
              } else {
                gate.clear();
              }
              break;
            }
            setState((s) => (s === 'processing' || s === 'responding' ? 'wakeListening' : s));
            break;
          }
          case 'error': {
            // === MOD #107 (critics' 2f) — the silent-mute bug. The old handler
            // logged and set 'wakeListening', leaving the race guard believing a
            // response was still in flight: the server had abandoned it and
            // would NEVER send the matching response.done, so every later
            // response.create was swallowed and JARVIS was mute for the rest of
            // the session with nothing on screen to say so.
            const errObj = (msg as unknown as {
              error?: { code?: string; message?: string; response_id?: string };
              response_id?: string;
            });
            // response_cancel_not_active is a benign cancel-race: our response.cancel
            // arrived just after OpenAI finished the response. No gate or UI action needed.
            if (errObj.error?.code === 'response_cancel_not_active') {
              console.warn('[realtime] cancel-race (benign):', errObj.error.message);
              break;
            }
            console.error('[realtime] OpenAI error event', e.data);
            const detail = errObj.error?.message;
            const failedId = errObj.response_id ?? errObj.error?.response_id ?? null;
            mergeStats({ rtcError: `server: ${detail ?? 'unknown'}` });

            // === MOD #107 ROUND 2 (smaller defect b) — speak only for an error
            // that actually killed a turn the user is waiting on. Round 1 spoke
            // for ANY server error event, which turned invisible bookkeeping
            // noise (the cancel-race 400 that defect (a) now prevents, stray
            // validation errors on cue/bookkeeping items) into JARVIS
            // interrupting himself to apologise for nothing.
            //
            // Same test decides whether to touch the gate: clearing it for an
            // error that belongs to some OTHER response would recreate exactly
            // the race defect (a) fixes.
            const abortedLiveTurn = gate.isActive() && gate.owns(failedId);
            if (!abortedLiveTurn) {
              mergeStats({ rtcNote: `server error ignored (no live turn): ${detail ?? 'unknown'}` });
              break;
            }
            gate.clear();
            resetTextLane();
            // === MOD #107 ROUND 2 (smaller defect c) — supersede the tool
            // round-trip. Without this, an ask_jarvis continuation that was
            // already in flight when the turn died would still post its
            // function_call_output and fire a response.create into an abandoned
            // turn — the same class of bug the stop button's toolGuard.begin()
            // fixes, on a path that had been left out.
            toolGuard.begin();
            // MOD #107 ROUND 4: held lines survive the failed turn.
            for (const r of reconciler.reset()) deliverOutboundRef.current(r.id, r.text);
            setInterim('');
            ttsBridgeRef.current?.speakLocal(
              'Something went wrong on my end, sir. Say that again.',
            );
            setState('wakeListening');
            break;
          }
        }
      };

      dc.onopen = () => {
        mergeStats({ voicePath: activeEngine, rtcState: pc.connectionState, dcState: 'open' });
        reconnectAttemptsRef.current = 0;
        // MOD #64: seed the cue so turn 1 is governed by the same checkpoint.
        refreshTonalCue();
      };
      // MOD #107: the data channel is the conversation. Losing it while the
      // peer connection technically survives left a live-looking session that
      // could neither hear nor answer.
      dc.onclose = () => {
        mergeStats({ dcState: 'closed' });
        if (dcRef.current !== dc) return;
        scheduleReconnectRef.current('dc-close');
      };
      dc.onerror = () => {
        mergeStats({ dcState: 'error' });
        if (dcRef.current !== dc) return;
        scheduleReconnectRef.current('dc-error');
      };

      // Step 7: Set up remote audio. Under 'realtime-el' no remote track is
      // ever negotiated (text-only session), but the element is harmless and
      // the fallback engine needs it.
      pc.ontrack = (e: RTCTrackEvent) => {
        const el = audioElRef.current;
        if (!el || !e.streams[0]) return;
        el.srcObject = e.streams[0];
        // MOD #107: was `.catch(() => {})` — a rejected play() is EXACTLY the
        // iOS silent-PWA failure, and swallowing it is how it stayed invisible.
        el.play().catch((err: unknown) => {
          const name = (err as { name?: string })?.name ?? 'PlayError';
          mergeStats({ rtcError: `audio-play-${name}` });
          // One more shot through the gesture primer, then say so out loud.
          primeMediaElement(el);
          el.play().catch(() => {
            ttsBridgeRef.current?.speakLocal?.('Tap the mic once to unlock audio, sir.');
          });
        });
      };

      // Step 8-9: SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Step 10: POST SDP to OpenAI
      const sdpRes = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });
      if (!sdpRes.ok) throw new Error(`sdp-exchange-${sdpRes.status}`);
      const answerSdp = await sdpRes.text();
      if (bail()) { sessionStartingRef.current = false; return; }

      // Step 11: Set remote description
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // Start amplitude loop on the mic stream
      startAmplitude(stream);

      sessionStartingRef.current = false;
      reconnectAttemptsRef.current = 0;

      // Step 12: Transition to wakeListening
      setState('wakeListening');
      mergeStats({ voicePath: activeEngine, rtcState: pc.connectionState, rtcError: null });
    } catch (err) {
      console.error('[realtime] startSession failed', err);
      sessionStartingRef.current = false;
      stopSession();
      failSession(String(err), { retryable: true });
    }
  }, [
    pushAgentReply,
    startAmplitude,
    stopSession,
    refreshTonalCue,
    addPending,
    resolvePending,
    requestResponse,
    resetTextLane,
    failSession,
    gate,
    toolGuard,
    lane,
    reconciler,
  ]);

  // === MOD #107 — reconnect with exponential backoff ==========================
  // Held in refs because the connection callbacks are bound once per session and
  // must reach the CURRENT implementation, not the one captured at bind time.
  useEffect(() => {
    startSessionRef.current = startSession;
  }, [startSession]);

  const scheduleReconnect = useCallback(
    (reason: string) => {
      if (!enabledRef.current || !openMicRef.current) return;
      if (reconnectTimerRef.current) return; // one restart in flight is enough
      const attempt = reconnectAttemptsRef.current;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptsRef.current = attempt + 1;
      mergeStats({ rtcError: `reconnect(${reason}) in ${delay}ms`, reconnects: attempt + 1 });
      stopSession(); // clears reconnectTimerRef, so set the timer AFTER it
      setState('processing');
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!enabledRef.current || !openMicRef.current) return;
        void startSessionRef.current();
      }, delay);
    },
    [stopSession],
  );
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  // === MOD #107 — screen lock / app switch recovery ===========================
  // Mirrors use-voice.ts:1144-1153. iOS tears WebRTC down when a standalone PWA
  // is backgrounded; without this the voice engine was permanently dead after a
  // single screen lock and only a reload brought it back.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      resumeSharedAudio();
      if (!openMicRef.current) return;
      const pc = pcRef.current;
      const dc = dcRef.current;
      const healthy =
        !!pc &&
        (pc.connectionState === 'connected' || pc.connectionState === 'connecting' || pc.connectionState === 'new') &&
        !!dc &&
        (dc.readyState === 'open' || dc.readyState === 'connecting');
      if (!healthy && !sessionStartingRef.current && !reconnectTimerRef.current) {
        reconnectAttemptsRef.current = 0; // a fresh foreground deserves a fast try
        scheduleReconnectRef.current('visibility-resume');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled]);

  // === MOD #107 — the remote-audio element, created ONCE at mount ============
  // Was created lazily inside startSession, detached from the DOM, with no
  // playsInline and a swallowed play() rejection — three separate reasons for
  // silence on an iPhone. Now: in the DOM, playsInline (iOS refuses to play
  // audio from a detached/fullscreen-eligible element in a PWA), and registered
  // with the gesture primer so the FIRST tap anywhere on the page authorizes it.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    el.setAttribute('data-testid', 'cosmos-remote-audio');
    el.style.display = 'none';
    // A source to prime against — play() on a sourceless element rejects, and a
    // rejected prime teaches iOS nothing.
    el.src = silentMediaSource();
    document.body.appendChild(el);
    audioElRef.current = el;
    const unregister = registerMediaElement(el);
    return () => {
      unregister();
      el.srcObject = null;
      el.pause();
      el.remove();
      if (audioElRef.current === el) audioElRef.current = null;
    };
  }, []);

  const sendText = useCallback((text: string) => {
    if (!enabledRef.current) return; // PHASE −1: the disabled lane sends nothing
    const trimmed = text.trim();
    if (!trimmed) return;

    sentTurnsRef.current += 1;
    mergeStats({ lastUserStopMs: performance.now() });

    const id = `realtime-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setLog((prev) => [...prev, { id, role: 'user', text: trimmed, ts: Date.now() }]);
    setInterim('');

    const dc = dcRef.current;
    if (dc?.readyState === 'open') {
      dc.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: trimmed }],
          },
        }),
      );
      requestResponse();
      setState('processing');
    } else {
      // Data channel not ready — fall back to HTTP send path
      setState('processing');
      // === JARVIS MOD #100: abortable + generation-gated. ===
      const gen = replyGuard.begin();
      const ac = new AbortController();
      replyGuard.track(gen, ac);
      fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: resolveVoiceAgent(), text: `[Cosmos] ${trimmed}`, stream: false }),
        signal: ac.signal,
      })
        .then(async (r) => {
          if (!replyGuard.isCurrent(gen)) return;
          if (!r.ok) { setState('wakeListening'); return; }
          let payload: { fastpath?: boolean; replyText?: string; replyId?: string } = {};
          try { payload = (await r.json()) as typeof payload; } catch { /* ok */ }
          if (!replyGuard.isCurrent(gen)) return;
          if (payload.fastpath && payload.replyText && payload.replyId) {
            fastReplyIdsRef.current.add(payload.replyId);
            pushAgentReply(payload.replyText, payload.replyId);
          } else {
            setState('responding');
          }
        })
        // An AbortError here is the interrupt doing its job, not a failure.
        .catch(() => {
          if (!replyGuard.isCurrent(gen)) return;
          setState('wakeListening');
        })
        .finally(() => replyGuard.release(ac));
      // === END MOD #100 ===
    }
  }, [pushAgentReply, requestResponse, replyGuard]);

  // === JARVIS MOD #101 / #107 — interruptReply for the Realtime lane ==========
  // Contract matches use-voice's interruptReply: cancel the reply, leave clean
  // state, and DO NOT touch state (the caller pairs it with stopListening).
  const interruptReply = useCallback(() => {
    replyGuard.begin(); // aborts the HTTP fallback leg, if that is the one in flight
    // === MOD #107 (2h): supersede the tool round-trip too. Without this, the
    // stop button visibly stopped nothing during a 35s ask_jarvis — the fetch
    // ran on, posted its output, and JARVIS narrated the cancelled lookup.
    toolGuard.begin();

    const channel = dcRef.current;
    if (channel?.readyState === 'open' && gate.isActive()) {
      channel.send(JSON.stringify({ type: 'response.cancel' }));
    }
    // Clearing BOTH flags is the load-bearing part (MOD #101): a cancel without
    // a clear leaves the guard believing a response is in flight and it swallows
    // the NEXT response.create — permanent mute.
    gate.clear();
    resetTextLane();

    // === MOD #107 (critics' 3d): the ledger dies with the turn. Before this,
    // stop left the pending entries alive, so the 90s escalation timer fired
    // later and JARVIS narrated the progress of a lookup the user had already
    // cancelled — and a late reply could still be injected and spoken.
    clearPending();
    // === MOD #107 ROUND 4: a barge-in cancels the MODEL'S reply, not the
    // world. Lines the tool never claimed are ordinary inbound mail — an alert,
    // a briefing — and round 3 destroyed them here. Their ids are already in
    // voice-panel's `seen` set, so backfill could never bring them back: they
    // were lost permanently. Hand them to the normal delivery path instead.
    for (const r of reconciler.reset()) deliverOutboundRef.current(r.id, r.text);

    // Stale interim belongs to the abandoned turn.
    setInterim('');

    // Deliberately NO setState here, matching use-voice's interruptReply. The
    // transition is the CALLER's half of the contract (handleStopThinking pairs
    // this with stopListening()).
  }, [replyGuard, toolGuard, gate, clearPending, resetTextLane, reconciler]);

  // === JARVIS MOD #104 / #107 — late-answer delivery ==========================
  const deliverLateReply = useCallback((text: string, replyId?: string): boolean => {
    if (!enabledRef.current) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return false;
    const oldest = pendingRef.current[0];
    // === MOD #107 (critics' 3a) — refuse to guess. A reply with no matching
    // ledger entry is NOT ours: it is an ordinary outbound Telegram line (Scott
    // texting JARVIS from his phone, a scheduled briefing, an alert), and
    // speaking it as "the answer to your earlier question" is worse than not
    // speaking it at all. Returning false hands it back to the caller's plain
    // text path. The age floor covers the other direction: an entry only
    // survives the tool handler when the route reported pending:true, i.e. it
    // already burned the full 35s budget — so anything younger than a couple of
    // seconds cannot be what this line is answering.
    //
    // DEFERRED (server half): true correlation needs the reply to carry the
    // originating call_id back from /api/messages/send + fast-lanes, which is
    // builder-wiring's territory this round. Until then this lane is
    // deliberately conservative: an unmatched reply is never spoken.
    if (!oldest) return false;
    if (Date.now() - oldest.ts < MIN_LATE_REPLY_AGE_MS) return false;
    resolvePending(oldest.id);
    // === MOD #107 ROUND 2 (BLOCKER 1): this line is now OURS — the model is
    // about to speak it. Register it so a later backfill sweep (which reads the
    // same outbound log from the top) can never surface the raw text again on
    // top of the spoken paraphrase.
    if (replyId) fastReplyIdsRef.current.add(replyId);
    dc.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                `The earlier lookup — "${oldest.question}" — just completed. Result: ${trimmed}\n` +
                'Deliver this to Scott now: lead with the answer, tie it back to his question in a ' +
                'few words, keep it under two sentences. No apology, no mechanics, no metaphors ' +
                'about the wait.',
            },
          ],
        },
      }),
    );
    requestResponse();
    setState('responding');
    return true;
  }, [requestResponse, resolvePending]);

  // === MOD #107 ROUND 3 — the one delivery path for an outbound line ==========
  // Either the live conversation consumes it (JARVIS speaks the answer to a
  // lookup he owes) or it surfaces as an ordinary reply. Both the immediate
  // path and the reconciler's delayed release go through here, so the two can
  // never drift apart.
  const deliverOutbound = useCallback((id: string, text: string) => {
    if (!deliverLateReply(text, id)) pushAgentReply(text, id);
  }, [deliverLateReply, pushAgentReply]);
  useEffect(() => {
    deliverOutboundRef.current = deliverOutbound;
  }, [deliverOutbound]);

  /**
   * MOD #107 ROUND 3 — voice-panel offers every outbound line that survived the
   * dedupe gate. Returns TRUE when this lane has taken responsibility for it
   * (delivered, held for reconciliation, or deliberately dropped as the tool's
   * own echo); FALSE means the caller should fall back to its own path — which
   * is what the legacy lane, with no reconciler, always gets.
   */
  const offerOutboundReply = useCallback((id: string, text: string): boolean => {
    if (!enabledRef.current) return false;
    const outcome = reconciler.offer(id, text);
    if (outcome === 'dropped') {
      // The tool consumed this exact line and the model is already speaking it.
      mergeStats({ rtcNote: `suppressed tool-reply echo ${id}` });
      return true;
    }
    if (outcome === 'buffered') return true; // released by resolveDispatch/flush
    deliverOutbound(id, text);
    return true;
  }, [reconciler, deliverOutbound]);

  // Safety valve: a dispatch can run for 35s, and an UNRELATED alert must not be
  // silenced for that long. Anything held past the reconciliation window is
  // released regardless of what the tool is still doing.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      if (reconciler.pendingCount() === 0) return;
      for (const r of reconciler.flushExpired()) deliverOutboundRef.current(r.id, r.text);
    }, 500);
    return () => clearInterval(t);
  }, [enabled, reconciler]);

  // Escalation: one honest sentence per stuck lookup, ~90s in.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== 'open') return;
      const now = Date.now();
      for (const p of pendingRef.current) {
        if (p.escalated || now - p.ts < 90_000) continue;
        p.escalated = true;
        syncPending();
        dc.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text:
                    `The lookup "${p.question}" has now taken over ninety seconds and may be stuck. ` +
                    'Tell Scott plainly, in one dry sentence, that this one is genuinely slow and ' +
                    'you will speak up the moment it lands — no metaphor, no repeat of any earlier ' +
                    'stall line, and do not promise a time.',
                },
              ],
            },
          }),
        );
        requestResponse();
        break; // one escalation per tick keeps turns clean
      }
    }, 15_000);
    return () => clearInterval(t);
  }, [requestResponse, syncPending, enabled]);
  // === END MOD #104 ===========================================================

  // === MOD #107 (critics' 2l) — both listen controls are gated on a live data
  // channel. Claiming 'listening' with a dead channel is a lie the UI tells with
  // a gold pulsing ring: the mic looks hot, nothing is being captured, and the
  // user talks into a closed socket.
  const startListening = useCallback(() => {
    if (!enabledRef.current) return;
    if (dcRef.current?.readyState !== 'open') {
      mergeStats({ rtcError: 'startListening ignored — data channel not open' });
      // A dead channel while the mic is meant to be on IS the reconnect trigger.
      if (openMicRef.current) scheduleReconnectRef.current('start-listening-no-dc');
      return;
    }
    setState('listening');
  }, []);

  const stopListening = useCallback(() => {
    if (dcRef.current?.readyState === 'open') {
      setState('wakeListening');
      return;
    }
    // No live channel: 'processing' is what a reconnecting session already
    // shows, and 'dormant' is the honest answer when the mic is off. Neither is
    // 'wakeListening', which would claim a wake word will be heard.
    setState(openMicRef.current && enabledRef.current ? 'processing' : 'dormant');
  }, []);

  /** MOD #107: manual recovery from the 'error' state (mic permission fixed,
   *  network back). Exposed so the mic button can offer a retry instead of
   *  being a dead affordance. */
  const retry = useCallback(() => {
    if (!enabledRef.current) return;
    reconnectAttemptsRef.current = 0;
    stopSession();
    setState('processing');
    void startSessionRef.current();
  }, [stopSession]);

  const toggleOpenMic = useCallback(() => {
    // Set the ref immediately so startSession bail() guards fire synchronously.
    const next = !openMicRef.current;
    openMicRef.current = next;
    setOpenMic(next);
  }, []);

  const bindTts = useCallback((bridge: TtsBridge) => {
    ttsBridgeRef.current = bridge;
  }, []);

  // notifyTtsSpeaking is a no-op for Realtime — state driven by data channel events
  const notifyTtsSpeaking = useCallback((_speaking: boolean): void => {
    // no-op: state is driven by OpenAI data channel events, not local TTS
  }, []);

  // Sync openMicRef + persist + start/stop session
  useEffect(() => {
    // === PHASE −1: a disabled lane owns no microphone, full stop. ===
    if (!enabled) {
      stopSession();
      return;
    }
    openMicRef.current = openMic;
    localStorage.setItem(OPEN_MIC_KEY, openMic ? '1' : '0');
    mergeStats({ openMic, voicePath: engine });

    if (openMic && supported) {
      if (!pcRef.current && !sessionStartingRef.current && !reconnectTimerRef.current) {
        void startSession();
      }
    } else if (!openMic) {
      stopSession();
      setState((s) => (s !== 'dormant' ? 'dormant' : s));
    }
  }, [openMic, supported, startSession, stopSession, enabled, engine]);

  // === MOD #107: tell useTts which lane is measuring, so the durable latency
  // line says 'realtime-el' instead of mislabelling every Daniel turn 'fastpath'. ===
  useEffect(() => {
    if (!enabled) return;
    ttsBridgeRef.current?.setLatencyPath?.(engine);
  }, [enabled, engine, state]);

  // === MOD #107 — micless test seam for THIS lane. use-voice has owned
  // `__cosmosVoiceTest` since MOD #36, but under the Realtime engine the legacy
  // hook's log is not the one on screen, so a Playwright test driving that seam
  // was asserting against a hook nobody renders. Whichever lane is enabled owns
  // the seam; the other never assigns it. ===
  useEffect(() => {
    if (!enabled) return;
    window.__cosmosVoiceTest = {
      utterance: (text: string) => sendText(text),
      agentReply: (text: string) =>
        pushAgentReply(text, `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
    };
    return () => {
      delete window.__cosmosVoiceTest;
    };
  }, [enabled, sendText, pushAgentReply]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
      replyGuard.begin();
      toolGuard.begin();
    };
  }, [stopSession, replyGuard, toolGuard]);

  return {
    state,
    supported,
    amplitude,
    interim,
    log,
    startListening,
    stopListening,
    sendText,
    pushAgentReply,
    sentTurnsRef,
    openMic,
    toggleOpenMic,
    bindTts,
    notifyTtsSpeaking,
    interruptReply, // === MOD #101 ===
    fastReplyIdsRef,
    // === MOD #104: pending-lookup ledger + late-answer delivery ===
    pendingLookups,
    deliverLateReply,
    // === MOD #107 ===
    retry,
    // === MOD #107 ROUND 3 ===
    offerOutboundReply,
  };
}
