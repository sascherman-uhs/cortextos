'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  ConversationEntry,
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

// GA WebRTC calls endpoint (2026): no model query param — the model is
// already baked into the ephemeral client secret minted server-side.
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const OPEN_MIC_KEY = 'cosmos-realtime-open-mic';

function mergeStats(patch: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.__cosmosStats = { ...(window.__cosmosStats ?? {}), ...patch } as Window['__cosmosStats'];
}

export function useRealtimeVoice(): UseVoiceResult {
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

  // === JARVIS MOD #51 fix — response.create race guard. OpenAI rejects a
  // response.create sent while a prior response is still in flight
  // ("conversation_already_has_active_response"). This happened when a tool
  // call's continuation raced another response (e.g. a second tool call in
  // the same turn, or a user turn arriving mid tool-call). requestResponse()
  // is now the ONLY way response.create gets sent: it sends immediately if
  // idle, otherwise defers one pending request until response.done clears
  // the active flag. ===
  const activeResponseRef = useRef(false);
  const pendingResponseCreateRef = useRef(false);

  // === JARVIS MOD #53 — goodbye state. `hadAgentTurn` gates the detector so
  // the very first thing said is never swallowed; `signoffIdx` rotates the
  // canned lines so a wind-down isn't the same words every time. ===
  const hadAgentTurnRef = useRef(false);
  const signoffIdxRef = useRef(0);
  // === JARVIS MOD #54 — one clock per turn (see src/lib/voice/latency.ts). ===
  const turnClockRef = useRef(new TurnClock());
  const turnToolRef = useRef<string | undefined>(undefined);
  const requestResponse = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    if (activeResponseRef.current) {
      pendingResponseCreateRef.current = true;
      return;
    }
    activeResponseRef.current = true;
    dc.send(JSON.stringify({ type: 'response.create' }));
  }, []);
  // === END MOD #51 fix ===

  // === JARVIS MOD #64 — per-turn tonal checkpoint (positional recency) ======
  // Session instructions are read once at mint time, so personality decays with
  // depth. After every assistant turn closes we delete the previous cue item
  // and append a fresh one at the tail: exactly one cue is ever live, and it
  // sits one item behind the next user utterance instead of turn-1 deep.
  // Rationale + API-support notes live in src/lib/realtime/jarvis-prompt.ts.
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

  // WebRTC refs
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // Amplitude refs
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ampSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animFrameRef = useRef<number>(0);

  // Check for getUserMedia support on mount
  useEffect(() => {
    const sup = typeof navigator.mediaDevices?.getUserMedia === 'function';
    setSupported(sup);
    if (!sup) {
      mergeStats({ voicePath: 'realtime', rtcState: 'unsupported' });
    }
  }, []);

  // Hydrate open-mic preference from localStorage
  useEffect(() => {
    if (!supported) return;
    const stored = localStorage.getItem(OPEN_MIC_KEY);
    const on = stored === null ? true : stored === '1';
    setOpenMic(on);
  }, [supported]);

  const stopAmplitude = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    ampSourceRef.current?.disconnect();
    ampSourceRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    setAmplitude(0);
  }, []);

  const startAmplitude = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
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

  const stopSession = useCallback(() => {
    sessionStartingRef.current = false;
    cancelAnimationFrame(animFrameRef.current);

    dcRef.current?.close();
    dcRef.current = null;

    if (pcRef.current) {
      mergeStats({ voicePath: 'realtime', rtcState: pcRef.current.connectionState });
      pcRef.current.close();
      pcRef.current = null;
    }

    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;

    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.pause();
    }

    stopAmplitude();
    setInterim('');
    setAmplitude(0);
    activeResponseRef.current = false;
    pendingResponseCreateRef.current = false;
    // MOD #64: the conversation dies with the session — forget the cue item so
    // the next session never tries to delete an id the server doesn't know.
    cueItemIdRef.current = null;
  }, [stopAmplitude]);

  const startSession = useCallback(async () => {
    if (sessionStartingRef.current || pcRef.current) return;
    sessionStartingRef.current = true;
    setState('processing');

    // bail() is called after each await to abort gracefully if openMic was
    // toggled off (or stopSession called) while we were in flight.
    const bail = (): boolean => !openMicRef.current || !sessionStartingRef.current;

    try {
      // Step 1: Get ephemeral token
      const tokenRes = await fetch('/api/uhs/realtime/session', { method: 'POST' });
      if (bail()) { sessionStartingRef.current = false; return; }
      if (!tokenRes.ok) throw new Error(`token-fetch-${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token: string; expires_at?: string };
      if (bail()) { sessionStartingRef.current = false; return; }

      // Step 2: Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        mergeStats({ voicePath: 'realtime', rtcState: pc.connectionState });
      };

      // Step 3: Get mic stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (bail()) {
        stream.getTracks().forEach((t) => t.stop());
        sessionStartingRef.current = false;
        return;
      }
      micStreamRef.current = stream;

      // Step 4: Add audio track
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // Step 5: Create data channel
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      // Step 6: Data channel message handler
      dc.onmessage = (e: MessageEvent<string>) => {
        let msg: { type?: string; delta?: string; transcript?: string };
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
            // MOD #54: the first transcript delta is the earliest reliable
            // "JARVIS is audibly speaking" marker on the data channel. The
            // clock ignores repeats, so whichever of this and
            // output_audio_buffer.started lands first wins the measurement.
            turnClockRef.current.firstAudio({ path: 'realtime', tool: turnToolRef.current });
            if (typeof msg.delta === 'string') {
              setInterim((prev) => prev + msg.delta);
            }
            break;
          }
          case 'output_audio_buffer.started': {
            // MOD #54: WebRTC-only event; fires when audio actually starts
            // flowing, usually a beat before the first transcript delta.
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
          case 'response.created': {
            // Server VAD auto-creates responses too (not just our own
            // requestResponse() calls) — track every response, not just
            // client-initiated ones, so the guard actually holds.
            activeResponseRef.current = true;
            break;
          }
          case 'input_audio_buffer.speech_started': {
            setState('listening');
            setInterim('');
            break;
          }
          case 'input_audio_buffer.speech_stopped': {
            // MOD #54: THE measurement origin — everything after this is wait.
            turnClockRef.current.stop();
            turnToolRef.current = undefined;
            setState('processing');
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            // GA shape is flat: { type, item_id, content_index, transcript } —
            // not nested under item.content[] like the beta event.
            const userText = (msg as { transcript?: string }).transcript?.trim() ?? '';
            if (userText) {
              turnClockRef.current.transcript();
              const uid = `realtime-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              setLog((prev) => {
                if (prev.some((entry) => entry.text === userText && entry.role === 'user')) return prev;
                return [...prev, { id: uid, role: 'user', text: userText, ts: Date.now() }];
              });

              // === JARVIS MOD #53 — goodbye detection on the Realtime path ===
              // Honest limitation: server VAD auto-creates the response as soon
              // as speech stops, and transcription is what the detector needs,
              // so we cannot gate the model call the way the fast path does —
              // we can only cut it short. `response.cancel` stops generation
              // within a word or two and we speak a canned local line instead,
              // which is what the user actually hears. Gating it properly would
              // mean turn_detection.create_response:false, i.e. adding whisper
              // transcription latency to EVERY turn to save it on a few — the
              // wrong trade for a latency phase. Revisit if OpenAI exposes a
              // transcript-before-response hook.
              if (isSignoff(userText, hadAgentTurnRef.current)) {
                const channel = dcRef.current;
                if (channel?.readyState === 'open' && activeResponseRef.current) {
                  channel.send(JSON.stringify({ type: 'response.cancel' }));
                }
                activeResponseRef.current = false;
                pendingResponseCreateRef.current = false;
                const line = signoffLine(signoffIdxRef.current);
                signoffIdxRef.current += 1;
                ttsBridgeRef.current?.interrupt();
                ttsBridgeRef.current?.speakLocal(line);
                turnClockRef.current.firstAudio({ path: 'realtime', signoff: true });
                setInterim('');
                // Wind down to the wake gate — no spinner limbo.
                setState('wakeListening');
                break;
              }
              // === END JARVIS MOD #53 ===
            }
            break;
          }
          case 'response.done': {
            // response.create is only ever safe to send once this response
            // is fully closed out — clear the active flag before anything
            // else in this branch (including the tool-call path below).
            activeResponseRef.current = false;

            // === JARVIS MOD #51 — tool bridge: the model called a function.
            // GA surfaces completed function calls on response.done as
            // output items of type "function_call" (call_id/name/arguments).
            // Execute server-side, return function_call_output, then
            // response.create so the model speaks the result. ===
            const output = (msg as unknown as {
              response?: { output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }> };
            }).response?.output;
            const calls = (output ?? []).filter((o) => o.type === 'function_call' && o.call_id && o.name);
            if (calls.length > 0) {
              // MOD #54: tag the turn so the latency line says WHICH tool the
              // wait paid for — a slow ask_jarvis and a slow fast lane look
              // identical in the log otherwise.
              turnToolRef.current = calls.map((c) => c.name).filter(Boolean).join('+');
              setState('responding');
              // MOD #51 fix: run all calls concurrently, but send exactly ONE
              // response.create after every function_call_output has landed —
              // one per call raced a second response.create against the first.
              void (async () => {
                await Promise.all(
                  calls.map(async (call) => {
                    let result = 'The tool call could not be completed.';
                    try {
                      const res = await fetch('/api/uhs/realtime/tool', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: call.name, arguments: call.arguments ?? '{}' }),
                      });
                      if (res.ok) {
                        const payload = (await res.json()) as { output?: string };
                        if (payload.output) result = payload.output;
                      } else {
                        result = `The tool call failed with status ${res.status}.`;
                      }
                    } catch {
                      // keep the default failure message
                    }
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
                requestResponse();
              })();
              break;
            }
            // === END JARVIS MOD #51 ===

            // === JARVIS MOD #64 — the assistant turn is fully closed and no
            // tool round-trip is outstanding: move the tonal cue to the tail so
            // it sits one item behind whatever the user says next. ===
            refreshTonalCue();
            // === END MOD #64 ===

            // A response finished with no pending tool calls — if a turn
            // arrived while we were busy (barge-in, or sendText during a
            // tool round-trip), fire the deferred response.create now.
            if (pendingResponseCreateRef.current) {
              pendingResponseCreateRef.current = false;
              requestResponse();
              break;
            }
            setState((s) => (s === 'processing' || s === 'responding' ? 'wakeListening' : s));
            break;
          }
          case 'error': {
            console.error('[realtime] OpenAI error event', e.data);
            setState('wakeListening');
            break;
          }
        }
      };

      dc.onopen = () => {
        mergeStats({ voicePath: 'realtime', rtcState: pc.connectionState, dcState: 'open' });
        // MOD #64: seed the cue so turn 1 is governed by the same checkpoint
        // every later turn gets. No response.create — it is context, not a turn.
        refreshTonalCue();
      };

      // Step 7: Set up remote audio
      if (!audioElRef.current) {
        audioElRef.current = document.createElement('audio');
        audioElRef.current.autoplay = true;
      }
      pc.ontrack = (e: RTCTrackEvent) => {
        if (audioElRef.current && e.streams[0]) {
          audioElRef.current.srcObject = e.streams[0];
          audioElRef.current.play().catch(() => {});
        }
      };

      // Step 8: Create SDP offer
      const offer = await pc.createOffer();

      // Step 9: Set local description
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

      // Step 12: Transition to wakeListening
      setState('wakeListening');
      mergeStats({ voicePath: 'realtime', rtcState: pc.connectionState });
    } catch (err) {
      console.error('[realtime] startSession failed', err);
      sessionStartingRef.current = false;
      stopSession();
      setState('dormant');
      mergeStats({ voicePath: 'realtime', rtcState: 'failed', rtcError: String(err) });
    }
  }, [pushAgentReply, startAmplitude, stopSession, refreshTonalCue]);

  const sendText = useCallback((text: string) => {
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
      fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'jarvis-telegram', text: `[Cosmos] ${trimmed}`, stream: false }),
      })
        .then(async (r) => {
          if (!r.ok) { setState('wakeListening'); return; }
          let payload: { fastpath?: boolean; replyText?: string; replyId?: string } = {};
          try { payload = (await r.json()) as typeof payload; } catch { /* ok */ }
          if (payload.fastpath && payload.replyText && payload.replyId) {
            fastReplyIdsRef.current.add(payload.replyId);
            pushAgentReply(payload.replyText, payload.replyId);
          } else {
            setState('responding');
          }
        })
        .catch(() => setState('wakeListening'));
    }
  }, [pushAgentReply, requestResponse]);

  // startListening: for Realtime VAD is server-side; this opens a follow-up window
  const startListening = useCallback(() => {
    setState('listening');
  }, []);

  // stopListening: close the follow-up window
  const stopListening = useCallback(() => {
    setState('wakeListening');
  }, []);

  const toggleOpenMic = useCallback(() => {
    // Set the ref immediately so startSession bail() guards fire synchronously
    // if a session is in flight when the user taps off.
    const next = !openMicRef.current;
    openMicRef.current = next;
    // State update triggers the openMic effect which handles start/stop session.
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
    openMicRef.current = openMic;
    localStorage.setItem(OPEN_MIC_KEY, openMic ? '1' : '0');
    mergeStats({ openMic });

    if (openMic && supported) {
      if (!pcRef.current && !sessionStartingRef.current) {
        void startSession();
      }
    } else if (!openMic) {
      stopSession();
      setState((s) => (s !== 'dormant' ? 'dormant' : s));
    }
  }, [openMic, supported, startSession, stopSession]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, [stopSession]);

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
    fastReplyIdsRef,
  };
}
